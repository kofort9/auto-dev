/**
 * Issue discovery and queue management.
 * Discovers issues via `gh` CLI, builds the processing queue,
 * and runs issues through the worker pool (sequential or concurrent).
 */

import { execFileSync } from "child_process";
import type { NightshiftState, NightshiftOptions } from "./types.js";
import {
  readState,
  updateIssue,
  updateIssueAsync,
  flushWrites,
} from "./state.js";
import { runAutoDev, runPostAutodev } from "./worker.js";
import type { ExtendedWorkerResult } from "./worker.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { WorkerPool } from "./pool.js";
import { generateSummary, writeSummary } from "./summary.js";
import { createLogger, formatDuration } from "./log.js";

interface GhIssue {
  number: number;
  title: string;
}

export function discoverIssues(
  repoRoot: string,
  issueList: number[],
): GhIssue[] {
  if (issueList.length > 0) {
    const results: GhIssue[] = [];
    for (const num of issueList) {
      const raw = execFileSync(
        "gh",
        ["issue", "view", String(num), "--json", "number,title"],
        { cwd: repoRoot, encoding: "utf-8" },
      );
      results.push(JSON.parse(raw) as GhIssue);
    }
    return results;
  }

  const raw = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--label",
      "auto-ready",
      "--state",
      "open",
      "--json",
      "number,title",
      "--limit",
      "50",
    ],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  return JSON.parse(raw) as GhIssue[];
}

export interface QueueEntry {
  number: number;
  title: string;
}

export function buildQueue(
  issues: GhIssue[],
  state: NightshiftState,
): { queue: QueueEntry[]; skippedCompleted: number } {
  let skippedCompleted = 0;
  const queue: QueueEntry[] = [];

  for (const issue of issues) {
    const prev = state.issues[String(issue.number)]?.status ?? "pending";

    if (prev === "completed") {
      skippedCompleted++;
      continue;
    }

    queue.push({ number: issue.number, title: issue.title });

    // Seed pending if new
    if (prev === "pending" || !state.issues[String(issue.number)]) {
      updateIssue(String(issue.number), "pending", { title: issue.title });
    }
  }

  return { queue, skippedCompleted };
}

export async function processQueue(
  queue: QueueEntry[],
  opts: NightshiftOptions,
  scriptDir: string,
  repoRoot: string,
): Promise<void> {
  const startTs = Date.now();
  const breaker = new CircuitBreaker(opts.maxFailures);
  const concurrency = opts.concurrency ?? 1;
  const pool = new WorkerPool(concurrency);

  if (concurrency > 1) {
    // Pre-fetch once to avoid parallel git fetch contention
    log(`Concurrency: ${concurrency} workers. Pre-fetching origin...`);
    try {
      execFileSync("git", ["fetch", "origin"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch {
      log("Warning: git fetch origin failed, workers will fetch individually");
    }
  }

  let halted = false;

  const processEntry = async (
    entry: QueueEntry,
    index: number,
  ): Promise<void> => {
    if (halted) return;

    await pool.acquire();
    if (halted) {
      pool.release();
      return;
    }

    const num = String(entry.number);
    const slot = pool.active;

    log(
      `[${index + 1}/${queue.length}] #${entry.number}: ${entry.title}${concurrency > 1 ? ` (slot ${slot}/${concurrency})` : ""}`,
    );
    await updateIssueAsync(num, "in_progress", {
      started_at: new Date().toISOString(),
      slot: concurrency > 1 ? slot : undefined,
    });

    try {
      // Phases 1-5: auto-dev.sh (discover, setup, execute, simplify, verify)
      const autodevResult = await runAutoDev(entry.number, scriptDir, repoRoot);

      if (autodevResult.status !== "completed") {
        await updateIssueAsync(num, "failed", {
          phase: autodevResult.phase,
          duration_s: autodevResult.duration_s,
        });
        log(
          `#${entry.number} — FAILED at ${autodevResult.phase} (${formatDuration(autodevResult.duration_s)})`,
        );

        const tripped = breaker.recordFailure(autodevResult.phase ?? "unknown");
        if (tripped) {
          log(
            `CIRCUIT BREAKER: ${breaker.count}/${breaker.max} consecutive crashes — halting`,
          );
          halted = true;
        } else {
          log(`  Crash counter: ${breaker.count}/${breaker.max}`);
        }
        return;
      }

      log(
        `#${entry.number} — Phases 1-5 passed (${formatDuration(autodevResult.duration_s)}). Starting panel review...`,
      );

      // Phases 6-9: panel review → fix → re-verify → publish
      const postResult: ExtendedWorkerResult = await runPostAutodev(
        entry.number,
        repoRoot,
      );

      const totalDuration = autodevResult.duration_s + postResult.duration_s;

      if (postResult.status === "completed") {
        await updateIssueAsync(num, "completed", {
          duration_s: totalDuration,
          pr_url: postResult.pr_url,
          review_brief_path: postResult.review_brief_path,
          panel_verdict: postResult.panel_verdict,
          token_usage: postResult.token_usage,
        });
        breaker.recordSuccess();
        log(
          `#${entry.number} — COMPLETED (${formatDuration(totalDuration)})${postResult.pr_url ? ` → ${postResult.pr_url}` : ""}`,
        );
      } else {
        await updateIssueAsync(num, "failed", {
          phase: postResult.phase,
          duration_s: totalDuration,
          review_brief_path: postResult.review_brief_path,
          panel_verdict: postResult.panel_verdict,
          token_usage: postResult.token_usage,
        });
        log(
          `#${entry.number} — FAILED at ${postResult.phase} (${formatDuration(totalDuration)})`,
        );

        // Panel review failures are spec failures, not systemic
        const tripped = breaker.recordFailure(postResult.phase ?? "unknown");
        if (tripped) {
          log(
            `CIRCUIT BREAKER: ${breaker.count}/${breaker.max} consecutive crashes — halting`,
          );
          halted = true;
        } else {
          log(`  Crash counter: ${breaker.count}/${breaker.max}`);
        }
      }
    } finally {
      pool.release();
    }
  };

  if (concurrency === 1) {
    // Sequential: process one at a time (original behavior)
    for (let i = 0; i < queue.length; i++) {
      if (halted) break;
      await processEntry(queue[i], i);
    }
  } else {
    // Concurrent: launch all, pool limits how many run at once
    const tasks = queue.map((entry, i) => processEntry(entry, i));
    await Promise.all(tasks);
  }

  // Wait for all in-flight async writes to flush before cleanup
  await flushWrites();

  // Mark remaining pending issues as skipped if circuit breaker tripped
  if (halted) {
    const currentState = readState();
    for (const entry of queue) {
      const status = currentState.issues[String(entry.number)]?.status;
      if (status === "pending") {
        updateIssue(String(entry.number), "skipped", {
          reason: "circuit_breaker",
        });
      }
    }
  }

  // Morning summary
  const endTs = Date.now();
  const state = readState();
  const summaryContent = generateSummary(state, startTs, endTs);
  const summaryPath = writeSummary(summaryContent);

  console.log("");
  console.log(summaryContent);
  log(`Summary → ${summaryPath}`);
}

const log = createLogger("nightshift");
