# auto-dev pipeline CLI — nightshift + bugbot
# Source this from .zshrc: source ~/Repos/auto-dev/nightshift/nightshift.zsh

bugbot() {
  local repo="${AUTO_DEV_REPO:-$HOME/Repos/auto-dev}"
  (cd "$repo" && npx tsx bugbot/src/index.ts "$@")
}

nightshift() {
  local repo="${AUTO_DEV_REPO:-$HOME/Repos/auto-dev}"
  # Load .env if it exists (key=value only, no code execution)
  if [[ -f "$repo/.env" ]]; then
    while IFS='=' read -r key value; do
      [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] && export "$key=${value/#\~/$HOME}"
    done < "$repo/.env"
  fi
  export TARGET_REPO="${TARGET_REPO:?Set TARGET_REPO in .env}"
  export STATE_DIR="${STATE_DIR:-$HOME/.auto-dev}"
  local -a ns=(npx tsx nightshift/src/index.ts)

  case "${1:-}" in
    start)
      if tmux has-session -t nightshift 2>/dev/null; then
        echo "Already running. Use 'nightshift' to view."
        return 1
      fi
      # Atomic lock acquisition (noclobber prevents TOCTOU race)
      if ! (set -C; echo $$ > "$STATE_DIR/nightshift.lock") 2>/dev/null; then
        # Lock exists — check if the owning process is still alive
        local lock_pid
        lock_pid=$(cat "$STATE_DIR/nightshift.lock" 2>/dev/null)
        if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
          echo "Lock held by PID $lock_pid. Use 'nightshift stop' first."
          return 1
        fi
        # Stale lock — remove and retry
        rm -f "$STATE_DIR/nightshift.lock"
        if ! (set -C; echo $$ > "$STATE_DIR/nightshift.lock") 2>/dev/null; then
          echo "Failed to acquire lock (race condition). Try again."
          return 1
        fi
      fi

      # Parse --at / --in for delayed start
      local delay_s=0 run_args=()
      local -a remaining=("${@:2}")
      local i=1  # zsh arrays are 1-indexed
      while (( i <= ${#remaining[@]} )); do
        case "${remaining[$i]}" in
          --at)
            local target_time="${remaining[$((i+1))]}"
            if [[ -z "$target_time" ]]; then
              echo "Error: --at requires a time (e.g., --at 2:00)"
              return 1
            fi
            local target_epoch now_epoch
            if ! target_epoch=$(date -j -f '%H:%M' "$target_time" +%s 2>/dev/null) && \
               ! target_epoch=$(date -d "today $target_time" +%s 2>/dev/null); then
              echo "Error: invalid time format '$target_time' (use HH:MM, e.g., 2:00 or 14:30)"
              return 1
            fi
            if [[ -z "$target_epoch" ]]; then
              echo "Error: invalid time format '$target_time' (use HH:MM, e.g., 2:00 or 14:30)"
              return 1
            fi
            now_epoch=$(date +%s)
            delay_s=$(( target_epoch - now_epoch ))
            # If the time has passed today, schedule for tomorrow
            if (( delay_s < 0 )); then
              delay_s=$(( delay_s + 86400 ))
            fi
            i=$(( i + 2 ))
            ;;
          --in)
            local duration="${remaining[$((i+1))]}"
            if [[ -z "$duration" ]]; then
              echo "Error: --in requires a duration (e.g., --in 1h, --in 30m)"
              return 1
            fi
            local num="${duration%[hm]}"
            local unit="${duration: -1}"
            if [[ ! "$num" =~ ^[0-9]+$ ]]; then
              echo "Error: invalid duration '$duration' (use Nh or Nm, e.g., 2h or 30m)"
              return 1
            fi
            case "$unit" in
              h) delay_s=$(( num * 3600 )) ;;
              m) delay_s=$(( num * 60 )) ;;
              *) echo "Error: duration must end in h or m (e.g., 2h, 30m)"; return 1 ;;
            esac
            i=$(( i + 2 ))
            ;;
          *)
            run_args+=("${remaining[$i]}")
            i=$(( i + 1 ))
            ;;
        esac
      done

      # Build tmux commands with safe quoting
      local q_repo q_dash
      printf -v q_repo '%q' "$repo"
      local escaped_args
      escaped_args=$(printf '%q ' "${run_args[@]}")
      local cmd="cd $q_repo && ${ns[*]} run $escaped_args"
      if (( delay_s > 0 )); then
        local launch_time
        launch_time=$(date -j -v+${delay_s}S +%H:%M 2>/dev/null || date -d "+${delay_s} seconds" +%H:%M 2>/dev/null)
        cmd="echo 'Nightshift scheduled — launching at $launch_time (sleeping ${delay_s}s)' && sleep $delay_s && $cmd"
      fi

      tmux new -d -s nightshift \; \
        set-option -t nightshift remain-on-exit on
      tmux send-keys -t nightshift "$cmd" Enter
      sleep 1
      tmux new-window -t nightshift -n dash \
        "cd $q_repo && python3 nightshift/dashboard/nightshift-dash.py"

      if (( delay_s > 0 )); then
        echo "Nightshift scheduled for $launch_time (in $(( delay_s / 60 ))m). Use 'nightshift' to view, 'nightshift stop' to cancel."
      else
        echo "Nightshift started. Use 'nightshift' to view dashboard."
      fi
      ;;
    stop)
      tmux kill-session -t nightshift 2>/dev/null && echo "Stopped." || echo "Not running."
      rm -f "$STATE_DIR/nightshift.lock"
      if tmux has-session -t autodev-sched 2>/dev/null; then
        echo "Note: scheduler is still running. Use 'nightshift schedule stop' to cancel it too."
      fi
      ;;
    status)
      cd "$repo" && "${ns[@]}" status
      ;;
    promote)
      cd "$repo" && "${ns[@]}" promote
      ;;
    log)
      tail -f "$STATE_DIR/nightshift.log"
      ;;
    schedule)
      local action="${2:-}"
      case "$action" in
        start)
          if tmux has-session -t autodev-sched 2>/dev/null; then
            echo "Schedule already running. Use 'nightshift schedule stop' to cancel."
            return 1
          fi
          # Default schedule: bugbot 9am+9pm, nightshift 2am, concurrency 2
          local bugbot_times="${3:-09:00,21:00}"
          local ns_time="${4:-02:00}"
          local ns_concurrency="${5:-2}"
          # Validate inputs
          if [[ ! "$ns_concurrency" =~ ^[1-9][0-9]?$ ]]; then
            echo "Error: concurrency must be 1-99"
            return 1
          fi
          # Validate time formats (HH:MM, allow single-digit hour)
          local _t
          for _t in ${(s:,:)bugbot_times} "$ns_time"; do
            if [[ ! "$_t" =~ ^[0-9]{1,2}:[0-5][0-9]$ ]]; then
              echo "Error: invalid time format '$_t' (use HH:MM, e.g., 09:00 or 2:00)"
              return 1
            fi
          done
          echo "Starting auto-dev schedule:"
          echo "  Bugbot:     ${bugbot_times//,/ and } (skips if no new commits)"
          echo "  Nightshift: $ns_time (concurrency $ns_concurrency)"
          echo ""
          # Build the scheduler script
          local sched_script="$STATE_DIR/scheduler.sh"
          install -m 700 /dev/null "$sched_script"
          cat > "$sched_script" <<'SCHED'
