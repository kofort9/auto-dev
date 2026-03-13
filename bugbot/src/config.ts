import path from "path";
import type { Category, LlmCategory, RiskTier, StaticCategory } from "./types.js";

function resolve(p: string): string {
  return path.resolve(p.replace(/^~/, process.env.HOME ?? ""));
}

export const SCAN_ROOT = resolve(
  process.env.SCAN_ROOT ?? "~/Repos/nonprofit-vetting-engine",
);
export const BUGBOT_ROOT = resolve(
  process.env.BUGBOT_ROOT ??
    "~/Repos/auto-dev/bugbot",
);
export const STATE_DIR = resolve(process.env.BUGBOT_STATE ?? "~/.bugbot");

// Checked top-to-bottom: first match wins. Specific files before globs.
export const RISK_CONTRACT: [RiskTier, string][] = [
  // High: scoring, financial, server
  ["high", "src/domain/nonprofit/scoring.ts"],
  ["high", "src/domain/nonprofit/scoring-criteria.ts"],
  ["high", "src/domain/nonprofit/scoring-math.ts"],
  ["high", "src/domain/nonprofit/financial-averaging.ts"],
  ["high", "src/domain/nonprofit/detect-red-flags.ts"],
  ["high", "src/domain/nonprofit/sector-thresholds.ts"],
  ["high", "src/data-sources/csv-data-store.ts"],
  ["high", "src/data-sources/token-decomposer.ts"],
  ["high", "src/server/**"],
  // Medium: parsers, builders, remaining data-sources, gates
  ["medium", "src/domain/nonprofit/xml-parser.ts"],
  ["medium", "src/domain/nonprofit/local-profile-builder.ts"],
  ["medium", "src/domain/nonprofit/classification-tag-builder.ts"],
  ["medium", "src/data-sources/**"],
  ["medium", "src/domain/gates/**"],
  // Low: everything else
  ["low", "src/core/**"],
  ["low", "src/domain/discovery/**"],
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

// Severity → GH priority label (matches VE repo's label scheme)
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
