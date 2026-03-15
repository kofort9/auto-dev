/**
 * Dashboard panel for optimize status.
 * Injects an autoresearch panel into the Bonsaei project dashboard.
 */

import fs from "fs";
import path from "path";
import type { OptimizeState } from "./types.js";
import { deltaPercent } from "./results.js";
import { createLogger } from "../log.js";

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const log = createLogger("optimize:dash");

const DASHBOARD_PATH = path.resolve(
  (process.env.HOME ?? "") + "/.agent/diagrams/bonsaei-project-status.html",
);

const PANEL_MARKER_START = "<!-- OPTIMIZE_PANEL_START -->";
const PANEL_MARKER_END = "<!-- OPTIMIZE_PANEL_END -->";

export function updateDashboard(state: OptimizeState): void {
  if (!fs.existsSync(DASHBOARD_PATH)) {
    log("Dashboard file not found — skipping update");
    return;
  }

  const panel = generatePanel(state);

  try {
    let html = fs.readFileSync(DASHBOARD_PATH, "utf-8");

    // Replace existing panel or inject before </body>
    const startIdx = html.indexOf(PANEL_MARKER_START);
    const endIdx = html.indexOf(PANEL_MARKER_END);

    if (startIdx !== -1 && endIdx !== -1) {
      html =
        html.slice(0, startIdx) +
        panel +
        html.slice(endIdx + PANEL_MARKER_END.length);
    } else {
      // Inject before closing body tag
      html = html.replace("</body>", `${panel}\n</body>`);
    }

    fs.writeFileSync(DASHBOARD_PATH, html);
    log("Dashboard updated");
  } catch (err) {
    log(`Dashboard update failed: ${err}`);
  }
}

function generatePanel(state: OptimizeState): string {
  const statusColor =
    state.status === "running"
      ? "#22c55e"
      : state.status === "paused"
        ? "#f59e0b"
        : "#6b7280";

  const statusLabel = state.status.toUpperCase();

  const deltaTotal = deltaPercent(state.baseline_p50_ms, state.current_p50_ms).toFixed(1);

  const winRate =
    state.total_experiments > 0
      ? ((state.total_wins / state.total_experiments) * 100).toFixed(0)
      : "—";

  const prLink = state.last_pr_url
    ? `<a href="${htmlEscape(state.last_pr_url)}" style="color:#60a5fa">${htmlEscape(state.last_pr_url.split("/").pop() ?? "")}</a>`
    : "none";

  const lastRun = state.last_run_at
    ? htmlEscape(new Date(state.last_run_at).toLocaleString())
    : "never";

  return `${PANEL_MARKER_START}
<div style="background:#1e1e2e;border:1px solid #313244;border-radius:8px;padding:16px;margin:12px 0;font-family:monospace;font-size:13px;color:#cdd6f4">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
    <span style="background:${statusColor};width:8px;height:8px;border-radius:50%;display:inline-block"></span>
    <strong style="color:#cdd6f4">Autoresearch Optimize</strong>
    <span style="color:${statusColor};font-size:11px">${htmlEscape(statusLabel)}</span>
  </div>
  <table style="width:100%;border-collapse:collapse;color:#bac2de">
    <tr><td style="padding:2px 8px">p50 latency</td><td style="text-align:right">${state.baseline_p50_ms}ms → <strong style="color:#a6e3a1">${state.current_p50_ms}ms</strong> (${deltaTotal}%)</td></tr>
    <tr><td style="padding:2px 8px">experiments</td><td style="text-align:right">${state.total_experiments}</td></tr>
    <tr><td style="padding:2px 8px">wins</td><td style="text-align:right">${state.total_wins} (${winRate}% win rate)</td></tr>
    <tr><td style="padding:2px 8px">wins since PR</td><td style="text-align:right">${state.wins_since_pr}</td></tr>
    <tr><td style="padding:2px 8px">latest PR</td><td style="text-align:right">${prLink}</td></tr>
    <tr><td style="padding:2px 8px">last run</td><td style="text-align:right;font-size:11px">${lastRun}</td></tr>
  </table>
</div>
${PANEL_MARKER_END}`;
}
