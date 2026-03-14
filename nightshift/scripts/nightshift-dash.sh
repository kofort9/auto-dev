#!/usr/bin/env bash
# nightshift-dash.sh — Real-time monitoring dashboard for nightshift.sh
# Read-only. Renders to buffer, writes once (no flicker). Alternate screen buffer.

STATE="$HOME/.auto-dev/nightshift-state.json"
LOG="$HOME/.auto-dev/nightshift.log"
SUMMARY="$HOME/.auto-dev/runs/summary.jsonl"
REPO="${TARGET_REPO:?Set TARGET_REPO in .env}"
BUF=$(mktemp)

# Colors
G=$'\033[32m' R=$'\033[31m' Y=$'\033[33m' B=$'\033[36m'
D=$'\033[2m' BD=$'\033[1m' N=$'\033[0m'

# --- Title cache (fetched once at startup) ---
declare -A TITLES
cache_titles() {
  [[ -f "$STATE" ]] || return
  local nums
  nums=$(jq -r '.issues | keys[]' "$STATE")
  for n in $nums; do
    TITLES[$n]=$(cd "$REPO" && gh issue view "$n" --json title -q '.title' 2>/dev/null || echo "Issue #$n") &
  done
  wait
}

fmt_dur() {
  local s="${1:-0}"
  [[ "$s" == "null" || -z "$s" ]] && s=0
  if [[ $s -ge 3600 ]]; then echo "$((s/3600))h $((s%3600/60))m"
  elif [[ $s -ge 60 ]]; then echo "$((s/60))m $((s%60))s"
  else echo "${s}s"; fi
}

