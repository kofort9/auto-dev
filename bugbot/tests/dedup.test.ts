import { describe, it, expect, vi, beforeEach } from "vitest";
import { isDuplicate } from "../src/dedup.js";
import type { Finding, ScanState } from "../src/types.js";

// Mock execFileSync to avoid real gh calls
vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => "[]"),
}));

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "abc123",
    category: "dead-code",
    severity: "medium",
    file: "src/core/utils.ts",
    lineStart: 10,
    lineEnd: 10,
    title: "Unused export: helperFn",
    description: "helperFn is unused",
    confidence: 80,
    riskTier: "low",
    status: "new",
    ...overrides,
  };
}

function makeState(overrides: Partial<ScanState> = {}): ScanState {
  return {
    lastScanDate: null,
    lastGitTreeHash: null,
    fingerprints: {},
    ...overrides,
  };
}

describe("isDuplicate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns duplicate when fingerprint exists in state", async () => {
    const finding = makeFinding({ id: "known-id" });
    const state = makeState({
      fingerprints: {
        "known-id": { firstSeen: "2026-03-01", lastSeen: "2026-03-07" },
      },
    });
    const emptyCache = new Map();

    const result = await isDuplicate(finding, state, emptyCache);
    expect(result.duplicate).toBe(true);
    expect(result.reason).toBe("previous-scan");
  });

  it("returns not duplicate for new findings with no GH matches", async () => {
    const finding = makeFinding({ id: "new-id" });
    const state = makeState();
    const emptyCache = new Map();

    const result = await isDuplicate(finding, state, emptyCache);
    expect(result.duplicate).toBe(false);
  });

  it("returns duplicate when GH cache has matching issue", async () => {
    const finding = makeFinding({
      id: "new-id",
      file: "src/core/utils.ts",
      title: "Unused export: helperFn",
    });
    const state = makeState();
    const cache = new Map([
      [
        "src/core/utils.ts",
        {
          issues: [{ number: 99, title: "[bugbot] Unused export: helperFn" }],
          prs: [],
        },
      ],
    ]);

    const result = await isDuplicate(finding, state, cache);
    expect(result.duplicate).toBe(true);
    expect(result.reason).toBe("gh-issue-99");
  });

  it("returns duplicate when GH cache has open PR for file", async () => {
    const finding = makeFinding({ id: "new-id", file: "src/core/utils.ts" });
    const state = makeState();
    const cache = new Map([
      [
        "src/core/utils.ts",
        { issues: [], prs: [{ number: 42 }] },
      ],
    ]);

    const result = await isDuplicate(finding, state, cache);
    expect(result.duplicate).toBe(true);
    expect(result.reason).toBe("open-pr-42");
  });
});
