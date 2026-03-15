/**
 * Read/write benchmark/results.tsv on the optimize branch.
 * Tab-separated, same format as Karpathy's autoresearch.
 */

import fs from "fs";
import path from "path";
import type { ExperimentRow } from "./types.js";

const TSV_HEADER = "commit\tp50_ms\tp95_ms\tdelta_pct\tstatus\tdescription";

/** Ensure results.tsv exists with header. */
export function initResultsTsv(repoRoot: string): void {
  const dir = path.join(repoRoot, "benchmark");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "results.tsv");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, TSV_HEADER + "\n");
  }
}

/** Append a row to results.tsv. */
export function appendResult(repoRoot: string, row: ExperimentRow): void {
  const file = path.join(repoRoot, "benchmark", "results.tsv");
  const line = [
    row.commit,
    row.p50_ms.toFixed(1),
    row.p95_ms.toFixed(1),
    row.delta_pct.toFixed(1),
    row.status,
    row.description,
  ].join("\t");
  fs.appendFileSync(file, line + "\n");
}

/** Read all rows from results.tsv. */
export function readResults(repoRoot: string): ExperimentRow[] {
  const file = path.join(repoRoot, "benchmark", "results.tsv");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  // Skip header
  return lines.slice(1).map((line) => {
    const [commit, p50, p95, delta, status, ...desc] = line.split("\t");
    return {
      commit,
      p50_ms: parseFloat(p50),
      p95_ms: parseFloat(p95),
      delta_pct: parseFloat(delta),
      status: isValidStatus(status) ? status : "crash",
      description: desc.join("\t"),
    };
  });
}

const VALID_STATUSES = new Set(["keep", "discard", "crash"]);
function isValidStatus(s: string): s is ExperimentRow["status"] {
  return VALID_STATUSES.has(s);
}

/** Compute improvement percentage between two p50 values. */
export function deltaPercent(baseline: number, current: number): number {
  return baseline > 0 ? ((baseline - current) / baseline) * 100 : 0;
}

/** Format recent results as a string for LLM context. */
export function formatRecentRows(rows: ExperimentRow[], n = 10): string {
  if (rows.length === 0) return "No experiments yet.";
  const recent = rows.slice(-n);
  const header = "commit\tp50_ms\tdelta%\tstatus\tdescription";
  const lines = recent.map(
    (r) =>
      `${r.commit}\t${r.p50_ms.toFixed(1)}\t${r.delta_pct > 0 ? "+" : ""}${r.delta_pct.toFixed(1)}%\t${r.status}\t${r.description}`,
  );
  return [header, ...lines].join("\n");
}

/** Get the last N results for context (reads from disk — prefer formatRecentRows for hot paths). */
export function recentResults(repoRoot: string, n = 10): string {
  return formatRecentRows(readResults(repoRoot), n);
}
