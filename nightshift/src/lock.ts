/**
 * PID-based lockfile to prevent concurrent nightshift runs.
 * Uses O_EXCL (exclusive create) for atomicity — same pattern as bash noclobber.
 */

import fs from "fs";
import path from "path";
import { getStateDir } from "./state.js";

const LOCK_FILE = path.join(getStateDir(), "nightshift.lock");

export function acquireLock(): void {
  try {
    // O_EXCL fails if file exists — atomic check-and-create
    const fd = fs.openSync(
      LOCK_FILE,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    );
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    // Lock file exists — check if the PID is still alive
    const existingPid = parseInt(
      fs.readFileSync(LOCK_FILE, "utf-8").trim(),
      10,
    );
    if (existingPid && isProcessAlive(existingPid)) {
      console.error(
        `Error: another nightshift instance is running (PID ${existingPid})`,
      );
      process.exit(1);
    }
    // Stale lock — reclaim atomically (delete then O_EXCL create)
    try {
      fs.unlinkSync(LOCK_FILE);
      const fd = fs.openSync(
        LOCK_FILE,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      );
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch {
      console.error("Error: another process reclaimed the lock first");
      process.exit(1);
    }
  }
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Already cleaned up
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence without killing
    return true;
  } catch {
    return false;
  }
}