trunc() {
  local s="$1" m="$2"
  [[ ${#s} -gt $m ]] && echo "${s:0:$((m-1))}…" || echo "$s"
}

render() {
  local now
  now=$(date +%H:%M:%S)
  local tw th
  tw=$(tput cols 2>/dev/null || echo 80)
  th=$(tput lines 2>/dev/null || echo 40)
  local title_w=$((tw - 30))
  [[ $title_w -gt 50 ]] && title_w=50
  [[ $title_w -lt 20 ]] && title_w=20

  # Start buffer
  exec 3>"$BUF"

  if [[ ! -f "$STATE" ]]; then
    echo -e "${R}  No state file. Is nightshift running?${N}" >&3
    exec 3>&-
    printf '\033[H\033[J'; cat "$BUF"
    return
  fi

  local state
  state=$(cat "$STATE")

  # Counts (single jq call)
  local completed failed pending in_prog skipped total
  read -r completed failed pending in_prog skipped total <<< "$(echo "$state" | jq -r '
    [.issues[] | .status] |
    "\([.[]|select(.=="completed")]|length) \([.[]|select(.=="failed")]|length) " +
    "\([.[]|select(.=="pending")]|length) \([.[]|select(.=="in_progress")]|length) " +
    "\([.[]|select(.=="skipped")]|length) \(length)"
  ')"

  # ETA
  local eta="—"
  if [[ $completed -gt 0 ]]; then
    local avg_s
    avg_s=$(echo "$state" | jq '[.issues[]|select(.status=="completed")|.duration_s // 0]|(add/length)|floor')
    local remaining=$((pending + in_prog))
    eta="~$(fmt_dur $((avg_s * remaining)))"
  fi

  # Progress bar
  local bw=$((tw - 35))
  [[ $bw -gt 40 ]] && bw=40; [[ $bw -lt 10 ]] && bw=10
  local pct=0 dw=0 fw=0 lw=$bw
  if [[ $total -gt 0 ]]; then
    pct=$(( completed * 100 / total ))
    dw=$(( completed * bw / total ))
    fw=$(( failed * bw / total ))
    lw=$(( bw - dw - fw ))
  fi
  local bar=""
  [[ $dw -gt 0 ]] && bar+="${G}$(printf '█%.0s' $(seq 1 $dw))"
  [[ $fw -gt 0 ]] && bar+="${R}$(printf '▓%.0s' $(seq 1 $fw))"
  [[ $lw -gt 0 ]] && bar+="${D}$(printf '░%.0s' $(seq 1 $lw))"
  bar+="${N}"

  # === HEADER ===
  echo -e "" >&3
  echo -e "  ${BD}${B}NIGHTSHIFT${N}  ${D}$now${N}   $bar  ${BD}$completed${N}/${total}  ($pct%)  ${D}ETA $eta${N}" >&3
  echo -e "  ${G}✅ $completed done${N}  ${R}❌ $failed fail${N}  ${B}🔄 $in_prog active${N}  ${Y}⏳ $pending queued${N}$(
    [[ $skipped -gt 0 ]] && echo "  ${D}⏭ $skipped skip${N}"
  )" >&3
  echo "" >&3

  # === ACTIVE ===
  echo "$state" | jq -r '
    .issues | to_entries[] | select(.value.status == "in_progress") | .key
  ' | while read -r num; do
    local title="${TITLES[$num]:-Issue #$num}"
    # Current phase from log
    local phase
    phase=$(grep -E "\[auto-dev\].*Phase [0-9]" "$LOG" 2>/dev/null | tail -1 | sed 's/.*\(Phase [0-9]*: [^.]*\).*/\1/' || echo "starting")
    echo -e "  ${BD}${B}▶ #$num${N}  $(trunc "$title" $title_w)" >&3
    echo -e "    ${B}$phase${N}" >&3
    echo "" >&3
  done

  # === COMPLETED ===
  if [[ $completed -gt 0 ]]; then
    echo -e "  ${D}─ Completed ─────────────────────────────────────${N}" >&3
    echo "$state" | jq -r '
      .issues | to_entries[] | select(.value.status == "completed") |
      "\(.key)\t\(.value.duration_s // 0)\t\(.value.pr_url // "")"
    ' | while IFS=$'\t' read -r num dur pr; do
      local title="${TITLES[$num]:-#$num}"
      local pr_s=""
      [[ -n "$pr" && "$pr" != "null" ]] && pr_s="${G}→ PR #$(echo "$pr" | grep -oE '[0-9]+$')${N}"
      printf "  ${G}✅${N} %-6s %-${title_w}s ${D}%8s${N}  %s\n" "#$num" "$(trunc "$title" $title_w)" "$(fmt_dur "$dur")" "$pr_s" >&3
    done
    echo "" >&3
  fi

  # === FAILED ===
  if [[ $failed -gt 0 ]]; then
    echo -e "  ${D}─ Failed ────────────────────────────────────────${N}" >&3
    echo "$state" | jq -r '
      .issues | to_entries[] | select(.value.status == "failed") |
      "\(.key)\t\(.value.duration_s // 0)\t\(.value.phase // "")"
    ' | while IFS=$'\t' read -r num dur phase; do
      local title="${TITLES[$num]:-#$num}"
      local reason=""
      [[ -f "$SUMMARY" ]] && reason=$(grep "\"issue\":$num," "$SUMMARY" | tail -1 | jq -r '.review_notes // ""' 2>/dev/null)
      printf "  ${R}❌${N} %-6s %-${title_w}s ${D}%8s${N}  ${R}%s${N}" "#$num" "$(trunc "$title" $title_w)" "$(fmt_dur "$dur")" "$phase" >&3
      [[ -n "$reason" ]] && printf " ${D}— %s${N}" "$reason" >&3
      echo "" >&3
    done
    echo "" >&3
  fi

  # === QUEUED (compact) ===
  if [[ $pending -gt 0 ]]; then
    echo -e "  ${D}─ Queued ($pending) ──────────────────────────────────${N}" >&3
    local nums_line="  "
    echo "$state" | jq -r '.issues | to_entries[] | select(.value.status == "pending") | .key' | sort -n | while read -r num; do
      nums_line+="${D}#$num${N}  "
    done
    echo -e "$nums_line" >&3
    echo "" >&3
  fi

  # === LOG TAIL ===
  local used=$((4 + completed + failed + (in_prog * 3) + 6))
  [[ $pending -gt 0 ]] && used=$((used + 2))
  local log_n=$(( th - used ))
  [[ $log_n -lt 3 ]] && log_n=3
  [[ $log_n -gt 20 ]] && log_n=20

  echo -e "  ${D}─ Log ───────────────────────────────────────────${N}" >&3
  tail -"$log_n" "$LOG" 2>/dev/null | while IFS= read -r line; do
    if [[ "$line" == *"COMPLETE"* || "$line" == *"✓"* || "$line" == *"passed"* ]]; then
      echo -e "  ${G}${line}${N}" >&3
    elif [[ "$line" == *"FAIL"* || "$line" == *"CRASH"* || "$line" == *"TIMEOUT"* || "$line" == *"ERROR"* ]]; then
      echo -e "  ${R}${line}${N}" >&3
    elif [[ "$line" == *"Processing"* || "$line" == *"═══"* || "$line" == *"Phase"* ]]; then
      echo -e "  ${B}${line}${N}" >&3
    else
      echo -e "  ${D}${line}${N}" >&3
    fi
  done

  exec 3>&-

  # Single write to terminal
  printf '\033[H\033[J'
  cat "$BUF"
}

# --- Init ---
printf '\033[?25l'          # hide cursor
printf '\033[?1049h'        # alternate screen buffer
trap 'printf "\033[?1049l\033[?25h"; rm -f "$BUF"; exit' INT TERM EXIT

echo "  Loading issue titles..."
cache_titles

while true; do
  render
  sleep 5
done
