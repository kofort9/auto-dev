import { describe, it, expect } from "vitest";
import {
  writeSpec,
  sanitizeTitle,
  redactSecrets,
  hasSecret,
} from "../src/publisher.js";
import type { Finding } from "../src/types.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "test-id",
    category: "dead-code",
    severity: "medium",
    file: "src/core/utils.ts",
    lineStart: 42,
    lineEnd: 42,
    title: "Unused export: helperFn",
    description: "helperFn is exported but never imported elsewhere.",
    suggestedFix: "Remove the export and declaration.",
    confidence: 80,
    riskTier: "low",
    status: "new",
    ...overrides,
  };
}

describe("writeSpec", () => {
  it("generates issue body with all sections", () => {
    const spec = writeSpec(makeFinding(), "2026-03-14");
    expect(spec).toContain("## Summary");
    expect(spec).toContain("## Files");
    expect(spec).toContain("## Implementation Steps");
    expect(spec).toContain("## Test Requirements");
    expect(spec).toContain("## Patterns to Follow");
    expect(spec).toContain("## Out of Scope");
    expect(spec).toContain("bugbot scan 2026-03-14");
    expect(spec).toContain("confidence: 80%");
  });

  it("includes file path and line number", () => {
    const spec = writeSpec(makeFinding(), "2026-03-14");
    expect(spec).toContain("`src/core/utils.ts:42`");
  });

  it("generates category-specific implementation steps", () => {
    const deadCode = writeSpec(makeFinding({ category: "dead-code" }), "2026-03-14");
    expect(deadCode).toContain("Remove the export");

    const typeHoles = writeSpec(makeFinding({ category: "type-holes" }), "2026-03-14");
    expect(typeHoles).toContain("Replace the type suppression");

    const testCoverage = writeSpec(makeFinding({ category: "test-coverage" }), "2026-03-14");
    expect(testCoverage).toContain("Add unit tests");

    const stale = writeSpec(makeFinding({ category: "stale-comments" }), "2026-03-14");
    expect(stale).toContain("Determine if the TODO/FIXME is still relevant");
  });
});

describe("sanitizeTitle", () => {
  it("strips backticks and quotes", () => {
    expect(sanitizeTitle('Test `code` "quoted"')).toBe("Test code quoted");
  });

  it("replaces newlines with spaces", () => {
    expect(sanitizeTitle("Line1\nLine2")).toBe("Line1 Line2");
  });

  it("truncates to 80 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeTitle(long).length).toBe(80);
  });
});

describe("secret detection", () => {
  it("detects GitHub PATs", () => {
    expect(hasSecret("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")).toBe(true);
  });

  it("detects AWS access keys", () => {
    expect(hasSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("detects Stripe-style keys", () => {
    expect(hasSecret("sk_live_abcdefghijklmnopqrstuvwxyz")).toBe(true);
  });

  it("does not flag normal code", () => {
    expect(hasSecret("const x = 42;")).toBe(false);
    expect(hasSecret("export function hello()")).toBe(false);
  });

  it("redacts detected secrets", () => {
    const input = "Key: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_");
  });
});
