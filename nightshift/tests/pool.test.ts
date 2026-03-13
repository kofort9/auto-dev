import { describe, it, expect } from "vitest";
import { WorkerPool } from "../src/pool.js";

describe("WorkerPool", () => {
  it("allows up to maxConcurrency workers", async () => {
    const pool = new WorkerPool(2);

    await pool.acquire(); // slot 1
    await pool.acquire(); // slot 2
    expect(pool.active).toBe(2);

    pool.release();
    expect(pool.active).toBe(1);

    pool.release();
    expect(pool.active).toBe(0);
  });

  it("blocks when all slots are occupied", async () => {
    const pool = new WorkerPool(1);
    const order: string[] = [];

    await pool.acquire();
    order.push("first-acquired");

    // This should block until release
    const blocked = pool.acquire().then(() => {
      order.push("second-acquired");
    });

    // Give the blocked promise a chance to resolve (it shouldn't)
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first-acquired"]);

    pool.release();
    await blocked;
    expect(order).toEqual(["first-acquired", "second-acquired"]);

    pool.release();
  });

  it("processes N items with concurrency limit", async () => {
    const pool = new WorkerPool(2);
    let maxConcurrent = 0;
    let current = 0;

    const work = async (id: number): Promise<number> => {
      await pool.acquire();
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 20));
      current--;
      pool.release();
      return id;
    };

    const results = await Promise.all([
      work(1), work(2), work(3), work(4), work(5),
    ]);

    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBe(2); // Should hit max
    expect(pool.active).toBe(0);
  });

  it("works with concurrency of 1 (sequential)", async () => {
    const pool = new WorkerPool(1);
    let maxConcurrent = 0;
    let current = 0;

    const work = async (): Promise<void> => {
      await pool.acquire();
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 5));
      current--;
      pool.release();
    };

    await Promise.all([work(), work(), work()]);
    expect(maxConcurrent).toBe(1);
  });
});
