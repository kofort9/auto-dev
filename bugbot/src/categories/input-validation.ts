import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createLogger } from "../log.js";
import { getRiskTier } from "../scanner.js";
import { callLlm, fenceCode, recordTokens } from "../llm.js";
import type { CategoryScanner, Finding } from "../types.js";

const log = createLogger("input-validation");

const MAX_FUNCTION_LINES = 200;

interface FunctionInfo {
  name: string;
  file: string; // relative path
  lineStart: number;
  lineEnd: number;
  body: string;
}

// Extract exported function bodies using brace-depth counting
function extractFunctions(
  relFile: string,
  scanRoot: string,
): FunctionInfo[] {
  const absPath = path.join(scanRoot, relFile);
  const lines = fs.readFileSync(absPath, "utf-8").split("\n");
  const fns: FunctionInfo[] = [];
  const exportRe = /^export\s+(?:async\s+)?function\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(exportRe);
    if (!match) continue;

    const name = match[1];
    const lineStart = i + 1;

    // Find function end by brace-depth counting
    let depth = 0;
    let started = false;
    let lineEnd = i;

    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          started = true;
        }
        if (ch === "}") depth--;
      }
      if (started && depth <= 0) {
        lineEnd = j + 1;
        break;
      }
    }

    const bodyLines = lines.slice(i, lineEnd);
    let body = bodyLines.join("\n");

    // Truncate if too long
    if (bodyLines.length > MAX_FUNCTION_LINES) {
      body =
        bodyLines.slice(0, MAX_FUNCTION_LINES).join("\n") +
        `\n// ...(truncated at ${MAX_FUNCTION_LINES} lines, total: ${bodyLines.length})`;
    }

    fns.push({ name, file: relFile, lineStart, lineEnd, body });
  }

  return fns;
}

function buildPrompt(fn: FunctionInfo): string {
  return `You are a security-focused code reviewer analyzing a TypeScript MCP tool handler for input validation gaps at the server boundary — where external (untrusted) input enters the system.

${fenceCode(fn.file, fn.body)}

Check for these categories ONLY:
1. Numeric parameters without runtime bounds checks (e.g., limit, offset, count with no min/max enforcement)
2. String parameters used in queries, file paths, or regex without sanitization or length limits
3. Missing runtime type narrowing on parameters typed as \`unknown\`, \`any\`, or broad unions
4. Array/object inputs without size limits that could cause memory exhaustion

DO NOT flag:
- Properties accessed on typed return values — if TypeScript types guarantee a field exists, that is NOT a validation gap
- Parameters that are already validated by the MCP schema/framework before reaching this function
- Missing null checks on values the type system guarantees are present
- Style preferences, naming issues, or refactoring suggestions

Rules:
- Max 3 findings per function. If you find more, keep only the highest confidence ones.
- Each finding must describe a DISTINCT issue. Do not report the same validation gap with different wording.
- Confidence should reflect how certain you are this is a REAL exploitable gap, not a style issue. Use 90+ only for clearly missing bounds checks on external input.
- Severity: critical = RCE/injection, high = data corruption/bypass, medium = DoS/abuse, low = minor info leak

Return JSON only (no markdown, no explanation outside JSON):
{
  "findings": [
    {
      "title": "string (<80 chars, specific — include the parameter name)",
      "description": "string (what input triggers the issue and what happens)",
      "severity": "critical|high|medium|low",
      "suggestedFix": "string (concrete code change, not vague advice)",
      "confidence": 0-100
    }
  ]
}

If no issues found, return: { "findings": [] }`;
}

function makeId(file: string, lineStart: number, lineEnd: number, title: string): string {
  return createHash("sha256")
    .update(`input-validation:${file}:${lineStart}-${lineEnd}:${title}`)
    .digest("hex")
    .slice(0, 16);
}

export const inputValidationScanner: CategoryScanner = {
  name: "input-validation",
  async scan(files, scanRoot) {
    // Only scan server boundary files (where external input enters)
    const serverFiles = files.filter(
      (f) =>
        f.startsWith("src/server/") &&
        !f.endsWith("index.ts") &&
        !f.endsWith("tool-registry.ts") &&
        !f.endsWith("context.ts"),
    );

    log(`Scanning ${serverFiles.length} server boundary files...`);
    const findings: Finding[] = [];

    for (const relFile of serverFiles) {
      const fns = extractFunctions(relFile, scanRoot);
      log(`  ${relFile}: ${fns.length} exported functions`);

      for (const fn of fns) {
        const prompt = buildPrompt(fn);
        const result = await callLlm(prompt);

        if (!result) {
          log(`  Skipping ${fn.name}: LLM call failed`);
          continue;
        }

        recordTokens("input-validation", result.tokens.input, result.tokens.output, result.tokens.cost_usd);

        const riskTier = getRiskTier(fn.file);
        for (const llmFinding of result.findings) {
          findings.push({
            id: makeId(fn.file, fn.lineStart, fn.lineEnd, llmFinding.title),
            category: "input-validation",
            severity: llmFinding.severity,
            file: fn.file,
            lineStart: fn.lineStart,
            lineEnd: fn.lineEnd,
            title: llmFinding.title,
            description: llmFinding.description,
            suggestedFix: llmFinding.suggestedFix,
            confidence: llmFinding.confidence,
            riskTier,
            status: "new",
          });
        }
      }
    }

    log(`Found ${findings.length} input validation issues`);
    return findings;
  },
};
