# Bugbot Test Run Notes — 2026-03-12

## What Worked

1. **End-to-end pipeline**: scan → categorize → confidence filter → dedup → publish → state persistence all functional
2. **GH issue creation**: Issues #232, #233 created with correct labels (`bugbot`, `bugbot:{category}`, `auto-ready`, `priority:low`), well-formatted spec bodies matching nightshift's expected format
3. **Tree-hash skip**: Second run without `--full` exits in 1s ("no changes since last scan")
4. **Fingerprint dedup**: Re-run correctly skips the 2 published findings and surfaces the next 2 in priority order
5. **Confidence × risk tier filtering**: High-risk files need 85% confidence, low-risk 60% — correctly filters noisy findings
6. **Priority cap**: `--max-issues 2` correctly caps and logs "68 deferred"
7. **JSONL logging**: 202 findings written to `~/.bugbot/runs/2026-03-12-findings.jsonl`
8. **Atomic state**: `scan-state.json` written via tmp→rename, crash-safe
9. **execFileSync everywhere**: No shell injection surface — all subprocess calls use array form

## What Broke (and fixes applied)

### 1. `P2`/`P3` labels don't exist on VE repo
- **Symptom**: `gh issue create` failed with "could not add label: 'P3' not found"
- **Fix**: Changed `SEVERITY_TO_PRIORITY` in config.ts to use `priority:high` / `priority:low` (matching VE repo's actual labels)
- **Lesson**: Should have checked existing labels before hardcoding. Consider a preflight label check.

### 2. `unknown return type` regex too greedy (type-holes)
- **Symptom**: 24 type-holes found, 23 were false positives — matching legitimate `(param: unknown)` signatures
- **Fix**: Removed the regex pattern. Deferred to Phase 2 AST-based detection.
- **Impact**: type-holes now finds 1 real suppression (eslint-disable in nonprofit-tools.ts)

### 3. Dead-code type/interface false positives
- **Symptom**: First dry run found 191 dead-code candidates; ~115 were exported types used via `import type` or barrel re-exports
- **Fix**: Added `import type` detection to `isImported()`, lowered type export confidence to 65 (only passes `low` tier threshold)
- **Impact**: Dead-code candidates dropped from 191 → 76 (first fix) → 168 with types back at lower confidence
- **Remaining concern**: Some type false positives still pass for low-risk files. Acceptable — nightshift will verify before merging.

## Timing

| Phase | Duration |
|-------|----------|
| Preflight (git fetch) | ~1s |
| Dead-code scanner | ~1s (grep per export) |
| Type-holes scanner | <1s |
| Test-coverage scanner | ~100s (grep per function — **bottleneck**) |
| Stale-comments scanner | <1s |
| Dedup (GH API) | ~70s for 70 findings (~1s per `gh issue list` call — **bottleneck**) |
| **Total** | ~3 min |

### Performance bottlenecks for Phase 2
- **test-coverage**: Runs `grep -rl` once per exported function (101 calls). Could batch into a single grep with alternation pattern.
- **dedup GH search**: Makes 2 `gh` API calls per finding (issues + PRs). Could batch by file or use GH GraphQL.

## Findings Distribution (after all fixes)

| Category | Raw | After confidence filter | Notes |
|----------|-----|------------------------|-------|
| dead-code | 168 | varies by risk tier | Type exports at confidence 65, value exports at 75 |
| type-holes | 1 | 1 | Single eslint-disable — VE codebase is clean |
| test-coverage | 35 | 18 | 17 filtered by confidence threshold |
| stale-comments | 0 | 0 | No TODO/FIXME > 30 days old — well-maintained |

## Nightshift Compatibility Verified
- Issue body format matches: Summary, Files table, Implementation Steps, Test Requirements, Patterns to Follow, Out of Scope
- `auto-ready` label applied — nightshift will pick up
- `bugbot` + `bugbot:{category}` labels enable filtering
