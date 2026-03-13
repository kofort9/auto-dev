#!/usr/bin/env bash
set -euo pipefail

# Allow running from inside a Claude Code session (e.g., cron within REPL)
unset CLAUDECODE 2>/dev/null || true

# auto-dev.sh — Autonomous development pipeline
# Discovers auto-ready issues, runs Claude Code headlessly, outputs draft PRs.
#
# Usage:
#   scripts/auto-dev.sh                 # Process all auto-ready issues
#   scripts/auto-dev.sh --issue 184     # Process a single issue
#   scripts/auto-dev.sh --cleanup 184   # Remove worktree for issue 184
#   scripts/auto-dev.sh --cleanup-all   # Remove all auto-dev worktrees
#   scripts/auto-dev.sh --dry-run       # Discover + setup only, no execution

TARGET_REPO="${TARGET_REPO:-$HOME/Repos/nonprofit-vetting-engine}"
LOG_DIR="${STATE_DIR:-$HOME/.auto-dev}/runs"
DATE="$(date +%Y-%m-%d)"
DRY_RUN=false
SINGLE_ISSUE=""
CLEANUP_ISSUE=""
CLEANUP_ALL=false

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)
      SINGLE_ISSUE="$2"
      shift 2
      ;;
    --cleanup)
      CLEANUP_ISSUE="$2"
      shift 2
      ;;
    --cleanup-all)
      CLEANUP_ALL=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { echo "[auto-dev] $(date +%H:%M:%S) $*"; }
fail_issue() {
  local number="$1" label="$2" message="$3"
  gh issue edit "$number" --add-label "$label" --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" 2>/dev/null || true
  gh issue comment "$number" --body "$message" 2>/dev/null || true
  log "FAIL: Issue #$number — $message"
}

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-40
}

append_summary() {
  local number="$1" result="$2" phase_failed="${3:-null}" files_changed="${4:-0}" lines_changed="${5:-0}" review_notes="${6:-}" duration_s="${7:-0}"
  echo "{\"issue\":$number,\"date\":\"$DATE\",\"result\":\"$result\",\"phase_failed\":$phase_failed,\"files_changed\":$files_changed,\"lines_changed\":$lines_changed,\"review_notes\":\"$review_notes\",\"duration_s\":$duration_s}" >> "$LOG_DIR/summary.jsonl"
}

# ---------------------------------------------------------------------------
# Phase 0: Cleanup
# ---------------------------------------------------------------------------
if [[ "$CLEANUP_ALL" == true ]]; then
  log "Cleaning up all auto-dev worktrees..."
  cd "$TARGET_REPO"
  for wt in ../auto-dev-*; do
    if [[ -d "$wt" ]]; then
      log "Removing $wt"
      git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
    fi
  done
  git worktree prune
  log "Cleanup complete."
  exit 0
fi

if [[ -n "$CLEANUP_ISSUE" ]]; then
  log "Cleaning up worktree for issue #$CLEANUP_ISSUE..."
  cd "$TARGET_REPO"
  wt="../auto-dev-$CLEANUP_ISSUE"
  if [[ -d "$wt" ]]; then
    git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
    git worktree prune
    log "Removed $wt"
  else
    log "No worktree found at $wt"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase 1: Discover
# ---------------------------------------------------------------------------
log "Phase 1: Discovering auto-ready issues..."
cd "$TARGET_REPO"

if [[ -n "$SINGLE_ISSUE" ]]; then
  ISSUES=$(gh issue view "$SINGLE_ISSUE" --json number,title,body)
  ISSUES="[$ISSUES]"
else
  ISSUES=$(gh issue list --label nightshift --state open --json number,title,body --limit 5)
fi

ISSUE_COUNT=$(echo "$ISSUES" | jq 'length')
if [[ "$ISSUE_COUNT" -eq 0 ]]; then
  log "No auto-ready issues found."
  exit 0
fi
log "Found $ISSUE_COUNT issue(s) to process."

