import { describe, it, expect } from "vitest";
import { buildQueue } from "../src/queue.js";
import type { NightshiftState } from "../src/types.js";

describe("buildQueue", () => {
  const issues = [
    { number: 215, title: "Fix widget" },
    { number: 216, title: "Add tests" },
    { number: 217, title: "Refactor auth" },
    { number: 218, title: "Update docs" },
  ];

  it("skips completed issues", () => {
    const state: NightshiftState = {
      run_id: "test",
      issues: {
        "215": { status: "completed", duration_s: 100 },
        "216": { status: "failed", phase: "verify" },
      },
    };

    // buildQueue calls updateIssue internally, so we mock state module
    // For this test, we just verify the filtering logic
    const { queue, skippedCompleted } = buildQueue(issues, state);

    expect(skippedCompleted).toBe(1); // #215 completed
    expect(queue).toHaveLength(3); // #216, #217, #218
    expect(queue.map((e) => e.number)).toEqual([216, 217, 218]);
  });

  it("includes failed issues for retry", () => {
    const state: NightshiftState = {
      run_id: "test",
      issues: {
        "215": { status: "failed", phase: "review" },
      },
    };

    const { queue } = buildQueue(issues, state);
    expect(queue.find((e) => e.number === 215)).toBeDefined();
  });

  it("returns empty queue when all completed", () => {
    const state: NightshiftState = {
      run_id: "test",
      issues: {
        "215": { status: "completed" },
        "216": { status: "completed" },
        "217": { status: "completed" },
        "218": { status: "completed" },
      },
    };

    const { queue, skippedCompleted } = buildQueue(issues, state);
    expect(queue).toHaveLength(0);
    expect(skippedCompleted).toBe(4);
  });
});
