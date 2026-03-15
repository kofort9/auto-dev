/**
 * Entry point for nightshift optimize subcommand.
 * Parses optimize-specific args and kicks off the experiment loop.
 */

import type { OptimizeOptions } from "./types.js";
import { readOptimizeState } from "./state.js";
import { runOptimizeLoop } from "./experiment-loop.js";
import { updateDashboard } from "./dashboard.js";
import { createLogger } from "../log.js";

const log = createLogger("optimize");

export async function runOptimize(
  args: string[],
  repoRoot: string,
): Promise<void> {
  // Handle sub-subcommands
  const action = args[0];

  if (action === "status") {
    printStatus();
    return;
  }

  if (action === "stop") {
    log("Stop should be handled by the shell wrapper (tmux kill)");
    return;
  }

  // Parse options
  const opts: OptimizeOptions = {
    maxExperiments: 10,
    winsBeforePr: 5,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--max-experiments": {
        const val = args[++i];
        if (!val || !/^\d+$/.test(val)) {
          console.error("Error: --max-experiments must be a positive integer");
          process.exit(1);
        }
        opts.maxExperiments = parseInt(val, 10);
        break;
      }
      case "--wins-before-pr": {
        const val = args[++i];
        if (!val || !/^\d+$/.test(val)) {
          console.error("Error: --wins-before-pr must be a positive integer");
          process.exit(1);
        }
        opts.winsBeforePr = parseInt(val, 10);
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
    }
  }

  log(`Starting optimize: max=${opts.maxExperiments} winsBeforePr=${opts.winsBeforePr}`);
  await runOptimizeLoop(repoRoot, opts);
}

function printStatus(): void {
  const state = readOptimizeState();

  const statusColors: Record<string, string> = {
    running: "\x1b[32m", // green
    paused: "\x1b[33m",  // yellow
    idle: "\x1b[90m",    // gray
    conflict: "\x1b[31m", // red
  };
  const reset = "\x1b[0m";
  const color = statusColors[state.status] ?? "";

  console.log(`Status:       ${color}${state.status.toUpperCase()}${reset}`);
  console.log(`Branch:       ${state.branch}`);

  if (state.baseline_p50_ms > 0) {
    const delta = (
      ((state.baseline_p50_ms - state.current_p50_ms) /
        state.baseline_p50_ms) *
      100
    ).toFixed(1);
    console.log(
      `Latency (p50): ${state.baseline_p50_ms}ms → ${state.current_p50_ms}ms (${delta}% improvement)`,
    );
  }

  console.log(`Experiments:  ${state.total_experiments}`);
  console.log(`Wins:         ${state.total_wins}`);
  console.log(`Wins → PR:    ${state.wins_since_pr}`);

  if (state.last_pr_url) {
    console.log(`Latest PR:    ${state.last_pr_url}`);
  }
  if (state.last_run_at) {
    console.log(`Last run:     ${state.last_run_at}`);
  }
  if (state.pause_reason) {
    console.log(`Pause reason: ${state.pause_reason}`);
  }

  // Update dashboard while we're at it
  updateDashboard(state);
}
