# auto-dev pipeline CLI — nightshift + bugbot
# Source this from .zshrc: source ~/Repos/auto-dev/nightshift/nightshift.zsh

bugbot() {
  local repo="${AUTO_DEV_REPO:-$HOME/Repos/auto-dev}"
  (cd "$repo" && npx tsx bugbot/src/index.ts "$@")
}

nightshift() {
  local repo="${AUTO_DEV_REPO:-$HOME/Repos/auto-dev}"
  # Source .env if it exists (provides TARGET_REPO, STATE_DIR, etc.)
  [[ -f "$repo/.env" ]] && source "$repo/.env"
  export TARGET_REPO="${TARGET_REPO:?Set TARGET_REPO in .env}"
  export STATE_DIR="${STATE_DIR:-$HOME/.auto-dev}"
  local -a ns=(npx tsx nightshift/src/index.ts)

  case "${1:-}" in
    start)
      if tmux has-session -t nightshift 2>/dev/null; then
        echo "Already running. Use 'nightshift' to view."
        return 1
      fi
      # Only remove lock if the owning process is dead
      if [[ -f "$STATE_DIR/nightshift.lock" ]]; then
        local lock_pid
        lock_pid=$(cat "$STATE_DIR/nightshift.lock" 2>/dev/null)
        if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
          echo "Lock held by PID $lock_pid. Use 'nightshift stop' first."
          return 1
        fi
        rm -f "$STATE_DIR/nightshift.lock"
      fi

      # Parse --at / --in for delayed start
      local delay_s=0 run_args=()
      local -a remaining=("${@:2}")
      local i=0
      while (( i < ${#remaining[@]} )); do
        case "${remaining[$((i+1))]}" in
          --at)
            local target_time="${remaining[$((i+2))]}"
            if [[ -z "$target_time" ]]; then
              echo "Error: --at requires a time (e.g., --at 2:00)"
              return 1
            fi
            local target_epoch now_epoch
            target_epoch=$(date -j -f '%H:%M' "$target_time" +%s 2>/dev/null)
            if [[ $? -ne 0 || -z "$target_epoch" ]]; then
              echo "Error: invalid time format '$target_time' (use HH:MM, e.g., 2:00 or 14:30)"
              return 1
            fi
            now_epoch=$(date +%s)
            delay_s=$(( target_epoch - now_epoch ))
            # If the time has passed today, schedule for tomorrow
            if (( delay_s <= 0 )); then
              delay_s=$(( delay_s + 86400 ))
            fi
            i=$(( i + 2 ))
            ;;
          --in)
            local duration="${remaining[$((i+2))]}"
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
            run_args+=("${remaining[$((i+1))]}")
            i=$(( i + 1 ))
            ;;
        esac
      done

      local cmd="cd $repo && ${ns[*]} run ${run_args[*]}"
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
        "cd $repo && python3 nightshift/dashboard/nightshift-dash.py"

      if (( delay_s > 0 )); then
        local launch_time
        launch_time=$(date -j -v+${delay_s}S +%H:%M 2>/dev/null || date -d "+${delay_s} seconds" +%H:%M 2>/dev/null)
        echo "Nightshift scheduled for $launch_time (in $(( delay_s / 60 ))m). Use 'nightshift' to view, 'nightshift stop' to cancel."
      else
        echo "Nightshift started. Use 'nightshift' to view dashboard."
      fi
      ;;
    stop)
      tmux kill-session -t nightshift 2>/dev/null && echo "Stopped." || echo "Not running."
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
        echo "  nightshift status                 One-shot status"
        echo "  nightshift log                    Tail the log"
        echo "  nightshift stop                   Kill the session"
        echo "  nightshift promote                Label next wave of issues"
      fi
      ;;
  esac
}
