import { describe, it, expect } from "vitest";
import { inputValidationScanner } from "../../src/categories/input-validation.js";

describe("inputValidationScanner", () => {
  it("has the correct category name", () => {
    expect(inputValidationScanner.name).toBe("input-validation");
  });

  // Integration test with real LLM is too expensive for CI.
  // The scanner is validated via dry-run against the target repo.
  // Unit tests cover the supporting functions (llm.test.ts).
});
