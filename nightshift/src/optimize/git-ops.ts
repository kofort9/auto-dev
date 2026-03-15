/**
 * Git operations for the optimize branch.
 * The optimize branch lives on TARGET_REPO, rebases from origin/main each cycle.
 *
 * Note: Uses execFileSync (not exec) with argument arrays — shell injection safe.
 */

import { execFileSync } from "child_process";
import { createLogger } from "../log.js";

const log = createLogger("optimize:git");

/** Ensure the optimize branch exists, branching from origin/main. */
export function ensureBranch(repoRoot: string, branch: string): void {
  // Fetch latest main
  gitExec(repoRoot, ["fetch", "origin", "main"]);

  const branches = gitExec(repoRoot, ["branch", "--list", branch]);
  if (branches.trim()) {
    gitExec(repoRoot, ["checkout", branch]);
    log(`Checked out existing branch ${branch}`);
  } else {
    gitExec(repoRoot, ["checkout", "-b", branch, "origin/main"]);
    log(`Created branch ${branch} from origin/main`);
  }
}

/** Rebase optimize branch onto origin/main. Returns true on success. */
export function rebaseFromMain(repoRoot: string): boolean {
  gitExec(repoRoot, ["fetch", "origin", "main"]);
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
  gitExec(repoRoot, ["add", "-A"]);
  gitExec(repoRoot, [
    "commit",
    "-m",
    `${message}\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>`,
  ]);
  return snapshotSha(repoRoot);
}

/** Push branch to origin. */
export function pushBranch(repoRoot: string, branch: string): void {
  gitExec(repoRoot, ["push", "-u", "origin", branch, "--force-with-lease"]);
  log(`Pushed ${branch}`);
}

/** Get current branch name. */
export function currentBranch(repoRoot: string): string {
  return gitExec(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
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
