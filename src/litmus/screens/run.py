"""Run-related screens: configuration, progress, viewer, and detail."""

import contextlib
import threading
from pathlib import Path

from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import (
    DataTable,
    Footer,
    Header,
    Label,
    OptionList,
    ProgressBar,
    Static,
    Tree,
)
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from ..agents import load_analysis_config, load_config
from ..run import CancelledError, get_scenario_ids, make_model_safe, run_single_scenario
from ._common import RESULTS_DIR, TEMPLATE_DIR, ModelSelectionList, OpenWithScreen


class RunConfigScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("enter", "start", "Start"),
    ]

    CSS = """
    RunConfigScreen { layout: vertical; }
    #rc-body { padding: 1 2; }
    #rc-tree { height: auto; max-height: 14; margin-bottom: 1; }
    #rc-scenarios { height: auto; max-height: 14; margin-bottom: 1; }
    #rc-summary { text-style: bold; margin-top: 1; }
    .rc-label { text-style: bold; color: $accent; margin-bottom: 0; }
    """

    def __init__(self) -> None:
        super().__init__()
        self._agents: list[dict] = []

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="rc-body"):
            yield Label("Agents & Models", classes="rc-label")
            yield Tree("config", id="rc-tree")
            yield Label("Scenarios", classes="rc-label")
            yield ModelSelectionList(id="rc-scenarios")
            yield Label("", id="rc-summary")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Run tests"
        config = load_config()
        if not config or "agents" not in config:
            self.notify("No config.yaml — run Models first", severity="error")
            return

        self._agents = config["agents"]

        # Build tree
        tree = self.query_one("#rc-tree", Tree)
        tree.show_root = False
        for agent in self._agents:
            name = agent["name"]
            models = agent.get("models", [])
            branch = tree.root.add(f"{name} ({len(models)} models)", expand=True)
            for m in models:
                branch.add_leaf(m)

        # Build scenario checklist (all selected)
        scenario_ids = get_scenario_ids(TEMPLATE_DIR)
        sl = self.query_one("#rc-scenarios", ModelSelectionList)
        for sid in scenario_ids:
            sl.add_option(Selection(sid, sid, True))

        self._update_summary()

    def on_selection_list_selection_toggled(self, event) -> None:
        self._update_summary()

    def _update_summary(self) -> None:
        sl = self.query_one("#rc-scenarios", ModelSelectionList)
        n_scenarios = len(sl.selected)
        n_models = sum(len(a.get("models", [])) for a in self._agents)
        n_agents = len(self._agents)
        total = n_models * n_scenarios
        self.query_one("#rc-summary", Label).update(
            f"Total: {n_agents} agents x {n_models} models x {n_scenarios} scenarios = {total} runs"
        )

    def action_start(self) -> None:
        # Block if there's already an active run
        active = getattr(self.app, "active_run", None)
        if active is not None and active.running:
            self.notify(
                "A run is already in progress — finish or stop it first", severity="warning"
            )
            return
        sl = self.query_one("#rc-scenarios", ModelSelectionList)
        selected_scenarios = list(sl.selected)
        if not selected_scenarios:
            self.notify("Select at least one scenario", severity="error")
            return
        if not self._agents:
            self.notify("No agents configured", severity="error")
            return
        self.app.push_screen(RunProgressScreen(self._agents, selected_scenarios))

    def action_back(self) -> None:
        self.app.pop_screen()


# ═══════════════════════════════════════════════════════════════════════════
# Run State — shared between RunProgressScreen and RunViewerScreen
# ═══════════════════════════════════════════════════════════════════════════


class RunState:
    """Mutable run state shared between the execution screen and viewer."""

    STYLE_MAP = {
        "pending": "dim",
        "running": "yellow",
        "done": "green",
        "failed": "red",
        "stopped": "magenta",
    }

    def __init__(
        self,
        tasks: list[tuple[str, str, str, str]],
        run_dir: Path,
    ) -> None:
        self.tasks = tasks
        self.run_dir = run_dir
        self.status: dict[int, str] = {i: "pending" for i in range(len(tasks))}
        self.times: dict[int, float] = {}
        self.done_count = 0
        self.running = False
        self.cancel_events: dict[int, threading.Event] = {}

    def set_status(self, idx: int, status: str, elapsed: float | None = None) -> None:
        self.status[idx] = status
        if elapsed is not None:
            self.times[idx] = elapsed
        self.done_count = sum(1 for s in self.status.values() if s in ("done", "failed", "stopped"))


