/**
 * Atomic state persistence for the optimize module.
 * Mirrors nightshift's state.ts pattern: tmp file + rename for crash safety.
 */

import fs from "fs";
import path from "path";
import type { OptimizeState } from "./types.js";

const STATE_DIR = path.resolve(
  (process.env.STATE_DIR ?? "~/.auto-dev").replace(/^~/, process.env.HOME ?? ""),
);
const STATE_FILE = path.join(STATE_DIR, "optimize-state.json");
const LOCK_FILE = path.join(STATE_DIR, "optimize.lock");

const DEFAULT_STATE: OptimizeState = {
  status: "idle",
  branch: "autoresearch/optimize",
  baseline_p50_ms: 0,
  current_p50_ms: 0,
  total_experiments: 0,
  total_wins: 0,
  wins_since_pr: 0,
};

export function readOptimizeState(): OptimizeState {
  if (!fs.existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as OptimizeState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeOptimizeState(state: OptimizeState): void {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
}

export function acquireOptimizeLock(): boolean {
  try {
    const fd = fs.openSync(
      LOCK_FILE,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch {
    // Check for stale lock
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (pid && isAlive(pid)) return false;
      // Stale — reclaim
      fs.unlinkSync(LOCK_FILE);
      const fd = fs.openSync(
        LOCK_FILE,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }
}

export function releaseOptimizeLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Already gone
  }
}

export function isPaused(): boolean {
  return fs.existsSync(path.join(STATE_DIR, "optimize-paused.json"));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
