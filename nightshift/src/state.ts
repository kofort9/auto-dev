/**
 * Atomic state file management for nightshift.
 * Reads/writes ~/.auto-dev/nightshift-state.json with crash-safe tmp+mv pattern.
 *
 * All writes go through an async mutex to prevent concurrent workers
 * from clobbering each other's state updates.
 */

import fs from "fs";
import path from "path";
import type { NightshiftState, IssueState } from "./types.js";

const STATE_DIR = path.resolve(
  (process.env.STATE_DIR ?? "~/.auto-dev").replace(/^~/, process.env.HOME ?? ""),
);
const STATE_FILE = path.join(STATE_DIR, "nightshift-state.json");

// Async mutex: serializes all state writes through a Promise chain
let writeLock = Promise.resolve();

export function ensureStateDir(): void {
  fs.mkdirSync(path.join(STATE_DIR, "runs"), { recursive: true });
}

export function readState(): NightshiftState {
  if (!fs.existsSync(STATE_FILE)) {
    return { run_id: "", issues: {} };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw) as NightshiftState;
  } catch (err) {
    console.error(
      `[nightshift] Warning: corrupt state file, using empty state: ${err}`,
    );
    return { run_id: "", issues: {} };
  }
}

/** Atomic write: write to .tmp, then rename (survives crash mid-write) */
export function writeState(state: NightshiftState): void {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * Serialized state update. Queues a read-modify-write through the mutex
 * so concurrent workers never see stale state.
 */
export async function updateIssueAsync(
  number: string,
  status: IssueState["status"],
  extra?: Partial<IssueState>,
): Promise<void> {
  // Capture the current tail BEFORE assigning, so the chain is extended atomically
  const prev = writeLock;
  writeLock = prev.then(() => {
    const state = readState();
    state.issues[number] = {
      ...(state.issues[number] ?? {}),
      ...extra,
      status,
    };
    writeState(state);
  });
  await writeLock;
}

/** Wait for all pending async writes to flush */
export async function flushWrites(): Promise<void> {
  await writeLock;
}

/** Synchronous version for non-concurrent code paths (startup, cleanup) */
export function updateIssue(
  number: string,
  status: IssueState["status"],
  extra?: Partial<IssueState>,
): void {
  const state = readState();
  state.issues[number] = {
    ...(state.issues[number] ?? {}),
    ...extra,
    status,
  };
  writeState(state);
}

/** Reset any in_progress issues back to pending (for crash recovery) */
export function resetInProgress(): void {
  const state = readState();
  let changed = false;
  for (const [num, issue] of Object.entries(state.issues)) {
    if (issue.status === "in_progress") {
      state.issues[num] = { ...issue, status: "pending" };
      changed = true;
    }
  }
  if (changed) writeState(state);
}

export function getStatePath(): string {
  return STATE_FILE;
}

export function getStateDir(): string {
  return STATE_DIR;
}
