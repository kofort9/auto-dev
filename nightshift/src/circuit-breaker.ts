/**
 * Circuit breaker: halts the queue after N consecutive systemic failures.
 *
 * "Systemic" = crashed, timeout, execute, setup (infra problems).
 * "Spec" = verify, review (bad issue spec, not infra). These reset the counter.
 */

export class CircuitBreaker {
  private consecutiveCrashes = 0;
  private readonly threshold: number;

  constructor(maxFailures: number) {
    this.threshold = maxFailures;
  }

  /** Record a failure. Returns true if circuit breaker tripped. */
  recordFailure(phase: string): boolean {
    if (isSystemicFailure(phase)) {
      this.consecutiveCrashes += 1;
      return this.consecutiveCrashes >= this.threshold;
    }
    // Spec failure — reset counter (infra is fine, issue was bad)
    this.consecutiveCrashes = 0;
    return false;
  }

  recordSuccess(): void {
    this.consecutiveCrashes = 0;
  }

  get count(): number {
    return this.consecutiveCrashes;
  }

  get max(): number {
    return this.threshold;
  }
}

function isSystemicFailure(phase: string): boolean {
  // Spec failures (bad issue, not infra) are known safe — everything else is systemic
  const specFailures = ["verify", "review", "panel-review", "re-verify"];
  return !specFailures.includes(phase);
}
