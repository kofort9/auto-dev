/**
 * Git operations for the optimize branch.
 * The optimize branch lives on TARGET_REPO, rebases from origin/main each cycle.
 *
 * Note: Uses execFileSync (not exec) with argument arrays — shell injection safe.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createLogger } from "../log.js";

const log = createLogger("optimize:git");

/** Validate branch name — reject anything that could be interpreted as a git flag. */
function assertValidBranch(branch: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branch) || branch.includes("..") || branch.endsWith(".")) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

/** Worktree path — adjacent to the main repo. */
function worktreePath(repoRoot: string): string {
  return `${repoRoot}--optimize`;
}

/** Create the optimize worktree. Returns the worktree path.
 *  Removes stale worktree from a previous crash if present. */
export function ensureWorktree(repoRoot: string, branch: string): string {
  assertValidBranch(branch);
  const wtPath = worktreePath(repoRoot);

  // Fetch latest main
  gitExec(repoRoot, ["fetch", "origin", "main"]);

  // Clean stale worktree from previous crash
  cleanupWorktree(repoRoot);

  const branches = gitExec(repoRoot, ["branch", "--list", branch]);
  if (branches.trim()) {
    gitExec(repoRoot, ["worktree", "add", wtPath, branch]);
    log(`Created worktree for existing branch ${branch}`);
  } else {
    gitExec(repoRoot, ["worktree", "add", "-b", branch, wtPath, "origin/main"]);
    log(`Created worktree with new branch ${branch}`);
  }

  // Symlink node_modules and data from main repo
  symlinkIfMissing(path.join(repoRoot, "node_modules"), path.join(wtPath, "node_modules"));
  symlinkIfMissing(path.join(repoRoot, "data"), path.join(wtPath, "data"));

  return wtPath;
}

/** Remove the optimize worktree and clean up symlinks. */
export function cleanupWorktree(repoRoot: string): void {
  const wtPath = worktreePath(repoRoot);

  // Remove symlinks first (prevents git worktree remove issues)
  for (const name of ["node_modules", "data"]) {
    try {
      const p = path.join(wtPath, name);
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    } catch { /* doesn't exist */ }
  }

  try {
    gitExec(repoRoot, ["worktree", "remove", "--force", wtPath]);
    log(`Removed worktree at ${wtPath}`);
  } catch {
    // Directory might exist without git tracking it (crash during creation)
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* nothing */ }
  }
}

function symlinkIfMissing(src: string, dst: string): void {
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    fs.symlinkSync(src, dst);
  }
}

/** Rebase optimize branch onto origin/main. Returns true on success.
 *  Assumes caller already fetched origin/main (ensureBranch does this). */
export function rebaseFromMain(repoRoot: string): boolean {
  try {
    gitExec(repoRoot, ["rebase", "origin/main"]);
    log("Rebased onto origin/main");
    return true;
  } catch {
    // Abort the failed rebase
    try {
      gitExec(repoRoot, ["rebase", "--abort"]);
    } catch {
      // Already aborted
    }
    log("Rebase conflict — aborting");
    return false;
  }
}

/** Get current commit SHA (short). */
export function snapshotSha(repoRoot: string): string {
  return gitExec(repoRoot, ["rev-parse", "--short", "HEAD"]).trim();
}

/** Hard reset to a specific SHA. */
export function rollback(repoRoot: string, sha: string): void {
  gitExec(repoRoot, ["reset", "--hard", sha]);
  log(`Rolled back to ${sha}`);
}

/** Commit all changes with a message. Returns the new short SHA. */
export function commitExperiment(repoRoot: string, message: string): string {
  gitExec(repoRoot, ["add", "src/"]);
  gitExec(repoRoot, [
    "commit",
    "-m",
    `${message}\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>`,
  ]);
  return snapshotSha(repoRoot);
}

/** Push branch to origin. */
export function pushBranch(repoRoot: string, branch: string): void {
  assertValidBranch(branch);
  gitExec(repoRoot, ["push", "-u", "origin", branch, "--force-with-lease"]);
  log(`Pushed ${branch}`);
}

/** Safe git execution — uses execFileSync with arg arrays (no shell). */
function gitExec(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
