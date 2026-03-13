/**
 * Compiles heterogeneous agent outputs into a unified ReviewBrief.
 *
 * 4-pass compilation:
 * 1. Parse — extract AgentFinding[] from each AgentResult
 * 2. Normalize — map confidence to standard scale, discard below threshold
 * 3. Deduplicate — key on file:line_range:keyword_hash, boost multi-agent agreement
 * 4. Classify — determine panel verdict from unanimous agent decisions
 */

import fs from "fs";
import path from "path";
import type {
  AgentName,
  AgentResult,
  AgentFinding,
  ReviewBrief,
} from "./review-types.js";
import { getStateDir } from "./state.js";

const CONFIDENCE_THRESHOLD = 80;

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// Pricing per 1M tokens (approximate, for cost estimation)
const PRICING: Record<string, { input: number; output: number }> = {
  sonnet: { input: 3.0, output: 15.0 },
  opus: { input: 15.0, output: 75.0 },
};

export function compileBrief(
  issueNumber: number,
  spec: string,
  filesChanged: string[],
  results: AgentResult[],
  skipped: { name: AgentName; reason: string }[],
): ReviewBrief {
  // Pass 1: Collect all findings (already parsed by agent-runner)
  const allFindings = results.flatMap((r) => r.findings);

  // Pass 2: Deduplicate FIRST — multi-agent agreement boosts confidence (+10)
  // This must happen before threshold filtering so that a 72-confidence finding
  // flagged by two agents gets boosted to 82 and survives the threshold.
  const deduplicated = deduplicateFindings(allFindings);

  // Pass 3: Normalize and filter — discard below confidence threshold
  const filtered = normalizeConfidence(deduplicated);

  // Sort: critical first, then by confidence desc
  filtered.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.confidence - a.confidence;
  });

  // Pass 4: Classify verdict
  const { verdict, failReasons, humanAttention } = classifyVerdict(
    results,
    filtered,
  );

  // Token totals
  const totalTokens = results.reduce(
    (acc, r) => ({
      input: acc.input + r.token_usage.input,
      output: acc.output + r.token_usage.output,
    }),
    { input: 0, output: 0 },
  );

  const estimatedCost = results.reduce((acc, r) => {
    const pricing = PRICING[r.model] ?? PRICING.sonnet;
    return (
      acc +
      (r.token_usage.input / 1_000_000) * pricing.input +
      (r.token_usage.output / 1_000_000) * pricing.output
    );
  }, 0);

  const brief: ReviewBrief = {
    version: 1,
    issue_number: issueNumber,
    date: new Date().toISOString(),
    spec_summary: spec.slice(0, 500),
    files_changed: filesChanged,
    scope_fence: [], // TODO: derive from spec if "do not change" sections exist

    agents_invoked: results.map((r) => r.agent),
    agents_skipped: skipped,
    results,

    findings: filtered,
    actionable_count: filtered.filter(
      (f) => f.category === "actionable" || f.category === "security",
    ).length,
    tradeoff_count: filtered.filter((f) => f.category === "tradeoff").length,
    blocker_count: filtered.filter(
      (f) =>
        (f.severity === "critical" || f.severity === "high") &&
        f.confidence >= CONFIDENCE_THRESHOLD,
    ).length,

    panel_verdict: verdict,
    fail_reasons: failReasons,
    human_attention: humanAttention,

    total_tokens: totalTokens,
    estimated_cost_usd: Math.round(estimatedCost * 100) / 100,
  };

  return brief;
}

/** Write the full brief to ~/.auto-dev/runs/{date}-{N}-review-brief.md */
export function writeBrief(brief: ReviewBrief): string {
  const date = new Date().toISOString().split("T")[0];
  const runsDir = path.join(getStateDir(), "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const briefPath = path.join(
    runsDir,
    `${date}-${brief.issue_number}-review-brief.md`,
  );

  const md = formatBriefMarkdown(brief);
  fs.writeFileSync(briefPath, md);
  return briefPath;
}

// ---------------------------------------------------------------------------
// Pass 2: Normalize confidence
// ---------------------------------------------------------------------------

function normalizeConfidence(findings: AgentFinding[]): AgentFinding[] {
  return findings
    .map((f) => ({
      ...f,
      // Normalize priority-based confidence if agent used P0/P1/P2/P3
      confidence: clampConfidence(f.confidence),
    }))
    .filter((f) => f.confidence >= CONFIDENCE_THRESHOLD);
}

function clampConfidence(c: number): number {
  if (c < 0) return 0;
  if (c > 100) return 100;
  return c;
}

// ---------------------------------------------------------------------------
// Pass 3: Deduplicate
// ---------------------------------------------------------------------------

