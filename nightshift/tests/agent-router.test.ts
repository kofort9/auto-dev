import { describe, it, expect } from "vitest";
import { selectAgents } from "../src/agent-router.js";

describe("selectAgents", () => {
  it("always includes the three base agents", () => {
    const { toRun } = selectAgents(["src/utils/helper.ts"]);
    expect(toRun).toContain("code-reviewer");
    expect(toRun).toContain("spec-compliance-checker");
    expect(toRun).toContain("test-coverage-checker");
  });

  it("skips red-team and ml-specialist for unrelated files", () => {
    const { toRun, skipped } = selectAgents(["src/utils/helper.ts", "src/index.ts"]);
    expect(toRun).toHaveLength(3);
    expect(skipped).toHaveLength(2);
    expect(skipped.map((s) => s.name)).toContain("red-team");
    expect(skipped.map((s) => s.name)).toContain("ml-specialist");
  });

  it("triggers red-team for auth files", () => {
    const { toRun } = selectAgents(["src/auth/login.ts"]);
    expect(toRun).toContain("red-team");
  });

  it("triggers red-team for middleware files", () => {
    const { toRun } = selectAgents(["src/middleware/cors.ts"]);
    expect(toRun).toContain("red-team");
  });

  it("triggers red-team for files with validation", () => {
    const { toRun } = selectAgents(["src/core/validate-input.ts"]);
    expect(toRun).toContain("red-team");
  });

  it("triggers red-team for api/ paths", () => {
    const { toRun } = selectAgents(["src/api/users.ts"]);
    expect(toRun).toContain("red-team");
  });

  it("triggers red-team for .env files", () => {
    const { toRun } = selectAgents([".env.example"]);
    expect(toRun).toContain("red-team");
  });

  it("triggers red-team for secret/key files", () => {
    const { toRun } = selectAgents(["config/secret-keys.ts"]);
    expect(toRun).toContain("red-team");
  });

  it("triggers ml-specialist for scoring files", () => {
    const { toRun } = selectAgents(["src/domain/nonprofit/scoring.ts"]);
    expect(toRun).toContain("ml-specialist");
  });

  it("triggers ml-specialist for threshold files", () => {
    const { toRun } = selectAgents(["src/domain/nonprofit/sector-threshold.ts"]);
    expect(toRun).toContain("ml-specialist");
  });

  it("triggers ml-specialist for similarity files", () => {
    const { toRun } = selectAgents(["src/domain/nonprofit/similar-orgs.ts"]);
    expect(toRun).toContain("ml-specialist");
  });

  it("triggers ml-specialist for confidence files", () => {
    const { toRun } = selectAgents(["src/domain/nonprofit/confidence-calc.ts"]);
    expect(toRun).toContain("ml-specialist");
  });

  it("triggers ml-specialist for classification files", () => {
    const { toRun } = selectAgents(["src/domain/nonprofit/classify-filing.ts"]);
    expect(toRun).toContain("ml-specialist");
  });

  it("triggers ml-specialist for financial files", () => {
    const { toRun } = selectAgents(["src/domain/nonprofit/financial-health.ts"]);
    expect(toRun).toContain("ml-specialist");
  });

  it("triggers both conditional agents when both patterns match", () => {
    const { toRun, skipped } = selectAgents([
      "src/auth/session-handler.ts",
      "src/domain/nonprofit/scoring.ts",
    ]);
    expect(toRun).toHaveLength(5);
    expect(toRun).toContain("red-team");
    expect(toRun).toContain("ml-specialist");
    expect(skipped).toHaveLength(0);
  });

  it("handles empty file list", () => {
    const { toRun, skipped } = selectAgents([]);
    expect(toRun).toHaveLength(3);
    expect(skipped).toHaveLength(2);
  });

  it("skipped entries have human-readable reasons", () => {
    const { skipped } = selectAgents(["README.md"]);
    const rtSkip = skipped.find((s) => s.name === "red-team");
    const mlSkip = skipped.find((s) => s.name === "ml-specialist");
    expect(rtSkip?.reason).toBe("no security files");
    expect(mlSkip?.reason).toBe("no scoring files");
  });
});
