import { describe, it, expect } from "vitest";
import { getRiskTier } from "../src/scanner.js";

describe("getRiskTier", () => {
  it("returns high for server files (glob)", () => {
    expect(getRiskTier("src/server/index.ts")).toBe("high");
    expect(getRiskTier("src/server/api-handler.ts")).toBe("high");
  });

  it("returns medium for data-source files", () => {
    expect(getRiskTier("src/data-sources/parser.ts")).toBe("medium");
    expect(getRiskTier("src/data-sources/adapter.ts")).toBe("medium");
  });

  it("returns low for core utilities", () => {
    expect(getRiskTier("src/core/config.ts")).toBe("low");
  });

  it("returns low for scripts", () => {
    expect(getRiskTier("scripts/setup.ts")).toBe("low");
  });

  it("returns low for tests", () => {
    expect(getRiskTier("tests/unit/helper.test.ts")).toBe("low");
  });

  it("returns low for unmatched files", () => {
    expect(getRiskTier("some/random/file.ts")).toBe("low");
  });
});
