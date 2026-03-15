/**
 * Types for the nightshift optimize (autoresearch) module.
 */

export interface OptimizeOptions {
  maxExperiments: number;
  winsBeforePr: number;
  dryRun: boolean;
}

export interface OptimizeState {
  status: "idle" | "running" | "paused" | "conflict";
  branch: string;
  baseline_p50_ms: number;
  current_p50_ms: number;
  total_experiments: number;
  total_wins: number;
  wins_since_pr: number;
  last_pr_url?: string;
  last_run_at?: string;
  pause_reason?: string;
}

export interface ExperimentRow {
  commit: string;
  p50_ms: number;
  p95_ms: number;
  delta_pct: number;
  status: "keep" | "discard" | "crash";
  description: string;
}

export interface BenchmarkResult {
  p50_ms: number;
  p95_ms: number;
  mean_ms: number;
  individual_ms: number[];
  tests_pass: boolean;
}

export interface Hypothesis {
  summary: string;
  target_files: string[];
  approach: string;
}
