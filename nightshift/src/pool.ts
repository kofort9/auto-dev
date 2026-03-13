/**
 * Semaphore-based worker pool for concurrent issue processing.
 *
 * Limits how many auto-dev.sh instances run simultaneously.
 * Each slot is a Promise that resolves when the worker finishes.
 */

export class WorkerPool {
  private running = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly maxConcurrency: number) {}

  /** Acquire a slot. Blocks if all slots are occupied. */
  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }

    // Wait for a slot to free up
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.running++;
  }

  /** Release a slot, unblocking the next waiter if any. */
  release(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next) next();
  }

  get active(): number {
    return this.running;
  }

  get capacity(): number {
    return this.maxConcurrency;
  }
}