#!/usr/bin/env bash
set -uo pipefail

REPO="$1"
BUGBOT_TIMES="$2"
NS_TIME="$3"
STATE_DIR="$4"
NS_CONCURRENCY="${5:-1}"
LOG="$STATE_DIR/scheduler.log"

rotate_log() {
  # Rotate if log exceeds 1MB, keep one backup
  if [[ -f "$LOG" ]] && (( $(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG" 2>/dev/null || echo 0) > 1048576 )); then
    mv -f "$LOG" "${LOG}.1"
  fi
}

log() {
  rotate_log
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
  chmod 600 "$LOG" 2>/dev/null
}

seconds_until() {
  # Compute seconds until next occurrence of HH:MM (local time).
  # Uses UTC arithmetic to avoid DST spring-forward/fall-back errors.
  local target_hhmm="$1"
  local target_h target_m now_epoch now_h now_m target_today_s now_today_s delta

  # Parse target HH:MM
  target_h="${target_hhmm%%:*}"
  target_m="${target_hhmm##*:}"
  target_h=$((10#$target_h))  # strip leading zero
  target_m=$((10#$target_m))

  # Get current local time components
  now_epoch=$(date +%s)
  now_h=$((10#$(date '+%H')))
  now_m=$((10#$(date '+%M')))
  local now_s=$((10#$(date '+%S')))

  # Seconds since midnight for target and now
  target_today_s=$(( target_h * 3600 + target_m * 60 ))
  now_today_s=$(( now_h * 3600 + now_m * 60 + now_s ))

  delta=$(( target_today_s - now_today_s ))
  if (( delta < 0 )); then
    delta=$(( delta + 86400 ))
  fi
  echo "$delta"
}

next_event() {
  local min_wait=86400 min_name="" min_time="" w
  IFS=',' read -ra btimes <<< "$BUGBOT_TIMES"
  for t in "${btimes[@]}"; do
    w=$(seconds_until "$t")
    if (( w < min_wait )); then
      min_wait=$w min_name="bugbot" min_time="$t"
    fi
  done
  w=$(seconds_until "$NS_TIME")
  if (( w < min_wait )); then
    min_wait=$w min_name="nightshift" min_time="$NS_TIME"
  fi
  echo "$min_name $min_time $min_wait"
}

log "Scheduler started — bugbot at $BUGBOT_TIMES, nightshift at $NS_TIME (concurrency $NS_CONCURRENCY)"

while true; do
  read -r event_name event_time event_wait <<< "$(next_event)"
  wake_at=$(date -j -v+${event_wait}S '+%H:%M' 2>/dev/null || date -d "+${event_wait} seconds" '+%H:%M' 2>/dev/null)
  log "Next: $event_name at $event_time (sleeping ${event_wait}s, wake ~$wake_at)"

  sleep "$event_wait"

  # Common setup: load env (key=value only, no code execution) and enter repo dir
  cd "$REPO"
  if [[ -f "$REPO/.env" ]]; then
    while IFS='=' read -r key value; do
      [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] && export "$key=${value/#\~/$HOME}"
    done < "$REPO/.env"
  fi

  if [[ "$event_name" == "bugbot" ]]; then
    log "Fetching origin/main..."
    git -C "${TARGET_REPO:?}" fetch origin main 2>&1 | tee -a "$LOG" || log "Fetch failed (non-fatal)"
    log "Running bugbot scan..."
    npx tsx bugbot/src/index.ts 2>&1 | tee -a "$LOG" || true
    log "Bugbot finished"
  elif [[ "$event_name" == "nightshift" ]]; then
    # Skip if manual nightshift is already running (atomic check)
    if [[ -f "$STATE_DIR/nightshift.lock" ]]; then
      lock_pid=$(cat "$STATE_DIR/nightshift.lock" 2>/dev/null)
      if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
        log "Skipping — manual nightshift already running (PID $lock_pid)"
        continue
      fi
      rm -f "$STATE_DIR/nightshift.lock"  # stale lock from dead process
    fi
    # Skip if no issues queued (nightshift + auto-ready labels)
    export TARGET_REPO="${TARGET_REPO:?}"
    export STATE_DIR
    queue_count=$(gh issue list --repo "$(cd "$TARGET_REPO" && gh repo view --json nameWithOwner -q .nameWithOwner)" \
      --label nightshift --label auto-ready --state open --json number -q 'length' 2>/dev/null || echo "0")
    if (( queue_count == 0 )); then
      log "Skipping — no issues labeled nightshift + auto-ready"
      continue
    fi
    log "Running nightshift ($queue_count issues queued, concurrency $NS_CONCURRENCY)..."
    npx tsx nightshift/src/index.ts run --concurrency "$NS_CONCURRENCY" 2>&1 | tee -a "$LOG" || true
    log "Nightshift finished"

    # After nightshift completes, run optimize if not paused
    if [[ ! -f "$STATE_DIR/optimize-paused.json" ]]; then
      log "Running optimize (post-nightshift, max 10 experiments)..."
      npx tsx nightshift/src/index.ts optimize --max-experiments 10 2>&1 | tee -a "$LOG" || true
      log "Optimize finished"
    else
      log "Skipping optimize — paused (rebase conflict)"
    fi
  fi

  # Check if next event is already overdue (e.g. a run took longer than expected)
  read -r next_name next_time next_wait <<< "$(next_event)"
  if (( next_wait < 60 )); then
    log "Catch-up: $next_name ($next_time) is due in ${next_wait}s — running immediately"
    continue
  fi

  # Brief pause to avoid tight loops if clock math is off
  sleep 5
done
SCHED
          chmod +x "$sched_script"

          local q_sched_repo q_sched_script q_sched_bb q_sched_ns q_sched_sd q_sched_conc
          printf -v q_sched_script '%q' "$sched_script"
          printf -v q_sched_repo   '%q' "$repo"
          printf -v q_sched_bb    '%q' "$bugbot_times"
          printf -v q_sched_ns    '%q' "$ns_time"
          printf -v q_sched_sd    '%q' "$STATE_DIR"
          printf -v q_sched_conc  '%q' "$ns_concurrency"
          tmux new -d -s autodev-sched \
            "bash $q_sched_script $q_sched_repo $q_sched_bb $q_sched_ns $q_sched_sd $q_sched_conc"
          echo "Schedule running in tmux session 'autodev-sched'."
          echo "  View: nightshift schedule log"
          echo "  Stop: nightshift schedule stop"
          ;;
        stop)
          tmux kill-session -t autodev-sched 2>/dev/null && echo "Schedule stopped." || echo "No schedule running."
          ;;
        log)
          tail -f "$STATE_DIR/scheduler.log"
          ;;
        status)
          if tmux has-session -t autodev-sched 2>/dev/null; then
            echo "Schedule is RUNNING"
            [[ -f "$STATE_DIR/scheduler.log" ]] && echo "" && tail -5 "$STATE_DIR/scheduler.log"
          else
            echo "No schedule running."
          fi
          ;;
        *)
          echo "Usage: nightshift schedule {start|stop|log|status}"
          echo ""
          echo "  nightshift schedule start                    Start with defaults (bugbot 9am+9pm, nightshift 2am)"
          echo "  nightshift schedule start 09:00,21:00 02:00  Custom bugbot and nightshift times"
          echo "  nightshift schedule stop                     Stop the scheduler"
          echo "  nightshift schedule log                      Tail scheduler log"
          echo "  nightshift schedule status                   Check if running + last 5 log lines"
          ;;
      esac
      ;;
    optimize)
      local action="${2:-}"
      case "$action" in
        stop)
          tmux kill-session -t nightshift-optimize 2>/dev/null && echo "Optimize stopped." || echo "Not running."
          ;;
        status)
          cd "$repo" && "${ns[@]}" optimize status
          ;;
        log)
          tail -f "$STATE_DIR/optimize.log"
          ;;
        *)
          # Check for pause state
          if [[ -f "$STATE_DIR/optimize-paused.json" ]]; then
            echo "Optimize is PAUSED (rebase conflict). Resolve on the autoresearch/optimize branch, then:"
            echo "  rm $STATE_DIR/optimize-paused.json"
            return 1
          fi
          if tmux has-session -t nightshift-optimize 2>/dev/null; then
            echo "Optimize already running. Use 'nightshift optimize stop' to cancel."
            return 1
          fi
          # Pass remaining args through
          local -a opt_args=("${@:2}")
          local escaped_opt_args
          escaped_opt_args=$(printf '%q ' "${opt_args[@]}")
          local opt_cmd="cd $q_repo && ${ns[*]} optimize $escaped_opt_args"
          tmux new -d -s nightshift-optimize "$opt_cmd"
          echo "Optimize started in tmux session 'nightshift-optimize'."
          echo "  View:   tmux attach -t nightshift-optimize"
          echo "  Status: nightshift optimize status"
          echo "  Stop:   nightshift optimize stop"
          ;;
      esac
      ;;
    *)
      if tmux has-session -t nightshift 2>/dev/null; then
        tmux attach -t nightshift:dash
      else
        echo "No nightshift session running."
        echo ""
        echo "  nightshift start                  Start pipeline + dashboard"
        echo "  nightshift start --at 2:00        Start at 2:00 AM tonight"
        echo "  nightshift start --in 1h          Start in 1 hour"
        echo "  nightshift start --fresh          Start clean (ignore prior state)"
        echo "  nightshift start --concurrency 3  Parallel workers"
        echo "  nightshift schedule start          Start 24/7 schedule (bugbot 9am+9pm, nightshift 2am)"
        echo "  nightshift optimize               Start autonomous optimization"
        echo "  nightshift status                 One-shot status"
        echo "  nightshift log                    Tail the log"
        echo "  nightshift stop                   Kill the session"
        echo "  nightshift promote                Label next wave of issues"
      fi
      ;;
  esac
}
