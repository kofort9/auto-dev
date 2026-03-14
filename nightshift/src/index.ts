#!/usr/bin/env npx tsx
/**
 * Nightshift — Job queue manager for the auto-dev pipeline.
 *
 * Usage:
 *   npx tsx nightshift/src/index.ts run                    # Process all auto-ready issues
 *   npx tsx nightshift/src/index.ts run --fresh            # Ignore prior state, start clean
 *   npx tsx nightshift/src/index.ts run --issue 215,216    # Specific issues only
 *   npx tsx nightshift/src/index.ts run --dry-run          # Show queue without executing
 *   npx tsx nightshift/src/index.ts run --max-failures 3   # Circuit breaker threshold
 *   npx tsx nightshift/src/index.ts run --concurrency 3    # Parallel workers (default: 1)
 *   npx tsx nightshift/src/index.ts status                 # One-shot status
 *   npx tsx nightshift/src/index.ts promote                # Label next wave of unblocked issues
 */

import path from "path";
import { fileURLToPath } from "url";
import type { NightshiftOptions } from "./types.js";
import {
  ensureStateDir,
  readState,
  writeState,
  resetInProgress,
} from "./state.js";
import { acquireLock, releaseLock } from "./lock.js";
import { discoverIssues, buildQueue, processQueue } from "./queue.js";
import { runPostRunReview } from "./pr-self-review.js";
import { generateSummary, writeSummary } from "./summary.js";
import { promoteNextWave } from "./promoter.js";
import { createLogger } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NIGHTSHIFT_ROOT = path.resolve(__dirname, ".."); // nightshift/
const SCRIPT_DIR = path.join(NIGHTSHIFT_ROOT, "scripts"); // nightshift/scripts/
const TARGET_REPO_DEFAULT = ""; // Set TARGET_REPO in .env
const REPO_ROOT = path.resolve(
  (process.env.TARGET_REPO ?? TARGET_REPO_DEFAULT).replace(/^~/, process.env.HOME ?? ""),
);

// --- Arg parsing ---
const args = process.argv.slice(2);
const subcommand = args[0] ?? "run";

if (subcommand === "status") {
  printStatus();
  process.exit(0);
}

if (subcommand === "promote") {
  promoteNextWave(REPO_ROOT);
  process.exit(0);
}

if (subcommand !== "run") {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error("Usage: nightshift [run|status|promote]");
  process.exit(1);
}

// Parse run options
const opts: NightshiftOptions = {
  fresh: false,
  dryRun: false,
  issueList: [],
  maxFailures: 3,
  concurrency: 1,
};

for (let i = 1; i < args.length; i++) {
  switch (args[i]) {
    case "--fresh":
      opts.fresh = true;
      break;
    case "--dry-run":
      opts.dryRun = true;
      break;
    case "--issue": {
      const val = args[++i];
      if (!val || !/^\d+(,\d+)*$/.test(val)) {
        console.error("Error: --issue must be comma-separated numbers");
        process.exit(1);
      }
      opts.issueList = val.split(",").map(Number);
      break;
    }
    case "--max-failures": {
      const val = args[++i];
      if (!val || !/^\d+$/.test(val)) {
        console.error("Error: --max-failures must be a positive integer");
        process.exit(1);
      }
      opts.maxFailures = parseInt(val, 10);
      break;
    }
    case "--concurrency": {
      const val = args[++i];
      if (!val || !/^[1-9]\d*$/.test(val)) {
        console.error("Error: --concurrency must be a positive integer (1-10)");
        process.exit(1);
      }
      const n = parseInt(val, 10);
      if (n > 10) {
        console.error("Error: --concurrency max is 10");
        process.exit(1);
      }
      opts.concurrency = n;
      break;
    }
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

// --- Main ---
async function main(): Promise<void> {
  ensureStateDir();
  acquireLock();

  // Cleanup on exit
  const cleanup = () => {
    resetInProgress();
    releaseLock();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("exit", cleanup);

  // Initialize state
  if (opts.fresh || readState().run_id === "") {
    const runId = new Date().toISOString();
    writeState({ version: 2, run_id: runId, issues: {} });
    log(`Starting fresh run: ${runId}`);
  } else {
    log(`Resuming run: ${readState().run_id}`);
  }

  // Discover issues
  log("Discovering issues...");
  const issues = discoverIssues(REPO_ROOT, opts.issueList);

  if (issues.length === 0) {
    log("No issues to process.");
    return;
  }

  // Build queue
  const state = readState();
  const { queue, skippedCompleted } = buildQueue(issues, state);
  log(
    `Queue: ${queue.length} to process, ${skippedCompleted} already completed`,
  );

  if (opts.dryRun) {
    log("DRY RUN — would process:");
    for (const entry of queue) {
      const prev = state.issues[String(entry.number)]?.status ?? "pending";
      log(`  #${entry.number} (${prev}): ${entry.title}`);
    }
    return;
  }

  if (queue.length === 0) {
    log("Nothing to process — all issues completed.");
    return;
  }

  // Process (phases 1-9)
  const { startTs, endTs } = await processQueue(queue, opts, SCRIPT_DIR, REPO_ROOT);

  // Post-run self-review (phases 10-12)
  await runPostRunReview(REPO_ROOT);

  // Morning summary (after self-review so triage results are included)
  const finalState = readState();
  const summaryContent = generateSummary(finalState, startTs, endTs);
  const summaryPath = writeSummary(summaryContent);
  console.log("");
  console.log(summaryContent);
  log(`Summary → ${summaryPath}`);

  // Auto-promote next wave after processing
  promoteNextWave(REPO_ROOT);

  log("Nightshift complete.");
}

function printStatus(): void {
  const state = readState();
  const grouped: Record<string, string[]> = {};

  for (const [num, issue] of Object.entries(state.issues)) {
    const status = issue.status;
    if (!grouped[status]) grouped[status] = [];
    grouped[status].push(`#${num}`);
  }

  for (const [status, nums] of Object.entries(grouped)) {
    console.log(`${status}: ${nums.join(" ")}`);
  }

  if (Object.keys(grouped).length === 0) {
    console.log("No state file.");
  }
}

const log = createLogger("nightshift");

main().catch((err) => {
  console.error("[nightshift] Fatal:", err);
  process.exit(1);
});