# ---------------------------------------------------------------------------
# Process each issue
# ---------------------------------------------------------------------------
echo "$ISSUES" | jq -c '.[]' | while read -r issue; do
  NUMBER=$(echo "$issue" | jq -r '.number')
  TITLE=$(echo "$issue" | jq -r '.title')
  BODY=$(echo "$issue" | jq -r '.body')
  SLUG=$(slugify "$TITLE")
  BRANCH="feat/gh-${NUMBER}-${SLUG}"
  WORKTREE="$TARGET_REPO/../auto-dev-$NUMBER"
  START_TIME=$(date +%s)

  log "═══════════════════════════════════════════"
  log "Processing issue #$NUMBER: $TITLE"
  log "═══════════════════════════════════════════"

  # -------------------------------------------------------------------------
  # Phase 2: Setup worktree (always start clean)
  # -------------------------------------------------------------------------
  log "Phase 2: Setting up worktree at $WORKTREE..."

  git fetch origin

  # Clean up any stale state from prior runs
  if [[ -d "$WORKTREE" ]]; then
    log "  Removing stale worktree at $WORKTREE"
    git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
    git worktree prune
  fi
  git branch -D "$BRANCH" 2>/dev/null && log "  Removed stale local branch $BRANCH" || true
  git push origin --delete "$BRANCH" 2>/dev/null && log "  Removed stale remote branch $BRANCH" || true

  # Create fresh worktree from origin/main
  git worktree add "$WORKTREE" origin/main
  cd "$WORKTREE"
  git checkout -b "$BRANCH"

  # Symlink node_modules from main repo
  if [[ -d "$TARGET_REPO/node_modules" ]]; then
    ln -s "$TARGET_REPO/node_modules" "$WORKTREE/node_modules"
  fi

  if [[ "$DRY_RUN" == true ]]; then
    log "DRY RUN: Worktree created. Skipping execution."
    append_summary "$NUMBER" "dry-run" "null" 0 0 "" 0
    continue
  fi

  # -------------------------------------------------------------------------
  # Phase 3: Execute — Run Claude Code headlessly
  # -------------------------------------------------------------------------
  log "Phase 3: Executing implementation with Claude Code..."
  EXECUTE_LOG="$LOG_DIR/${DATE}-${NUMBER}-execute.log"

  # Write prompt to temp file to avoid shell expansion of $BODY (security: prevents command injection)
  EXECUTE_PROMPT=$(mktemp "$LOG_DIR/prompt-execute-XXXXXX.md")
  cat > "$EXECUTE_PROMPT" <<'PROMPT_HEADER'
You are working on an issue in the nonprofit-vetting-engine repo. Here is the full spec:

PROMPT_HEADER
  printf '%s' "$BODY" >> "$EXECUTE_PROMPT"
  cat >> "$EXECUTE_PROMPT" <<'PROMPT_FOOTER'

Implement this spec exactly. Follow CLAUDE.md conventions. Do not add dependencies. Run `npm run verify` before finishing. If verify fails, fix the issues and re-run until it passes.

Scope constraint — read carefully:
- Only modify code that the spec directly describes. Do not refactor, clean up, or "fix" surrounding code.
- When removing a field, variable, or config key: replace references to it with sensible inline defaults (literal values, fallback constants) rather than deleting the code that consumes it. The consuming code may serve purposes beyond the removed item.
- Do NOT cascade-delete functions, classes, or logic blocks just because they reference something being removed — unless the spec explicitly says to remove that system/feature.
- If you are unsure whether something is in scope, leave it alone.
PROMPT_FOOTER

  claude --print --permission-mode bypassPermissions < "$EXECUTE_PROMPT" \
    > "$EXECUTE_LOG" 2>&1 || {
      log "Claude execution failed (exit code $?). See $EXECUTE_LOG"
      fail_issue "$NUMBER" "auto-failed" "Claude execution failed. See logs."
      rm -f "$EXECUTE_PROMPT"
      END_TIME=$(date +%s)
      append_summary "$NUMBER" "fail" "\"execute\"" 0 0 "Claude execution crashed" "$((END_TIME - START_TIME))"
      continue
    }
  rm -f "$EXECUTE_PROMPT"

  log "Execution complete. Log: $EXECUTE_LOG"

  # -------------------------------------------------------------------------
  # Phase 4: Simplify — Code quality pass (now gets spec for context)
  # -------------------------------------------------------------------------
  log "Phase 4: Running simplify pass..."
  SIMPLIFY_LOG="$LOG_DIR/${DATE}-${NUMBER}-simplify.log"

  # Write prompt to temp file (same security pattern as Phase 3)
  SIMPLIFY_PROMPT=$(mktemp "$LOG_DIR/prompt-simplify-XXXXXX.md")
  cat > "$SIMPLIFY_PROMPT" <<'PROMPT_HEADER'
