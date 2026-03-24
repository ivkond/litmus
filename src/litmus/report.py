#!/usr/bin/env python3
"""
HTML report generation from run results.

Structure:
  <session>/
    report.html                          — summary (statuses, no logs)
    <agent_model>/report.html            — detail per agent (all scenarios + logs)

CLI usage:
  python report.py <session_dir>

Code usage:
  from report import generate_report
  paths = generate_report(session_dir)
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\]8;;.*?\x1b\\?")


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def escape_html(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _format_log(text: str) -> str:
    return escape_html(strip_ansi(text))


# ---------------------------------------------------------------------------
# CSS (shared)
# ---------------------------------------------------------------------------

_CSS = """\
:root {
  --bg: #0f1419; --surface: #1a2332; --border: #2d3a4d;
  --text: #e6edf3; --muted: #8b949e;
  --ok: #3fb950; --warn: #d29922; --fail: #f85149; --accent: #58a6ff;
}
* { box-sizing: border-box; }
body { font-family: "Segoe UI", system-ui, sans-serif; background: var(--bg);
       color: var(--text); margin: 0; padding: 1.5rem; line-height: 1.5; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 1rem; }
.meta { color: var(--muted); font-size: .9rem; margin-bottom: 1.5rem; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; max-width: 1400px;
         background: var(--surface); border-radius: 8px; overflow: hidden;
         box-shadow: 0 2px 8px rgba(0,0,0,.3); }
th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid var(--border); }
th { background: var(--surface); color: var(--muted); font-weight: 600; }
td.run-name { font-weight: 500; white-space: nowrap; }
td.cell.empty { color: var(--muted); }
.badge { display: inline-block; padding: .2em .5em; border-radius: 4px;
          font-size: .8rem; font-weight: 600; }
.badge.ok { background: rgba(63,185,80,.2); color: var(--ok); }
.badge.warn { background: rgba(210,153,34,.2); color: var(--warn); }
.badge.fail { background: rgba(248,81,73,.2); color: var(--fail); }
.detail-panel { background: var(--surface); border: 1px solid var(--border);
                 border-radius: 8px; padding: 1rem 1.5rem; margin: 1.5rem 0; }
.detail-panel h3 { margin: 0 0 1rem; font-size: 1.1rem; color: var(--accent); }
.cmd-block { margin-bottom: 1.5rem; }
.cmd-block:last-child { margin-bottom: 0; }
.cmd-header { font-size: .85rem; color: var(--muted); margin-bottom: .25rem; }
.exit-ok { color: var(--ok); }
.exit-fail { color: var(--fail); }
.cmd-output { background: var(--bg); padding: .75rem; border-radius: 4px;
               font-size: .8rem; overflow-x: auto; max-height: 20rem;
               overflow-y: auto; white-space: pre-wrap; word-break: break-word;
               margin: .25rem 0; }
