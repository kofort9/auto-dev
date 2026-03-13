import { describe, it, expect, vi } from "vitest";
import { deadCodeScanner } from "../../src/categories/dead-code.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("deadCodeScanner", () => {
  it("has the correct category name", () => {
    expect(deadCodeScanner.name).toBe("dead-code");
  });

  it("detects unused exports in a temp directory", async () => {
    // Create a minimal test fixture
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bugbot-test-"));
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    // File with an export that nothing imports
    fs.writeFileSync(
      path.join(srcDir, "unused.ts"),
      `export function unusedHelper(): void {}\nexport function anotherUnused(): string { return ""; }\n`,
    );

    // File that imports nothing from unused.ts
    fs.writeFileSync(
      path.join(srcDir, "main.ts"),
      `import { something } from "./other.js";\n`,
    );

    const files = ["src/unused.ts", "src/main.ts"];
    const findings = await deadCodeScanner.scan(files, tmpDir);

    expect(findings.length).toBe(2);
    expect(findings[0].title).toContain("unusedHelper");
    expect(findings[1].title).toContain("anotherUnused");
    expect(findings[0].category).toBe("dead-code");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("skips barrel index files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bugbot-test-"));
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, "index.ts"),
      `export { foo } from "./foo.js";\n`,
    );

    const files = ["src/index.ts"];
    const findings = await deadCodeScanner.scan(files, tmpDir);
    expect(findings.length).toBe(0);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