function deduplicateFindings(findings: AgentFinding[]): AgentFinding[] {
  const groups = new Map<string, AgentFinding[]>();

  for (const f of findings) {
    // Key: file + approximate line range + lowercase title keywords
    const lineRange = f.line ? `${Math.floor(f.line / 10) * 10}` : "0";
    const keywords = f.title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .sort()
      .join(",");
    const key = `${f.file}:${lineRange}:${keywords}`;

    const existing = groups.get(key);
    if (existing) {
      existing.push(f);
    } else {
      groups.set(key, [f]);
    }
  }

  const result: AgentFinding[] = [];
  for (const group of groups.values()) {
    // Keep the highest severity finding
    group.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );

    const best = { ...group[0] };

    // Boost confidence +10 when multiple agents agree (capped at 100)
    if (group.length > 1) {
      best.confidence = Math.min(100, best.confidence + 10);
    }

    result.push(best);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pass 4: Classify verdict
// ---------------------------------------------------------------------------

function classifyVerdict(
  results: AgentResult[],
  findings: AgentFinding[],
): {
  verdict: "pass" | "fail" | "conditional";
  failReasons: string[];
  humanAttention: string[];
} {
  const failReasons: string[] = [];
  const humanAttention: string[] = [];

  // Any agent with request_changes AND findings with confidence ≥ 80 → FAIL
  for (const r of results) {
    if (r.verdict === "request_changes") {
      const highConfFindings = r.findings.filter(
        (f) =>
          f.confidence >= CONFIDENCE_THRESHOLD &&
          (f.severity === "critical" || f.severity === "high"),
      );
      if (highConfFindings.length > 0) {
        failReasons.push(
          `${r.agent}: ${highConfFindings.length} high-confidence blocker(s)`,
        );
      }
    }
  }

  // Collect items needing human attention
  for (const f of findings) {
    if (f.category === "tradeoff") {
      humanAttention.push(
        `#${f.id} Tradeoff: ${f.title}${f.recommendation ? `. Recommendation: ${f.recommendation}` : ""}`,
      );
    }
    if (f.category === "question") {
      humanAttention.push(`#${f.id} Question: ${f.title}`);
    }
  }

  if (failReasons.length > 0) {
    return { verdict: "fail", failReasons, humanAttention };
  }

  if (humanAttention.length > 0) {
    return { verdict: "conditional", failReasons: [], humanAttention };
  }

  return { verdict: "pass", failReasons: [], humanAttention: [] };
}

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

function formatBriefMarkdown(brief: ReviewBrief): string {
  const lines: string[] = [];

  lines.push(`## Nightshift Review Panel`);
  lines.push("");
  lines.push(
    `**Verdict**: ${brief.panel_verdict.toUpperCase()} | **Issue**: #${brief.issue_number} | **Date**: ${brief.date}`,
  );

  // Agents
  const agentStatus = brief.agents_invoked
    .map((a) => {
      const r = brief.results.find((result) => result.agent === a);
      let icon = "~";
      if (r?.verdict === "approve") icon = "✓";
      else if (r?.verdict === "request_changes") icon = "✗";
      return `${a} ${icon}`;
    })
    .join(" | ");
  lines.push(`**Agents**: ${agentStatus}`);

  if (brief.agents_skipped.length > 0) {
    const skipped = brief.agents_skipped
      .map((s) => `${s.name} (${s.reason})`)
      .join(" | ");
    lines.push(`**Skipped**: ${skipped}`);
  }
  lines.push("");

  // Findings summary
  const fixed = brief.findings.filter(
    (f) => f.category === "actionable",
  ).length;
  const tradeoffs = brief.tradeoff_count;
  const questions = brief.findings.filter(
    (f) => f.category === "question",
  ).length;
  lines.push(
    `### Findings: ${brief.findings.length} total → ${fixed} actionable, ${tradeoffs} tradeoff${tradeoffs !== 1 ? "s" : ""}, ${questions} question${questions !== 1 ? "s" : ""}`,
  );
  lines.push("");

  // Findings table
  if (brief.findings.length > 0) {
    lines.push("| # | Sev | Category | File | Title | Status |");
    lines.push("|---|-----|----------|------|-------|--------|");
    for (const f of brief.findings) {
      const fileLoc = f.line ? `${f.file}:${f.line}` : f.file;
      let status = "To fix";
      if (f.category === "tradeoff") status = "Needs decision";
      else if (f.category === "question") status = "Needs answer";
      lines.push(
        `| ${f.id} | ${f.severity} | ${f.category} | ${fileLoc} | ${f.title} | ${status} |`,
      );
    }
    lines.push("");
  }

  // Human attention
  if (brief.human_attention.length > 0) {
    lines.push("### Needs Your Decision");
    for (const item of brief.human_attention) {
      lines.push(`- [ ] **${item}**`);
    }
    lines.push("");
  }

  // Fail reasons
  if (brief.fail_reasons.length > 0) {
    lines.push("### Blockers");
    for (const reason of brief.fail_reasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  // Token usage
  lines.push("### Token Usage");
  lines.push(
    `Input: ${brief.total_tokens.input.toLocaleString()} | Output: ${brief.total_tokens.output.toLocaleString()} | Est: $${brief.estimated_cost_usd.toFixed(2)}`,
  );
  lines.push("");

  // Per-agent details
  lines.push("<details><summary>Per-agent details</summary>");
  lines.push("");
  for (const r of brief.results) {
    lines.push(
      `**${r.agent}** (${r.model}) — ${r.verdict} — ${r.findings.length} findings — ${Math.round(r.duration_ms / 1000)}s`,
    );
  }
  lines.push("");
  lines.push("</details>");

  return lines.join("\n") + "\n";
}
