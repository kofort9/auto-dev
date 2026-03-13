#!/usr/bin/env bash
set -uo pipefail

# ERR trap: log unexpected failures without exiting
trap 'echo "[nightshift] ERR at line $LINENO: command exited with $?" >&2' ERR

# nightshift.sh — Overnight job queue manager for auto-dev pipeline
# Wraps auto-dev.sh with resume, circuit breaker, and morning summary.
#
# TODO (v2 — post-PR review automation):
#   - After auto-dev creates draft PR, run scrutinize + simplify on changed files
#   - If all agents APPROVED + tests pass → auto-mark PR ready
#   - If any agent REQUEST_CHANGES → leave as draft, log findings in morning summary
#   - Human still merges (merge decision stays manual)
#   - Unblock dependents: if merged issue unblocks a successor, label it auto-ready
#   - Dashboard update hook: move issue to Recently Closed, refresh KPI counts
#
# Usage:
#   nightshift/scripts/nightshift.sh                     # Run all auto-ready issues (resumes)
#   nightshift/scripts/nightshift.sh --issue 215,216     # Run specific issues
#   nightshift/scripts/nightshift.sh --fresh             # Ignore prior state, start clean
#   nightshift/scripts/nightshift.sh --dry-run           # Show queue without executing
#   nightshift/scripts/nightshift.sh --max-failures 3    # Circuit breaker threshold (default: 3)
#   nightshift/scripts/nightshift.sh --promote           # Label next wave of unblocked issues as auto-ready

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIGHTSHIFT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUTODEV_ROOT="$(cd "$NIGHTSHIFT_ROOT/.." && pwd)"
TARGET_REPO="${TARGET_REPO:-$HOME/Repos/nonprofit-vetting-engine}"
STATE_DIR="$HOME/.auto-dev"
STATE_FILE="$STATE_DIR/nightshift-state.json"
SUMMARY_JSONL="$STATE_DIR/runs/summary.jsonl"
LOG_FILE="$STATE_DIR/nightshift.log"
DATE="$(date +%Y-%m-%d)"
TIMEOUT_S=$((90 * 60))

# Self-logging: script writes its own log (no external | tee needed)
mkdir -p "$STATE_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

DRY_RUN=false
FRESH=false
MAX_FAILURES=3
ISSUE_LIST=""
PROMOTE=false

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue)        ISSUE_LIST="$2"; shift 2 ;;
    --fresh)        FRESH=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --max-failures) MAX_FAILURES="$2"; shift 2 ;;
    --promote)      PROMOTE=true; shift ;;
    *)              echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$STATE_DIR/runs"

