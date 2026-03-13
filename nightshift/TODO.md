# Nightshift TS Migration — TODO

## References

- **Auto-dev runbook**: `docs/auto-dev-runbook.md` — what works, what breaks, rework log
- **Code Factory gap analysis**: `~/Documents/Obsidian/sources/x/2026-03-11-ryancarson-code-factory-agent-setup--reflection.md`
  - SHA discipline (pin review state to PR head commit)
  - Machine-readable risk contract (tier by file path)
  - Harness-gap loop (every regression becomes a test case)

## From Session Log (2026-03-11 13:01)

6-phase migration plan:
1. Core engine
2. Promotion + CLI
3. Concurrency
4. OTEL
5. Web dashboard
6. Webhooks

Key decisions: bun runtime, `scripts/nightshift/` directory, v2 state format (superset of v1), semaphore worker pool.
