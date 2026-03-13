# auto-dev

Autonomous development pipeline for the [nonprofit-vetting-engine](https://github.com/kofort9/nonprofit-vetting-engine). Two tools work together: **bugbot** scans the codebase for issues and files them on GitHub, **nightshift** picks them up and implements fixes autonomously using Claude Code.

## Architecture

```
bugbot scan → GitHub Issues (labeled "nightshift")
                    ↓
nightshift start → picks up issues → Claude Code headless
                    ↓
    Phases 1-5:  discover → setup worktree → execute → simplify → verify
    Phases 6-9:  panel review → simplify filter → fix → re-verify → publish draft PR
    Phases 10-12: self-review → auto-fix loop → triage
                    ↓
    Morning summary: auto-approved / self-fixed / needs-human
```

See [`docs/pipeline-explainer.html`](docs/pipeline-explainer.html) for an interactive visual breakdown.

## Setup

```bash
git clone git@github.com:kofort9/auto-dev.git
cd auto-dev
npm install
cp .env.example .env   # edit paths if needed
```

Add the CLI functions to your shell:

```bash
echo 'source ~/Repos/auto-dev/nightshift/nightshift.zsh' >> ~/.zshrc
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
nightshift start --fresh            # Ignore prior state, start clean
nightshift start --issue 184,185    # Process specific issues only
nightshift start --concurrency 3    # Parallel workers
nightshift status                   # One-shot status check
nightshift log                      # Tail the log
nightshift stop                     # Kill the tmux session
nightshift promote                  # Label next wave of unblocked issues
```

## Pipeline Phases

| Phase | Name | Tool | Description |
|-------|------|------|-------------|
| 1 | Discover | auto-dev.sh | Find `nightshift`-labeled issues via `gh` |
| 2 | Setup | auto-dev.sh | Create git worktree from `origin/main` |
| 3 | Execute | auto-dev.sh | Claude Code implements the fix headlessly |
| 4 | Simplify | auto-dev.sh | Code quality pass (Claude reviews own work) |
| 5 | Verify | auto-dev.sh | Guardrails: `npm run verify`, file/line limits, no dep changes |
| 6 | Panel Review | worker.ts | Multi-agent review (code, spec, tests, security) |
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
| `TARGET_REPO` | `~/Repos/nonprofit-vetting-engine` | Repository to scan and process |
| `STATE_DIR` | `~/.auto-dev` | Nightshift state, logs, and run artifacts |
| `BUGBOT_STATE` | `~/.bugbot` | Bugbot state directory |
| `SCAN_ROOT` | Same as `TARGET_REPO` | Bugbot scan target (if different) |
| `BUGBOT_ROOT` | `~/Repos/auto-dev/bugbot` | Bugbot source directory |

## Label Lifecycle

```
[bugbot files issue]
    → auto-ready + nightshift
        → [nightshift picks up]
            → [success] auto-pr-ready (draft PR created)
            → [no changes] issue closed with comment
            → [failure] auto-failed
```

- `nightshift` — scoped for autonomous processing
- `auto-ready` — specced and ready (broader gate)
- `auto-pr-ready` — PR created, awaiting human merge
- `auto-failed` — pipeline failed, needs investigation

## Wave Promotion

Nightshift includes a dependency-aware promoter (`nightshift promote`) that uses Kahn's algorithm to find issues whose dependencies are all satisfied (closed or PR-ready), then labels them for the next run.
