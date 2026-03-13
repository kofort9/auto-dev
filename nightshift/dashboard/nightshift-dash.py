#!/usr/bin/env python3
"""nightshift-dash.py — Factory-floor dashboard for the nightshift pipeline.

Reads ~/.auto-dev/nightshift-state.json and nightshift.log.
Renders a conveyor-belt view of the auto-dev pipeline.

Usage:
    python3 nightshift/dashboard/nightshift-dash.py              # Live dashboard
    python3 nightshift/dashboard/nightshift-dash.py --once        # Render once and exit
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich import box

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
STATE_DIR = Path(os.environ.get("NIGHTSHIFT_STATE_DIR", str(Path.home() / ".auto-dev")))
STATE_FILE = STATE_DIR / "nightshift-state.json"
LOG_FILE = STATE_DIR / "nightshift.log"
SUMMARY_JSONL = STATE_DIR / "runs" / "summary.jsonl"
REPO_DIR = Path(os.environ.get("TARGET_REPO", os.environ.get("NIGHTSHIFT_REPO_DIR", str(Path.home() / "Repos" / "nonprofit-vetting-engine"))))

REFRESH_INTERVAL = 4
PHASES = ["setup", "execute", "simplify", "verify", "panel-review", "fix", "publish"]

# Sub-step detail that can appear under each phase when active
PHASE_SUBSTEPS: dict[str, list[str]] = {
    "verify": ["npm run verify", "Files changed \u226415", "Lines changed \u2264500", "No dep changes"],
    "panel-review": ["code-reviewer", "spec-compliance", "test-coverage", "red-team", "ml-specialist"],
    "execute": ["Claude Code running..."],
    "simplify": ["Code quality pass..."],
    "setup": ["Worktree creation..."],
    "fix": ["Simplify filter", "Apply fixes", "Re-verify"],
    "publish": ["git push", "gh pr create", "Post brief"],
}

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {"run_id": "", "issues": {}}
    try:
        return json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {"run_id": "", "issues": {}}


def load_log_tail(n: int = 15) -> list[str]:
    if not LOG_FILE.exists():
        return []
    try:
        result = subprocess.run(
            ["tail", f"-{n}", str(LOG_FILE)],
            capture_output=True, text=True, timeout=2
        )
        return result.stdout.strip().splitlines()
    except Exception:
        return []


def load_log_blocks() -> list[dict]:
    """Parse log into per-issue blocks split on ═══ separators."""
    if not LOG_FILE.exists():
        return []
    try:
        text = LOG_FILE.read_text(errors="replace")
    except OSError:
        return []

    blocks: list[dict] = []
    current: dict | None = None

    for line in text.splitlines():
        if "\u2550\u2550\u2550" in line:
            if current is not None and current.get("header"):
                current["lines"].append(line)
            continue

        m = re.search(r"\[(\d+)/(\d+)\]\s+#(\d+):\s+(.*)", line)
        if m:
            if current is not None:
                blocks.append(current)
            current = {
                "number": m.group(3), "header": line,
                "title": m.group(4).strip(),
                "position": f"{m.group(1)}/{m.group(2)}",
                "lines": [], "result": None,
            }
            continue

        if current is not None:
            current["lines"].append(line)
            if f"#{current['number']}" in line:
                if "COMPLETED" in line:
                    current["result"] = "completed"
                elif any(kw in line for kw in ["FAILED", "CRASHED", "TIMEOUT"]):
                    current["result"] = "failed"

    if current is not None:
        blocks.append(current)
    return blocks


def load_contextual_log(active_number: str | None, max_lines: int = 12) -> tuple[list[dict], list[str]]:
    """Collapsed summaries for finished blocks, expanded tail for active."""
    blocks = load_log_blocks()
    if not blocks:
        return [], load_log_tail(max_lines)

    collapsed: list[dict] = []
    active_lines: list[str] = []

    for blk in blocks:
        if blk.get("number") is None:
            continue
        if active_number and blk["number"] == active_number:
            active_lines = blk["lines"][-max_lines:]
        elif blk["result"]:
            collapsed.append({
                "number": blk["number"],
                "result": blk["result"],
            })

    if not active_lines and active_number:
        active_lines = load_log_tail(max_lines)

    return collapsed, active_lines


_title_cache: dict[str, str] = {}

def get_title(number: str, state: dict | None = None) -> str:
    if number in _title_cache:
        return _title_cache[number]
    if state:
        t = state.get("issues", {}).get(number, {}).get("title")
        if t:
            _title_cache[number] = t
            return t
    try:
        result = subprocess.run(
            ["gh", "issue", "view", number, "--json", "title", "-q", ".title"],
            capture_output=True, text=True, timeout=10, cwd=str(REPO_DIR)
        )
        title = result.stdout.strip() or f"#{number}"
    except Exception:
        title = f"#{number}"
    _title_cache[number] = title
    return title


def detect_phase(number: str) -> str:
    """Detect which pipeline phase the active issue is in."""
    if not LOG_FILE.exists():
        return "setup"
    try:
        result = subprocess.run(
            ["grep", "-E", f"Phase [0-9]", str(LOG_FILE)],
            capture_output=True, text=True, timeout=2
        )
        for line in reversed(result.stdout.strip().splitlines()):
            m = re.search(r"Phase (\d+)", line)
            if m:
                idx = int(m.group(1)) - 2
                if 0 <= idx < len(PHASES):
                    return PHASES[idx]
        return "setup"
    except Exception:
        return "setup"


def detect_substep_progress(phase: str, lines: list[str]) -> list[tuple[str, str]]:
    """Parse log lines to detect which sub-steps within a phase have passed.

    Returns list of (substep_label, status) where status is 'done', 'running', or 'pending'.
    """
    substeps = PHASE_SUBSTEPS.get(phase, [])
    if not substeps:
        return []

    log_text = "\n".join(lines)
    results: list[tuple[str, str]] = []

    if phase == "verify":
        patterns = [
            ("npm run verify", r"npm run verify passed|verify passed|\u2713.*verify"),
            ("Files changed", r"Files changed.*\u2264|Files:.*\u2264|\u2713.*Files"),
            ("Lines changed", r"Lines changed.*\u2264|\u2713.*Lines"),
            ("No dep changes", r"No unexpected dependency|\u2713.*dependency"),
        ]
        for i, step in enumerate(substeps):
            if i < len(patterns):
                _, pat = patterns[i]
                if re.search(pat, log_text, re.IGNORECASE):
                    results.append((step, "done"))
                else:
                    results.append((step, "running"))
                    results.extend((s, "pending") for s in substeps[i + 1:])
                    break
    elif phase == "panel-review":
        # Detect per-agent status from nightshift:panel log lines
        for step in substeps:
            agent_key = step.replace("-", ".")
            if re.search(rf"{re.escape(step)}.*done", log_text, re.IGNORECASE):
                results.append((step, "done"))
            elif re.search(rf"Starting {re.escape(step)}|{re.escape(step)}.*running", log_text, re.IGNORECASE):
                results.append((step, "running"))
            elif re.search(rf"{re.escape(step)}.*skip", log_text, re.IGNORECASE):
                results.append((step, "skipped"))
            else:
                results.append((step, "pending"))
    elif phase == "fix":
        fix_patterns = [
            ("Simplify filter", r"Simplify filter|simplify.filter"),
            ("Apply fixes", r"Fixing.*actionable|Apply fixes"),
            ("Re-verify", r"Re-verif|re.verify"),
        ]
        for i, step in enumerate(substeps):
            if i < len(fix_patterns):
                _, pat = fix_patterns[i]
                if re.search(pat, log_text, re.IGNORECASE):
                    results.append((step, "done"))
                else:
                    results.append((step, "running"))
                    results.extend((s, "pending") for s in substeps[i + 1:])
                    break
    else:
        # For other phases, just show them all as "running"
        for step in substeps:
            results.append((step, "running"))

    return results


def elapsed_since(iso_str: str | None) -> str:
    """Compute live elapsed time from an ISO timestamp."""
    if not iso_str:
        return ""
    try:
        started = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - started
        s = int(delta.total_seconds())
        if s < 0:
            s = 0
        if s >= 3600:
            return f"{s // 3600}h {s % 3600 // 60}m {s % 60}s"
        if s >= 60:
            return f"{s // 60}m {s % 60}s"
        return f"{s}s"
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def fmt_dur(seconds: int | None) -> str:
    if not seconds:
        return "\u2014"
    if seconds >= 3600:
        return f"{seconds // 3600}h {seconds % 3600 // 60}m"
    if seconds >= 60:
        return f"{seconds // 60}m {seconds % 60}s"
    return f"{seconds}s"


def trunc(s: str, n: int = 45) -> str:
    return s[:n - 1] + "\u2026" if len(s) > n else s


def colorize_log(line: str) -> Text:
    t = Text("    ")
    s = line.strip()
    if not s:
        return t

    if any(kw in s for kw in ["COMPLETE", "\u2713", "passed", "PASS"]):
        t.append(s, style="green")
    elif any(kw in s for kw in ["FAIL", "CRASH", "TIMEOUT", "ERROR"]):
        t.append(s, style="red")
    elif any(kw in s for kw in ["Phase", "\u2550\u2550\u2550"]):
        t.append(s, style="cyan")
    elif s.startswith("[nightshift]"):
        m = re.match(r"(\[nightshift\] \S+) (.*)", s)
        if m:
            t.append(m.group(1), style="bright_black")
            t.append(" " + m.group(2), style="white")
        else:
            t.append(s, style="white")
    elif s.startswith("[auto-dev]"):
        m = re.match(r"(\[auto-dev\] \S+) (.*)", s)
        if m:
            t.append(m.group(1), style="bright_black")
            t.append(" " + m.group(2), style="dim")
        else:
            t.append(s, style="dim")
    else:
        t.append(s, style="dim")
    return t


# ---------------------------------------------------------------------------
# Components — Factory aesthetic
# ---------------------------------------------------------------------------

def load_token_usage(state: dict) -> dict:
    """Aggregate token usage across all issues."""
    totals = {"input": 0, "output": 0, "cost": 0.0}
    for v in state.get("issues", {}).values():
        tu = v.get("token_usage")
        if tu:
            totals["input"] += tu.get("input", 0)
            totals["output"] += tu.get("output", 0)
            totals["cost"] += tu.get("cost_usd", 0)
    return totals


def make_header(state: dict, counts: dict, tw: int) -> Text:
    """Compact header: title + stats + progress bar, no panel border."""
    now = datetime.now().strftime("%H:%M:%S")
    total = counts["total"]
    done = counts["completed"]
    fail = counts["failed"]
    active = counts["in_progress"]
    pend = counts["pending"]
    skip = counts["skipped"]
    processed = done + fail
    pct = (done * 100 // total) if total > 0 else 0

    # Pass rate
    pass_rate = f"{done}/{processed}" if processed > 0 else "\u2014"

    # ETA
    eta = "\u2014"
    if done > 0:
        durs = [v.get("duration_s", 0) or 0 for v in state["issues"].values() if v.get("status") == "completed"]
        if durs:
            avg = sum(durs) / len(durs)
            eta = fmt_dur(int(avg * (pend + active)))

    # Progress bar
    bw = min(tw - 4, 70)
    if bw < 20:
        bw = 20
    dw = (done * bw // total) if total > 0 else 0
    fw = (fail * bw // total) if total > 0 else 0
    lw = max(0, bw - dw - fw)

    h = Text()
    h.append("\n")
    h.append("  NIGHTSHIFT", style="bold cyan")
    h.append(f"  {now}", style="bright_black")
    h.append(f"    pass rate: ", style="bright_black")
    h.append(pass_rate, style="bold green" if processed > 0 and done >= fail else "bold yellow")
    h.append(f"    ETA: ", style="bright_black")
    h.append(eta, style="white")

    # Token usage
    tokens = load_token_usage(state)
    if tokens["input"] > 0:
        h.append(f"    tokens: ", style="bright_black")
        h.append(f"{tokens['input'] // 1000}k in", style="white")
        h.append(" / ", style="bright_black")
        h.append(f"{tokens['output'] // 1000}k out", style="white")
        h.append(f"  est: ", style="bright_black")
        h.append(f"${tokens['cost']:.2f}", style="bold yellow")
    h.append("\n\n")

    # Bar
    h.append("  ")
    h.append("\u2588" * dw, style="green")
    h.append("\u2593" * fw, style="red")
    h.append("\u2591" * lw, style="bright_black")
    h.append(f"  {pct}%", style="bold")
    h.append(f"  {done}", style="green")
    h.append("/", style="bright_black")
    h.append(f"{total}", style="white")
    h.append("\n")

    # Compact status counts
    h.append("  ")
    h.append(f"{done} done", style="green")
    h.append("  \u2502  ", style="bright_black")
    h.append(f"{fail} fail", style="red")
    h.append("  \u2502  ", style="bright_black")
    h.append(f"{active} active", style="bold cyan")
    h.append("  \u2502  ", style="bright_black")
    h.append(f"{pend} queued", style="yellow")
    if skip > 0:
        h.append("  \u2502  ", style="bright_black")
        h.append(f"{skip} skip", style="bright_black")
    h.append("\n")

    return h


def make_conveyor(state: dict, active_num: str | None, active_lines: list[str]) -> Panel:
    """The conveyor belt: horizontal pipeline with expandable detail."""
    if not active_num:
        # No active issue — show idle state
        t = Text()
        t.append("  ", style="bright_black")
        for i, phase in enumerate(PHASES):
            t.append(f" \u25cb {phase} ", style="bright_black")
            if i < len(PHASES) - 1:
                t.append("\u2500\u2500\u2500", style="bright_black")
        t.append("\u2500\u25b6", style="bright_black")
        t.append("\n\n  ", style="")
        t.append("idle \u2014 waiting for next issue", style="bright_black")
        return Panel(t, title="[bright_black]\u2550 CONVEYOR \u2550[/]",
                     box=box.DOUBLE, border_style="bright_black", padding=(0, 1))

    info = state["issues"].get(active_num, {})
    title = get_title(active_num, state)
    current = detect_phase(active_num)
    elapsed = elapsed_since(info.get("started_at"))
    cur_idx = PHASES.index(current) if current in PHASES else 0

    t = Text()

    # --- Issue label ---
    t.append(f"  #{active_num}", style="bold cyan")
    t.append(f"  {trunc(title, 50)}", style="white")
    if elapsed:
        t.append(f"    \u23f1 {elapsed}", style="bold yellow")
    t.append("\n\n")

    # --- Horizontal belt ---
    t.append("  ")
    for i, phase in enumerate(PHASES):
        if i < cur_idx:
            t.append(f" \u25cf {phase} ", style="green")
        elif i == cur_idx:
            t.append(f" \u25c6 {phase.upper()} ", style="bold cyan")
        else:
            t.append(f" \u25cb {phase} ", style="bright_black")

        if i < len(PHASES) - 1:
            if i < cur_idx:
                t.append("\u2500\u2500\u2500", style="green")
            elif i == cur_idx:
                t.append("\u2501\u2501\u25b6", style="bold cyan")
            else:
                t.append("\u2500\u2500\u2500", style="bright_black")
    t.append("\n")

    # --- Expandable sub-step detail for active phase ---
    substeps = detect_substep_progress(current, active_lines)
    if substeps:
        # Draw a connector down from the active phase
        # Approximate position: each phase takes ~12 chars
        t.append("\n")
        for step_label, status in substeps:
            if status == "done":
                t.append("      \u2523\u2501 ", style="green")
                t.append(f"\u2713 {step_label}", style="green")
            elif status == "running":
                t.append("      \u2523\u2501 ", style="cyan")
                t.append(f"\u25b8 {step_label}", style="bold cyan")
            else:
                t.append("      \u2503  ", style="bright_black")
                t.append(f"\u25cb {step_label}", style="bright_black")
            t.append("\n")

    return Panel(t, title="[bold cyan]\u2550 CONVEYOR \u2550[/]",
                 box=box.DOUBLE, border_style="cyan", padding=(0, 1))


def make_output_bins(state: dict) -> Text:
    """Compact output bins for completed and failed issues. No heavy tables."""
    t = Text()

    completed = sorted(
        [(n, v) for n, v in state["issues"].items() if v.get("status") == "completed"],
        key=lambda x: int(x[0])
    )
    failed = sorted(
        [(n, v) for n, v in state["issues"].items() if v.get("status") == "failed"],
        key=lambda x: int(x[0])
    )

    if completed:
        t.append("  \u2550 OUTPUT ", style="green")
        t.append("\u2550" * 50, style="bright_black")
        t.append("\n")
        for num, info in completed:
            title = trunc(get_title(num, state), 35)
            dur = fmt_dur(info.get("duration_s"))
            pr_url = info.get("pr_url", "")
            pr = ""
            if pr_url:
                m = re.search(r"(\d+)$", pr_url)
                if m:
                    pr = f" \u2192 PR #{m.group(1)}"
            panel = info.get("panel_verdict", "")
            panel_str = f" [{panel}]" if panel else ""
            t.append(f"  \u2713 #{num:<5}", style="green")
            t.append(f" {title:<37}", style="white")
            panel_style = {"pass": "green", "conditional": "yellow", "fail": "red"}.get(panel, "bright_black")
            t.append(f"{panel_str:<14}", style=panel_style)
            t.append(f" {dur:>8}", style="bright_black")
            if pr:
                t.append(pr, style="bold green")
            t.append("\n")
        t.append("\n")

    if failed:
        t.append("  \u2550 REJECTED ", style="red")
        t.append("\u2550" * 48, style="bright_black")
        t.append("\n")
        for num, info in failed:
            title = trunc(get_title(num, state), 40)
            dur = fmt_dur(info.get("duration_s"))
            phase = info.get("phase", "?")
            t.append(f"  \u2717 #{num:<5}", style="red")
            t.append(f" {title:<42}", style="white")
            t.append(f" {phase:<10}", style="red")
            t.append(f" {dur:>8}", style="bright_black")
            t.append("\n")
        t.append("\n")

    return t


def make_hopper(state: dict) -> Text | None:
    """Input hopper: issues waiting to enter the conveyor."""
    pending = sorted(
        [n for n, v in state["issues"].items() if v.get("status") == "pending"],
        key=int
    )
    if not pending:
        return None

    t = Text()
    t.append("  \u2550 HOPPER ", style="yellow")
    t.append(f"({len(pending)}) ", style="yellow")
    t.append("\u2550" * 46, style="bright_black")
    t.append("\n  ")
    for i, num in enumerate(pending):
        t.append(f"#{num}", style="yellow")
        if i < len(pending) - 1:
            t.append(" \u00b7 ", style="bright_black")
    t.append("\n")
    return t


def make_log_feed(active_num: str | None, collapsed: list[dict], active_lines: list[str]) -> Text:
    """Live log feed with history ribbon."""
    t = Text()
    t.append("  \u2550 FEED ", style="bright_black")
    t.append("\u2550" * 52, style="bright_black")
    t.append("\n")

    # History ribbon
    if collapsed:
        t.append("  ")
        for i, blk in enumerate(collapsed):
            num = blk["number"]
            if blk["result"] == "completed":
                t.append(f"#{num}\u2713", style="green")
            else:
                t.append(f"#{num}\u2717", style="red")
            if i < len(collapsed) - 1:
                t.append(" ", style="")
        t.append("\n")

    # Active log lines
    if active_lines:
        for line in active_lines:
            t.append_text(colorize_log(line))
            t.append("\n")
    else:
        lines = load_log_tail(10)
        for line in lines:
            t.append_text(colorize_log(line))
            t.append("\n")

    return t


# ---------------------------------------------------------------------------
# Main render
# ---------------------------------------------------------------------------

def render(console: Console) -> Group:
    tw = console.width or 80
    state = load_state()
    issues = state.get("issues", {})

    counts = {
        "completed": sum(1 for v in issues.values() if v.get("status") == "completed"),
        "failed": sum(1 for v in issues.values() if v.get("status") == "failed"),
        "pending": sum(1 for v in issues.values() if v.get("status") == "pending"),
        "in_progress": sum(1 for v in issues.values() if v.get("status") == "in_progress"),
        "skipped": sum(1 for v in issues.values() if v.get("status") == "skipped"),
        "total": len(issues),
    }

    active_nums = [n for n, v in issues.items() if v.get("status") == "in_progress"]
    active_num = active_nums[0] if active_nums else None
    collapsed, active_lines = load_contextual_log(active_num)

    parts: list = []

    # Header (no border — just text)
    parts.append(make_header(state, counts, tw))

    # Conveyor belt (the star)
    parts.append(make_conveyor(state, active_num, active_lines))

    # Log feed (contextual)
    parts.append(make_log_feed(active_num, collapsed, active_lines))

    # Output bins (completed + failed)
    bins = make_output_bins(state)
    if bins.plain.strip():
        parts.append(bins)

    # Hopper (queued)
    hopper = make_hopper(state)
    if hopper:
        parts.append(hopper)

    # Footer
    parts.append(Text("\n  q: quit  r: refresh\n", style="bright_black"))

    return Group(*parts)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    once = "--once" in sys.argv
    console = Console()

    # Pre-cache titles
    console.print("[bright_black]  Loading titles...[/]")
    state = load_state()
    for num in state.get("issues", {}):
        get_title(num, state)

    if once:
        console.print(render(console))
        return

    try:
        with Live(render(console), console=console, refresh_per_second=0.5, screen=True) as live:
            while True:
                time.sleep(REFRESH_INTERVAL)
                live.update(render(console))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
