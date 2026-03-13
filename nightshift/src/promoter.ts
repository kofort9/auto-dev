/**
 * Wave promotion using Kahn's algorithm.
 *
 * Finds open issues whose dependencies are all satisfied (closed or auto-pr-ready),
 * then labels them `auto-ready` so nightshift picks them up in the next run.
 *
 * Skips issues that already have auto-ready/auto-pr-ready labels,
 * and issues tagged research/design (need human judgment).
 */

import { execFileSync } from "child_process";

interface GhIssueWithBody {
  number: number;
  title: string;
  labels: { name: string }[];
  body: string | null;
}

const DEP_PATTERN = /(?:depends on|blocked by|prerequisite[^\n]*)\s*#(\d+)/gi;
const SKIP_LABELS = /auto-ready|auto-pr-ready/;
const HUMAN_LABELS = /research|design/;

export function promoteNextWave(repoRoot: string): void {
  log("Promoting next wave...");

  const repoNwo = execFileSync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { cwd: repoRoot, encoding: "utf-8" },
  ).trim();

  // Satisfied = closed issues + issues with PRs ready to merge
  const satisfied = new Set<number>();

  const closedRaw = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "closed",
      "--json",
      "number",
      "-q",
      ".[].number",
      "--limit",
      "200",
      "--repo",
      repoNwo,
    ],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  for (const line of closedRaw.trim().split("\n").filter(Boolean)) {
    satisfied.add(parseInt(line, 10));
  }

  const prReadyRaw = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "auto-pr-ready",
      "--json",
      "number",
      "-q",
      ".[].number",
      "--repo",
      repoNwo,
    ],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  for (const line of prReadyRaw.trim().split("\n").filter(Boolean)) {
    satisfied.add(parseInt(line, 10));
  }

  // All open issues with body text
  const allOpenRaw = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--json",
      "number,title,labels,body",
      "--limit",
      "100",
      "--repo",
      repoNwo,
    ],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  const allOpen = JSON.parse(allOpenRaw) as GhIssueWithBody[];

  for (const issue of allOpen) {
    const labelNames = issue.labels.map((l) => l.name).join(",");

    // Skip already labeled
    if (SKIP_LABELS.test(labelNames)) continue;

    // Skip human-judgment issues
    if (HUMAN_LABELS.test(labelNames)) {
      log(`  skip #${issue.number} (research/design label): ${issue.title}`);
      continue;
    }

    // Extract dependency edges from body (truncated to 3000 chars for safety)
    const body = (issue.body ?? "").slice(0, 3000);
    const deps = extractDependencies(body);

    if (deps.length === 0) {
      log(`  promote #${issue.number} (no deps): ${issue.title}`);
      labelAutoReady(issue.number, repoNwo, repoRoot);
      continue;
    }

    // Check if all deps are satisfied
    const unmet = deps.filter((d) => !satisfied.has(d));
    if (unmet.length === 0) {
      log(`  promote #${issue.number} (all deps met): ${issue.title}`);
      labelAutoReady(issue.number, repoNwo, repoRoot);
    } else {
      log(
        `  blocked #${issue.number} (by ${unmet.map((n) => `#${n}`).join(", ")}): ${issue.title}`,
      );
    }
  }

  log("Wave promotion complete.");
}

/** Extract issue numbers from dependency markers in issue body text */
export function extractDependencies(body: string): number[] {
  const deps = new Set<number>();
  let match: RegExpExecArray | null;

  // Reset regex state for global regex
  DEP_PATTERN.lastIndex = 0;
  while ((match = DEP_PATTERN.exec(body)) !== null) {
    deps.add(parseInt(match[1], 10));
  }

  return [...deps].sort((a, b) => a - b);
}

function labelAutoReady(
  issueNumber: number,
  repoNwo: string,
  repoRoot: string,
): void {
  try {
    execFileSync(
      "gh",
      [
        "issue",
        "edit",
        String(issueNumber),
        "--add-label",
        "auto-ready",
        "--repo",
        repoNwo,
      ],
      { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" },
    );
  } catch {
    // Non-fatal — label might already exist or permissions issue
  }
}

function log(msg: string): void {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  console.log(`[nightshift] ${time} ${msg}`);
}
