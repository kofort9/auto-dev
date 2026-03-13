import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createLogger } from "../log.js";
import { getRiskTier, getBlameDate } from "../scanner.js";
import type { CategoryScanner, Finding, Severity } from "../types.js";

const log = createLogger("stale-comments");

const TODO_RE = /\/\/\s*(TODO|FIXME|HACK|XXX|TEMP)\b[:\s]*(.*)/i;

function ageSeverity(days: number): Severity {
  if (days > 180) return "critical";
  if (days > 90) return "high";
  if (days > 30) return "medium";
  return "low";
}

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function makeId(file: string, line: number): string {
  return createHash("sha256")
    .update(`stale-comments:${file}:${line}-${line}`)
    .digest("hex")
    .slice(0, 16);
}

export const staleCommentsScanner: CategoryScanner = {
  name: "stale-comments",
  async scan(files, scanRoot) {
    log("Scanning for stale TODO/FIXME comments...");
    const findings: Finding[] = [];

    for (const relFile of files) {
      const absPath = path.join(scanRoot, relFile);
      const lines = fs.readFileSync(absPath, "utf-8").split("\n");
      const riskTier = getRiskTier(relFile);

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(TODO_RE);
        if (!match) continue;

        const tag = match[1].toUpperCase();
        const comment = match[2].trim();
        const blameDate = getBlameDate(scanRoot, relFile, i + 1);

        let severity: Severity = "low";
        let days = 0;
        let ageNote = "unknown age";

        if (blameDate) {
          days = daysSince(blameDate);
          severity = ageSeverity(days);
          ageNote = `${days} days old`;
        }

        // Only report if > 30 days or no blame date (can't determine freshness)
        if (blameDate && days <= 30) continue;

        findings.push({
          id: makeId(relFile, i + 1),
          category: "stale-comments",
          severity,
          file: relFile,
          lineStart: i + 1,
          lineEnd: i + 1,
          title: `Stale ${tag}: ${comment.slice(0, 50) || "(no description)"}`,
          description: `${tag} comment at \`${relFile}:${i + 1}\` is ${ageNote}. Content: "${comment || "(empty)"}"`,
          suggestedFix: `Resolve the ${tag} or remove it if no longer applicable.`,
          confidence: blameDate ? 85 : 60, // Lower confidence without age data
          riskTier,
          status: "new",
        });
      }
    }

    log(`Found ${findings.length} stale comments`);
    return findings;
  },
};
