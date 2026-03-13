import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("trips after threshold consecutive systemic failures", () => {
    const cb = new CircuitBreaker(3);
    expect(cb.recordFailure("crashed")).toBe(false);
    expect(cb.recordFailure("timeout")).toBe(false);
    expect(cb.recordFailure("execute")).toBe(true); // 3rd consecutive
  });

  it("resets counter on success", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure("crashed");
    cb.recordFailure("crashed");
    cb.recordSuccess();
    expect(cb.count).toBe(0);
    expect(cb.recordFailure("crashed")).toBe(false); // back to 1
  });

  it("resets counter on spec failures (verify/review)", () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure("crashed");
    cb.recordFailure("crashed");
    // Verify failure = bad spec, not systemic
    expect(cb.recordFailure("verify")).toBe(false);
    expect(cb.count).toBe(0);
  });

  it("does not count review failures as systemic", () => {
    const cb = new CircuitBreaker(2);
    cb.recordFailure("review");
    cb.recordFailure("review");
    cb.recordFailure("review");
    expect(cb.count).toBe(0); // all reset, never trips
  });

  it("counts setup failures as systemic", () => {
    const cb = new CircuitBreaker(2);
    expect(cb.recordFailure("setup")).toBe(false);
    expect(cb.recordFailure("setup")).toBe(true);
  });
});
