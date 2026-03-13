import { describe, it, expect } from "vitest";
import { extractDependencies } from "../src/promoter.js";

describe("extractDependencies", () => {
  it("extracts 'Depends on #N' patterns", () => {
    const body = "This issue depends on #42 and depends on #100.";
    expect(extractDependencies(body)).toEqual([42, 100]);
  });

  it("extracts 'Blocked by #N' patterns", () => {
    const body = "Blocked by #10, also blocked by #20";
    expect(extractDependencies(body)).toEqual([10, 20]);
  });

  it("extracts 'Prerequisite #N' patterns", () => {
    const body = "Prerequisite: complete #55 first";
    expect(extractDependencies(body)).toEqual([55]);
  });

  it("deduplicates references", () => {
    const body = "Depends on #42. Also depends on #42 again.";
    expect(extractDependencies(body)).toEqual([42]);
  });

  it("returns empty array for no dependencies", () => {
    const body = "Simple fix, no blockers. Fixes #99.";
    expect(extractDependencies(body)).toEqual([]);
  });

  it("is case-insensitive", () => {
    const body = "DEPENDS ON #7, BLOCKED BY #8";
    expect(extractDependencies(body)).toEqual([7, 8]);
  });

  it("handles empty body", () => {
    expect(extractDependencies("")).toEqual([]);
  });

  it("sorts results numerically", () => {
    const body = "Depends on #100, depends on #3, depends on #50";
    expect(extractDependencies(body)).toEqual([3, 50, 100]);
  });
});
