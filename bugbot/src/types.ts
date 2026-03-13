// Phase 1 categories (static analysis only)
export type StaticCategory = "dead-code" | "type-holes" | "test-coverage" | "stale-comments";
// Phase 2 categories (LLM-powered)
export type LlmCategory = "input-validation";
export type Category = StaticCategory | LlmCategory;

export type Severity = "critical" | "high" | "medium" | "low";
export type RiskTier = "high" | "medium" | "low";
export type FindingStatus = "new" | "duplicate" | "published" | "skipped";

export interface Finding {
  id: string; // SHA-256 of {category}:{file}:{lineStart}-{lineEnd}
  category: Category;
  severity: Severity;
  file: string; // relative path from SCAN_ROOT
  lineStart: number;
  lineEnd: number;
  title: string; // < 80 chars
  description: string;
  suggestedFix?: string;
  confidence: number; // 0-100
  riskTier: RiskTier; // from risk contract (first-match)
  status: FindingStatus;
}

export interface ScanResult {
  date: string;
  gitTreeHash: string;
  filesScanned: number;
  findings: Finding[];
  duration_s: number;
  categories: Record<Category, { count: number; skipped: number }>;
}

export interface ScanState {
  lastScanDate: string | null;
  lastGitTreeHash: string | null;
  fingerprints: Record<
    string,
    { firstSeen: string; lastSeen: string; issueNumber?: number }
  >;
}

export interface BugbotOptions {
  categories: Category[];
  dryRun: boolean;
  full: boolean;
  maxIssues: number; // default 10 per run
}

export interface CategoryScanner {
  name: Category;
  scan(files: string[], scanRoot: string): Promise<Finding[]>;
}
