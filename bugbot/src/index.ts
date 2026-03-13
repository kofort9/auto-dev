import { execFileSync } from "child_process";
import { parseArgs } from "util";
import {
  ALL_CATEGORIES,
  ALL_STATIC_CATEGORIES,
  CONFIDENCE_THRESHOLDS,
  MAX_ISSUES_DEFAULT,
  SCAN_ROOT,
  SEVERITY_TO_PRIORITY,
} from "./config.js";
import { createLogger, formatDuration } from "./log.js";
import { ensureLatestMain, collectFiles } from "./scanner.js";
import { readState, writeState, updateFingerprint, appendFindings } from "./state.js";
import { deduplicateFindings } from "./dedup.js";
import { publishIssue } from "./publisher.js";
import { deadCodeScanner } from "./categories/dead-code.js";
import { typeHolesScanner } from "./categories/type-holes.js";
import { testCoverageScanner } from "./categories/test-coverage.js";
import { staleCommentsScanner } from "./categories/stale-comments.js";
import { inputValidationScanner } from "./categories/input-validation.js";
import { tokenSummary, resetTokenLog } from "./llm.js";
import type {
  BugbotOptions,
  Category,
  CategoryScanner,
  Finding,
  ScanResult,
} from "./types.js";

const log = createLogger("bugbot");

const SCANNERS: Record<Category, CategoryScanner> = {
  "dead-code": deadCodeScanner,
  "type-holes": typeHolesScanner,
  "test-coverage": testCoverageScanner,
  "stale-comments": staleCommentsScanner,
  "input-validation": inputValidationScanner,
};

function parseCliArgs(): BugbotOptions {
  const { values } = parseArgs({
    options: {
      full: { type: "boolean", default: false },
      category: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "max-issues": { type: "string" },
    },
    strict: false,
  });

  const categories: Category[] = values.category
    ? [values.category as Category]
    : [...ALL_STATIC_CATEGORIES];

  // Validate category
  for (const c of categories) {
    if (!ALL_CATEGORIES.includes(c)) {
      console.error(`Unknown category: ${c}. Valid: ${ALL_CATEGORIES.join(", ")}`);
      process.exit(1);
    }
  }

  let maxIssues = MAX_ISSUES_DEFAULT;
  if (values["max-issues"]) {
    maxIssues = parseInt(values["max-issues"] as string, 10);
    if (isNaN(maxIssues) || maxIssues < 1) {
      console.error("--max-issues must be a positive integer");
      process.exit(1);
    }
  }

  return {
    categories,
    dryRun: !!(values["dry-run"] ?? false),
    full: !!(values.full ?? false),
    maxIssues,
  };
}

function prioritizeFindings(findings: Finding[]): Finding[] {
  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };

  const sev = (s: string) => severityOrder[s] ?? 999;
  const risk = (s: string) => riskOrder[s] ?? 999;
  return [...findings].sort((a, b) => {
    const sevDiff = sev(a.severity) - sev(b.severity);
    if (sevDiff !== 0) return sevDiff;
    return risk(a.riskTier) - risk(b.riskTier);
  });
}