# --- Input validation ---
if [[ -n "$ISSUE_LIST" ]] && ! [[ "$ISSUE_LIST" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "Error: --issue must be comma-separated numbers" >&2; exit 1
fi
if ! [[ "$MAX_FAILURES" =~ ^[0-9]+$ ]]; then
  echo "Error: --max-failures must be a positive integer" >&2; exit 1
fi

# --- Lockfile (prevent concurrent runs) ---
LOCKFILE="$STATE_DIR/nightshift.lock"
if ! ( set -o noclobber; echo $$ > "$LOCKFILE" ) 2>/dev/null; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [[ -n "$LOCK_PID" ]] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "Error: another nightshift instance is running (PID $LOCK_PID)" >&2; exit 1
  fi
  # Stale lock — reclaim
  echo $$ > "$LOCKFILE"
fi
cleanup() {
  rm -f "$LOCKFILE"
  # Reset any in_progress issues back to pending on unexpected exit
  if [[ -f "$STATE_FILE" ]]; then
    local state
    state=$(cat "$STATE_FILE")
    local updated
    updated=$(echo "$state" | jq '.issues |= with_entries(if .value.status == "in_progress" then .value.status = "pending" else . end)')
    if echo "$updated" | jq '.' > "$STATE_FILE.tmp" 2>/dev/null; then
      mv "$STATE_FILE.tmp" "$STATE_FILE"
    fi
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { echo "[nightshift] $(date +%H:%M:%S) $*"; }

# Atomic state write: write to .tmp, then mv (survives crash mid-write)
write_state() {
  if echo "$1" | jq '.' > "$STATE_FILE.tmp"; then
    mv "$STATE_FILE.tmp" "$STATE_FILE"
  else
    rm -f "$STATE_FILE.tmp"
    log "ERROR: write_state received invalid JSON"
    return 1
  fi
}

EMPTY_STATE='{"run_id":"","issues":{}}'

read_state() {
  [[ -f "$STATE_FILE" ]] && cat "$STATE_FILE" || echo "$EMPTY_STATE"
}

# Update a single issue's status (and optional extra JSON fields) in state
update_issue() {
  local number="$1" status="$2"
  local state
  state=$(read_state)
  if [[ -n "${3:-}" ]]; then
    state=$(echo "$state" | jq \
      --arg n "$number" --arg s "$status" --argjson e "$3" \
      '.issues[$n] = ((.issues[$n] // {}) + $e + {status: $s})')
  else
    state=$(echo "$state" | jq \
      --arg n "$number" --arg s "$status" \
      '.issues[$n] = ((.issues[$n] // {}) + {status: $s})')
  fi
  write_state "$state"
}

# Read latest result for a specific issue from summary.jsonl
get_summary_result() {
  local number="$1"
  [[ -f "$SUMMARY_JSONL" ]] && grep "\"issue\":$number," "$SUMMARY_JSONL" | tail -1 || true
}

# POSIX-compatible timeout (no coreutils/gtimeout dependency)
run_with_timeout() {
  local timeout_s="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$timeout_s" && kill "$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  local exit_code=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null || true
  # Signal-killed (SIGTERM=143) → treat as timeout
  if [[ $exit_code -gt 128 ]]; then
    return 124
  fi
  return "$exit_code"
}

format_duration() {
  local s="$1"
  echo "$((s / 60))m $((s % 60))s"
}

# ---------------------------------------------------------------------------
# Wave promotion (Kahn's algorithm — label unblocked issues as auto-ready)
# ---------------------------------------------------------------------------
promote_next_wave() {
  log "Promoting next wave..."
  cd "$TARGET_REPO"

  local repo_nwo
  repo_nwo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

  # Satisfied dependencies = closed issues + issues with PRs ready to merge
  local satisfied
  satisfied=$(
    gh issue list --state closed --json number -q '.[].number' --limit 200 --repo "$repo_nwo"
    gh issue list --state open --label auto-pr-ready --json number -q '.[].number' --repo "$repo_nwo"
  )
  satisfied=$(echo "$satisfied" | sort -u)

  local all_open
  all_open=$(gh issue list --state open --json number,title,labels,body --limit 100 --repo "$repo_nwo")

  echo "$all_open" | jq -c '.[]' | while read -r issue; do
    local num title labels body
    num=$(echo "$issue" | jq -r '.number')
    title=$(echo "$issue" | jq -r '.title')
    labels=$(echo "$issue" | jq -r '[.labels[].name] | join(",")')
    body=$(echo "$issue" | jq -r '.body // ""')

    # Skip if already labeled auto-ready or auto-pr-ready
    if echo "$labels" | grep -qE 'auto-ready|auto-pr-ready'; then
      continue
    fi

    # Skip issues that need human judgment
    if echo "$labels" | grep -qE 'research|design'; then
      log "  skip #$num (research/design label): $title"
      continue
    fi

    # Extract dependency edges: "Depends on #N", "Blocked by #N"
    # Truncate body to avoid DoS from huge issue bodies
    local deps
    deps=$(printf '%s' "${body:0:3000}" | grep -ioE '(depends on|blocked by|prerequisite.*)\s*#[0-9]+' | grep -oE '#[0-9]+' | tr -d '#' | sort -u || true)

    if [[ -z "$deps" ]]; then
      log "  promote #$num (no deps): $title"
      gh issue edit "$num" --add-label auto-ready --repo "$repo_nwo" 2>/dev/null
      continue
    fi

    # Check if all dependencies are satisfied
    local all_met=true unmet=""
    for dep in $deps; do
      if ! echo "$satisfied" | grep -qx "$dep"; then
        all_met=false
        unmet="${unmet:+$unmet, }#$dep"
      fi
    done

    if [[ "$all_met" == true ]]; then
      log "  promote #$num (all deps met): $title"
      gh issue edit "$num" --add-label auto-ready --repo "$repo_nwo" 2>/dev/null
    else
      log "  blocked #$num (by $unmet): $title"
    fi
  done

  log "Wave promotion complete."
}

if [[ "$PROMOTE" == true ]]; then
  promote_next_wave
  exit 0
fi

# ---------------------------------------------------------------------------
# Initialize state
# ---------------------------------------------------------------------------
if [[ "$FRESH" == true ]] || [[ ! -f "$STATE_FILE" ]]; then
  RUN_ID=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  write_state "{\"run_id\":\"$RUN_ID\",\"issues\":{}}"
  log "Starting fresh run: $RUN_ID"
else
  RUN_ID=$(jq -r '.run_id' "$STATE_FILE")
  log "Resuming run: $RUN_ID"
fi

START_TS=$(date +%s)

# ---------------------------------------------------------------------------
# Discover issues
# ---------------------------------------------------------------------------
log "Discovering issues..."
cd "$TARGET_REPO"

if [[ -n "$ISSUE_LIST" ]]; then
  IFS=',' read -ra NUMS <<< "$ISSUE_LIST"
  ISSUES=$(printf '%s\n' "${NUMS[@]}" \
    | xargs -I{} gh issue view {} --json number,title \
    | jq -s '.')
else
  ISSUES=$(gh issue list --label auto-ready --state open --json number,title --limit 50)
fi

ISSUE_COUNT=$(echo "$ISSUES" | jq 'length')
if [[ "$ISSUE_COUNT" -eq 0 ]]; then
  log "No issues to process."
  exit 0
fi

# ---------------------------------------------------------------------------
# Build queue: skip completed, retry failed
# ---------------------------------------------------------------------------
STATE_DATA=$(read_state)
QUEUE=()
SKIPPED_COMPLETED=0

for i in $(seq 0 $((ISSUE_COUNT - 1))); do
  NUMBER=$(echo "$ISSUES" | jq -r ".[$i].number")
  TITLE=$(echo "$ISSUES" | jq -r ".[$i].title")
  PREV_STATUS=$(echo "$STATE_DATA" | jq -r ".issues[\"$NUMBER\"].status // \"pending\"")

  if [[ "$PREV_STATUS" == "completed" ]]; then
    SKIPPED_COMPLETED=$((SKIPPED_COMPLETED + 1))
    continue
  fi

  QUEUE+=("$NUMBER"$'\t'"$TITLE")
  # Seed pending if new
  if [[ "$PREV_STATUS" == "pending" ]] || [[ "$PREV_STATUS" == "null" ]]; then
    update_issue "$NUMBER" "pending"
  fi
done

log "Queue: ${#QUEUE[@]} to process, $SKIPPED_COMPLETED already completed"

if [[ "$DRY_RUN" == true ]]; then
  log "DRY RUN — would process:"
  for entry in "${QUEUE[@]}"; do
    IFS=$'\t' read -r num title <<< "$entry"
    prev=$(echo "$STATE_DATA" | jq -r ".issues[\"$num\"].status // \"pending\"")
    log "  #$num ($prev): $title"
  done
  exit 0
fi

if [[ ${#QUEUE[@]} -eq 0 ]]; then
  log "Nothing to process — all issues completed."
  exit 0
fi

# ---------------------------------------------------------------------------
# Process queue
# ---------------------------------------------------------------------------
CONSECUTIVE_CRASHES=0
PROCESSED=0

for entry in "${QUEUE[@]}"; do
  IFS=$'\t' read -r NUMBER TITLE <<< "$entry"
  ISSUE_START=$(date +%s)
  PROCESSED=$((PROCESSED + 1))

  log "═══════════════════════════════════════════"
  log "[$PROCESSED/${#QUEUE[@]}] #$NUMBER: $TITLE"
  log "═══════════════════════════════════════════"

  update_issue "$NUMBER" "in_progress"

  EXIT_CODE=0
  run_with_timeout "$TIMEOUT_S" "$SCRIPT_DIR/auto-dev.sh" --issue "$NUMBER" || EXIT_CODE=$?

  DURATION=$(( $(date +%s) - ISSUE_START ))

  # --- Determine outcome ---
  RESULT_JSON=$(get_summary_result "$NUMBER")
  RESULT=""
  PHASE=""

  if [[ $EXIT_CODE -eq 124 ]]; then
    RESULT="failed"; PHASE="timeout"
    log "#$NUMBER — TIMEOUT after $(format_duration $DURATION)"

  elif [[ $EXIT_CODE -ne 0 ]]; then
    RESULT="failed"; PHASE="crashed"
    log "#$NUMBER — CRASHED (exit $EXIT_CODE) after $(format_duration $DURATION)"

  elif [[ -n "$RESULT_JSON" ]]; then
    RESULT=$(echo "$RESULT_JSON" | jq -r '.result // "fail"' 2>/dev/null || echo "fail")
    PHASE=$(echo "$RESULT_JSON" | jq -r '.phase_failed // "none"' 2>/dev/null || echo "unknown")
  else
    RESULT="failed"; PHASE="unknown"
  fi

  # --- Update state ---
  if [[ "$RESULT" == "pass" ]]; then
    PR_URL=$(gh pr list --search "head:feat/gh-${NUMBER}" --json url -q '.[0].url' 2>/dev/null || echo "")
    EXTRAS=$(jq -nc --argjson d "$DURATION" --arg pr "$PR_URL" \
      '{duration_s: $d} + (if $pr != "" then {pr_url: $pr} else {} end)')
    update_issue "$NUMBER" "completed" "$EXTRAS"
    CONSECUTIVE_CRASHES=0
    log "#$NUMBER — COMPLETED ($(format_duration $DURATION))${PR_URL:+ → $PR_URL}"
  else
    update_issue "$NUMBER" "failed" "{\"phase\":\"$PHASE\",\"duration_s\":$DURATION}"
    log "#$NUMBER — FAILED at $PHASE ($(format_duration $DURATION))"

    # Circuit breaker: only systemic failures (not verify/review = bad spec)
    case "$PHASE" in
      crashed|timeout|execute|setup)
        CONSECUTIVE_CRASHES=$((CONSECUTIVE_CRASHES + 1))
        log "  Crash counter: $CONSECUTIVE_CRASHES/$MAX_FAILURES"
        if [[ $CONSECUTIVE_CRASHES -ge $MAX_FAILURES ]]; then
          log "CIRCUIT BREAKER: $CONSECUTIVE_CRASHES consecutive crashes — halting"
          for remaining in "${QUEUE[@]}"; do
            IFS=$'\t' read -r rnum _ <<< "$remaining"
            rstatus=$(read_state | jq -r ".issues[\"$rnum\"].status // \"pending\"")
            if [[ "$rstatus" == "pending" || "$rstatus" == "in_progress" ]]; then
              update_issue "$rnum" "skipped" '{"reason":"circuit_breaker"}'
            fi
          done
          break
        fi
        ;;
      *)
        # verify/review failure = bad spec, reset crash counter
        CONSECUTIVE_CRASHES=0
        ;;
    esac
  fi
done

# ---------------------------------------------------------------------------
# Morning summary
# ---------------------------------------------------------------------------
END_TS=$(date +%s)
TOTAL_S=$((END_TS - START_TS))

STATE_DATA=$(read_state)
read -r N_COMPLETED N_FAILED N_SKIPPED N_TOTAL <<< "$(echo "$STATE_DATA" | jq -r '
  [.issues[] | .status] |
  "\([.[] | select(. == "completed")] | length) " +
  "\([.[] | select(. == "failed")] | length) " +
  "\([.[] | select(. == "skipped")] | length) " +
  "\(length)"
')"

SUMMARY_PATH="$STATE_DIR/nightshift-summary-${DATE}.md"

{
  echo "# Nightshift Summary — $DATE"
  echo "Started: $(date -r "$START_TS" +%H:%M) | Finished: $(date -r "$END_TS" +%H:%M) | Duration: $(format_duration $TOTAL_S)"
  echo ""
  echo "## Results"

  echo "$STATE_DATA" | jq -r '
    .issues | to_entries | sort_by(.key | tonumber) | .[] |
    "\(.key)\t\(.value.status)\t\(.value.phase // "")\t\(.value.duration_s // 0)\t\(.value.pr_url // "")"
  ' | while IFS=$'\t' read -r num status phase dur pr; do
    case "$status" in
      completed)
        pr_display=""
        if [[ -n "$pr" ]]; then
          pr_num=$(echo "$pr" | grep -oE '[0-9]+$' || echo "")
          [[ -n "$pr_num" ]] && pr_display=" → PR #$pr_num"
        fi
        echo "✅ #$num ($(format_duration "$dur"))$pr_display"
        ;;
      failed)
        echo "❌ #$num — failed at $phase ($(format_duration "$dur"))"
        ;;
      skipped)
        echo "⏭️ #$num — skipped (circuit breaker)"
        ;;
      *)
        echo "⬜ #$num — $status"
        ;;
    esac
  done

  echo ""
  echo "## Totals"
  echo "Completed: $N_COMPLETED/$N_TOTAL | Failed: $N_FAILED | Skipped: $N_SKIPPED"

  PR_LIST=$(echo "$STATE_DATA" | jq -r '
    [.issues[] | select(.status == "completed") | .pr_url // empty] |
    map(capture("(?<n>[0-9]+)$").n) | map("#" + .) | join(", ")
  ')
  [[ -n "$PR_LIST" ]] && echo "PRs to review: $PR_LIST"
} > "$SUMMARY_PATH"

echo ""
cat "$SUMMARY_PATH"
log "Summary → $SUMMARY_PATH"
log "State → $STATE_FILE"

promote_next_wave

log "Nightshift complete."
