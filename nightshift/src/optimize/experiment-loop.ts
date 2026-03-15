/**
 * Core experiment loop for nightshift optimize.
 * Autoresearch pattern: hypothesis → implement → benchmark → keep/discard → repeat.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import type {
  OptimizeOptions,
  OptimizeState,
  BenchmarkResult,
  ExperimentRow,
  Hypothesis,
} from "./types.js";
import {
  readOptimizeState,
  writeOptimizeState,
  acquireOptimizeLock,
  releaseOptimizeLock,
  isPaused,
  getOptimizeStateDir,
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
import { initResultsTsv, appendResult, readResults, formatRecentRows } from "./results.js";
import {
  notifyWin,
  notifyConflict,
  notifyCrash,
} from "./notify.js";
import { draftPr } from "./pr.js";
import { updateDashboard } from "./dashboard.js";
import { createLogger, formatDuration } from "../log.js";

// __dirname equivalent for ESM (must be at module scope, not after first use)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = createLogger("optimize:loop");

/** Max description length stored in results.tsv to limit prompt injection surface. */
const MAX_DESCRIPTION_LEN = 120;

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
      fs.writeFileSync(
        path.join(getOptimizeStateDir(), "optimize-paused.json"),
        JSON.stringify({ reason: "rebase_conflict", at: new Date().toISOString() }),
      );
      return;
    }

    // Seed benchmark infrastructure (one-time)
    seedBenchmark(repoRoot);
    initResultsTsv(repoRoot);

    // Read program.md once — passed to all hypothesis calls
    let programMd: string;
    try {
      programMd = fs.readFileSync(path.join(__dirname, "program.md"), "utf-8");
    } catch (err) {
      log(`Failed to read program.md: ${err} — cannot run optimize loop`);
      return;
    }

    // In-memory results buffer seeded from disk (cross-run history for LLM context)
    const rows: ExperimentRow[] = readResults(repoRoot);

    // Establish baseline
    log("Running baseline benchmark...");
    const baselineBench = runBenchmark(repoRoot);
    if (!baselineBench) {
      log("Baseline benchmark failed — cannot proceed");
      return;
    }
    // Orchestrator controls tests_pass — verify must pass for baseline
    const baseline: BenchmarkResult = { ...baselineBench, tests_pass: runVerify(repoRoot) };
    log(`Baseline: p50=${baseline.p50_ms}ms p95=${baseline.p95_ms}ms`);

    // Update state — preserve original baseline across runs
    state.status = "running";
    if (state.baseline_p50_ms <= 0) state.baseline_p50_ms = baseline.p50_ms;
    state.current_p50_ms = baseline.p50_ms;
    state.last_run_at = new Date().toISOString();
    writeOptimizeState(state);

    let currentBaseline = baseline;
    let winsThisRun = 0;

    // Experiment loop
    for (let i = 0; i < opts.maxExperiments; i++) {
      const experimentStart = Date.now();
      log(`\n--- Experiment ${i + 1}/${opts.maxExperiments} ---`);

      // Snapshot current state
      const snapshot = snapshotSha(repoRoot);

      // Generate hypothesis using in-memory results
      log("Generating hypothesis...");
      const hypothesis = generateHypothesis(repoRoot, programMd, formatRecentRows(rows));
      if (!hypothesis) {
        log("Failed to generate hypothesis — skipping");
        continue;
      }
      log(`Hypothesis: ${hypothesis.summary}`);

      // Validate target_files — reject paths outside src/
      if (!validateTargetFiles(hypothesis.target_files)) {
        log("Hypothesis targets files outside src/ — rejecting");
        recordCrash(repoRoot, rows, snapshot, "bad targets", hypothesis.summary);
        finishExperiment(state);
        continue;
      }

      // Implement the change
      log("Implementing change...");
      const implemented = implementChange(repoRoot, hypothesis);
      if (!implemented) {
        log("Implementation failed — rolling back");
        rollback(repoRoot, snapshot);
        recordCrash(repoRoot, rows, snapshot, "impl failed", hypothesis.summary);
        notifyCrash(hypothesis.summary);
        finishExperiment(state);
        continue;
      }

      // Verify (build + lint + test)
      log("Running verify...");
      const testsPass = runVerify(repoRoot);
      if (!testsPass) {
        log("Verify failed — rolling back");
        rollback(repoRoot, snapshot);
        recordCrash(repoRoot, rows, snapshot, "verify failed", hypothesis.summary);
        finishExperiment(state);
        continue;
      }

      // Benchmark
      log("Running benchmark...");
      const benchResult = runBenchmark(repoRoot);
      if (!benchResult) {
        log("Benchmark failed — rolling back");
        rollback(repoRoot, snapshot);
        recordCrash(repoRoot, rows, snapshot, "bench failed", hypothesis.summary);
        finishExperiment(state);
        continue;
      }

      // Orchestrator sets tests_pass (not the runner template)
      const after: BenchmarkResult = { ...benchResult, tests_pass: testsPass };

      // Evaluate
      const { improved, delta_pct } = isImprovement(currentBaseline, after);
      const elapsed = formatDuration(
        Math.round((Date.now() - experimentStart) / 1000),
      );

      if (improved) {
        // WIN — commit and advance
        const safeSummary = hypothesis.summary.replace(/[\n\r]/g, " ").slice(0, MAX_DESCRIPTION_LEN);
        const sha = commitExperiment(repoRoot, `optimize: ${safeSummary}`);
        log(`WIN: p50 ${currentBaseline.p50_ms}ms → ${after.p50_ms}ms (${delta_pct.toFixed(1)}% improvement) [${elapsed}]`);

        const winRow: ExperimentRow = {
          commit: sha,
          p50_ms: after.p50_ms,
          p95_ms: after.p95_ms,
          delta_pct,
          status: "keep",
          description: truncateDesc(hypothesis.summary),
        };
        appendResult(repoRoot, winRow);
        rows.push(winRow);

        notifyWin(
          hypothesis.summary,
          `p50: ${currentBaseline.p50_ms}ms → ${after.p50_ms}ms (${delta_pct.toFixed(1)}%)`,
        );

        currentBaseline = after;
        winsThisRun++;

        state.total_wins++;
        state.wins_since_pr++;
        state.current_p50_ms = after.p50_ms;

        // Check if we should draft a PR
        if (state.wins_since_pr >= opts.winsBeforePr) {
          log(`${state.wins_since_pr} wins accumulated — drafting PR`);
          draftPr(repoRoot, branch, state);
        }
      } else {
        // DISCARD — rollback
        log(`DISCARD: p50 ${currentBaseline.p50_ms}ms → ${after.p50_ms}ms (${delta_pct.toFixed(1)}%) [${elapsed}]`);
        rollback(repoRoot, snapshot);

        const discardRow: ExperimentRow = {
          commit: snapshot,
          p50_ms: after.p50_ms,
          p95_ms: after.p95_ms,
          delta_pct,
          status: "discard",
          description: truncateDesc(hypothesis.summary),
        };
        appendResult(repoRoot, discardRow);
        rows.push(discardRow);
      }

      // All paths: increment experiments, persist, update dashboard
      finishExperiment(state);
    }

    // Final state update
    state.status = "idle";
    state.last_run_at = new Date().toISOString();
    writeOptimizeState(state);

    const totalElapsed = formatDuration(
      Math.round((Date.now() - loopStart) / 1000),
    );
    log(`\nOptimize complete: ${winsThisRun} wins / ${opts.maxExperiments} experiments in ${totalElapsed}`);
  } finally {
    releaseOptimizeLock();
  }
}

