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
      tmux new -d -s nightshift \; \
        set-option -t nightshift remain-on-exit on
      tmux send-keys -t nightshift \
        "cd $repo && ${ns[*]} run ${@:2}" Enter
      sleep 1
      tmux new-window -t nightshift -n dash \
        "cd $repo && python3 nightshift/dashboard/nightshift-dash.py"
      echo "Nightshift started. Use 'nightshift' to view dashboard."
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
        echo "  nightshift start                Start pipeline + dashboard"
        echo "  nightshift start --fresh        Start clean (ignore prior state)"
        echo "  nightshift start --concurrency 3  Parallel workers"
        echo "  nightshift status               One-shot status"
        echo "  nightshift log                  Tail the log"
        echo "  nightshift stop                 Kill the session"
        echo "  nightshift promote              Label next wave of issues"
      fi
      ;;
  esac
}
