import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createLogger } from "../log.js";
import { getRiskTier } from "../scanner.js";
import type { CategoryScanner, Finding, Severity } from "../types.js";

const log = createLogger("test-coverage");

interface ExportedFn {
  name: string;
  file: string;
  line: number;
}

function findExportedFunctions(
  files: string[],
  scanRoot: string,
): ExportedFn[] {
  const fns: ExportedFn[] = [];
  const fnRe = /^export\s+(?:async\s+)?function\s+(\w+)/;

  for (const relFile of files) {
    if (relFile.includes(".test.") || relFile.startsWith("tests/")) continue;
    if (relFile.startsWith("scripts/")) continue;

    const absPath = path.join(scanRoot, relFile);
    const lines = fs.readFileSync(absPath, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(fnRe);
      if (match) {
        fns.push({ name: match[1], file: relFile, line: i + 1 });
      }
    }
  }
  return fns;
}

// Batch grep: one call finds all function names that appear in test files
function buildTestedSet(names: string[], scanRoot: string): Set<string> {
  if (names.length === 0) return new Set();

  const tested = new Set<string>();

  // Chunk into batches to avoid regex-too-long (safe limit: ~200 names per call)
  const BATCH_SIZE = 200;
  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    const pattern = batch.join("|");

    try {
      const result = execFileSync(
        "grep",
        [
          "-ohE",
          pattern,
          "--include=*.test.ts",
          "--include=*.spec.ts",
          "-r",
          scanRoot,
        ],
        { cwd: scanRoot, stdio: ["pipe", "pipe", "pipe"] },
      )
        .toString()
        .trim();

      if (result) {
        for (const match of result.split("\n")) {
          if (match) tested.add(match);
        }
      }
    } catch {
      // grep exit 1 = no matches in this batch
    }
  }

  return tested;
}

function makeId(file: string, line: number): string {
  return createHash("sha256")
    .update(`test-coverage:${file}:${line}-${line}`)
    .digest("hex")
    .slice(0, 16);
}

export const testCoverageScanner: CategoryScanner = {
  name: "test-coverage",
  async scan(files, scanRoot) {
    log("Scanning for untested public functions...");
    const fns = findExportedFunctions(files, scanRoot);
    log(`Found ${fns.length} exported functions to check`);

    // Single batched grep instead of one-per-function
    const testedNames = buildTestedSet(
      fns.map((f) => f.name),
      scanRoot,
    );
    log(`${testedNames.size} function names found in test files`);

    const findings: Finding[] = [];

    for (const fn of fns) {
      if (testedNames.has(fn.name)) continue;

      const riskTier = getRiskTier(fn.file);
      let severity: Severity = "low";
      if (riskTier === "high") severity = "high";
      else if (riskTier === "medium") severity = "medium";

      findings.push({
        id: makeId(fn.file, fn.line),
        category: "test-coverage",
        severity,
        file: fn.file,
        lineStart: fn.line,
        lineEnd: fn.line,
        title: `Untested function: ${fn.name}`,
        description: `\`${fn.name}\` in \`${fn.file}\` has no test references in the test suite. ${riskTier === "high" ? "This is a high-risk file — test coverage is critical." : "Consider adding test coverage."}`,
        suggestedFix: `Add tests for \`${fn.name}\` in the corresponding test file.`,
        confidence: 80,
        riskTier,
        status: "new",
      });
    }

    log(`Found ${findings.length} untested functions`);
    return findings;
  },
};