async function main(): Promise<void> {
  const opts = parseCliArgs();
  const start = Date.now();
  const scanDate = new Date().toISOString().slice(0, 10);

  log(`Starting scan (dry-run: ${opts.dryRun}, full: ${opts.full})`);
  log(`Categories: ${opts.categories.join(", ")}`);
  resetTokenLog();

  // --- Preflight: verify required labels exist ---
  if (!opts.dryRun) {
    const requiredLabels = [
      "bugbot",
      "auto-ready",
      ...opts.categories.map((c) => `bugbot:${c}`),
      ...new Set(Object.values(SEVERITY_TO_PRIORITY)),
    ];
    try {
      const raw = execFileSync(
        "gh",
        ["label", "list", "--json", "name", "--limit", "200"],
        { cwd: SCAN_ROOT, stdio: ["pipe", "pipe", "pipe"] },
      ).toString();
      const existing = new Set(
        (JSON.parse(raw) as { name: string }[]).map((l) => l.name),
      );
      const missing = requiredLabels.filter((l) => !existing.has(l));
      if (missing.length > 0) {
        log(`ERROR: Missing GH labels: ${missing.join(", ")}`);
        log("Create them with: gh label create <name>");
        process.exit(1);
      }
      log(`Label check passed (${requiredLabels.length} labels verified)`);
    } catch (err) {
      log(`WARNING: Could not verify labels: ${err}`);
    }
  }

  // --- Preflight: fetch latest main ---
  const treeHash = ensureLatestMain(SCAN_ROOT);
  const state = readState();

  // --- Tree hash check: skip if no new merges ---
  if (!opts.full && state.lastGitTreeHash === treeHash) {
    log(`No changes since last scan (hash: ${treeHash.slice(0, 8)}). Use --full to force.`);
    return;
  }

  // --- Collect files ---
  const files = collectFiles(SCAN_ROOT);

  // --- Run category scanners ---
  const allFindings: Finding[] = [];
  const categoryStats: ScanResult["categories"] = {} as ScanResult["categories"];

  for (const cat of opts.categories) {
    const scanner = SCANNERS[cat];
    if (!scanner) continue;

    const findings = await scanner.scan(files, SCAN_ROOT);

    // Apply confidence threshold per risk tier
    const passed: Finding[] = [];
    let skipped = 0;
    for (const f of findings) {
      const threshold = CONFIDENCE_THRESHOLDS[f.riskTier];
      if (f.confidence >= threshold) {
        passed.push(f);
      } else {
        skipped++;
      }
    }

    categoryStats[cat] = { count: passed.length, skipped };
    allFindings.push(...passed);
  }

  log(`Total findings after confidence filter: ${allFindings.length}`);

  // --- Deduplication ---
  const unique = await deduplicateFindings(allFindings, state);

  // --- Prioritize and cap ---
  const prioritized = prioritizeFindings(unique);
  const toPublish = prioritized.slice(0, opts.maxIssues);
  const overflow = prioritized.length - toPublish.length;

  if (overflow > 0) {
    log(`Capped at ${opts.maxIssues} issues (${overflow} deferred)`);
  }

  // --- Publish ---
  let published = 0;
  for (const finding of toPublish) {
    if (opts.dryRun) {
      log(`[DRY RUN] Would create: ${finding.title} (${finding.severity}/${finding.riskTier})`);
      finding.status = "skipped";
    } else {
      const issueNumber = publishIssue(finding, scanDate);
      if (issueNumber) {
        finding.status = "published";
        updateFingerprint(state, finding.id, issueNumber);
        published++;
      } else {
        finding.status = "skipped";
        updateFingerprint(state, finding.id);
      }
    }
  }

  // --- Update state ---
  state.lastScanDate = scanDate;
  state.lastGitTreeHash = treeHash;
  writeState(state);

  // --- Write JSONL log ---
  const jsonlLines = allFindings.map((f) => JSON.stringify(f));
  if (jsonlLines.length > 0) {
    appendFindings(scanDate, jsonlLines);
  }

  // --- Summary ---
  const duration = (Date.now() - start) / 1000;
  log("--- Scan Complete ---");
  log(`Duration: ${formatDuration(duration)}`);
  log(`Files scanned: ${files.length}`);
  log(`Findings: ${allFindings.length} total, ${unique.length} unique`);
  log(`Published: ${published} issues${opts.dryRun ? " (dry run)" : ""}`);
  if (overflow > 0) log(`Deferred: ${overflow} (hit max-issues cap)`);

  for (const [cat, stats] of Object.entries(categoryStats)) {
    log(`  ${cat}: ${stats.count} findings, ${stats.skipped} below threshold`);
  }

  const tokens = tokenSummary();
  if (tokens) {
    log(`LLM tokens: ${tokens}`);
  }
}

main().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
