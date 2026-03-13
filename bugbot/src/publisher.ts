import { execFileSync } from "child_process";
import { createLogger } from "./log.js";
import { SCAN_ROOT, SEVERITY_TO_PRIORITY } from "./config.js";
import type { Finding } from "./types.js";

const log = createLogger("publisher");

// --- Secret pre-filter ---

const SECRET_PATTERNS = [
  /sk[-_][a-zA-Z0-9_]{20,}/g, // Stripe-style keys
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub PATs
  /AKIA[A-Z0-9]{16}/g, // AWS access keys
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0; // reset global regex state
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0; // reset global regex state
    return p.test(text);
  });
}

// --- Spec writer (issue body) ---

function writeSpec(finding: Finding, scanDate: string): string {
  const steps = getImplementationSteps(finding);
  const testReqs = getTestRequirements(finding);
  const patterns = getPatterns(finding);

  return `## Summary
${finding.description}

## Files
| File | Change |
|------|--------|
| \`${finding.file}:${finding.lineStart}\` | ${finding.suggestedFix ?? "See implementation steps"} |

## Implementation Steps
${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Test Requirements
${testReqs.map((t) => `- ${t}`).join("\n")}

## Patterns to Follow
${patterns.map((p) => `- ${p}`).join("\n")}

## Out of Scope
- Refactoring beyond the specific fix
- Changes to unrelated files

**Source**: bugbot scan ${scanDate} (confidence: ${finding.confidence}%)`;
}

function getImplementationSteps(finding: Finding): string[] {
  switch (finding.category) {
    case "dead-code":
      return [
        `Verify \`${finding.title.replace("Unused export: ", "")}\` is truly unused by searching for all references`,
        "Remove the export and declaration if confirmed unused",
        "Remove any related imports that become unused",
        "Run type-check to confirm no breakage",
      ];
    case "type-holes":
      return [
        `Identify the correct type for the suppression at \`${finding.file}:${finding.lineStart}\``,
        "Replace the type suppression with proper type annotation",
        "Fix any type errors that surface",
        "Run type-check to confirm no regressions",
      ];
    case "test-coverage":
      return [
        `Create test file if it doesn't exist`,
        `Add unit tests for \`${finding.title.replace("Untested function: ", "")}\``,
        "Cover happy path and edge cases",
        "Run test suite to verify",
      ];
    case "stale-comments":
      return [
        `Review the ${finding.title.split(":")[0].replace("Stale ", "")} at \`${finding.file}:${finding.lineStart}\``,
        "Determine if the TODO/FIXME is still relevant",
        "Either implement the fix or remove the comment",
        "Update any related documentation",
      ];
    case "input-validation":
      return [
        `Add input validation to the function at \`${finding.file}:${finding.lineStart}\``,
        "Validate parameter types, ranges, and formats at the function boundary",
        "Return clear error messages for invalid inputs",
        "Run type-check and tests to confirm no regressions",
      ];
    default:
      return ["Review and fix the finding"];
  }
}

function getTestRequirements(finding: Finding): string[] {
  switch (finding.category) {
    case "dead-code":
      return [
        "Existing tests still pass after removal",
        "No runtime errors in related features",
      ];
    case "type-holes":
      return [
        "Type-check passes without suppressions",
        "Existing tests pass with new types",
      ];
    case "test-coverage":
      return [
        "New tests cover happy path",
        "New tests cover error/edge cases",
        "All tests pass",
      ];
    case "stale-comments":
      return [
        "If TODO was implemented: add test for the new behavior",
        "If TODO was removed: existing tests still pass",
      ];
    case "input-validation":
      return [
        "Test with invalid inputs (null, empty, negative, oversized)",
        "Test boundary values (min, max, zero)",
        "Verify error messages are clear and actionable",
      ];
    default:
      return ["Verify fix doesn't introduce regressions"];
  }
}

function getPatterns(finding: Finding): string[] {
  switch (finding.category) {
    case "dead-code":
      return ["Follow existing export patterns in the module"];
    case "type-holes":
      return [
        "Use specific types from the domain model",
        "Prefer type narrowing over assertions",
      ];
    case "test-coverage":
      return [
        "Follow existing test file naming conventions",
        "Use describe/it blocks matching the function name",
      ];
    case "stale-comments":
      return [
        "Keep TODOs actionable with clear context",
        "Remove comments that describe what code does (let the code speak)",
      ];
    case "input-validation":
      return [
        "Validate at the server boundary, not deep in domain logic",
        "Use early returns for invalid inputs",
        "Follow existing validation patterns in sibling tool files",
      ];
    default:
      return ["Follow existing codebase conventions"];
  }
}

// --- Sanitize title for GH ---

function sanitizeTitle(title: string): string {
  return title.replace(/[`'"]/g, "").replace(/\n/g, " ").slice(0, 80);
}

// --- Publish to GitHub ---

export function publishIssue(
  finding: Finding,
  scanDate: string,
): number | null {
  const priority = SEVERITY_TO_PRIORITY[finding.severity] ?? "priority:low";
  const labels = [
    "bugbot",
    `bugbot:${finding.category}`,
    "auto-ready",
    "nightshift",
    priority,
  ];

  let body = writeSpec(finding, scanDate);
  let title = sanitizeTitle(`[bugbot] ${finding.title}`);

  // Secret check on both body and title
  if (hasSecret(body) || hasSecret(title)) {
    log(`WARNING: Redacted potential secret in ${finding.id}`);
    body = redactSecrets(body);
    title = redactSecrets(title);
  }

  try {
    const result = execFileSync(
      "gh",
      [
        "issue",
        "create",
        "--title",
        title,
        "--body",
        body,
        ...labels.flatMap((l) => ["--label", l]),
      ],
      { cwd: SCAN_ROOT, stdio: ["pipe", "pipe", "pipe"] },
    )
      .toString()
      .trim();

    // gh issue create prints the URL; extract issue number
    const match = result.match(/\/issues\/(\d+)/);
    const issueNumber = match ? parseInt(match[1], 10) : null;
    log(`Created issue ${issueNumber ?? result}: ${title}`);
    return issueNumber;
  } catch (err) {
    log(`Failed to create issue: ${title} — ${err}`);
    return null;
  }
}

// Exported for testing
export { writeSpec, sanitizeTitle, redactSecrets, hasSecret };