Review the code changes in this repo (git diff origin/main) against the original spec. Simplify for clarity, consistency, and maintainability. Preserve all functionality.

Spec:
PROMPT_HEADER
  printf '%s' "$BODY" >> "$SIMPLIFY_PROMPT"
  cat >> "$SIMPLIFY_PROMPT" <<'PROMPT_FOOTER'

Instructions:
- Follow CLAUDE.md conventions
- Do not add features or change behavior — only improve code quality
- Remove duplication and ensure consistency with existing patterns
- Do not over-engineer: if the spec asks for something simple, keep it simple
- Do NOT delete functions, classes, or logic blocks that the spec did not ask to remove — even if they seem unused after the execute phase's changes. Only remove code that the execute phase introduced and that is genuinely dead.
- Run `npm run verify` after any changes.
PROMPT_FOOTER

  claude --print --permission-mode bypassPermissions < "$SIMPLIFY_PROMPT" \
    > "$SIMPLIFY_LOG" 2>&1 || {
      log "Simplify pass had issues. See $SIMPLIFY_LOG"
      # Non-fatal — continue to verify
    }
  rm -f "$SIMPLIFY_PROMPT"

  log "Simplify complete. Log: $SIMPLIFY_LOG"

  # -------------------------------------------------------------------------
  # Phase 5: Verify — Guardrails gate
  # -------------------------------------------------------------------------
  log "Phase 5: Running verification gates..."

  # Gate 1: npm run verify
  if ! npm run verify 2>&1; then
    fail_issue "$NUMBER" "auto-failed" "Verification failed: \`npm run verify\` did not pass."
    END_TIME=$(date +%s)
    append_summary "$NUMBER" "fail" "\"verify\"" 0 0 "npm run verify failed" "$((END_TIME - START_TIME))"
    continue
  fi
  log "  ✓ npm run verify passed"

  # Gate 2: Files changed limit
  FILES_CHANGED=$(git diff --name-only origin/main | wc -l | tr -d ' ')
  if [[ "$FILES_CHANGED" -gt 15 ]]; then
    fail_issue "$NUMBER" "auto-failed" "Too many files changed: $FILES_CHANGED (limit: 15)"
    END_TIME=$(date +%s)
    append_summary "$NUMBER" "fail" "\"verify\"" "$FILES_CHANGED" 0 "Too many files: $FILES_CHANGED" "$((END_TIME - START_TIME))"
    continue
  fi
  log "  ✓ Files changed: $FILES_CHANGED (≤15)"

  # Gate 3: Lines changed limit
  LINES_CHANGED=$(git diff --stat origin/main | tail -1 | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
  LINES_DELETED=$(git diff --stat origin/main | tail -1 | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")
  [[ "$LINES_CHANGED" =~ ^[0-9]+$ ]] || LINES_CHANGED=0
  [[ "$LINES_DELETED" =~ ^[0-9]+$ ]] || LINES_DELETED=0
  TOTAL_LINES=$((LINES_CHANGED + LINES_DELETED))
  if [[ "$TOTAL_LINES" -gt 500 ]]; then
    fail_issue "$NUMBER" "auto-failed" "Too many lines changed: $TOTAL_LINES (limit: 500)"
    END_TIME=$(date +%s)
    append_summary "$NUMBER" "fail" "\"verify\"" "$FILES_CHANGED" "$TOTAL_LINES" "Too many lines: $TOTAL_LINES" "$((END_TIME - START_TIME))"
    continue
  fi
  log "  ✓ Lines changed: $TOTAL_LINES (≤500)"

  # Gate 4: No dependency changes (unless spec explicitly requests adding one)
  if git diff origin/main --name-only | grep -qE '^package(-lock)?\.json$'; then
    # Require an explicit positive request — e.g., "add dependency X", "install package Y"
    # Must NOT match negations like "no new dependencies" or "without adding dependencies"
    if printf '%s' "$BODY" | grep -qiE '\b(add|install|require|include|introduce)\b.{0,30}\b(dependency|dependencies|package|module|library)\b'; then
      log "  ✓ Dependency changes detected, spec explicitly requests adding dependencies"
    else
      fail_issue "$NUMBER" "auto-failed" "Unexpected dependency changes detected in package.json"
      END_TIME=$(date +%s)
      append_summary "$NUMBER" "fail" "\"verify\"" "$FILES_CHANGED" "$TOTAL_LINES" "Unexpected dependency changes" "$((END_TIME - START_TIME))"
      continue
    fi
  fi
  log "  ✓ No unexpected dependency changes"

  # Gate 5: Deletion budget — flag excessive deletions without spec justification
  NET_DELETIONS=$(( LINES_DELETED - LINES_CHANGED ))
  if [[ "$NET_DELETIONS" -lt 0 ]]; then
    NET_DELETIONS=0
  fi

  # Regex: does the spec describe large-scale removal? (verb + noun within 50 chars)
  DELETION_ALLOWLIST_RE='\b(remove|delete|eliminate|rip out|deprecate|drop|strip|sunset)\b.{0,50}\b(feature|system|module|service|component|implementation|class|file|handler|middleware|layer|integration|workflow|subsystem|engine)\b'

  spec_permits_removal() {
    # Strip HTML comments (invisible in GitHub rendered view, could bypass gate)
    printf '%s' "$BODY" | sed 's/<!--.*-->//g' | grep -qiE "$DELETION_ALLOWLIST_RE"
  }

  DELETION_BLOCKED=false

  # Check 1: Net deletions (deletions minus insertions)
  if [[ "$NET_DELETIONS" -gt 15 ]]; then
    if spec_permits_removal; then
      log "  ✓ Net deletions: $NET_DELETIONS (>15, but spec permits removal)"
    else
      DELETION_BLOCKED=true
      DELETION_MSG="Excessive net deletions: $NET_DELETIONS lines (limit: 15)"
    fi
  else
    log "  ✓ Net deletions: $NET_DELETIONS (≤15)"
  fi

  # Check 2: Gross deletions (catch verbose-replacement evasion)
  if [[ "$DELETION_BLOCKED" == "false" && "$LINES_DELETED" -gt 40 ]]; then
    if spec_permits_removal; then
      log "  ✓ Gross deletions: $LINES_DELETED (>40, but spec permits removal)"
    else
      DELETION_BLOCKED=true
      DELETION_MSG="Excessive gross deletions: $LINES_DELETED lines deleted (limit: 40)"
    fi
  elif [[ "$DELETION_BLOCKED" == "false" ]]; then
    log "  ✓ Gross deletions: $LINES_DELETED (≤40)"
  fi

  if [[ "$DELETION_BLOCKED" == "true" ]]; then
    fail_issue "$NUMBER" "auto-failed" "$DELETION_MSG. Spec does not indicate large-scale removal. Review manually."
    END_TIME=$(date +%s)
    append_summary "$NUMBER" "fail" "\"verify\"" "$FILES_CHANGED" "$TOTAL_LINES" "$DELETION_MSG" "$((END_TIME - START_TIME))"
    continue
  fi

  log "All verification gates passed."

  # -------------------------------------------------------------------------
  # Phase 6: Write sentinel — hand off to nightshift TS layer
  # -------------------------------------------------------------------------
  log "Phase 6: Writing sentinel file..."

  # Collect changed files as JSON array
  CHANGED_FILES_JSON=$(git diff --name-only origin/main | jq -R -s 'split("\n") | map(select(length > 0))')

  SENTINEL_FILE="$LOG_DIR/${DATE}-${NUMBER}-sentinel.json"
  cat > "$SENTINEL_FILE" <<SENTINEL_EOF
{
  "issue": $NUMBER,
  "worktree": "$WORKTREE",
  "branch": "$BRANCH",
  "spec": $(echo "$BODY" | jq -Rs .),
  "files_changed": $CHANGED_FILES_JSON,
  "lines_changed": $TOTAL_LINES,
  "net_deletions": $NET_DELETIONS,
  "head_sha": "$(git rev-parse HEAD)",
  "files_count": $FILES_CHANGED
}
SENTINEL_EOF

  log "Sentinel → $SENTINEL_FILE"

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  append_summary "$NUMBER" "pass" "null" "$FILES_CHANGED" "$TOTAL_LINES" "" "$DURATION"

  log "═══════════════════════════════════════════"
  log "Issue #$NUMBER: PHASES 1-5 COMPLETE (${DURATION}s)"
  log "  Sentinel: $SENTINEL_FILE"
  log "  Worktree: $WORKTREE (handed to panel review)"
  log "═══════════════════════════════════════════"

done

log "Auto-dev pipeline finished (phases 1-5)."
