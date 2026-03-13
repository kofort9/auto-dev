/**
 * Panel review orchestrator.
 *
 * Wires: agent-router → agent-runner (parallel via Promise.all) → brief compiler.
 * This is the main entry point called by worker.ts after auto-dev.sh completes Phase 5.
 */

import { execFileSync } from "child_process";
import type { ReviewBrief } from "./review-types.js";
import { selectAgents } from "./agent-router.js";
import { runAgent } from "./agent-runner.js";
import { compileBrief, writeBrief } from "./review-brief.js";
import { createLogger } from "./log.js";

export async function runPanelReview(
  issueNumber: number,
  spec: string,
  worktree: string,
  _repoRoot: string,
): Promise<ReviewBrief> {
  // Get diff for review
  const diff = getDiff(worktree);
  const filesChanged = getChangedFiles(worktree);

  // Route: decide which agents to invoke
  const { toRun, skipped } = selectAgents(filesChanged);

  log(
    `Panel review for #${issueNumber}: ${toRun.length} agents (${toRun.join(", ")})`,
  );
  if (skipped.length > 0) {
    log(
      `  Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`,
    );
  }

  // Run all agents in parallel
  const results = await Promise.all(
    toRun.map(async (agent) => {
      log(`  Starting ${agent}...`);
      const result = await runAgent({ agent, spec, diff, worktree });
      log(
        `  ${agent} done: ${result.verdict} (${result.findings.length} findings, ${Math.round(result.duration_ms / 1000)}s)`,
      );
      return result;
    }),
  );

  // Compile into unified brief
  const brief = compileBrief(issueNumber, spec, filesChanged, results, skipped);

  // Write to disk
  const briefPath = writeBrief(brief);
  log(
    `Panel verdict: ${brief.panel_verdict.toUpperCase()} — ${brief.findings.length} findings (${brief.blocker_count} blockers)`,
  );
  log(`Brief → ${briefPath}`);

  return brief;
}

function getDiff(worktree: string): string {
  try {
    return execFileSync("git", ["diff", "origin/main"], {
      cwd: worktree,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
    });
  } catch {
    return "";
  }
}

function getChangedFiles(worktree: string): string[] {
  try {
    const raw = execFileSync("git", ["diff", "--name-only", "origin/main"], {
      cwd: worktree,
      encoding: "utf-8",
    });
    return raw
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

const log = createLogger("nightshift:panel");
