import fs from "fs";
import path from "path";
import { STATE_DIR } from "./config.js";
import type { ScanState } from "./types.js";

const STATE_FILE = path.join(STATE_DIR, "scan-state.json");

function ensureDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, "runs"), { recursive: true });
}

export function readState(): ScanState {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastScanDate: null, lastGitTreeHash: null, fingerprints: {} };
  }
}

// Atomic write: tmp -> rename (crash-safe)
export function writeState(state: ScanState): void {
  ensureDir();
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
}

export function updateFingerprint(
  state: ScanState,
  id: string,
  issueNumber?: number,
): void {
  const now = new Date().toISOString();
  const existing = state.fingerprints[id];
  if (existing) {
    existing.lastSeen = now;
    if (issueNumber !== undefined) existing.issueNumber = issueNumber;
  } else {
    state.fingerprints[id] = {
      firstSeen: now,
      lastSeen: now,
      ...(issueNumber !== undefined ? { issueNumber } : {}),
    };
  }
}

export function appendFindings(date: string, lines: string[]): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date format: ${date}`);
  ensureDir();
  const filePath = path.join(STATE_DIR, "runs", `${date}-findings.jsonl`);
  fs.appendFileSync(filePath, lines.join("\n") + "\n");
}
