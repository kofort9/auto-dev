import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createLogger } from "../log.js";
import { getRiskTier } from "../scanner.js";
import type { CategoryScanner, Finding, Severity } from "../types.js";

const log = createLogger("type-holes");

interface HolePattern {
  regex: RegExp;
  label: string;
  severityBoost: boolean; // true = bump severity in high-risk files
}

const HOLE_PATTERNS: HolePattern[] = [
  { regex: /\bas\s+any\b/, label: "as any", severityBoost: true },
  { regex: /\/\/\s*@ts-ignore/, label: "@ts-ignore", severityBoost: true },
  { regex: /\/\/\s*@ts-nocheck/, label: "@ts-nocheck", severityBoost: true },
  {
    regex: /\/\/\s*eslint-disable.*\bany\b/,
    label: "eslint-disable any",
    severityBoost: false,
  },
  // Phase 2: add AST-based detection of untyped function returns
  // The regex approach for `unknown` has too many false positives (legitimate unknown params)
];

function makeId(file: string, line: number, label: string): string {
  return createHash("sha256")
    .update(`type-holes:${file}:${line}-${line}:${label}`)
    .digest("hex")
    .slice(0, 16);
}

export const typeHolesScanner: CategoryScanner = {
  name: "type-holes",
  async scan(files, scanRoot) {
    log("Scanning for type safety suppressions...");
    const findings: Finding[] = [];

    for (const relFile of files) {
      if (relFile.includes(".test.")) continue;
      const absPath = path.join(scanRoot, relFile);
      const lines = fs.readFileSync(absPath, "utf-8").split("\n");
      const riskTier = getRiskTier(relFile);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of HOLE_PATTERNS) {
          if (!pattern.regex.test(line)) continue;

          let severity: Severity = "medium";
          if (riskTier === "high" && pattern.severityBoost) severity = "high";
          if (riskTier === "low") severity = "low";

          findings.push({
            id: makeId(relFile, i + 1, pattern.label),
            category: "type-holes",
            severity,
            file: relFile,
            lineStart: i + 1,
            lineEnd: i + 1,
            title: `Type suppression: ${pattern.label}`,
            description: `\`${pattern.label}\` found at \`${relFile}:${i + 1}\`. This bypasses TypeScript's type checking and may hide bugs.`,
            suggestedFix: `Replace with a proper type annotation or fix the underlying type error.`,
            confidence: 95, // Very mechanical — high confidence
            riskTier,
            status: "new",
          });
        }
      }
    }

    log(`Found ${findings.length} type holes`);
    return findings;
  },
};