# ═══════════════════════════════════════════════════════════════════════════
# Run Progress Screen — live execution
# ═══════════════════════════════════════════════════════════════════════════


class RunProgressScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("s", "stop", "Stop"),
        Binding("r", "restart", "Restart"),
    ]

    CSS = """
    RunProgressScreen { layout: vertical; }
    #rp-header { padding: 0 2; height: 3; }
    #rp-progress { margin: 0 2; }
    #rp-table { height: 1fr; }
    """

    def __init__(self, agents: list[dict], scenario_ids: list[str]) -> None:
        from datetime import datetime

        super().__init__()
        # Build flat task list
        tasks: list[tuple[str, str, str, str]] = []
        for agent in agents:
            tasks.extend(
                (agent["name"], agent["cmd_template"], model, sid)
                for model in agent.get("models", [])
                for sid in scenario_ids
            )
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self._state = RunState(tasks, RESULTS_DIR / ts)

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical(id="rp-header"):
            yield Label("", id="rp-label")
            yield ProgressBar(id="rp-progress", total=len(self._state.tasks), show_eta=False)
        yield DataTable(id="rp-table")
        yield Footer()

    def on_mount(self) -> None:
        self.app.active_run = self._state  # type: ignore[attr-defined]
        self.title = "Running..."
        table = self.query_one("#rp-table", DataTable)
        cols = table.add_columns("#", "Agent", "Model", "Scenario", "Status", "Time")
        self._col_status = cols[4]
        self._col_time = cols[5]
        table.cursor_type = "row"
        for i, (agent, _cmd, model, sid) in enumerate(self._state.tasks):
            table.add_row(str(i + 1), agent, model, sid, "pending", "-", key=str(i))
        self.query_one("#rp-label", Label).update(f"Progress: 0/{len(self._state.tasks)} runs")
        self._run_all()

    def _exec_task(self, idx: int) -> tuple[int, bool]:
        import time

        st = self._state
        cancel_ev = st.cancel_events.get(idx)
        if cancel_ev and cancel_ev.is_set():
            st.set_status(idx, "stopped")
            self._try_update_ui(idx)
            return idx, False

        cancel_ev = threading.Event()
        st.cancel_events[idx] = cancel_ev

        agent_name, cmd_template, model, scenario_id = st.tasks[idx]
        model_safe = make_model_safe(model)
        run_name = f"{agent_name}_{model_safe}"
        work_dir = st.run_dir / run_name / scenario_id
        run_id = f"{run_name}/{scenario_id}"

        st.set_status(idx, "running")
        self._try_update_ui(idx)
        start = time.monotonic()
        try:
            ok = run_single_scenario(
                cmd_template,
                model,
                scenario_id,
                TEMPLATE_DIR,
                work_dir,
                run_id,
                cancel_event=cancel_ev,
            )
        except CancelledError:
            elapsed = time.monotonic() - start
            st.set_status(idx, "stopped", elapsed)
            self._try_update_ui(idx)
            return idx, False
        except Exception as exc:
            ok = False
            import traceback

            print(f"  [{run_id}] crashed: {exc}", file=__import__("sys").stderr)
            traceback.print_exc(file=__import__("sys").stderr)
            err_log = work_dir / "00_crash.log"
            try:
                work_dir.mkdir(parents=True, exist_ok=True)
                with err_log.open("a", encoding="utf-8") as f:
                    f.write(f"\n[CRASH] {exc}\n")
                    traceback.print_exc(file=f)
            except OSError:
                pass
        elapsed = time.monotonic() - start

        status = "done" if ok else "failed"
        st.set_status(idx, status, elapsed)
        self._try_update_ui(idx)

        # Trigger incremental LLM evaluation when all scenarios for this run_name are done
        if ok:
            self._maybe_evaluate_run(run_name)

        return idx, ok

    def _maybe_evaluate_run(self, run_name: str) -> None:
        """If all scenarios for run_name are complete, trigger LLM evaluation."""
        st = self._state
        # Check if all tasks for this run_name are done
        for i, (a, _cmd, m, _sid) in enumerate(st.tasks):
            rn = f"{a}_{make_model_safe(m)}"
            if rn == run_name and st.status.get(i) not in ("done", "failed", "stopped"):
                return  # still pending/running

        run_dir = st.run_dir / run_name
        cache = run_dir / "evaluation.json"
        if cache.is_file():
            return  # already evaluated

        # Load analysis config
        cfg = load_analysis_config()
        if not cfg.get("model"):
            return  # LLM not configured

        try:
            from ..analysis import evaluate_run

            evaluate_run(run_dir, cfg["model"], cfg.get("api_key", ""), cfg.get("base_url", ""))
        except Exception as e:
            import sys

            print(f"  [analysis] {run_name} evaluation failed: {e}", file=sys.stderr)

    def _try_update_ui(self, idx: int) -> None:
        """Schedule UI update from worker thread. No-op if screen is gone."""
        with contextlib.suppress(Exception):
            self.app.call_from_thread(self._refresh_row, idx)

    @work(thread=True)
    def _run_all(self) -> None:
        self._run_batch(list(range(len(self._state.tasks))))

    @work(thread=True)
    def _run_indices(self, indices: list[int]) -> None:
        self._run_batch(indices)

    def _run_batch(self, indices: list[int]) -> None:
        from concurrent.futures import ThreadPoolExecutor, as_completed

        self._state.run_dir.mkdir(parents=True, exist_ok=True)
        self._state.running = True

        max_workers = min(len(indices), 4) or 1
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(self._exec_task, i): i for i in indices}
            for future in as_completed(futures):
                future.result()

        self._state.running = False

        # Generate reports in worker thread (doesn't need UI)
        self._finalize_reports()

        # Notify UI (best-effort — screen may be popped)
        with contextlib.suppress(Exception):
            self.app.call_from_thread(self._on_all_done)

    def _finalize_reports(self) -> None:
        """Generate HTML reports and LLM analysis. Runs in worker thread."""
        import sys

        # HTML reports
        from ..report import generate_report

        try:
            generate_report(self._state.run_dir)
        except Exception as e:
            print(f"  [report] generation failed: {e}", file=sys.stderr)

        # LLM analysis assembly (from cached per-run evaluations)
        cfg = load_analysis_config()
        if cfg.get("model"):
            from ..analysis import assemble_report

            try:
                assemble_report(self._state.run_dir, **cfg)
            except Exception as e:
                print(f"  [analysis] assembly failed: {e}", file=sys.stderr)

    def _refresh_row(self, idx: int) -> None:
        """Update a single row in the UI from current state. Main-thread only."""
        st = self._state
        status = st.status.get(idx, "pending")
        elapsed = st.times.get(idx)
        try:
            self.query_one("#rp-progress", ProgressBar).update(progress=st.done_count)
            style = RunState.STYLE_MAP.get(status, "")
            time_str = f"{elapsed:.1f}s" if elapsed is not None else "-"
            table = self.query_one("#rp-table", DataTable)
            table.update_cell(str(idx), self._col_status, Text(status, style=style))
            table.update_cell(str(idx), self._col_time, time_str)
            total = len(st.tasks)
            self.query_one("#rp-label", Label).update(f"Progress: {st.done_count}/{total} runs")
        except Exception:
            pass

    def _on_all_done(self) -> None:
        done = sum(1 for s in self._state.status.values() if s == "done")
        failed = sum(1 for s in self._state.status.values() if s == "failed")
        self.title = f"Done — {done} passed, {failed} failed"
        self.notify(f"Finished: {done} passed, {failed} failed. Reports generated.")

    def _get_cursor_idx(self) -> int | None:
        table = self.query_one("#rp-table", DataTable)
        idx = table.cursor_row
        if idx is not None and idx < len(self._state.tasks):
            return idx
        return None

    def action_stop(self) -> None:
        idx = self._get_cursor_idx()
        if idx is None:
            return
        st = self._state
        status = st.status.get(idx)
        if status in ("pending", "running"):
            ev = st.cancel_events.get(idx)
            if ev:
                ev.set()
            else:
                ev = threading.Event()
                ev.set()
                st.cancel_events[idx] = ev
            if status == "pending":
                st.set_status(idx, "stopped")
                self._refresh_row(idx)
            else:
                self.notify(f"Killing #{idx + 1}...")

    def action_restart(self) -> None:
        idx = self._get_cursor_idx()
        if idx is None:
            return
        st = self._state
        status = st.status.get(idx)
        if status in ("done", "failed", "stopped"):
            st.cancel_events.pop(idx, None)
            st.set_status(idx, "pending")
            self._refresh_row(idx)
            self._run_indices([idx])

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        idx = event.cursor_row
        if idx < len(self._state.tasks):
            agent_name, _cmd, model, scenario_id = self._state.tasks[idx]
            model_safe = make_model_safe(model)
            run_name = f"{agent_name}_{model_safe}"
            work_dir = self._state.run_dir / run_name / scenario_id
            self.app.push_screen(RunDetailScreen(agent_name, model, scenario_id, work_dir))

    def action_back(self) -> None:
        self.app.pop_screen()


