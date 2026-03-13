import { describe, it, expect } from "vitest";
import { getRiskTier } from "../src/scanner.js";

describe("getRiskTier", () => {
  it("returns high for scoring files", () => {
    expect(getRiskTier("src/domain/nonprofit/scoring.ts")).toBe("high");
    expect(getRiskTier("src/domain/nonprofit/scoring-criteria.ts")).toBe("high");
    expect(getRiskTier("src/domain/nonprofit/scoring-math.ts")).toBe("high");
  });

  it("returns high for financial and red-flag files", () => {
    expect(getRiskTier("src/domain/nonprofit/financial-averaging.ts")).toBe("high");
    expect(getRiskTier("src/domain/nonprofit/detect-red-flags.ts")).toBe("high");
  });

  it("returns high for server files (glob)", () => {
    expect(getRiskTier("src/server/index.ts")).toBe("high");
    expect(getRiskTier("src/server/nonprofit-tools.ts")).toBe("high");
  });

  it("returns high for specific data-source files before medium glob matches", () => {
    // csv-data-store.ts is listed explicitly as high, even though src/data-sources/** is medium
    expect(getRiskTier("src/data-sources/csv-data-store.ts")).toBe("high");
    expect(getRiskTier("src/data-sources/token-decomposer.ts")).toBe("high");
  });

  it("returns medium for remaining data-source files", () => {
    expect(getRiskTier("src/data-sources/bmf-parser.ts")).toBe("medium");
    expect(getRiskTier("src/data-sources/sqlite-adapter.ts")).toBe("medium");
  });

  it("returns medium for gates", () => {
    expect(getRiskTier("src/domain/gates/gate-runner.ts")).toBe("medium");
  });

  it("returns medium for parsers and builders", () => {
    expect(getRiskTier("src/domain/nonprofit/xml-parser.ts")).toBe("medium");
    expect(getRiskTier("src/domain/nonprofit/local-profile-builder.ts")).toBe("medium");
  });

  it("returns low for core utilities", () => {
    expect(getRiskTier("src/core/config.ts")).toBe("low");
  });

  it("returns low for discovery", () => {
    expect(getRiskTier("src/domain/discovery/pipeline.ts")).toBe("low");
  });

  it("returns low for unmatched files", () => {
    expect(getRiskTier("some/random/file.ts")).toBe("low");
  });
});
