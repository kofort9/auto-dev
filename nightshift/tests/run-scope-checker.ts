/**
 * Golden-set test runner for the scope-checker agent.
 *
 * Feeds each fixture through buildPrompt + execClaude with the scope-checker agent,
 * then validates the verdict matches the expected outcome.
 *
 * Usage: npx tsx nightshift/tests/run-scope-checker.ts
 *
 * Requires: `claude` CLI available in PATH.
 * Set SKIP_LLM=1 to validate fixture loading without calling the LLM.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "scope-checker-fixtures");

interface Expected {
  verdict: string;
  must_contain_category?: string;
  must_not_contain_category?: string;
  must_contain_severity?: string;
  description: string;
}

interface Finding {
  category: string;
  severity: string;
  confidence: number;
  title: string;
  description: string;
}

interface AgentOutput {
  verdict: string;
  summary: string;
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function loadFixtures(): { name: string; spec: string; diff: string; expected: Expected }[] {
  const cases: string[] = [];
  for (const file of fs.readdirSync(FIXTURES_DIR)) {
    if (file.endsWith(".spec.md")) {
      cases.push(file.replace(".spec.md", ""));
    }
  }

  return cases.map((name) => ({
    name,
    spec: fs.readFileSync(path.join(FIXTURES_DIR, `${name}.spec.md`), "utf-8"),
    diff: fs.readFileSync(path.join(FIXTURES_DIR, `${name}.diff.patch`), "utf-8"),
    expected: JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, `${name}.expected.json`), "utf-8"),
    ) as Expected,
  }));
}

// ---------------------------------------------------------------------------
// Import buildPrompt dynamically (it's in the src dir)
// ---------------------------------------------------------------------------

async function buildScopeCheckerPrompt(spec: string, diff: string): Promise<string> {
  // We import the agent instructions directly to construct the prompt
  // This mirrors what agent-runner.ts does internally
  const agentRunnerPath = path.join(__dirname, "..", "src", "agent-runner.ts");
  const source = fs.readFileSync(agentRunnerPath, "utf-8");

  // Extract the scope-checker instructions from the source
  const match = source.match(/"scope-checker":\s*`([\s\S]*?)`,?\n\}/);
  if (!match) {
    throw new Error("Could not extract scope-checker instructions from agent-runner.ts");
  }
  const instructions = match[1];

  return `${instructions}

## Issue Spec

${spec}

## Diff (changes under review)

\`\`\`diff
${diff}
\`\`\`

## Output Format

Respond with valid JSON matching this schema:

\`\`\`json
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "1-2 sentence summary of your review",
  "findings": [
    {
      "category": "actionable" | "style" | "tradeoff" | "question" | "false_positive" | "security" | "spec_gap" | "test_gap" | "scope_violation",
      "severity": "critical" | "high" | "medium" | "low",
      "confidence": 0-100,
      "file": "path/to/file.ts",
      "line": 42,
      "title": "Short title",
      "description": "Detailed explanation",
      "fix": "Suggested fix (optional)",
      "effort": "trivial" | "small" | "medium"
    }
  ]
}
\`\`\`

Only output valid JSON. No markdown fences around it, no preamble, no explanation outside the JSON.`;
}

// ---------------------------------------------------------------------------
// Claude execution (simplified for test runner)
// ---------------------------------------------------------------------------

async function execClaude(prompt: string): Promise<string> {
  const { spawn } = await import("child_process");

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "--print",
      "--permission-mode", "bypassPermissions",
      "--model", "sonnet",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", () => { /* consumed to prevent backpressure */ });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Timeout (5 min)"));
    }, 5 * 60 * 1000);

    proc.on("close", () => {
      clearTimeout(timeout);
      resolve(stdout);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(output: AgentOutput, expected: Expected): { pass: boolean; errors: string[] } {
  const errors: string[] = [];

  // Verdict check
  if (output.verdict !== expected.verdict) {
    errors.push(`Expected verdict "${expected.verdict}", got "${output.verdict}"`);
  }

  // Category checks
  if (expected.must_contain_category) {
    const has = output.findings.some((f) => f.category === expected.must_contain_category);
    if (!has) {
      errors.push(`Expected finding with category "${expected.must_contain_category}" — none found`);
    }
  }
  if (expected.must_not_contain_category) {
    const has = output.findings.some((f) => f.category === expected.must_not_contain_category);
    if (has) {
      errors.push(`Expected NO finding with category "${expected.must_not_contain_category}" — but found one`);
    }
  }

  // Severity check
  if (expected.must_contain_severity) {
    const has = output.findings.some((f) => f.severity === expected.must_contain_severity);
    if (!has) {
      errors.push(`Expected finding with severity "${expected.must_contain_severity}" — none found`);
    }
  }

  return { pass: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const skipLlm = process.env.SKIP_LLM === "1";
  const fixtures = loadFixtures();

  console.log(`Scope-Checker Golden-Set Tests (${fixtures.length} fixtures)`);
  console.log(`Mode: ${skipLlm ? "fixture-load-only (SKIP_LLM=1)" : "full LLM execution"}`);
  console.log("=".repeat(60));

  let passed = 0;
  let failed = 0;

  for (const fixture of fixtures) {
    console.log(`\n  Testing: ${fixture.name}`);
    console.log(`  Expected: ${fixture.expected.verdict} — ${fixture.expected.description}`);

    if (skipLlm) {
      console.log("  ✓ Fixture loaded successfully (LLM skipped)");
      passed++;
      continue;
    }

    try {
      const prompt = await buildScopeCheckerPrompt(fixture.spec, fixture.diff);
      const raw = await execClaude(prompt);
      const jsonStr = extractJson(raw);

      if (!jsonStr) {
        console.log(`  ✗ No valid JSON in output`);
        console.log(`  Raw (first 500 chars): ${raw.slice(0, 500)}`);
        failed++;
        continue;
      }

      const output = JSON.parse(jsonStr) as AgentOutput;
      const result = validate(output, fixture.expected);

      if (result.pass) {
        console.log(`  ✓ PASS — verdict: ${output.verdict}, findings: ${output.findings.length}`);
        passed++;
      } else {
        console.log(`  ✗ FAIL`);
        for (const err of result.errors) {
          console.log(`    - ${err}`);
        }
        console.log(`  Agent summary: ${output.summary}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ✗ ERROR: ${err}`);
      failed++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
  console.log("All golden-set tests passed.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
