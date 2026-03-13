import { describe, it, expect } from "vitest";
import { compileBrief } from "../src/review-brief.js";
import type { AgentResult, AgentFinding } from "../src/review-types.js";

function makeFinding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    id: "cr-001",
    agent: "code-reviewer",
    category: "actionable",
    severity: "medium",
    confidence: 85,
    file: "src/foo.ts",
    line: 42,
    title: "Missing null check",
    description: "The value could be null",
    ...overrides,
  };
}

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    agent: "code-reviewer",
    model: "sonnet",
    verdict: "comment",
    findings: [],
    summary: "Looks ok",
    duration_ms: 5000,
    token_usage: { input: 1000, output: 200 },
    raw_output: "{}",
    ...overrides,
  };
}

describe("compileBrief", () => {
  it("produces a valid brief structure", () => {
    const brief = compileBrief(
      215,
      "Add null checks",
      ["src/foo.ts"],
      [makeResult()],
      [],
    );

    expect(brief.version).toBe(1);
    expect(brief.issue_number).toBe(215);
    expect(brief.files_changed).toEqual(["src/foo.ts"]);
    expect(brief.agents_invoked).toEqual(["code-reviewer"]);
  });

  it("filters findings below confidence threshold (80)", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts", "src/bar.ts", "src/baz.ts"],
      [
        makeResult({
          findings: [
            makeFinding({ confidence: 90, id: "cr-001", file: "src/foo.ts", title: "Null check" }),
            makeFinding({ confidence: 70, id: "cr-002", file: "src/bar.ts", title: "Type issue" }), // below threshold
            makeFinding({ confidence: 80, id: "cr-003", file: "src/baz.ts", title: "Error handling" }), // exactly at threshold
          ],
        }),
      ],
      [],
    );

    expect(brief.findings).toHaveLength(2);
    expect(brief.findings.map((f) => f.id)).toContain("cr-001");
    expect(brief.findings.map((f) => f.id)).toContain("cr-003");
  });

  it("deduplicates findings from same file/line range", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts"],
      [
        makeResult({
          agent: "code-reviewer",
          findings: [
            makeFinding({
              id: "cr-001",
              agent: "code-reviewer",
              file: "src/foo.ts",
              line: 42,
              title: "Missing null check",
              severity: "medium",
              confidence: 85,
            }),
          ],
        }),
        makeResult({
          agent: "spec-compliance-checker",
          findings: [
            makeFinding({
              id: "sc-001",
              agent: "spec-compliance-checker",
              file: "src/foo.ts",
              line: 45, // same 10-line range
              title: "Missing null check",
              severity: "high",
              confidence: 85,
            }),
          ],
        }),
      ],
      [],
    );

    // Should deduplicate to 1, keeping higher severity, with boosted confidence
    expect(brief.findings).toHaveLength(1);
    expect(brief.findings[0].severity).toBe("high");
    expect(brief.findings[0].confidence).toBe(95); // 85 + 10 boost
  });

  it("verdict is PASS when all agents approve", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts"],
      [
        makeResult({ verdict: "approve" }),
        makeResult({ agent: "spec-compliance-checker", verdict: "approve" }),
      ],
      [],
    );

    expect(brief.panel_verdict).toBe("pass");
  });

  it("verdict is FAIL when an agent requests changes with high-confidence blockers", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts"],
      [
        makeResult({
          verdict: "request_changes",
          findings: [
            makeFinding({ severity: "critical", confidence: 90 }),
          ],
        }),
      ],
      [],
    );

    expect(brief.panel_verdict).toBe("fail");
    expect(brief.fail_reasons.length).toBeGreaterThan(0);
  });

  it("verdict is CONDITIONAL when there are tradeoffs but no blockers", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts"],
      [
        makeResult({
          verdict: "comment",
          findings: [
            makeFinding({ category: "tradeoff", severity: "medium", confidence: 85 }),
          ],
        }),
      ],
      [],
    );

    expect(brief.panel_verdict).toBe("conditional");
    expect(brief.human_attention.length).toBeGreaterThan(0);
  });

  it("counts actionable and blocker findings correctly", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts"],
      [
        makeResult({
          findings: [
            makeFinding({ id: "cr-001", category: "actionable", severity: "high", confidence: 90 }),
            makeFinding({ id: "cr-002", category: "actionable", severity: "low", confidence: 85, file: "src/bar.ts" }),
            makeFinding({ id: "cr-003", category: "tradeoff", severity: "medium", confidence: 85, file: "src/baz.ts" }),
            makeFinding({ id: "cr-004", category: "security", severity: "critical", confidence: 95, file: "src/auth.ts" }),
          ],
        }),
      ],
      [],
    );

    expect(brief.actionable_count).toBe(3); // actionable + security
    expect(brief.tradeoff_count).toBe(1);
    expect(brief.blocker_count).toBe(2); // high@90 + critical@95
  });

  it("estimates token cost correctly", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts"],
      [
        makeResult({
          model: "sonnet",
          token_usage: { input: 1_000_000, output: 100_000 },
        }),
        makeResult({
          agent: "red-team",
          model: "opus",
          token_usage: { input: 500_000, output: 50_000 },
        }),
      ],
      [],
    );

    // sonnet: 1M * $3 + 100k * $15 = $3 + $1.50 = $4.50
    // opus: 500k * $15 + 50k * $75 = $7.50 + $3.75 = $11.25
    // total: $15.75
    expect(brief.estimated_cost_usd).toBe(15.75);
    expect(brief.total_tokens.input).toBe(1_500_000);
    expect(brief.total_tokens.output).toBe(150_000);
  });

  it("records skipped agents", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts"],
      [makeResult()],
      [{ name: "red-team", reason: "no security files" }],
    );

    expect(brief.agents_skipped).toHaveLength(1);
    expect(brief.agents_skipped[0].name).toBe("red-team");
  });

  it("sorts findings by severity then confidence", () => {
    const brief = compileBrief(
      215,
      "spec",
      ["src/foo.ts"],
      [
        makeResult({
          findings: [
            makeFinding({ id: "cr-001", severity: "low", confidence: 95, file: "a.ts" }),
            makeFinding({ id: "cr-002", severity: "critical", confidence: 85, file: "b.ts" }),
            makeFinding({ id: "cr-003", severity: "high", confidence: 90, file: "c.ts" }),
            makeFinding({ id: "cr-004", severity: "high", confidence: 95, file: "d.ts" }),
          ],
        }),
      ],
      [],
    );

    expect(brief.findings[0].severity).toBe("critical");
    expect(brief.findings[1].severity).toBe("high");
    expect(brief.findings[1].confidence).toBe(95);
    expect(brief.findings[2].severity).toBe("high");
    expect(brief.findings[2].confidence).toBe(90);
    expect(brief.findings[3].severity).toBe("low");
  });
});
