/**
 * Git operations for the optimize branch.
 * The optimize branch lives on TARGET_REPO, rebases from origin/main each cycle.
 *
 * Note: Uses execFileSync (not exec) with argument arrays — shell injection safe.
 */

import { execFileSync } from "child_process";
import { createLogger } from "../log.js";

const log = createLogger("optimize:git");

/** Validate branch name — reject anything that could be interpreted as a git flag. */
function assertValidBranch(branch: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branch) || branch.includes("..") || branch.endsWith(".")) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

/** Ensure the optimize branch exists, branching from origin/main. */
export function ensureBranch(repoRoot: string, branch: string): void {
  assertValidBranch(branch);
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
