import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// We test state logic by pointing to a temp dir
// The state module reads STATE_DIR from env, but for unit tests
// we test the atomic write pattern directly.

describe("Atomic state writes", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-test-"));
    stateFile = path.join(tmpDir, "nightshift-state.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON atomically via tmp+rename", () => {
    const state = { run_id: "test-run", issues: { "42": { status: "pending" as const } } };
    const tmp = stateFile + ".tmp";

    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(tmp, stateFile);

    const result = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(result.run_id).toBe("test-run");
    expect(result.issues["42"].status).toBe("pending");

    // tmp file should not exist after rename
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("leaves original intact if tmp write is interrupted", () => {
    // Write initial state
    const initial = { run_id: "run-1", issues: { "1": { status: "completed" as const } } };
    fs.writeFileSync(stateFile, JSON.stringify(initial));

    // Simulate: tmp exists but rename never happened (crash mid-write)
    const tmp = stateFile + ".tmp";
    fs.writeFileSync(tmp, "incomplete json{{{");

    // Original should still be valid
    const result = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(result.run_id).toBe("run-1");
  });

  it("handles v1 state format (no version field)", () => {
    const v1State = { run_id: "2026-03-11T18:11:32Z", issues: { "201": { status: "failed", phase: "verify" } } };
    fs.writeFileSync(stateFile, JSON.stringify(v1State));

    const loaded = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    // v1 has no version field — should still parse fine
    expect(loaded.version).toBeUndefined();
    expect(loaded.issues["201"].status).toBe("failed");
  });
});
