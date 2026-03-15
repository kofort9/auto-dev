/**
 * Benchmark orchestrator for the optimize module.
 *
 * Seeds a benchmark script + corpus onto the optimize branch of TARGET_REPO,
 * then runs it and collects timing results.
 *
 * The actual benchmark runner (benchmark/run-benchmark.ts) lives in the target
 * repo so it can import VE pipeline code directly.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import type { BenchmarkResult } from "./types.js";
import { deltaPercent } from "./results.js";
import { createLogger } from "../log.js";

const log = createLogger("optimize:bench");

const BENCHMARK_DIR = "benchmark";
const CORPUS_FILE = "benchmark/corpus.json";
const RUNNER_FILE = "benchmark/run-benchmark.ts";

// Threshold: improvement must be >= 5% to count as a win
export const IMPROVEMENT_THRESHOLD_PCT = 5;

/** Seed the benchmark infrastructure on the optimize branch (one-time). */
export function seedBenchmark(repoRoot: string): void {
  const benchDir = path.join(repoRoot, BENCHMARK_DIR);
  fs.mkdirSync(benchDir, { recursive: true });

  // Seed corpus if not present
  if (!fs.existsSync(path.join(repoRoot, CORPUS_FILE))) {
    log("Seeding benchmark corpus...");
    seedCorpus(repoRoot);
  }

  // Seed runner script if not present
  if (!fs.existsSync(path.join(repoRoot, RUNNER_FILE))) {
    log("Seeding benchmark runner script...");
    fs.writeFileSync(path.join(repoRoot, RUNNER_FILE), RUNNER_TEMPLATE);
  }
}

/** Run the benchmark and return timing results. */
export function runBenchmark(repoRoot: string): BenchmarkResult | null {
  const outputFile = path.join(repoRoot, BENCHMARK_DIR, "results.json");

  // Clean previous output
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

  try {
    execFileSync("npx", ["tsx", RUNNER_FILE], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10 * 60 * 1000, // 10 min max
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Empty API keys force offline mode — enrichers gracefully skip
        COURTLISTENER_API_TOKEN: "",
        SAM_GOV_API_KEY: "",
        // Keep rate limit fast for benchmarks
        GT_RATE_LIMIT_MS: "0",
      },
    });
  } catch (err) {
    log(`Benchmark run failed: ${err}`);
    return null;
  }

  // Read structured output
  if (!fs.existsSync(outputFile)) {
    log("Benchmark produced no output file");
    return null;
  }

  try {
    const raw = fs.readFileSync(outputFile, "utf-8");
    const parsed = JSON.parse(raw) as Omit<BenchmarkResult, "tests_pass">;
    // tests_pass is set by the orchestrator after running verify, not by the runner
    return { ...parsed, tests_pass: false };
  } catch (err) {
    log(`Failed to parse benchmark output: ${err}`);
    return null;
  }
}

/** Run npm run verify in the target repo. */
export function runVerify(repoRoot: string): boolean {
  try {
    execFileSync("npm", ["run", "verify"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5 * 60 * 1000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Check if the result is a meaningful improvement over baseline. */
export function isImprovement(
  baseline: BenchmarkResult,
  after: BenchmarkResult,
): { improved: boolean; delta_pct: number } {
  const delta_pct = deltaPercent(baseline.p50_ms, after.p50_ms);
  return {
    improved: delta_pct >= IMPROVEMENT_THRESHOLD_PCT && after.tests_pass,
    delta_pct,
  };
}

// ---------------------------------------------------------------------------
// Corpus seeding
// ---------------------------------------------------------------------------

/**
 * Seed benchmark corpus by querying the VE's vetting.db for diverse EINs.
 * Picks 15 EINs with cached results across different recommendations.
 */
function seedCorpus(repoRoot: string): void {
  const dbPath = path.join(repoRoot, "data", "vetting.db");
  if (!fs.existsSync(dbPath)) {
    log("Warning: vetting.db not found — using fallback corpus");
    fs.writeFileSync(
      path.join(repoRoot, CORPUS_FILE),
      JSON.stringify({ eins: [], note: "No vetting.db found — seed manually" }, null, 2),
    );
    return;
  }

  // Use sqlite3 CLI to query diverse EINs from the cache
  try {
    const query = `
      SELECT ein FROM (
        SELECT ein, recommendation, ROW_NUMBER() OVER (PARTITION BY recommendation ORDER BY vetted_at DESC) as rn
        FROM vetting_results
        WHERE gate_blocked = 0 AND result_json IS NOT NULL
      ) WHERE rn <= 5
      ORDER BY recommendation
      LIMIT 15;
    `;
    const result = execFileSync("sqlite3", [dbPath, query], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const eins = result.trim().split("\n").filter(Boolean);

    if (eins.length === 0) {
      log("No EINs found in vetting.db — corpus empty");
    } else {
      log(`Seeded corpus with ${eins.length} EINs`);
    }

    fs.writeFileSync(
      path.join(repoRoot, CORPUS_FILE),
      JSON.stringify({ eins, seeded_at: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    log(`Corpus seeding failed: ${err}`);
    fs.writeFileSync(
      path.join(repoRoot, CORPUS_FILE),
      JSON.stringify({ eins: [], note: "Seeding failed — add EINs manually" }, null, 2),
    );
  }
}

// ---------------------------------------------------------------------------
// Runner template — gets written to TARGET_REPO/benchmark/run-benchmark.ts
// ---------------------------------------------------------------------------

const RUNNER_TEMPLATE = `/**
 * Benchmark runner for nightshift optimize.
 * Lives on the optimize branch of the VE repo.
 * Runs screenings against cached data and outputs timing metrics.
 *
 * Usage: npx tsx benchmark/run-benchmark.ts
 * Output: benchmark/results.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initPipeline } from "../scripts/lib/pipeline-factory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_FILE = path.join(__dirname, "corpus.json");
const OUTPUT_FILE = path.join(__dirname, "results.json");

async function main() {
  // Load corpus
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, "utf-8"));
  const eins: string[] = corpus.eins;

  if (eins.length === 0) {
    console.error("No EINs in corpus — seed first");
    process.exit(1);
  }

  console.log(\`Benchmarking \${eins.length} EINs...\`);

  // Initialize pipeline (uses cached SQLite data)
  const { pipeline, cleanup } = await initPipeline({ rateLimitMs: 0 });

  const timings: number[] = [];

  for (const ein of eins) {
    const start = performance.now();
    try {
      await pipeline.runScreening(ein, { forceRefresh: false });
    } catch (err) {
      console.error(\`EIN \${ein} failed: \${err}\`);
    }
    const elapsed = performance.now() - start;
    timings.push(elapsed);
    console.log(\`  \${ein}: \${elapsed.toFixed(0)}ms\`);
  }

  cleanup();

  // Calculate percentiles
  const sorted = [...timings].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

  const result = {
    p50_ms: Math.round(p50),
    p95_ms: Math.round(p95),
    mean_ms: Math.round(mean),
    individual_ms: timings.map((t) => Math.round(t)),
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(\`\\nResults: p50=\${result.p50_ms}ms p95=\${result.p95_ms}ms mean=\${result.mean_ms}ms\`);
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
`;
