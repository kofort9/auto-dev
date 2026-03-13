/**
 * Morning summary generator — reads state file and produces a markdown report.
 */

import fs from "fs";
import path from "path";
import type { NightshiftState } from "./types.js";
import { getStateDir } from "./state.js";
import { formatDuration } from "./log.js";

export function generateSummary(
  state: NightshiftState,
  startTs: number,
  endTs: number,
): string {
  const date = new Date().toISOString().split("T")[0];
  const totalS = Math.round((endTs - startTs) / 1000);
  const startTime = new Date(startTs).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const endTime = new Date(endTs).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const entries = Object.entries(state.issues).sort(
    ([a], [b]) => parseInt(a) - parseInt(b),
  );

  const counts = { completed: 0, failed: 0, skipped: 0, total: entries.length };
  for (const [, issue] of entries) {
    if (issue.status === "completed") counts.completed++;
    else if (issue.status === "failed") counts.failed++;
    else if (issue.status === "skipped") counts.skipped++;
  }

  const lines: string[] = [];
  lines.push(`# Nightshift Summary — ${date}`);
  lines.push(
    `Started: ${startTime} | Finished: ${endTime} | Duration: ${formatDuration(totalS)}`,
  );
  lines.push("");
  lines.push("## Results");

  for (const [num, issue] of entries) {
    switch (issue.status) {
      case "completed": {
        const prDisplay = issue.pr_url
          ? ` → PR #${issue.pr_url.match(/\d+$/)?.[0] ?? ""}`
          : "";
        const panelDisplay = issue.panel_verdict
          ? ` [panel: ${issue.panel_verdict}]`
          : "";
        lines.push(
          `✅ #${num} (${formatDuration(issue.duration_s ?? 0)})${panelDisplay}${prDisplay}`,
        );
        break;
      }
      case "failed":
        lines.push(
          `❌ #${num} — failed at ${issue.phase ?? "unknown"} (${formatDuration(issue.duration_s ?? 0)})`,
        );
        break;
      case "skipped":
        lines.push(
          `⏭️ #${num} — skipped (${issue.reason ?? "circuit breaker"})`,
        );
        break;
      default:
        lines.push(`⬜ #${num} — ${issue.status}`);
    }
  }

  lines.push("");
  lines.push("## Totals");
  lines.push(
    `Completed: ${counts.completed}/${counts.total} | Failed: ${counts.failed} | Skipped: ${counts.skipped}`,
  );

  // Triage section (from phases 10-12 self-review)
  const triaged = entries.filter(([, i]) => i.self_review_status);
  if (triaged.length > 0) {
    lines.push("");
    lines.push("## Triage");

    const autoApproved = triaged
      .filter(([, i]) => i.self_review_status === "auto_approved")
      .map(([n]) => `#${n}`);
    const selfFixed = triaged
      .filter(([, i]) => i.self_review_status === "self_fixed")
      .map(([n, i]) => `#${n} (${i.self_review_iterations ?? 0} iteration(s))`);
    const needsHuman = triaged
      .filter(([, i]) => i.self_review_status === "needs_human")
      .map(([n, i]) => `#${n} (${i.triage_reason ?? "review findings"})`);
    const reviewFailed = triaged
      .filter(([, i]) => i.self_review_status === "review_failed")
      .map(([n]) => `#${n}`);

    if (autoApproved.length > 0)
      lines.push(`✅ Auto-approved: ${autoApproved.join(", ")}`);
    if (selfFixed.length > 0)
      lines.push(`🔄 Self-fixed: ${selfFixed.join(", ")}`);
    if (needsHuman.length > 0)
      lines.push(`⚠️  Needs human: ${needsHuman.join(", ")}`);
    if (reviewFailed.length > 0)
      lines.push(`❌ Review failed: ${reviewFailed.join(", ")}`);
  } else {
    // Fallback: no self-review ran, show old-style PR list
    const prNums = entries
      .filter(([, i]) => i.status === "completed" && i.pr_url)
      .map(([, i]) => `#${i.pr_url!.match(/\d+$/)?.[0] ?? ""}`)
      .join(", ");
    if (prNums) lines.push(`PRs to review: ${prNums}`);
  }

  // Token usage totals
  const totalTokens = entries.reduce(
    (acc, [, issue]) => {
      if (issue.token_usage) {
        acc.input += issue.token_usage.input;
        acc.output += issue.token_usage.output;
        acc.cost += issue.token_usage.cost_usd;
      }
      return acc;
    },
    { input: 0, output: 0, cost: 0 },
  );
  if (totalTokens.input > 0) {
    lines.push("");
    lines.push("## Token Usage");
    lines.push(
      `Input: ${totalTokens.input.toLocaleString()} | Output: ${totalTokens.output.toLocaleString()} | Est: $${totalTokens.cost.toFixed(2)}`,
    );
  }

  // Review brief links
  const briefs = entries
    .filter(([, i]) => i.review_brief_path)
    .map(([num, i]) => `- #${num}: ${i.review_brief_path}`);
  if (briefs.length > 0) {
    lines.push("");
    lines.push("## Review Briefs");
    lines.push(...briefs);
  }

  return lines.join("\n") + "\n";
}

export function writeSummary(content: string): string {
  const date = new Date().toISOString().split("T")[0];
  const summaryPath = path.join(getStateDir(), `nightshift-summary-${date}.md`);
  fs.writeFileSync(summaryPath, content);
  return summaryPath;
}
