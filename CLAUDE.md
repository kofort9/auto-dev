# auto-dev

Autonomous development pipeline — bugbot scanner + nightshift job queue.

## Structure

- `bugbot/` — Static + LLM-powered code scanner that files GitHub issues against the target repo
- `nightshift/` — Job queue that discovers `auto-ready` issues, runs Claude Code headlessly, produces draft PRs

Both tools operate on the `TARGET_REPO` (set in `.env`) but live here independently.

## Code Conventions

- TypeScript, strict mode, ESM (`type: module`)
- Vitest for testing
- npm workspaces (root + per-tool package.json)
- `TARGET_REPO` env var points at the target repo (set in `.env`)

## Key Commands

```bash
npm test                                          # All tests
npm run verify                                    # Format + build + lint + test
npx tsx bugbot/src/index.ts --dry-run             # Bugbot dry run
npx tsx nightshift/src/index.ts status            # Nightshift status
TARGET_REPO=~/Repos/your-target-repo npx tsx nightshift/src/index.ts run --dry-run
```

## Environment

- `TARGET_REPO` — Path to target repo (set in `.env`)
- `SCAN_ROOT` — Bugbot scan target (defaults to `TARGET_REPO`)
- `BUGBOT_ROOT` — Bugbot install dir (defaults to `./bugbot`)
- State lives in `~/.auto-dev/` (nightshift) and `~/.bugbot/` (bugbot)
