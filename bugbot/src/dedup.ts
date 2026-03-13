import { execFileSync } from "child_process";
import { createLogger } from "./log.js";
import { SCAN_ROOT } from "./config.js";
import type { Finding, ScanState } from "./types.js";

const log = createLogger("dedup");

interface GhIssue {
  number: number;
  title: string;
}

interface GhPr {
  number: number;
}

// --- Batched GH lookups: one API call per unique file ---

interface FileGhCache {
  issues: GhIssue[];
  prs: GhPr[];
}

function buildGhCache(files: string[]): Map<string, FileGhCache> {
  const uniqueFiles = [...new Set(files)];
  const cache = new Map<string, FileGhCache>();

  log(`Fetching GH state for ${uniqueFiles.length} unique files...`);

  for (const file of uniqueFiles) {
    let issues: GhIssue[] = [];
    let prs: GhPr[] = [];

    try {
      const raw = execFileSync(
        "gh",
        [
          "issue",
          "list",
          "--search",
          `${file} in:body is:issue is:open`,
          "--json",
          "number,title",
          "--limit",
          "10",
        ],
        { cwd: SCAN_ROOT, stdio: ["pipe", "pipe", "pipe"] },
      ).toString();
      issues = JSON.parse(raw) as GhIssue[];
    } catch {
      // gh failure — treat as no issues
    }

    try {
      const raw = execFileSync(
        "gh",
        [
          "pr",
          "list",
          "--search",
          `${file} in:body is:pr is:open`,
          "--json",
          "number",
          "--limit",
          "5",
        ],
        { cwd: SCAN_ROOT, stdio: ["pipe", "pipe", "pipe"] },
      ).toString();
      prs = JSON.parse(raw) as GhPr[];
    } catch {
      // gh failure — treat as no PRs
    }

    cache.set(file, { issues, prs });
  }

  log(`GH cache built: ${cache.size} files queried`);
  return cache;
}

// Simple word-overlap similarity (no external deps)
function similarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

export async function isDuplicate(
  finding: Finding,
  state: ScanState,
  ghCache: Map<string, FileGhCache>,
): Promise<{ duplicate: boolean; reason?: string }> {
  // Layer 1: Own fingerprint cache (previous bugbot runs)
  if (state.fingerprints[finding.id]) {
    return { duplicate: true, reason: "previous-scan" };
  }

  // Layer 2: GH issues + PRs (from pre-built cache)
  const cached = ghCache.get(finding.file);
  if (cached) {
    const match = cached.issues.find(
      (i) => similarity(i.title, finding.title) > 0.7,
    );
    if (match) {
      return { duplicate: true, reason: `gh-issue-${match.number}` };
    }
    if (cached.prs.length > 0) {
      return { duplicate: true, reason: `open-pr-${cached.prs[0].number}` };
    }
  }

  return { duplicate: false };
}

export async function deduplicateFindings(
  findings: Finding[],
  state: ScanState,
): Promise<Finding[]> {
  // Split: fingerprint hits are instant, GH lookups need batching
  const needsGh: Finding[] = [];
  const results: Finding[] = [];
  let skipped = 0;

  for (const finding of findings) {
    if (state.fingerprints[finding.id]) {
      log(`Skipping duplicate: ${finding.title} (previous-scan)`);
      finding.status = "duplicate";
      skipped++;
    } else {
      needsGh.push(finding);
    }
  }

  // Batch GH lookups by unique file
  const ghCache = buildGhCache(needsGh.map((f) => f.file));

  for (const finding of needsGh) {
    const result = await isDuplicate(finding, state, ghCache);
    if (result.duplicate) {
      log(`Skipping duplicate: ${finding.title} (${result.reason})`);
      finding.status = "duplicate";
      skipped++;
    } else {
      results.push(finding);
    }
  }

  log(
    `Dedup: ${findings.length} in, ${results.length} passed, ${skipped} duplicates`,
  );
  return results;
}
