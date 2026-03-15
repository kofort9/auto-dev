/**
 * macOS notifications for optimize events.
 * Uses osascript for native notification center integration.
 */

import { execFileSync } from "child_process";
import { createLogger } from "../log.js";

const log = createLogger("optimize:notify");

export function notifyWin(description: string, delta: string): void {
  send("Optimization Win", `${description}\n${delta}`);
}

export function notifyConflict(): void {
  send("Rebase Conflict", "Optimize paused — manual rebase needed on autoresearch/optimize");
}

export function notifyPrDrafted(url: string): void {
  send("PR Drafted", `Optimization PR ready for review:\n${url}`);
}

export function notifyCrash(description: string): void {
  send("Experiment Crashed", description);
}

function send(title: string, body: string): void {
  try {
    execFileSync("osascript", [
      "-e",
      `display notification "${escape(body)}" with title "${escape(title)}" subtitle "nightshift optimize"`,
    ]);
  } catch (err) {
    log(`Notification failed: ${err}`);
  }
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