// ---------------------------------------------------------------------------
// Hypothesis generation — Claude --print mode
// ---------------------------------------------------------------------------

function generateHypothesis(repoRoot: string, programMd: string, resultsContext: string): Hypothesis | null {

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
- One focused change only
- target_files MUST be relative paths starting with src/`;

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

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!isValidHypothesis(parsed)) {
      log("Hypothesis failed schema validation");
      return null;
    }
    return parsed;
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

- ONLY modify the files listed above (or closely related files in src/)
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

    if (result.status !== 0) {
      log(`Implementation exited with code ${result.status}: ${(result.stderr ?? "").slice(-500)}`);
    }

    return result.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Type guard for hypothesis JSON from LLM output. */
function isValidHypothesis(h: unknown): h is Hypothesis {
  return (
    typeof h === "object" &&
    h !== null &&
    typeof (h as Record<string, unknown>).summary === "string" &&
    Array.isArray((h as Record<string, unknown>).target_files) &&
    ((h as Record<string, unknown>).target_files as unknown[]).every(
      (f: unknown) => typeof f === "string",
    ) &&
    typeof (h as Record<string, unknown>).approach === "string"
  );
}

/** Validate that all target files are relative paths within src/. */
function validateTargetFiles(files: string[]): boolean {
  for (const f of files) {
    if (path.isAbsolute(f) || f.includes("..") || !f.startsWith("src/")) {
      log(`Rejected target file: ${f}`);
      return false;
    }
  }
  return files.length > 0;
}

/** Truncate description for results.tsv (limits prompt injection surface). */
function truncateDesc(s: string): string {
  // Strip XML-like tags that could be used for prompt injection
  const cleaned = s.replace(/<[^>]*>/g, "").trim();
  return cleaned.length > MAX_DESCRIPTION_LEN
    ? cleaned.slice(0, MAX_DESCRIPTION_LEN) + "..."
    : cleaned;
}

/** Persist experiment count, write state, update dashboard — called once per iteration. */
function finishExperiment(state: OptimizeState): void {
  state.total_experiments++;
  writeOptimizeState(state);
  updateDashboard(state);
}

/** Record a crash result: append to TSV + in-memory buffer. */
function recordCrash(
  repoRoot: string,
  rows: ExperimentRow[],
  snapshot: string,
  reason: string,
  summary: string,
): void {
  const row: ExperimentRow = {
    commit: snapshot,
    p50_ms: 0,
    p95_ms: 0,
    delta_pct: 0,
    status: "crash",
    description: truncateDesc(`[${reason}] ${summary}`),
  };
  appendResult(repoRoot, row);
  rows.push(row);
}
