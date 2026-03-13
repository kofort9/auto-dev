/**
 * Conditional agent selection based on changed files.
 *
 * Pure function: no I/O, no side effects. Given a list of changed file paths,
 * decides which review agents to invoke. Three agents always run; two are
 * conditional on file patterns that indicate security or ML/scoring relevance.
 */

import type { AgentName } from "./review-types.js";

export interface RouterDecision {
  toRun: AgentName[];
  skipped: { name: AgentName; reason: string }[];
}

const SECURITY_PATTERN =
  /auth|session|token|password|api\/|middleware|sanitiz|validat|\.env|secret|key/i;

const ML_PATTERN =
  /scor(e|ing)|similar|threshold|weight|confidence|classif|pipeline\/|financial|sector-threshold/i;

/** Always-on agents that run for every PR. */
const ALWAYS_RUN: AgentName[] = [
  "code-reviewer",
  "spec-compliance-checker",
  "test-coverage-checker",
  "scope-checker",
];

/** Conditional agents with their trigger patterns. */
const CONDITIONAL: { name: AgentName; pattern: RegExp; label: string }[] = [
  { name: "red-team", pattern: SECURITY_PATTERN, label: "security files" },
  { name: "ml-specialist", pattern: ML_PATTERN, label: "scoring files" },
];

export function selectAgents(changedFiles: string[]): RouterDecision {
  const toRun: AgentName[] = [...ALWAYS_RUN];
  const skipped: RouterDecision["skipped"] = [];

  for (const { name, pattern, label } of CONDITIONAL) {
    const triggered = changedFiles.some((f) => pattern.test(f));
    if (triggered) {
      toRun.push(name);
    } else {
      skipped.push({ name, reason: `no ${label}` });
    }
  }

  return { toRun, skipped };
}