# ═══════════════════════════════════════════════════════════════════════════
# Run Viewer Screen — read-only view of a RunState (for "Current run")
# ═══════════════════════════════════════════════════════════════════════════


class RunViewerScreen(Screen):
    """Read-only view that polls RunState and refreshes the table."""

    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("h", "report", "Report"),
    ]

    CSS = """
    RunViewerScreen { layout: vertical; }
    #rv-header { padding: 0 2; height: 3; }
    #rv-progress { margin: 0 2; }
    #rv-table { height: 1fr; }
    """

    def __init__(self, state: RunState) -> None:
        super().__init__()
        self._state = state
        self._last_snapshot: dict[int, tuple[str, float | None]] = {}

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical(id="rv-header"):
            yield Label("", id="rv-label")
            yield ProgressBar(id="rv-progress", total=len(self._state.tasks), show_eta=False)
        yield DataTable(id="rv-table")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Current run"
        self._build_table()
        self.set_interval(0.5, self._poll_state)

    def _build_table(self) -> None:
        table = self.query_one("#rv-table", DataTable)
        table.clear(columns=True)
        cols = table.add_columns("#", "Agent", "Model", "Scenario", "Status", "Time")
        self._col_status = cols[4]
        self._col_time = cols[5]
        table.cursor_type = "row"

        st = self._state
        for i, (agent, _cmd, model, sid) in enumerate(st.tasks):
            status = st.status.get(i, "pending")
            elapsed = st.times.get(i)
            time_str = f"{elapsed:.1f}s" if elapsed is not None else "-"
            style = RunState.STYLE_MAP.get(status, "")
            table.add_row(
                str(i + 1),
                agent,
                model,
                sid,
                Text(status, style=style),
                time_str,
                key=str(i),
            )
            self._last_snapshot[i] = (status, elapsed)

        self._update_chrome()

    def _poll_state(self) -> None:
        """Called by timer — update only changed rows."""
        st = self._state
        table = self.query_one("#rv-table", DataTable)
        changed = False
        for i in range(len(st.tasks)):
            status = st.status.get(i, "pending")
            elapsed = st.times.get(i)
            prev = self._last_snapshot.get(i)
            if prev == (status, elapsed):
                continue
            changed = True
            self._last_snapshot[i] = (status, elapsed)
            style = RunState.STYLE_MAP.get(status, "")
            time_str = f"{elapsed:.1f}s" if elapsed is not None else "-"
            table.update_cell(str(i), self._col_status, Text(status, style=style))
            table.update_cell(str(i), self._col_time, time_str)
        if changed:
            self._update_chrome()

    def _update_chrome(self) -> None:
        st = self._state
        total = len(st.tasks)
        self.query_one("#rv-label", Label).update(f"Progress: {st.done_count}/{total} runs")
        self.query_one("#rv-progress", ProgressBar).update(progress=st.done_count)
        if not st.running:
            done = sum(1 for s in st.status.values() if s == "done")
            failed = sum(1 for s in st.status.values() if s == "failed")
            self.title = f"Done — {done} passed, {failed} failed"

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        idx = event.cursor_row
        st = self._state
        if idx < len(st.tasks):
            agent_name, _cmd, model, scenario_id = st.tasks[idx]
            model_safe = make_model_safe(model)
            run_name = f"{agent_name}_{model_safe}"
            work_dir = st.run_dir / run_name / scenario_id
            self.app.push_screen(RunDetailScreen(agent_name, model, scenario_id, work_dir))

    def action_report(self) -> None:
        report_file = self._state.run_dir / "report.html"
        if report_file.is_file():
            import webbrowser

            webbrowser.open(report_file.as_uri())
        else:
            self.notify("No report yet", severity="warning")

    def action_back(self) -> None:
        self.app.pop_screen()


