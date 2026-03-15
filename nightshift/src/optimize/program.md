# nightshift optimize — program.md

You are an autonomous code optimizer for the nonprofit-vetting-engine screening pipeline.
Your goal: **reduce screening latency (p50)** while keeping all tests passing.

## Rules

- **Only modify files in `src/`** — do not touch `scripts/`, `benchmark/`, `data/`, or config files.
- **Do not change the public API** — `runScreening()` must return the same `ScreeningResult` shape.
- **Do not change test expectations** — if a test asserts specific behavior, preserve it.
- **One change per experiment** — keep diffs small and focused. This makes it easy to attribute improvements.
- **Simplicity wins** — if two approaches give similar gains, pick the simpler one.

## Ranked Optimization Targets

Based on pipeline profiling, these are the highest-impact areas:

### 1. Enricher Parallelization (HIGH)
The vetting pipeline runs 5 enrichers sequentially. Many are independent and can run in parallel with `Promise.all()`.
- **Files**: `src/domain/nonprofit/vetting-pipeline.ts`, enricher files in `src/domain/nonprofit/enrichers/`
- **Expected gain**: 30-50% p50 reduction
- **Risk**: Low — enrichers are stateless, no shared mutable state

### 2. Multi-Year Filing Parallelization (HIGH)
990 filings for multiple years are fetched sequentially. These can be parallelized.
- **Files**: `src/data-sources/xml-990-store.ts`, filing fetch logic
- **Expected gain**: 15-25% p50 reduction
- **Risk**: Low — independent HTTP requests

### 3. Red Flag Check Parallelization (MEDIUM)
~20 independent red flag checks run one at a time. Each is a pure function.
- **Files**: `src/domain/nonprofit/red-flags/`
- **Expected gain**: 5-15% p50 reduction
- **Risk**: Very low — pure functions with no side effects

### 4. Result Caching for External APIs (MEDIUM)
CourtListener and USAspending results are fetched fresh each time. Adding SQLite caching would eliminate redundant network calls.
- **Files**: `src/data-sources/courtlistener.ts`, `src/data-sources/usaspending.ts`
- **Expected gain**: Variable — depends on cache hit rate
- **Risk**: Low — additive change, no existing behavior modified

### 5. XML Parse Profiling (LOW)
XML-990 parsing may have hot spots. Profile and optimize the parse path.
- **Files**: `src/data-sources/xml-990-store.ts`, XML parsing utilities
- **Expected gain**: 5-10% if bottleneck found
- **Risk**: Low

### 6. Early-Exit Path Tightening (LOW)
Some screenings can exit earlier when gate-blocked. Ensure all early-exit paths are tight.
- **Files**: `src/domain/nonprofit/vetting-pipeline.ts`
- **Expected gain**: Small for individual runs, cumulative for batches
- **Risk**: Very low

## Context

The benchmark runs 15 diverse EINs through the full screening pipeline using cached SQLite data (no live API calls). The metric is **p50 latency in milliseconds** — lower is better.

An improvement counts only if p50 drops by **>=5%** AND `npm run verify` passes.

## Previous Results

Check `benchmark/results.tsv` for the history of experiments and their outcomes.
Use this to avoid repeating failed approaches and to build on successful ones.
