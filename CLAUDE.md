# auto-dev

Autonomous development pipeline — bugbot scanner + nightshift job queue.

## Structure

- `bugbot/` — Static + LLM-powered code scanner that files GitHub issues against the VE repo
- `nightshift/` — Job queue that discovers `auto-ready` issues, runs Claude Code headlessly, produces draft PRs

Both tools operate ON `~/Repos/nonprofit-vetting-engine` but live here independently.

## Code Conventions

- TypeScript, strict mode, ESM (`type: module`)
- Vitest for testing
- npm workspaces (root + per-tool package.json)
- `TARGET_REPO` env var points at the VE repo (default: `~/Repos/nonprofit-vetting-engine`)

## Key Commands

```bash
npm test                                          # All tests
npm run verify                                    # Format + build + lint + test
npx tsx bugbot/src/index.ts --dry-run             # Bugbot dry run
npx tsx nightshift/src/index.ts status            # Nightshift status
TARGET_REPO=~/Repos/nonprofit-vetting-engine npx tsx nightshift/src/index.ts run --dry-run
```

## Environment

- `TARGET_REPO` — Path to VE repo (default: `~/Repos/nonprofit-vetting-engine`)
- `SCAN_ROOT` — Bugbot scan target (default: `~/Repos/nonprofit-vetting-engine`)
- `BUGBOT_ROOT` — Bugbot install dir (default: `~/Repos/auto-dev/bugbot`)
- State lives in `~/.auto-dev/` (nightshift) and `~/.bugbot/` (bugbot)
