# auto-dev

Autonomous development pipeline that pairs with any GitHub-hosted TypeScript/Node repo. Three components work together: **bugbot** scans the codebase for issues and files them on GitHub, **nightshift** picks them up and implements fixes autonomously using Claude Code, and **self-review** triages its own PRs before you see them.

> **Note:** Currently TypeScript-only. The verification gates (`npm run verify`, dependency guard, etc.) assume a Node/TS project. Supporting other languages would require swappable verify commands and language-aware guardrails.

## Prerequisites

- Node.js 18+
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) — authenticated
- `npx tsx` (included with Node 18+)
- tmux (for `nightshift start`)

## Architecture

```
bugbot scan → GitHub Issues (labeled "nightshift")
                    ↓
nightshift start → picks up issues → Claude Code headless
                    ↓
    Phases 1-5:  discover → setup worktree → execute → simplify → verify → [sentinel.json]
    Phases 6-9:  [sentinel.json] → panel review → simplify filter → fix → re-verify → publish draft PR
    Phases 10-12: self-review → auto-fix loop → triage
                    ↓
    Morning summary: auto-approved / self-fixed / needs-human
```

See [`docs/pipeline-explainer.html`](docs/pipeline-explainer.html) for an interactive visual breakdown.

## Setup

```bash
git clone <this-repo-url>
cd auto-dev
npm install
cp .env.example .env   # edit TARGET_REPO to point at your project
```

Add the CLI functions to your shell:

```bash
echo 'source /path/to/auto-dev/nightshift/nightshift.zsh' >> ~/.zshrc
```

If you clone to a non-standard location, set `AUTO_DEV_REPO` to the repo root:

```bash
export AUTO_DEV_REPO=~/projects/auto-dev  # default: ~/Repos/auto-dev
```

## Usage

### Bugbot (scan + file issues)

```bash
bugbot                    # Run all scanners against TARGET_REPO
bugbot --dry-run          # Show findings without filing issues
bugbot --category dead-code  # Run specific scanner only
```

### Nightshift (autonomous implementation)

```bash
nightshift start                    # Launch in tmux with dashboard
nightshift start --at 2:00          # Start at 2:00 AM tonight (sleeps in tmux)
nightshift start --in 1h            # Start in 1 hour
nightshift start --fresh            # Ignore prior state, start clean
nightshift start --issue 184,185    # Process specific issues (comma-separated, passed individually to auto-dev.sh)
nightshift start --concurrency 3    # Parallel workers
nightshift start --dry-run          # Preview queue without executing
nightshift start --max-failures 3   # Stop after N consecutive failures
nightshift status                   # One-shot status check
nightshift log                      # Tail $STATE_DIR/nightshift.log
nightshift stop                     # Kill the tmux session (also cancels scheduled runs)
nightshift promote                  # Label next wave of unblocked issues
```

Flags can be combined: `nightshift start --at 2:00 --concurrency 2 --fresh`

## Pipeline Phases

| Phase | Name | Tool | Description |
|-------|------|------|-------------|
| 1 | Discover | auto-dev.sh | Find `nightshift`-labeled issues via `gh` |
| 2 | Setup | auto-dev.sh | Create git worktree from `origin/main` |
| 3 | Execute | auto-dev.sh | Claude Code implements the fix headlessly + scope constraints (no cascade deletions) |
| 4 | Simplify | auto-dev.sh | Code quality pass (Claude reviews own work) + scope-limited (won't delete code spec didn't mention) |
| 5 | Verify | auto-dev.sh | Gates 1-5: verify, file limits (≤15), line limits (≤500 total), dependency guard (positive-verb match), deletion budget (≤15 net / ≤40 gross). Writes sentinel JSON on success |
| — | Handoff | auto-dev.sh → worker.ts | Sentinel JSON (with `net_deletions`, `head_sha`) bridges bash and TypeScript layers |
| 6 | Panel Review | worker.ts | Always: code-reviewer, spec-compliance-checker, test-coverage-checker, scope-checker. Conditional: red-team (security files), ml-specialist (scoring files) |
| 6.5 | Simplify Filter | worker.ts | Remove overengineered review suggestions |
| 7 | Fix | worker.ts | Apply actionable review findings |
| 8 | Re-verify | worker.ts | `npm run verify` after fixes |
| 9 | Publish | worker.ts | Create draft PR, post review brief |
| 10 | Self-Review | pr-self-review.ts | Review each PR diff, classify findings |
| 11 | Auto-Fix | pr-self-review.ts | Fix auto-fixable findings, re-verify, push |
| 12 | Triage | pr-self-review.ts | Deterministic: approve / self-fix / flag for human |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TARGET_REPO` | `~/Repos/your-target-repo` | Repository to scan and process |
| `STATE_DIR` | `~/.auto-dev` | Nightshift state, logs, and run artifacts |
| `BUGBOT_STATE` | `~/.bugbot` | Bugbot state directory |
| `SCAN_ROOT` | Same as `TARGET_REPO` | Bugbot scan target (if different) |
| `BUGBOT_ROOT` | `~/Repos/auto-dev/bugbot` | Bugbot source directory |

## Label Lifecycle

```
[bugbot files issue]
    → adds: auto-ready + nightshift + bugbot + bugbot:{category} + priority:{level}
        → [nightshift picks up]
            → removes: auto-ready + nightshift
            → [success] adds: auto-pr-ready (draft PR created)
            → [no changes] issue closed with comment (no label added)
            → [failure] adds: auto-failed
```

- `nightshift` — scoped for autonomous processing
- `auto-ready` — specced and ready (broader gate)
- `auto-pr-ready` — PR created, awaiting human merge
- `auto-failed` — pipeline failed, needs investigation
- `bugbot` — filed by bugbot (vs. manually created)
- `bugbot:{category}` — scanner category (e.g., `bugbot:dead-code`, `bugbot:type-holes`)
- `priority:{level}` — severity-based priority (e.g., `priority:high`, `priority:low`)

## Wave Promotion

Nightshift includes a dependency-aware promoter (`nightshift promote`) that uses Kahn's algorithm to find issues whose dependencies are all satisfied (closed or PR-ready), then labels them for the next run.
