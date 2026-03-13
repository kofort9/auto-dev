/**
 * Wraps `claude --print --permission-mode bypassPermissions` for a single review agent.
 *
 * Constructs the prompt with spec + diff + agent-specific instructions,
 * runs claude as a child process, parses structured output into AgentResult.
 * 15-minute timeout per agent (vs 90 min for the execute phase).
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { AgentName, AgentResult, AgentFinding } from "./review-types.js";

const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Model assignment per agent. Opus for deep analysis, sonnet for breadth. */
const AGENT_MODELS: Record<AgentName, string> = {
  "code-reviewer": "sonnet",
  "spec-compliance-checker": "sonnet",
  "test-coverage-checker": "sonnet",
  "red-team": "opus",
  "ml-specialist": "opus",
};

/** Agent-specific review instructions appended to the base prompt. */
const AGENT_INSTRUCTIONS: Record<AgentName, string> = {
  "code-reviewer": `You are a code reviewer. Focus on:
- Bugs, logic errors, off-by-one mistakes
- Security vulnerabilities (injection, missing validation)
- Code quality: dead code, unnecessary complexity, naming
- Project convention violations (check CLAUDE.md)
- Error handling gaps

For each finding, assess effort to fix: trivial (1 line), small (5-10 lines), medium (refactor).`,

  "spec-compliance-checker": `You are a spec compliance checker. Compare the diff against the spec.
For each spec requirement:
- Mark as IMPLEMENTED, MISSING, EXTRA (scope creep), or PARTIAL
- If PARTIAL or MISSING, describe what's lacking
- Flag any behavior that contradicts the spec
- Flag any files changed that aren't related to the spec (scope creep)

Be strict: the spec is the source of truth.`,

  "test-coverage-checker": `You are a test coverage checker. Given the spec and the diff:
- Identify all testable scenarios from the spec
- Map each scenario to test cases in the diff
- Flag scenarios with no test coverage (test_gap)
- Flag edge cases that should be tested
- Check that test assertions are meaningful (not just "doesn't throw")

Focus on behavioral coverage, not line coverage.`,

  "red-team": `You are a security reviewer (red team). Focus exclusively on:
- Authentication/authorization bypasses
- Input validation and sanitization gaps
- Injection vectors (SQL, command, path traversal)
- Secrets or credentials in code
- Race conditions in security-critical paths
- Privilege escalation
- Data exposure through error messages or logs

Only report findings with concrete attack vectors. No generic advice.`,

  "ml-specialist": `You are an ML/statistical review specialist. Focus on:
- Scoring algorithm correctness and fairness
- Threshold selection and sensitivity analysis
- Simpson's Paradox risks in aggregation
- Confidence score calibration
- Edge cases in classification logic
- Data quality assumptions that might not hold
- Potential for gaming/Goodhart's Law

Reference specific lines and explain the statistical concern.`,
};

/** ID prefix per agent for finding IDs (e.g., "cr-001"). */
const AGENT_ID_PREFIX: Record<AgentName, string> = {
  "code-reviewer": "cr",
  "red-team": "rt",
  "ml-specialist": "ml",
  "spec-compliance-checker": "sc",
  "test-coverage-checker": "tc",
};

interface RunAgentOptions {
  agent: AgentName;
  spec: string;
  diff: string;
  worktree: string;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { agent, spec, diff, worktree } = opts;
  const model = AGENT_MODELS[agent];
  const instructions = AGENT_INSTRUCTIONS[agent];
  const start = Date.now();

  const prompt = buildPrompt(agent, spec, diff, instructions);

  const { stdout, stderr } = await execClaude(prompt, model, worktree);

  const duration_ms = Date.now() - start;
  const tokenUsage = parseTokenUsage(stderr);

  // Parse structured output once, extract findings and summary
  const parsed = parseAgentOutput(stdout, agent);

  return {
    agent,
    model,
    verdict: deriveVerdict(parsed.findings),
    findings: parsed.findings,
    summary: parsed.summary,
    duration_ms,
    token_usage: tokenUsage,
    raw_output: stdout,
  };
}

function buildPrompt(
  agent: AgentName,
  spec: string,
  diff: string,
  instructions: string,
): string {
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
      "category": "actionable" | "style" | "tradeoff" | "question" | "false_positive" | "security" | "spec_gap" | "test_gap",
      "severity": "critical" | "high" | "medium" | "low",
      "confidence": 0-100,
      "file": "path/to/file.ts",
      "line": 42,
      "title": "Short title",
      "description": "Detailed explanation",
      "fix": "Suggested fix (optional)",
      "effort": "trivial" | "small" | "medium",
      "options": ["option1", "option2"],
      "recommendation": "For tradeoffs, your recommendation"
    }
  ]
}
\`\`\`

Only output valid JSON. No markdown fences around it, no preamble, no explanation outside the JSON.`;
}

function execClaude(
  prompt: string,
  model: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  // Write prompt to a temp file to avoid shell buffer limits on large diffs
  const tmpFile = path.join(
    os.tmpdir(),
    `nightshift-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
  );
  fs.writeFileSync(tmpFile, prompt);

  return new Promise((resolve) => {
    const args = [
      "--print",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      model,
      "--prompt-file",
      tmpFile,
    ];

    const proc = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      // SIGKILL follow-up if process ignores SIGTERM
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, 5000);
    }, AGENT_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      // Clean up temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* cleanup best-effort */
      }
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* cleanup best-effort */
      }
      stderr += `\nSpawn error: ${err.message}`;
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}

function parseTokenUsage(stderr: string): { input: number; output: number } {
  // Claude CLI outputs token usage to stderr in format like:
  // "Input tokens: 1234" / "Output tokens: 567"
  const inputMatch = stderr.match(/input.*?(\d[\d,]+)/i);
  const outputMatch = stderr.match(/output.*?(\d[\d,]+)/i);
  return {
    input: inputMatch ? parseInt(inputMatch[1].replace(/,/g, ""), 10) : 0,
    output: outputMatch ? parseInt(outputMatch[1].replace(/,/g, ""), 10) : 0,
  };
}

interface ParsedAgentOutput {
  findings: AgentFinding[];
  summary: string;
}

function parseAgentOutput(raw: string, agent: AgentName): ParsedAgentOutput {
  const prefix = AGENT_ID_PREFIX[agent];
  const jsonStr = extractJson(raw);
  if (!jsonStr)
    return { findings: [], summary: "No structured output from agent." };

  try {
    const parsed = JSON.parse(jsonStr) as {
      findings?: Array<Omit<AgentFinding, "id" | "agent">>;
      summary?: string;
    };

    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map((f, i) => ({
          ...f,
          id: `${prefix}-${String(i + 1).padStart(3, "0")}`,
          agent,
          category: f.category ?? "actionable",
          severity: f.severity ?? "medium",
          confidence: f.confidence ?? 70,
          file: f.file ?? "unknown",
          title: f.title ?? "Untitled finding",
          description: f.description ?? "",
        }))
      : [];

    return {
      findings,
      summary: parsed.summary ?? "No summary provided.",
    };
  } catch {
    return { findings: [], summary: "Failed to parse agent output." };
  }
}

function extractJson(raw: string): string | null {
  // Try direct parse first
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;

  // Try extracting from markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try finding the first { to last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function deriveVerdict(
  findings: AgentFinding[],
): "approve" | "request_changes" | "comment" {
  const hasBlocker = findings.some(
    (f) =>
      (f.severity === "critical" || f.severity === "high") &&
      f.confidence >= 80,
  );

  if (hasBlocker) return "request_changes";
  if (findings.length > 0) return "comment";
  return "approve";
}
