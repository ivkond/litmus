"""Results browser screen - browse previous test run sessions."""

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import DataTable, Footer, Header, Label, OptionList
from textual.widgets.option_list import Option

from ..agents import load_analysis_config
from ._common import RESULTS_DIR, OpenWithScreen
from .analysis import AnalysisModal
from .run import RunDetailScreen

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SEL_RESULTS_TABLE = "#rb-scenarios-table"
LEGACY_LABEL = "(legacy runs)"


class ResultsBrowserScreen(Screen):
    """Browse previous test run sessions from results/ directory."""

    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("r", "report", "Report"),
        Binding("a", "analysis", "LLM Analysis"),
        Binding("o", "open", "Open project..."),
    ]

    CSS = """
    ResultsBrowserScreen { layout: vertical; }
    #rb-main { height: 1fr; }
    #rb-sessions-pane {
        width: 1fr;
        max-width: 30;
        border-right: solid $surface-lighten-2;
    }
    #rb-sessions-pane-label {
        padding: 0 1;
        text-style: bold;
        color: $text-muted;
    }
    #rb-sessions-list { height: 1fr; }
    #rb-runs-pane {
        width: 1fr;
        max-width: 35;
        border-right: solid $surface-lighten-2;
    }
    #rb-runs-pane-label {
        padding: 0 1;
        text-style: bold;
        color: $text-muted;
    }
    #rb-runs-list { height: 1fr; }
    #rb-detail-pane {
        width: 2fr;
        padding: 0 1;
    }
    #rb-detail-title {
        text-style: bold;
        color: $accent;
        margin-bottom: 1;
    }
    #rb-scenarios-table { height: 1fr; }
    """

    def __init__(self) -> None:
        super().__init__()
        self._sessions: list[str] = []
        self._runs: list[str] = []
        self._current_session: str = ""
        self._current_run: str = ""

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="rb-main"):
            with Vertical(id="rb-sessions-pane"):
                yield Label(" Sessions", id="rb-sessions-pane-label")
                yield OptionList(id="rb-sessions-list")
            with Vertical(id="rb-runs-pane"):
                yield Label(" Runs", id="rb-runs-pane-label")
                yield OptionList(id="rb-runs-list")
            with Vertical(id="rb-detail-pane"):
                yield Label("Select a session", id="rb-detail-title")
                yield DataTable(id="rb-scenarios-table")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Results"
        self._load_sessions()
        table = self.query_one(SEL_RESULTS_TABLE, DataTable)
        table.add_columns("Scenario", "Status", "Steps", "Has logs")
        table.cursor_type = "row"

    def _load_sessions(self) -> None:
        ol = self.query_one("#rb-sessions-list", OptionList)
        ol.clear_options()
        self._sessions = []

        if not RESULTS_DIR.is_dir():
            return

        # Find session directories (timestamped dirs or legacy dirs)
        dirs = [d.name for d in sorted(RESULTS_DIR.iterdir(), reverse=True) if d.is_dir()]

        # Separate timestamped sessions from legacy flat runs
        sessions = []
        legacy = []
        for name in dirs:
            # Timestamped dirs are like 20260324_022046
            if len(name) >= 15 and name[:8].isdigit() and name[8] == "_":
                sessions.append(name)
            else:
                legacy.append(name)

        if legacy:
            sessions.append(LEGACY_LABEL)

        self._sessions = sessions
        for s in sessions:
            # Format timestamp nicely
            if s.startswith("("):
                label = s
            else:
                try:
                    label = f"{s[:4]}-{s[4:6]}-{s[6:8]} {s[9:11]}:{s[11:13]}:{s[13:15]}"
                except (IndexError, ValueError):
                    label = s
            ol.add_option(Option(label, id=s))

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        if event.option is None or event.option.id is None:
            return
        if event.option_list.id == "rb-sessions-list":
            self._select_session(event.option.id)
        elif event.option_list.id == "rb-runs-list":
            self._select_run(event.option.id)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_list.id == "rb-runs-list" and event.option.id:
            # Drill into run detail
            pass
        elif event.option_list.id == "rb-scenarios-table":
            pass

    def _select_session(self, session_id: str) -> None:
        if session_id == self._current_session:
            return
        self._current_session = session_id

        ol = self.query_one("#rb-runs-list", OptionList)
        ol.clear_options()
        self._runs = []
        table = self.query_one(SEL_RESULTS_TABLE, DataTable)
        table.clear()

        if session_id == LEGACY_LABEL:
            session_dir = RESULTS_DIR
            # Legacy runs are flat agent_model dirs directly in results/
            for d in sorted(session_dir.iterdir()):
                if d.is_dir() and not (
                    len(d.name) >= 15 and d.name[:8].isdigit() and d.name[8] == "_"
                ):
                    self._runs.append(d.name)
                    ol.add_option(Option(d.name, id=d.name))
        else:
            session_dir = RESULTS_DIR / session_id
            if session_dir.is_dir():
                for d in sorted(session_dir.iterdir()):
                    if d.is_dir():
                        self._runs.append(d.name)
                        ol.add_option(Option(d.name, id=d.name))

        self.query_one("#rb-detail-title", Label).update(
            f"Session: {session_id} ({len(self._runs)} runs)"
        )

    def _select_run(self, run_id: str) -> None:
        if run_id == self._current_run:
            return
        self._current_run = run_id

        if self._current_session == LEGACY_LABEL:
            run_dir = RESULTS_DIR / run_id
        else:
            run_dir = RESULTS_DIR / self._current_session / run_id

        table = self.query_one(SEL_RESULTS_TABLE, DataTable)
        table.clear()

        self.query_one("#rb-detail-title", Label).update(f"Run: {run_id}")

        if not run_dir.is_dir():
            return

        import json

        for d in sorted(run_dir.iterdir()):
            if not d.is_dir():
                continue
            scenario_id = d.name

            # Check steps.json
            steps_file = d / "steps.json"
            steps_count = ""
            status = "?"
            if steps_file.is_file():
                try:
                    steps = json.loads(steps_file.read_text(encoding="utf-8"))
                    steps_count = str(len(steps))
                    statuses = [s.get("status", "") for s in steps]
                    if "failed" in statuses:
                        status = "✗ failed"
                    elif "cancelled" in statuses:
                        status = "⊘ cancelled"
                    elif all(s == "done" for s in statuses):
                        status = "✓ done"
                    elif "running" in statuses:
                        status = "▸ running"
                    else:
                        status = "?"
                except (json.JSONDecodeError, OSError):
                    pass
            else:
                # Fallback: check for any .log files
                log_count = sum(1 for f in d.iterdir() if f.is_file() and f.suffix == ".log")
                if log_count > 1:
                    status = "✓ has logs"
                elif log_count == 1:
                    status = "▸ partial"
                else:
                    status = "○ empty"

            has_logs = "✓" if any(f.suffix == ".log" for f in d.iterdir() if f.is_file()) else "—"
            table.add_row(scenario_id, status, steps_count or "—", has_logs, key=scenario_id)

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if event.data_table.id != "rb-scenarios-table":
            return
        scenario_id = str(event.row_key.value)
        if not scenario_id:
            return

        if self._current_session == LEGACY_LABEL:
            work_dir = RESULTS_DIR / self._current_run / scenario_id
        else:
            work_dir = RESULTS_DIR / self._current_session / self._current_run / scenario_id

        if work_dir.is_dir():
            # Parse agent/model from run name
            parts = self._current_run.split("_", 1)
            agent = parts[0] if parts else "?"
            model = parts[1] if len(parts) > 1 else "?"
            self.app.push_screen(RunDetailScreen(agent, model, scenario_id, work_dir))

    def action_report(self) -> None:
        if not self._current_session or self._current_session == LEGACY_LABEL:
            self.notify("Select a session first", severity="warning")
            return
        session_dir = RESULTS_DIR / self._current_session
        if not session_dir.is_dir():
            self.notify("Session directory not found", severity="error")
            return
        from ..report import generate_report

        paths = generate_report(session_dir)
        if paths:
            self.notify(f"{len(paths)} reports generated", title="Reports")
            # Open summary in browser
            summary = session_dir / "report.html"
            if summary.is_file():
                import webbrowser

                webbrowser.open(summary.as_uri())
        else:
            self.notify("No data to generate report", severity="warning")

    def action_analysis(self) -> None:
        if not self._current_session or self._current_session == LEGACY_LABEL:
            self.notify("Select a session first", severity="warning")
            return
        cfg = load_analysis_config()
        if not cfg.get("model"):
            self.notify("Configure LLM model in Settings first", severity="warning")
            return
        session_dir = RESULTS_DIR / self._current_session
        if not session_dir.is_dir():
            self.notify("Session directory not found", severity="error")
            return
        self.app.push_screen(AnalysisModal(session_dir, cfg))

    def action_open(self) -> None:
        if self._current_run:
            if self._current_session == LEGACY_LABEL:
                path = RESULTS_DIR / self._current_run
            else:
                path = RESULTS_DIR / self._current_session / self._current_run
            if path.is_dir():
                self.app.push_screen(OpenWithScreen(str(path)))

    def action_back(self) -> None:
        self.app.pop_screen()