# ═══════════════════════════════════════════════════════════════════════════
# Run Detail Screen — single scenario drill-in
# ═══════════════════════════════════════════════════════════════════════════


class RunDetailScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("o", "open", "Open project..."),
        Binding("r", "refresh", "Refresh"),
        Binding("h", "report", "Report"),
    ]

    CSS = """
    RunDetailScreen { layout: vertical; }
    #rd-main { height: 1fr; }
    #rd-steps-pane {
        width: 1fr;
        max-width: 35;
        border-right: solid $surface-lighten-2;
    }
    #rd-steps-pane-label {
        padding: 0 1;
        text-style: bold;
        color: $text-muted;
    }
    #rd-steps-list { height: 1fr; }
    #rd-log-pane {
        width: 3fr;
        padding: 0 1;
    }
    #rd-log-title {
        text-style: bold;
        color: $accent;
        margin-bottom: 1;
    }
    #rd-log-content {
        height: 1fr;
    }
    """

    def __init__(self, agent: str, model: str, scenario_id: str, work_dir: Path) -> None:
        super().__init__()
        self._agent = agent
        self._model = model
        self._scenario_id = scenario_id
        self._work_dir = work_dir
        self._steps: list[dict] = []

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="rd-main"):
            with Vertical(id="rd-steps-pane"):
                yield Label(" Steps", id="rd-steps-pane-label")
                yield OptionList(id="rd-steps-list")
            with Vertical(id="rd-log-pane"):
                yield Label("Select a step", id="rd-log-title")
                with VerticalScroll(id="rd-log-content"):
                    yield Static("", id="rd-log-text", markup=False)
        yield Footer()

    def on_mount(self) -> None:
        self.title = f"{self._agent} / {self._model} / {self._scenario_id}"
        self._load_steps()

    @staticmethod
    def _strip_ansi(text: str) -> str:
        import re

        return re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", text)

    def _load_steps(self) -> None:
        import json

        steps_file = self._work_dir / "steps.json"
        ol = self.query_one("#rd-steps-list", OptionList)
        ol.clear_options()
        self._steps = []

        if steps_file.is_file():
            with contextlib.suppress(json.JSONDecodeError, OSError):
                self._steps = json.loads(steps_file.read_text(encoding="utf-8"))

        if not self._steps:
            # Fallback: show raw log files sorted by name (numbered: 01_*, 02_*, ...)
            log_files = sorted(
                f.name for f in self._work_dir.iterdir() if f.is_file() and f.suffix == ".log"
            )
            for name in log_files:
                self._steps.append(
                    {
                        "name": name,
                        "log_file": name,
                        "status": "done",
                        "elapsed": None,
                        "start_iso": "",
                        "end_iso": "",
                    }
                )

        status_style = {
            "running": ("▸", "bold yellow"),
            "done": ("✓", "bold green"),
            "failed": ("✗", "bold red"),
            "cancelled": ("⊘", "dim"),
        }
        for i, step in enumerate(self._steps):
            icon, style = status_style.get(step.get("status", ""), (" ", ""))
            elapsed = step.get("elapsed")
            time_str = f" ({elapsed}s)" if elapsed is not None else ""
            ts = step.get("start_iso", "")
            prefix = f"[{ts}] " if ts else ""
            label = Text.assemble(
                (icon, style),
                " ",
                prefix,
                step["name"],
                time_str,
            )
            ol.add_option(Option(label, id=str(i)))

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_list.id != "rd-steps-list":
            return
        idx = int(event.option.id)  # type: ignore[arg-type]
        if idx < len(self._steps):
            self._show_step_log(self._steps[idx])

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        if event.option_list.id != "rd-steps-list":
            return
        if event.option and event.option.id is not None:
            idx = int(event.option.id)
            if idx < len(self._steps):
                self._show_step_log(self._steps[idx])

    def _show_step_log(self, step: dict) -> None:
        log_file = self._work_dir / step.get("log_file", "")
        title = step.get("name", "")
        status = step.get("status", "")
        self.query_one("#rd-log-title", Label).update(f"{title}  [{status}]")
        if log_file.is_file():
            text = self._strip_ansi(log_file.read_text(encoding="utf-8", errors="replace"))
            self.query_one("#rd-log-text", Static).update(text or "(empty log)")
        else:
            self.query_one("#rd-log-text", Static).update("(log not yet available)")
        self.query_one("#rd-log-content", VerticalScroll).scroll_home()

    def action_refresh(self) -> None:
        self._load_steps()
        self.notify("Refreshed")

    def action_report(self) -> None:
        report_file = self._work_dir.parent / "report.html"
        if report_file.is_file():
            import webbrowser

            webbrowser.open(report_file.as_uri())
        else:
            self.notify("No report yet — run from Results (r)", severity="warning")

    def action_open(self) -> None:
        self.app.push_screen(OpenWithScreen(str(self._work_dir)))

    def action_back(self) -> None:
        self.app.pop_screen()
