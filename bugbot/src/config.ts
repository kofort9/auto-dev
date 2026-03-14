import path from "path";
import type { Category, LlmCategory, RiskTier, StaticCategory } from "./types.js";

function resolve(p: string): string {
  return path.resolve(p.replace(/^~/, process.env.HOME ?? ""));
}

export const SCAN_ROOT = resolve(
  process.env.SCAN_ROOT ?? process.env.TARGET_REPO ?? "",
);
export const BUGBOT_ROOT = resolve(
  process.env.BUGBOT_ROOT ??
    path.resolve(import.meta.dirname, ".."),
);
export const STATE_DIR = resolve(process.env.BUGBOT_STATE ?? "~/.bugbot");

// Checked top-to-bottom: first match wins. Specific files before globs.
// Customize this for your project — list critical files as "high", supporting
// modules as "medium", and everything else as "low". Higher-risk files require
// higher confidence scores before bugbot will file an issue.
export const RISK_CONTRACT: [RiskTier, string][] = [
  // High: core business logic, data processing, server entry points
  ["high", "src/server/**"],
  // Medium: parsers, builders, data access layers
  ["medium", "src/data-sources/**"],
  // Low: utilities, scripts, tests
  ["low", "src/core/**"],
  ["low", "scripts/**"],
  ["low", "tests/**"],
];

export const CONFIDENCE_THRESHOLDS: Record<RiskTier, number> = {
  high: 85,
  medium: 70,
  low: 60,
};

export const ALL_STATIC_CATEGORIES: StaticCategory[] = [
  "dead-code",
  "type-holes",
  "test-coverage",
  "stale-comments",
];

export const ALL_LLM_CATEGORIES: LlmCategory[] = ["input-validation"];
export const ALL_CATEGORIES: Category[] = [
  ...ALL_STATIC_CATEGORIES,
  ...ALL_LLM_CATEGORIES,
];

// Severity → GH priority label (must match labels that exist on your target repo)
export const SEVERITY_TO_PRIORITY: Record<string, string> = {
  critical: "priority:high",
  high: "priority:high",
  medium: "priority:low",
  low: "priority:low",
};

export const MAX_ISSUES_DEFAULT = 10;

// Directories to scan under SCAN_ROOT
export const SCAN_DIRS = ["src", "scripts"];

// Patterns to skip during file traversal
export const SKIP_PATTERNS = [
  "node_modules",
  "dist",
  ".git",
  "fixtures",
];
