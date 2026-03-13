/**
 * Shared types for the panel review system.
 *
 * These types flow through: agent-router → agent-runner → review-brief → panel-review.
 * The ReviewBrief is the persistent artifact that survives across phases
 * (fix, re-verify, publish) and gets posted as a PR comment.
 */

export type AgentName =
  | "code-reviewer"
  | "red-team"
  | "ml-specialist"
  | "spec-compliance-checker"
  | "test-coverage-checker";

export type FindingCategory =
  | "actionable"
  | "style"
  | "tradeoff"
  | "question"
  | "false_positive"
  | "security"
  | "spec_gap"
  | "test_gap";

export interface AgentFinding {
  id: string; // "cr-001", "rt-001"
  agent: AgentName;
  category: FindingCategory;
  severity: "critical" | "high" | "medium" | "low";
  confidence: number; // 0-100
  file: string;
  line?: number;
  title: string;
  description: string;
  fix?: string;
  effort?: "trivial" | "small" | "medium";
  options?: string[]; // for tradeoffs
  recommendation?: string;
}

export interface AgentResult {
  agent: AgentName;
  model: string;
  verdict: "approve" | "request_changes" | "comment";
  findings: AgentFinding[];
  summary: string;
  duration_ms: number;
  token_usage: { input: number; output: number };
  raw_output: string;
}

export interface ReviewBrief {
  version: 1;
  issue_number: number;
  date: string;
  spec_summary: string;
  files_changed: string[];
  scope_fence: string[]; // "DO NOT change these files"

  agents_invoked: AgentName[];
  agents_skipped: { name: AgentName; reason: string }[];
  results: AgentResult[];

  findings: AgentFinding[]; // deduplicated, scored, sorted
  actionable_count: number;
  tradeoff_count: number;
  blocker_count: number;

  panel_verdict: "pass" | "fail" | "conditional";
  fail_reasons: string[];
  human_attention: string[]; // items for morning decision

  total_tokens: { input: number; output: number };
  estimated_cost_usd: number;
}

/** Sentinel JSON written by auto-dev.sh after Phase 5 (verify) passes. */
export interface SentinelData {
  issue: number;
  worktree: string;
  branch: string;
  spec: string;
  files_changed: string[];
  lines_changed: number;
  files_count: number;
}
