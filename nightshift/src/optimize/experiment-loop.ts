/**
 * Core experiment loop for nightshift optimize.
 * Autoresearch pattern: hypothesis → implement → benchmark → keep/discard → repeat.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import type {
  OptimizeOptions,
  BenchmarkResult,
  Hypothesis,
} from "./types.js";
import {
  readOptimizeState,
  writeOptimizeState,
  acquireOptimizeLock,
  releaseOptimizeLock,
  isPaused,
} from "./state.js";
import {
  ensureBranch,
  rebaseFromMain,
  snapshotSha,
  rollback,
  commitExperiment,
} from "./git-ops.js";
import {
  seedBenchmark,
  runBenchmark,
  runVerify,
  isImprovement,
} from "./benchmark.js";
import { initResultsTsv, appendResult, recentResults } from "./results.js";
import {
  notifyWin,
  notifyConflict,
  notifyCrash,
} from "./notify.js";
import { draftPr } from "./pr.js";
import { updateDashboard } from "./dashboard.js";
import { createLogger, formatDuration } from "../log.js";

const log = createLogger("optimize:loop");

export async function runOptimizeLoop(
  repoRoot: string,
  opts: OptimizeOptions,
): Promise<void> {
  // Acquire lock
  if (!acquireOptimizeLock()) {
    log("Another optimize instance is running — exiting");
    return;
  }

  const loopStart = Date.now();

  try {
    const state = readOptimizeState();
    const branch = state.branch || "autoresearch/optimize";

    // Check if paused (rebase conflict from previous run)
    if (isPaused()) {
      log("Optimize is paused (rebase conflict). Resolve manually.");
      return;
    }

    // Dry run: show what would happen
    if (opts.dryRun) {
      log("DRY RUN — would run optimize loop:");
      log(`  Branch: ${branch}`);
      log(`  Max experiments: ${opts.maxExperiments}`);
      log(`  Wins before PR: ${opts.winsBeforePr}`);
      log(`  Target repo: ${repoRoot}`);
      return;
    }

    // Setup branch
    log(`Setting up branch ${branch}...`);
    ensureBranch(repoRoot, branch);

    // Rebase from main
    log("Rebasing from origin/main...");
    if (!rebaseFromMain(repoRoot)) {
      log("Rebase conflict — pausing optimize");
      notifyConflict();
      writeOptimizeState({
        ...state,
        status: "paused",
        pause_reason: "Rebase conflict with origin/main",
        last_run_at: new Date().toISOString(),
      });
      // Write pause marker
      const stateDir = (process.env.STATE_DIR ?? "~/.auto-dev").replace(
        /^~/,
        process.env.HOME ?? "",
      );
      fs.writeFileSync(
        path.join(stateDir, "optimize-paused.json"),
        JSON.stringify({ reason: "rebase_conflict", at: new Date().toISOString() }),
      );
      return;
    }

    // Seed benchmark infrastructure (one-time)
    seedBenchmark(repoRoot);
    initResultsTsv(repoRoot);

    // Establish baseline
    log("Running baseline benchmark...");
    const baseline = runBenchmark(repoRoot);
    if (!baseline) {
      log("Baseline benchmark failed — cannot proceed");
      return;
    }
    log(`Baseline: p50=${baseline.p50_ms}ms p95=${baseline.p95_ms}ms`);

    // Update state
    writeOptimizeState({
      ...state,
      status: "running",
      baseline_p50_ms: state.baseline_p50_ms || baseline.p50_ms,
      current_p50_ms: baseline.p50_ms,
      last_run_at: new Date().toISOString(),
    });

    let currentBaseline = baseline;
    let winsThisRun = 0;

    // Experiment loop
    for (let i = 0; i < opts.maxExperiments; i++) {
      const experimentStart = Date.now();
      log(`\n--- Experiment ${i + 1}/${opts.maxExperiments} ---`);

      // Snapshot current state
      const snapshot = snapshotSha(repoRoot);

      // Generate hypothesis
      log("Generating hypothesis...");
      const hypothesis = generateHypothesis(repoRoot);
      if (!hypothesis) {
        log("Failed to generate hypothesis — skipping");
        continue;
      }
      log(`Hypothesis: ${hypothesis.summary}`);

      // Implement the change
      log("Implementing change...");
      const implemented = implementChange(repoRoot, hypothesis);
      if (!implemented) {
        log("Implementation failed — rolling back");
        rollback(repoRoot, snapshot);
        appendResult(repoRoot, {
          commit: snapshot,
          p50_ms: 0,
          p95_ms: 0,
          delta_pct: 0,
          status: "crash",
          description: `[impl failed] ${hypothesis.summary}`,
        });
        notifyCrash(hypothesis.summary);
        updateLoopState(state, 0, winsThisRun);
        continue;
      }

      // Verify (build + lint + test)
      log("Running verify...");
      if (!runVerify(repoRoot)) {
        log("Verify failed — rolling back");
        rollback(repoRoot, snapshot);
        appendResult(repoRoot, {
          commit: snapshot,
          p50_ms: 0,
          p95_ms: 0,
          delta_pct: 0,
          status: "crash",
          description: `[verify failed] ${hypothesis.summary}`,
        });
        updateLoopState(state, 0, winsThisRun);
        continue;
      }

      // Benchmark
      log("Running benchmark...");
      const after = runBenchmark(repoRoot);
      if (!after) {
        log("Benchmark failed — rolling back");
        rollback(repoRoot, snapshot);
        appendResult(repoRoot, {
          commit: snapshot,
          p50_ms: 0,
          p95_ms: 0,
          delta_pct: 0,
          status: "crash",
          description: `[bench failed] ${hypothesis.summary}`,
        });
        updateLoopState(state, 0, winsThisRun);
        continue;
      }

      // Evaluate
      const { improved, delta_pct } = isImprovement(currentBaseline, after);
      const elapsed = formatDuration(
        Math.round((Date.now() - experimentStart) / 1000),
      );

      if (improved) {
        // WIN — commit and advance
        const sha = commitExperiment(repoRoot, `optimize: ${hypothesis.summary}`);
        log(`WIN: p50 ${currentBaseline.p50_ms}ms → ${after.p50_ms}ms (${delta_pct.toFixed(1)}% improvement) [${elapsed}]`);

        appendResult(repoRoot, {
          commit: sha,
          p50_ms: after.p50_ms,
          p95_ms: after.p95_ms,
          delta_pct,
          status: "keep",
          description: hypothesis.summary,
        });

        notifyWin(
          hypothesis.summary,
          `p50: ${currentBaseline.p50_ms}ms → ${after.p50_ms}ms (${delta_pct.toFixed(1)}%)`,
        );

        currentBaseline = after;
        winsThisRun++;

        // Update state
        const updated = readOptimizeState();
        updated.total_wins++;
        updated.wins_since_pr++;
        updated.current_p50_ms = after.p50_ms;
        updated.total_experiments++;
        writeOptimizeState(updated);

        // Check if we should draft a PR
        if (updated.wins_since_pr >= opts.winsBeforePr) {
          log(`${updated.wins_since_pr} wins accumulated — drafting PR`);
          draftPr(repoRoot, branch, updated);
        }
      } else {
        // DISCARD — rollback
        log(`DISCARD: p50 ${currentBaseline.p50_ms}ms → ${after.p50_ms}ms (${delta_pct.toFixed(1)}%) [${elapsed}]`);
        rollback(repoRoot, snapshot);

        appendResult(repoRoot, {
          commit: snapshot,
          p50_ms: after.p50_ms,
          p95_ms: after.p95_ms,
          delta_pct,
          status: "discard",
          description: hypothesis.summary,
        });

        const updated = readOptimizeState();
        updated.total_experiments++;
        writeOptimizeState(updated);
      }

      // Update dashboard after each experiment
      updateDashboard(readOptimizeState());
    }

    // Final state update
    const finalState = readOptimizeState();
    finalState.status = "idle";
    finalState.last_run_at = new Date().toISOString();
    writeOptimizeState(finalState);

    const totalElapsed = formatDuration(
      Math.round((Date.now() - loopStart) / 1000),
    );
    log(`\nOptimize complete: ${winsThisRun} wins / ${opts.maxExperiments} experiments in ${totalElapsed}`);

    // Final dashboard update
    updateDashboard(finalState);
  } finally {
    releaseOptimizeLock();
  }
}

// ---------------------------------------------------------------------------
// Hypothesis generation — Claude --print mode
// ---------------------------------------------------------------------------

function generateHypothesis(repoRoot: string): Hypothesis | null {
  const programMd = fs.readFileSync(
    path.join(__dirname, "program.md"),
    "utf-8",
  );
  const resultsContext = recentResults(repoRoot);

  const prompt = `You are an autonomous code optimizer. Read the program below and the recent experiment results, then propose ONE specific optimization to try next.

<program>
${programMd}
</program>

<recent_results>
${resultsContext}
</recent_results>

Respond with ONLY a JSON object (no markdown fences, no explanation):
{
  "summary": "one-line description of the change",
  "target_files": ["src/path/to/file.ts"],
  "approach": "detailed description of what to change and how"
}

Rules:
- Do NOT repeat experiments that already failed (check results above)
- Prioritize high-impact targets that haven't been tried
- Be specific about the change — reference actual function names and patterns
- One focused change only`;

  try {
    const result = spawnSync(
      "claude",
      ["--print", "--model", "sonnet"],
      {
        cwd: repoRoot,
        input: prompt,
        encoding: "utf-8",
        timeout: 2 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      },
    );

    const output = (result.stdout ?? "").trim();
    if (!output) return null;

    // Extract JSON from response
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as Hypothesis;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Implementation — Claude headless with bypassPermissions
// ---------------------------------------------------------------------------

function implementChange(repoRoot: string, hypothesis: Hypothesis): boolean {
  const prompt = `You are implementing a specific optimization for the nonprofit-vetting-engine screening pipeline.

## What to do

${hypothesis.summary}

## Approach

${hypothesis.approach}

## Target files

${hypothesis.target_files.map((f) => `- ${f}`).join("\n")}

## Rules

- ONLY modify the files listed above (or closely related files if necessary)
- Do NOT modify test files, config files, scripts/, or benchmark/
- Keep the change minimal and focused
- Preserve the public API — runScreening() return type must not change
- After making changes, run: npm run verify
- If verify fails, fix the issues until it passes`;

  try {
    const result = spawnSync(
      "claude",
      ["--permission-mode", "bypassPermissions", "--model", "sonnet"],
      {
        cwd: repoRoot,
        input: prompt,
        encoding: "utf-8",
        timeout: 10 * 60 * 1000, // 10 min for implementation
        maxBuffer: 5 * 1024 * 1024,
      },
    );

    // Consider it implemented if Claude didn't crash
    return result.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateLoopState(
  _state: ReturnType<typeof readOptimizeState>,
  _delta: number,
  _wins: number,
): void {
  const state = readOptimizeState();
  state.total_experiments++;
  writeOptimizeState(state);
}

// __dirname equivalent for ESM
const __dirname = path.dirname(new URL(import.meta.url).pathname);