.back-link { display: inline-block; margin-top: 1rem; font-size: .9rem; }
.stats { display: flex; gap: 1.5rem; margin-bottom: 1rem; font-size: .95rem; }
.stats span { font-weight: 600; }
"""


# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------


def _parse_scenario(scenario_dir: Path, read_logs: bool = True) -> dict | None:
    """Parse a single scenario directory."""
    steps_file = scenario_dir / "steps.json"
    if not steps_file.is_file():
        return None
    try:
        steps = json.loads(steps_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    statuses = [s.get("status", "") for s in steps]
    has_fail = "failed" in statuses or "cancelled" in statuses
    has_done = "done" in statuses

    if not has_fail:
        status = "ok"
    elif has_fail and has_done:
        status = "warn"
    else:
        status = "fail"

    total_time = sum(s.get("elapsed", 0) or 0 for s in steps)

    if read_logs:
        for step in steps:
            log_file = scenario_dir / step.get("log_file", "")
            if log_file.is_file():
                step["output"] = log_file.read_text(encoding="utf-8", errors="replace")
            else:
                step["output"] = ""

    return {
        "status": status,
        "steps": steps,
        "total_time": round(total_time, 1),
        "step_count": len(steps),
    }


def _collect_run(run_dir: Path, read_logs: bool = True) -> dict[str, dict]:
    """Collect all scenarios for a single run (agent_model dir).
    Returns {scenario_id: parsed_data}."""
    results: dict[str, dict] = {}
    for d in sorted(run_dir.iterdir()):
        if not d.is_dir() or d.name == "reports":
            continue
        parsed = _parse_scenario(d, read_logs=read_logs)
        if parsed is not None:
            results[d.name] = parsed
    return results


# ---------------------------------------------------------------------------
# Per-agent detail report
# ---------------------------------------------------------------------------


def _build_agent_html(run_name: str, scenarios: dict[str, dict], session_name: str) -> str:
    generated = datetime.now().isoformat(sep=" ", timespec="seconds")
    title = escape_html(run_name)

    # Summary table
    rows = ["<tr><th>Scenario</th><th>Status</th><th>Steps</th><th>Time</th></tr>"]
    for sid, info in sorted(scenarios.items()):
        badge_cls = info["status"]
        badge_lbl = {"ok": "OK", "warn": "Warn", "fail": "Fail"}[badge_cls]
        detail_id = f"detail-{sid}"
        link = f'<a href="#{detail_id}">{escape_html(sid)}</a>'
        rows.append(
            f"<tr><td>{link}</td>"
            f'<td><span class="badge {badge_cls}">{badge_lbl}</span></td>'
            f"<td>{info['step_count']}</td>"
            f"<td>{info['total_time']}s</td></tr>"
        )

    # Detail panels
    panels = []
    for sid, info in sorted(scenarios.items()):
        detail_id = f"detail-{sid}"
        blocks = []
        for j, step in enumerate(info.get("steps", []), 1):
            name = escape_html(step.get("name", f"Step {j}"))
            output = _format_log(step.get("output", ""))
            status = step.get("status", "?")
            elapsed = step.get("elapsed")
            time_str = f" ({elapsed}s)" if elapsed is not None else ""
            sc = "exit-ok" if status == "done" else "exit-fail"
            blocks.append(
                f'<div class="cmd-block">'
                f'<div class="cmd-header">#{j}: {name}{time_str} '
                f'<span class="{sc}">[{status}]</span></div>'
                f'<pre class="cmd-output">{output}</pre>'
                f"</div>"
            )
        panels.append(
            f'<section class="detail-panel" id="{detail_id}">'
            f"<h3>{escape_html(sid)}</h3>"
            f"{''.join(blocks)}"
            f'<a href="#top" class="back-link">^ back to table</a>'
            f"</section>"
        )

    ok = sum(1 for s in scenarios.values() if s["status"] == "ok")
    warn = sum(1 for s in scenarios.values() if s["status"] == "warn")
    fail = sum(1 for s in scenarios.values() if s["status"] == "fail")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{_CSS}</style>
</head>
<body>
<h1 id="top">{title}</h1>
<p class="meta">Session: {escape_html(session_name)} &middot; Generated: {generated}
 &middot; <a href="../report.html">Summary</a></p>
<div class="stats">
  <span style="color:var(--ok)">{ok} ok</span>
  <span style="color:var(--warn)">{warn} warn</span>
  <span style="color:var(--fail)">{fail} fail</span>
</div>
<div class="table-wrap"><table>
{"".join(rows)}
</table></div>
<h2>Step details</h2>
{"".join(panels)}
</body></html>"""


# ---------------------------------------------------------------------------
# Summary report
# ---------------------------------------------------------------------------


