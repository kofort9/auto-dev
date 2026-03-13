import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createLogger } from "../log.js";
import { getRiskTier } from "../scanner.js";
import type { CategoryScanner, Finding } from "../types.js";

const log = createLogger("dead-code");

interface ExportInfo {
  name: string;
  file: string;
  line: number;
  isType: boolean; // type/interface — harder to trace, lower confidence
}

function findExports(files: string[], scanRoot: string): ExportInfo[] {
  const exports: ExportInfo[] = [];
  const exportRe =
    /^export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/;

  for (const relFile of files) {
    // Skip barrel files — they re-export and aren't dead code
    if (path.basename(relFile) === "index.ts") continue;
    // Skip test files
    if (relFile.includes(".test.")) continue;

    const absPath = path.join(scanRoot, relFile);
    const lines = fs.readFileSync(absPath, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(exportRe);
      if (match) {
        const isType = /^export\s+(?:type|interface)\s/.test(lines[i]);
        exports.push({ name: match[1], file: relFile, line: i + 1, isType });
      }
    }
  }
  return exports;
}

// Batch grep: find all export names referenced anywhere in src/
function buildReferencedSet(
  exports: ExportInfo[],
  scanRoot: string,
): Set<string> {
  if (exports.length === 0) return new Set();

  const referenced = new Set<string>();
  const BATCH_SIZE = 200;
  const names = exports.map((e) => e.name);

  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    const pattern = batch.join("|");

    try {
      const result = execFileSync(
        "grep",
        ["-rohE", pattern, "--include=*.ts", path.join(scanRoot, "src")],
        { cwd: scanRoot, stdio: ["pipe", "pipe", "pipe"] },
      )
        .toString()
        .trim();

      if (result) {
        for (const match of result.split("\n")) {
          if (match) referenced.add(match);
        }
      }
    } catch {
      // grep exit 1 = no matches
    }
  }

  return referenced;
}

// Per-export verification: is this name actually imported by another file?
function isImportedByOtherFile(
  name: string,
  sourceFile: string,
  scanRoot: string,
): boolean {
  try {
    const result = execFileSync(
      "grep",
      ["-rl", "--include=*.ts", name, path.join(scanRoot, "src")],
      { cwd: scanRoot, stdio: ["pipe", "pipe", "pipe"] },
    )
      .toString()
      .trim();

    if (!result) return false;

    const importingFiles = result.split("\n").filter(Boolean);
    const absSource = path.join(scanRoot, sourceFile);

    for (const f of importingFiles) {
      if (f === absSource) continue;
      const content = fs.readFileSync(f, "utf-8");
      // Catch: import { Foo }, import type { Foo }, typeof Foo
      const importPattern = new RegExp(
        `(?:import|import\\s+type|from).*\\b${name}\\b|\\b${name}\\b.*(?:from)|\\btypeof\\s+${name}\\b`,
      );
      if (importPattern.test(content)) return true;
    }
  } catch {
    // grep returns exit 1 on no matches
  }
  return false;
}

function isUsedInSameFile(
  name: string,
  line: number,
  sourceFile: string,
  scanRoot: string,
): boolean {
  const absPath = path.join(scanRoot, sourceFile);
  const lines = fs.readFileSync(absPath, "utf-8").split("\n");

  // Check if the name appears on any line OTHER than the export declaration
  const nameRe = new RegExp(`\\b${name}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (i === line - 1) continue; // skip the export line itself
    if (nameRe.test(lines[i])) return true;
  }
  return false;
}

function makeId(file: string, line: number): string {
  return createHash("sha256")
    .update(`dead-code:${file}:${line}-${line}`)
    .digest("hex")
    .slice(0, 16);
}

// Cache tool-registry content (read once, not per export)
let toolRegistryCache: string | null = null;
function isToolEntryCached(name: string, scanRoot: string): boolean {
  if (toolRegistryCache === null) {
    const registryPath = path.join(scanRoot, "src/server/tool-registry.ts");
    try {
      toolRegistryCache = fs.readFileSync(registryPath, "utf-8");
    } catch {
      toolRegistryCache = "";
    }
  }
  return toolRegistryCache.includes(name);
}

export const deadCodeScanner: CategoryScanner = {
  name: "dead-code",
  async scan(files, scanRoot) {
    log("Scanning for unused exports...");
    toolRegistryCache = null; // reset per scan
    const exports = findExports(files, scanRoot);
    log(`Found ${exports.length} exports to check`);

    // Phase 1: fast batch grep to find names that appear ANYWHERE in src/
    // Names not in this set are definitely unused — no per-file check needed
    const referenced = buildReferencedSet(exports, scanRoot);
    log(`${referenced.size}/${exports.length} export names appear somewhere in src/`);

    const findings: Finding[] = [];

    for (const exp of exports) {
      if (isToolEntryCached(exp.name, scanRoot)) continue;

      // Fast path: name appears nowhere outside grep → definitely dead
      // Slow path: name appears somewhere → verify it's an actual import from another file
      if (referenced.has(exp.name)) {
        // Name exists in src/ — but could be same-file usage or a different symbol with same name
        // Check same-file first (cheap), then cross-file imports (expensive)
        if (isUsedInSameFile(exp.name, exp.line, exp.file, scanRoot)) continue;
        if (isImportedByOtherFile(exp.name, exp.file, scanRoot)) continue;
      }

      const riskTier = getRiskTier(exp.file);
      findings.push({
        id: makeId(exp.file, exp.line),
        category: "dead-code",
        severity: riskTier === "high" ? "medium" : "low",
        file: exp.file,
        lineStart: exp.line,
        lineEnd: exp.line,
        title: `Unused export: ${exp.name}`,
        description: `\`${exp.name}\` is exported from \`${exp.file}\` but has no import references in the codebase. If unused, remove it to reduce surface area.`,
        suggestedFix: `Remove the export or the entire declaration if unused.`,
        confidence: exp.isType ? 65 : 75,
        riskTier,
        status: "new",
      });
    }

    log(`Found ${findings.length} dead code candidates`);
    return findings;
  },
};
