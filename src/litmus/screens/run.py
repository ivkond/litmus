"""Run-related screens: configuration, progress, viewer, and detail."""

import contextlib
import json
import sys
import threading
import time
import traceback
import webbrowser
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import yaml
from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Header,
    Input,
    Label,
    OptionList,
    ProgressBar,
    Static,
)
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from ..agents import DetectedAgent, load_cache
from ..report import strip_ansi
from ..run import CancelledError, get_scenario_ids, make_model_safe, run_single_scenario
from ._common import RESULTS_DIR, TEMPLATE_DIR, ModelSelectionList, OpenWithScreen


class AgentModelPickerScreen(Screen):
    """Modal: pick agents and models for a run."""

    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("a", "show_all_selected", "All selected"),
    ]

    CSS = """
    AgentModelPickerScreen { align: center middle; }
    #amp-box {
        width: 90;
        height: 26;
        border: solid $accent;
        padding: 1 2;
    }
    #amp-title {
        text-style: bold;
        text-align: center;
        margin-bottom: 1;
    }
    #amp-body { height: 1fr; }
    #amp-agents-pane {
        width: 1fr;
        max-width: 35;
        border-right: solid $surface-lighten-2;
    }
    #amp-models-pane { width: 2fr; }
    .amp-label {
        text-style: bold;
        color: $accent;
        padding: 0 1;
    }
    #amp-filter {
        margin: 0 1;
        height: 3;
    }
    #amp-footer {
        height: auto;
        width: 1fr;
        margin-top: 1;
        layout: horizontal;
        align: center middle;
    }
    #amp-hint {
        width: 1fr;
        color: $text-muted;
        padding: 0 1;
    }
    #amp-ok {
        width: auto;
        min-width: 16;
        border: none;
        padding: 0 2;
        dock: right;
    }
    """

    def __init__(
        self,
        detected: list[DetectedAgent],
        selected_models: set[str] | None = None,
    ) -> None:
        super().__init__()
        self._detected = detected
        self._by_name: dict[str, DetectedAgent] = {d.info.name: d for d in detected}
        self._selected_models: set[str] = set(selected_models) if selected_models else set()
        self._highlighted_agent: str | None = None
        self._show_all_mode: bool = False
        # Models currently displayed in the list (for index → value mapping)
        self._displayed_models: list[str] = []

    def compose(self) -> ComposeResult:
        with Vertical(id="amp-box"):
            yield Label("Select agents and models", id="amp-title")
            with Horizontal(id="amp-body"):
                with Vertical(id="amp-agents-pane"):
                    yield Label("Agents", classes="amp-label")
                    yield OptionList(id="amp-agents")
                with Vertical(id="amp-models-pane"):
                    yield Label("Models", id="amp-models-label", classes="amp-label")
                    yield Input(placeholder="Filter models...", id="amp-filter")
                    yield ModelSelectionList(id="amp-models")
            with Horizontal(id="amp-footer"):
                yield Label("Esc = Cancel \u00b7 A = All selected", id="amp-hint")
                yield Button("OK", id="amp-ok", variant="primary")

    def on_mount(self) -> None:
        agents_ol = self.query_one("#amp-agents", OptionList)
        for d in self._detected:
            agents_ol.add_option(Option(self._agent_label(d), id=d.info.name))
        # Models pane starts empty — highlight an agent to see its models

    # ── Agent labels with counter ─────────────────────────────────────────

    def _agent_label(self, d: DetectedAgent) -> str:
        n_sel = len(self._selected_models & set(d.models))
        n_total = len(d.models)
        return f"{d.info.name}  ({n_sel}/{n_total})"

    def _update_agent_labels(self) -> None:
        agents_ol = self.query_one("#amp-agents", OptionList)
        for i, d in enumerate(self._detected):
            agents_ol.replace_option_prompt_at_index(i, self._agent_label(d))

    def _compute_selected_agents(self) -> set[str]:
        """Agents that have at least one selected model."""
        return {d.info.name for d in self._detected if self._selected_models & set(d.models)}

    # ── Models list rebuild ───────────────────────────────────────────────

    def _rebuild_models_list(self, models: list[str]) -> None:
        sl = self.query_one("#amp-models", ModelSelectionList)
        sl.clear_options()
        self._displayed_models = list(models)
        for m in models:
            sl.add_option(Selection(m, m, m in self._selected_models))

    def _show_agent_models(self, agent_name: str) -> None:
        self._highlighted_agent = agent_name
        self._show_all_mode = False
        d = self._by_name.get(agent_name)
        models = d.models if d else []
        filter_text = self.query_one("#amp-filter", Input).value.strip().lower()
        if filter_text:
            models = [m for m in models if filter_text in m.lower()]
        self._rebuild_models_list(models)
        label = self.query_one("#amp-models-label", Label)
        label.update(f"Models \u2014 {agent_name}")

    def _refresh_models_view(self) -> None:
        """Re-apply current view (agent or all-selected) with current filter."""
        if self._show_all_mode:
            self._do_show_all_selected()
        elif self._highlighted_agent:
            self._show_agent_models(self._highlighted_agent)

    # ── Events ────────────────────────────────────────────────────────────

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        if event.option_list.id == "amp-agents" and event.option and event.option.id:
            self._show_agent_models(event.option.id)

    def on_selection_list_selection_toggled(
        self, event: ModelSelectionList.SelectionToggled
    ) -> None:
        if event.selection_list.id == "amp-models":
            idx = event.selection_index
            if idx < len(self._displayed_models):
                model_name = self._displayed_models[idx]
                if model_name in self._selected_models:
                    self._selected_models.discard(model_name)
                else:
                    self._selected_models.add(model_name)
                self._update_agent_labels()

    @on(Input.Changed, "#amp-filter")
    def _on_filter_changed(self, event: Input.Changed) -> None:
        self._refresh_models_view()

    # ── Actions ───────────────────────────────────────────────────────────

    def action_show_all_selected(self) -> None:
        if self._show_all_mode:
            # Toggle back to agent view
            if self._highlighted_agent:
                self._show_agent_models(self._highlighted_agent)
            else:
                self._show_all_mode = False
                self._rebuild_models_list([])
                self.query_one("#amp-models-label", Label).update("Models")
            return
        self._do_show_all_selected()

    def _do_show_all_selected(self) -> None:
        self._show_all_mode = True
        models = sorted(self._selected_models)
        filter_text = self.query_one("#amp-filter", Input).value.strip().lower()
        if filter_text:
            models = [m for m in models if filter_text in m.lower()]
        self._rebuild_models_list(models)
        label = self.query_one("#amp-models-label", Label)
        label.update(f"All selected ({len(self._selected_models)})")

    @on(Button.Pressed, "#amp-ok")
    def _on_ok(self, event: Button.Pressed) -> None:
        self.dismiss((self._compute_selected_agents(), self._selected_models.copy()))

    def action_cancel(self) -> None:
        self.dismiss(None)


class RunConfigScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("enter", "start", "Start"),
        Binding("m", "pick_models", "Models"),
    ]

    CSS = """
    RunConfigScreen { layout: vertical; }
    #rc-body { padding: 1 2; }
    #rc-tree {
        height: auto;
        max-height: 14;
        margin-bottom: 1;
        padding: 1;
        border: solid $surface-lighten-2;
    }
    #rc-scenarios { height: auto; max-height: 10; margin-bottom: 1; }
    #rc-summary { text-style: bold; margin-top: 1; }
    .rc-label { text-style: bold; color: $accent; margin-bottom: 0; }
    """

    def __init__(self) -> None:
        super().__init__()
        self._detected: list[DetectedAgent] = []
        self._by_name: dict[str, DetectedAgent] = {}
        self._selected_models: set[str] = set()

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="rc-body"):
            yield Label("Agents & Models  [dim]m = edit[/]", classes="rc-label")
            yield Static("(none selected)", id="rc-tree")
            yield Label("Scenarios", classes="rc-label")
            yield ModelSelectionList(id="rc-scenarios")
            yield Label("", id="rc-summary")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Run tests"
        cached = load_cache()
        if cached is None:
            self.notify("No agent cache \u2014 run Models scan first", severity="error")
            return

        detected, _not_found = cached
        self._detected = detected
        self._by_name = {d.info.name: d for d in detected}

        if not self._detected:
            self.notify("No agents detected \u2014 run Models scan first", severity="error")
            return

        # Start with empty selection — user opens picker via 'm'

        # Scenarios checklist (all selected)
        scenario_ids = get_scenario_ids(TEMPLATE_DIR)
        scenarios_sl = self.query_one("#rc-scenarios", ModelSelectionList)
        for sid in scenario_ids:
            scenarios_sl.add_option(Selection(sid, sid, True))

        self._update_tree()
        self._update_summary()

    def _active_agents(self) -> list[DetectedAgent]:
        """Agents that have at least one selected model."""
        return [d for d in self._detected if self._selected_models & set(d.models)]

    def _update_tree(self) -> None:
        """Rebuild the agent/model tree display."""
        lines: list[str] = []
        active = self._active_agents()
        for d in active:
            agent_models = sorted(self._selected_models & set(d.models))
            lines.append(f"[bold]{d.info.name}[/bold]")
            for i, m in enumerate(agent_models):
                connector = " \u2514 " if i == len(agent_models) - 1 else " \u251c "
                lines.append(f"[dim]{connector}[/]{m}")

        self.query_one("#rc-tree", Static).update(
            "\n".join(lines) if lines else "(none selected \u2014 press [bold]m[/] to select)"
        )

    def _update_summary(self) -> None:
        active = self._active_agents()
        scenarios_sl = self.query_one("#rc-scenarios", ModelSelectionList)
        n_scenarios = len(scenarios_sl.selected)
        # Each agent runs only its own selected models
        n_agent_model_pairs = sum(len(self._selected_models & set(d.models)) for d in active)
        total = n_agent_model_pairs * n_scenarios
        self.query_one("#rc-summary", Label).update(
            f"Total: {n_agent_model_pairs} agent\u00d7model pairs"
            f" \u00d7 {n_scenarios} scenarios = {total} runs"
        )

    def on_selection_list_selection_toggled(self, event) -> None:
        self._update_summary()

    def action_pick_models(self) -> None:
        if not self._detected:
            self.notify("No agents available", severity="error")
            return
        self.app.push_screen(
            AgentModelPickerScreen(
                self._detected,
                self._selected_models,
            ),
            self._on_picker_result,
        )

    def _on_picker_result(self, result: tuple[set[str], set[str]] | None) -> None:
        if result is None:
            return
        _agents, self._selected_models = result
        self._update_tree()
        self._update_summary()

    def action_start(self) -> None:
        active = getattr(self.app, "active_run", None)
        if active is not None and active.running:
            self.notify(
                "A run is already in progress \u2014 finish or stop it first",
                severity="warning",
            )
            return

        selected_scenarios = list(self.query_one("#rc-scenarios", ModelSelectionList).selected)
        active_agents = self._active_agents()

        if not active_agents:
            self.notify("Select at least one model", severity="error")
            return
        if not selected_scenarios:
            self.notify("Select at least one scenario", severity="error")
            return

        # Build agents list — each agent gets only its own selected models
        agents = []
        for d in active_agents:
            agent_models = sorted(self._selected_models & set(d.models))
            agents.append(
                {
                    "name": d.info.name,
                    "binary": d.path,
                    "cmd_template": d.info.cmd_template,
                    "models": agent_models,
                }
            )

        self.app.push_screen(RunProgressScreen(agents, selected_scenarios))

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
        # Queue for restarted tasks, keyed by (agent, model) lane.
        # Lanes drain this after finishing their initial work.
        self.restart_queue: dict[tuple[str, str], list[int]] = {}
        self.restart_lock = threading.Lock()
        # Lanes currently alive (still inside run_lane).
        self.active_lanes: set[tuple[str, str]] = set()

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
        run_dir = RESULTS_DIR / ts
        self._state = RunState(tasks, run_dir)

        # Save run configuration to results
        self._save_run_config(agents, scenario_ids, run_dir)

    @staticmethod
    def _save_run_config(agents: list[dict], scenario_ids: list[str], run_dir: Path) -> None:

        run_dir.mkdir(parents=True, exist_ok=True)
        config = {
            "agents": [
                {
                    "name": a["name"],
                    "cmd_template": a["cmd_template"],
                    "models": a.get("models", []),
                }
                for a in agents
            ],
            "scenarios": scenario_ids,
        }
        (run_dir / "run_config.yaml").write_text(
            yaml.dump(config, default_flow_style=False, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )

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
            print(f"  [{run_id}] crashed: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
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

        return idx, ok

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
        self._state.run_dir.mkdir(parents=True, exist_ok=True)
        self._state.running = True

        # Group tasks by (agent, model) pair: run scenarios sequentially
        # within each pair, but run different pairs in parallel.
        lanes: dict[tuple[str, str], list[int]] = defaultdict(list)
        for i in indices:
            agent_name, _cmd, model, _scenario = self._state.tasks[i]
            lanes[(agent_name, model)].append(i)

        st = self._state

        def run_lane(lane_key: tuple[str, str], task_indices: list[int]) -> None:
            with st.restart_lock:
                st.active_lanes.add(lane_key)
            try:
                for i in task_indices:
                    self._exec_task(i)
                # Drain restart queue: tasks restarted while the lane was running
                while True:
                    with st.restart_lock:
                        queued = st.restart_queue.pop(lane_key, [])
                    if not queued:
                        break
                    for i in queued:
                        self._exec_task(i)
            finally:
                with st.restart_lock:
                    st.active_lanes.discard(lane_key)

        with ThreadPoolExecutor(max_workers=len(lanes) or 1) as pool:
            futures = [pool.submit(run_lane, key, idxs) for key, idxs in lanes.items()]
            for future in as_completed(futures):
                future.result()

        self._state.running = False

        # Generate reports in worker thread (doesn't need UI)
        self._finalize_reports()

        # Notify UI (best-effort — screen may be popped)
        with contextlib.suppress(Exception):
            self.app.call_from_thread(self._on_all_done)

    def _finalize_reports(self) -> None:
        """Generate HTML reports. Runs in worker thread."""
        from ..report import generate_report

        try:
            generate_report(self._state.run_dir)
        except Exception as e:
            print(f"  [report] generation failed: {e}", file=sys.stderr)

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
            agent_name, _cmd, model, _scenario = st.tasks[idx]
            lane_key = (agent_name, model)
            with st.restart_lock:
                lane_alive = lane_key in st.active_lanes
                if lane_alive:
                    # Lane still running — append; it will drain the queue
                    st.restart_queue.setdefault(lane_key, []).append(idx)
            if not lane_alive:
                # TOCTOU: lane may finish between lock release and this call.
                # Worst case: task runs twice (benign — overwrites same dir).
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

    # ANSI stripping delegated to report.strip_ansi (imported at top)

    def _load_steps(self) -> None:
        steps_file = self._work_dir / "steps.json"
        ol = self.query_one("#rd-steps-list", OptionList)
        ol.clear_options()
        self._steps = []

        if steps_file.is_file():
            with contextlib.suppress(json.JSONDecodeError, OSError):
                self._steps = json.loads(steps_file.read_text(encoding="utf-8"))

        if not self._steps and self._work_dir.is_dir():
            # Fallback: show raw log files sorted by name (numbered: 01_*, 02_*, ...)
            try:
                log_files = sorted(
                    f.name for f in self._work_dir.iterdir() if f.is_file() and f.suffix == ".log"
                )
            except OSError:
                log_files = []
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
            text = strip_ansi(log_file.read_text(encoding="utf-8", errors="replace"))
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
            webbrowser.open(report_file.as_uri())
        else:
            self.notify("No report yet — run from Results (r)", severity="warning")

    def action_open(self) -> None:
        self.app.push_screen(OpenWithScreen(str(self._work_dir)))

    def action_back(self) -> None:
        self.app.pop_screen()