def _build_summary_html(
    run_names: list[str],
    scenario_ids: list[str],
    summary: dict[tuple[str, str], dict],
    session_name: str,
) -> str:
    generated = datetime.now().isoformat(sep=" ", timespec="seconds")

    header = (
        "<tr><th>Agent / Model</th>"
        + "".join(f"<th>{escape_html(s)}</th>" for s in scenario_ids)
        + "<th>Score</th></tr>"
    )

    rows = []
    for run_name in run_names:
        link = f'<a href="{run_name}/report.html">{escape_html(run_name)}</a>'
        cells = [f'<td class="run-name">{link}</td>']
        ok_count = 0
        total_count = 0
        for sid in scenario_ids:
            key = (run_name, sid)
            if key not in summary:
                cells.append('<td class="cell empty">&mdash;</td>')
                continue
            total_count += 1
            info = summary[key]
            sc = info["status"]
            label = {"ok": "OK", "warn": "Warn", "fail": "Fail"}[sc]
            time_str = f'<br><small style="color:var(--muted)">{info["total_time"]}s</small>'
            cells.append(f'<td class="cell"><span class="badge {sc}">{label}</span>{time_str}</td>')
            if sc in ("ok", "warn"):
                ok_count += 1
        # Score column
        if total_count:
            pct = ok_count * 100 // total_count
            color = "var(--ok)" if pct == 100 else "var(--warn)" if pct >= 50 else "var(--fail)"
            cells.append(f'<td style="font-weight:600;color:{color}">{ok_count}/{total_count}</td>')
        else:
            cells.append('<td class="cell empty">&mdash;</td>')
        rows.append("<tr>" + "".join(cells) + "</tr>")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Summary: {escape_html(session_name)}</title>
<style>{_CSS}</style>
</head>
<body>
<h1 id="top">Summary: {escape_html(session_name)}</h1>
<p class="meta">Generated: {generated}</p>
<div class="table-wrap"><table>
<thead>{header}</thead>
<tbody>{"".join(rows)}</tbody>
</table></div>
</body></html>"""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def generate_report(session_dir: Path) -> list[Path]:
    """Generate all reports for a session.

    Returns list of generated file paths.
    """
    if not session_dir.is_dir():
        return []

    generated: list[Path] = []
    run_names: list[str] = []
    all_scenario_ids: set[str] = set()
    summary: dict[tuple[str, str], dict] = {}

    # 1. Per-agent detail reports
    for run_dir in sorted(session_dir.iterdir()):
        if not run_dir.is_dir() or run_dir.name.startswith(".") or run_dir.name == "reports":
            continue
        run_name = run_dir.name
        scenarios = _collect_run(run_dir, read_logs=True)
        if not scenarios:
            continue

        run_names.append(run_name)
        all_scenario_ids.update(scenarios.keys())

        # Store summary info (without logs)
        for sid, info in scenarios.items():
            summary[(run_name, sid)] = {
                "status": info["status"],
                "total_time": info["total_time"],
                "step_count": info["step_count"],
            }

        html = _build_agent_html(run_name, scenarios, session_dir.name)
        out = run_dir / "report.html"
        out.write_text(html, encoding="utf-8")
        generated.append(out)

    if not run_names:
        return []

    # 2. Summary report
    scenario_ids = sorted(all_scenario_ids)
    html = _build_summary_html(run_names, scenario_ids, summary, session_dir.name)
    out = session_dir / "report.html"
    out.write_text(html, encoding="utf-8")
    generated.append(out)

    return generated


def main() -> None:
    from rich.console import Console

    console = Console()

    if len(sys.argv) < 2:
        console.print("[red]Usage: python report.py <session_dir>[/red]")
        sys.exit(1)

    session_dir = Path(sys.argv[1])
    paths = generate_report(session_dir)
    if paths:
        for p in paths:
            console.print(f"  [bold]{p}[/bold]")
        console.print(f"[green]Generated {len(paths)} reports[/green]")
    else:
        console.print(f"[red]No data in {session_dir}[/red]")
        sys.exit(1)


if __name__ == "__main__":
    main()
