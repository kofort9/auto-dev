/**
 * Shared types for the nightshift job queue system.
 */

export type IssueStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped";

export interface IssueState {
  status: IssueStatus;
  title?: string;
  phase?: string;
  duration_s?: number;
  pr_url?: string;
  reason?: string;
  started_at?: string;
  slot?: number;
  attempts?: number;
  last_failed_phase?: string;
  review_brief_path?: string;
  panel_verdict?: "pass" | "fail" | "conditional";
  token_usage?: { input: number; output: number; cost_usd: number };
}

export interface NightshiftState {
  version?: 2;
  run_id: string;
  issues: Record<string, IssueState>;
}

export interface SummaryRecord {
  issue: number;
  date: string;
  result: string;
  phase_failed: string | null;
  files_changed: number;
  lines_changed: number;
  review_notes: string;
  duration_s: number;
}

export interface NightshiftOptions {
  fresh: boolean;
  dryRun: boolean;
  issueList: number[];
  maxFailures: number;
  concurrency: number;
}

export interface WorkerResult {
  status: "completed" | "failed";
  phase?: string;
  duration_s: number;
  pr_url?: string;
}
