import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import picomatch from "picomatch";
import { RISK_CONTRACT, SCAN_DIRS, SKIP_PATTERNS } from "./config.js";
import { createLogger } from "./log.js";
import type { RiskTier } from "./types.js";

const log = createLogger("scanner");

// --- Preflight: fetch + detached HEAD on origin/main ---

export function ensureLatestMain(scanRoot: string): string {
  log("Fetching origin...");
  execFileSync("git", ["fetch", "origin"], { cwd: scanRoot });
  // Use rev-parse on origin/main without checking out — avoids putting VE
  // main worktree into detached HEAD (destructive if user is working there).
  const treeHash = execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: scanRoot,
  })
    .toString()
    .trim();
  log(`Scanning origin/main at ${treeHash}`);
  return treeHash;
}

// --- Risk tier assignment (first-match on ordered contract) ---

const matchers = RISK_CONTRACT.map(
  ([tier, pattern]) => [tier, picomatch(pattern)] as const,
);

export function getRiskTier(relPath: string): RiskTier {
  for (const [tier, match] of matchers) {
    if (match(relPath)) return tier;
  }
  return "low";
}

// --- File traversal ---

function shouldSkip(name: string): boolean {
  return SKIP_PATTERNS.includes(name);
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(path.relative(root, full));
    }
  }
}

export function collectFiles(scanRoot: string): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(scanRoot, dir);
    if (fs.existsSync(abs)) {
      walk(abs, scanRoot, files);
    }
  }
  files.sort(); // Deterministic ordering
  log(`Collected ${files.length} .ts files`);
  return files;
}

// --- Git blame for age (used by stale-comments) ---

export function getBlameDate(
  scanRoot: string,
  file: string,
  line: number,
): Date | null {
  try {
    const out = execFileSync(
      "git",
      ["blame", "-L", `${line},${line}`, "--porcelain", file],
      { cwd: scanRoot },
    ).toString();
    const match = out.match(/^committer-time (\d+)$/m);
    if (match) return new Date(parseInt(match[1], 10) * 1000);
  } catch {
    // blame can fail on uncommitted files
  }
  return null;
}
