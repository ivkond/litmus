"""Scenario management screens: browse, create, edit, delete, export, import."""

from pathlib import Path

from textual import on
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
    SelectionList,
    Static,
    TextArea,
)
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from ..run import get_scenario_ids
from ._common import TEMPLATE_DIR, OpenWithScreen


class ScenariosScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("n", "new", "New"),
        Binding("e", "edit", "Edit"),
        Binding("d", "delete", "Delete"),
        Binding("o", "open", "Open project..."),
        Binding("x", "export", "Export"),
        Binding("i", "import_pack", "Import"),
    ]

    CSS = """
    ScenariosScreen {
        layout: vertical;
    }
    #scenarios-body {
        height: 1fr;
    }
    #scenario-pane {
        width: 1fr;
        max-width: 40;
        border-right: solid $surface-lighten-2;
    }
    #scenario-pane-label {
        padding: 0 1;
        text-style: bold;
        color: $text-muted;
    }
    #scenario-list {
        height: 1fr;
    }
    #detail-scroll {
        width: 3fr;
        padding: 0 1;
    }
    #detail-title {
        text-style: bold;
        margin-bottom: 1;
    }
    .detail-section {
        margin-bottom: 1;
        border: solid $surface-lighten-2;
        padding: 1;
        height: auto;
    }
    .detail-section-title {
        text-style: bold;
        color: $accent;
        margin-bottom: 0;
    }
    .detail-content {
        color: $text;
    }
    """

    def __init__(self) -> None:
        super().__init__()
        self._scenario_ids: list[str] = []

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="scenarios-body"):
            with Vertical(id="scenario-pane"):
                yield Label(" Scenarios", id="scenario-pane-label")
                yield OptionList(id="scenario-list")
            with VerticalScroll(id="detail-scroll"):
                yield Label("Select a scenario from the list", id="detail-title")
                with Vertical(id="prompt-section", classes="detail-section"):
                    yield Label("Prompt", classes="detail-section-title")
                    yield Static("", id="prompt-content", classes="detail-content")
                with Vertical(id="task-section", classes="detail-section"):
                    yield Label("Task", classes="detail-section-title")
                    yield Static("", id="task-content", classes="detail-content")
                with Vertical(id="scoring-section", classes="detail-section"):
                    yield Label("Scoring", classes="detail-section-title")
                    yield DataTable(id="scoring-table", show_cursor=False)
                with Vertical(id="files-section", classes="detail-section"):
                    yield Label("Project files", classes="detail-section-title")
                    yield Static("", id="files-content", classes="detail-content")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Scenarios"
        # Hide detail sections until a scenario is selected
        for sid in ("#prompt-section", "#task-section", "#scoring-section", "#files-section"):
            self.query_one(sid).display = False
        self._scenario_ids = get_scenario_ids(TEMPLATE_DIR)
        scenario_list = self.query_one("#scenario-list", OptionList)
        for sid in self._scenario_ids:
            scenario_list.add_option(Option(sid, id=sid))

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_list.id != "scenario-list":
            return
        sid = event.option.id
        if sid:
            self._show_scenario(sid)

    def _show_scenario(self, scenario_id: str) -> None:
        import csv
        import io

        scenario_dir = TEMPLATE_DIR / scenario_id

        # Show sections
        for sid in ("#prompt-section", "#task-section", "#scoring-section", "#files-section"):
            self.query_one(sid).display = True

        # Title
        self.query_one("#detail-title", Label).update(scenario_id)

        # Prompt
        prompt_file = scenario_dir / "prompt.txt"
        prompt_text = (
            prompt_file.read_text(encoding="utf-8").strip()
            if prompt_file.is_file()
            else "(no prompt.txt)"
        )
        self.query_one("#prompt-content", Static).update(prompt_text)

        # Task
        task_file = scenario_dir / "task.txt"
        task_text = (
            task_file.read_text(encoding="utf-8").strip()
            if task_file.is_file()
            else "(no task.txt)"
        )
        self.query_one("#task-content", Static).update(task_text)

        # Scoring table
        table = self.query_one("#scoring-table", DataTable)
        table.clear(columns=True)
        scoring_file = scenario_dir / "scoring.csv"
        if scoring_file.is_file():
            try:
                reader = csv.DictReader(io.StringIO(scoring_file.read_text(encoding="utf-8")))
                if "criterion" in (reader.fieldnames or []) and "score" in (
                    reader.fieldnames or []
                ):
                    table.add_columns("Criterion", "Score")
                    total = 0
                    for row in reader:
                        try:
                            score = int(row["score"])
                        except (ValueError, TypeError):
                            score = 0
                        total += score
                        table.add_row(row["criterion"], str(score))
                    table.add_row("TOTAL", str(total))
                else:
                    table.add_columns("Info")
                    table.add_row("(invalid CSV: expected criterion,score header)")
            except Exception:
                table.add_columns("Info")
                table.add_row("(error reading scoring.csv)")
        else:
            table.add_columns("Info")
            table.add_row("(no scoring.csv)")

        # Project files
        project_dir = scenario_dir / "project"
        if project_dir.is_dir():
            files = sorted(f.name for f in project_dir.iterdir() if f.is_file())
        else:
            files = []
        files_text = "  ".join(files) if files else "(empty — no project files)"
        self.query_one("#files-content", Static).update(files_text)

        # Scroll to top
        self.query_one("#detail-scroll", VerticalScroll).scroll_home()

    def _get_selected_id(self) -> str | None:
        ol = self.query_one("#scenario-list", OptionList)
        idx = ol.highlighted
        if idx is None:
            return None
        return ol.get_option_at_index(idx).id

    def _refresh_list(self, select_id: str | None = None) -> None:
        ol = self.query_one("#scenario-list", OptionList)
        ol.clear_options()
        self._scenario_ids = get_scenario_ids(TEMPLATE_DIR)
        for sid in self._scenario_ids:
            ol.add_option(Option(sid, id=sid))
        if select_id and select_id in self._scenario_ids:
            idx = self._scenario_ids.index(select_id)
            ol.highlighted = idx

    def action_back(self) -> None:
        self.app.pop_screen()

    def action_new(self) -> None:
        self.app.push_screen(ScenarioEditScreen(None), callback=self._on_edit_done)

    def action_edit(self) -> None:
        sid = self._get_selected_id()
        if sid:
            self.app.push_screen(ScenarioEditScreen(sid), callback=self._on_edit_done)

    def action_delete(self) -> None:
        sid = self._get_selected_id()
        if sid:
            self.app.push_screen(
                ConfirmDeleteScreen(sid),
                callback=self._on_delete_done,  # type: ignore[arg-type]
            )

    def _on_edit_done(self, result: str | None) -> None:
        if result:
            self._refresh_list(select_id=result)
            self._show_scenario(result)

    def _on_delete_done(self, confirmed: bool) -> None:
        if confirmed:
            self._refresh_list()
            # Hide detail sections
            for sid in ("#prompt-section", "#task-section", "#scoring-section", "#files-section"):
                self.query_one(sid).display = False
            self.query_one("#detail-title", Label).update("Select a scenario from the list")

    def action_export(self) -> None:
        self.app.push_screen(
            ScenarioExportScreen(self._scenario_ids),
            callback=self._on_export_done,
        )

    def _on_export_done(self, result: str | None) -> None:
        if result:
            self.notify(f"Exported → {result}")

    def action_import_pack(self) -> None:
        self.app.push_screen(
            ScenarioImportScreen(),
            callback=self._on_import_done,
        )

    def _on_import_done(self, result: list[str] | None) -> None:
        if result:
            self._refresh_list()
            self.notify(f"Imported {len(result)} scenario(s)")

    def action_open(self) -> None:
        sid = self._get_selected_id()
        if not sid:
            return
        project_dir = TEMPLATE_DIR / sid / "project"
        # Fall back to scenario dir if project/ doesn't exist
        target = project_dir if project_dir.is_dir() else TEMPLATE_DIR / sid
        self.app.push_screen(OpenWithScreen(str(target)))


# ═══════════════════════════════════════════════════════════════════════════
# Scenario Export Screen
# ═══════════════════════════════════════════════════════════════════════════


class ScenarioExportScreen(Screen):
    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("enter", "confirm", "Export", priority=True),
    ]

    CSS = """
    ScenarioExportScreen {
        align: center middle;
    }
    #export-box {
        width: 60;
        height: auto;
        max-height: 80%;
        border: solid $accent;
        padding: 1 2;
    }
    #export-title {
        text-style: bold;
        text-align: center;
        margin-bottom: 1;
    }
    #export-list {
        height: auto;
        max-height: 16;
        margin-bottom: 1;
    }
    #export-path {
        margin-bottom: 1;
    }
    """

    def __init__(self, scenario_ids: list[str]) -> None:
        super().__init__()
        self._scenario_ids = scenario_ids

    def compose(self) -> ComposeResult:
        with Vertical(id="export-box"):
            yield Label("Export scenarios", id="export-title")
            yield SelectionList[str](
                *[Selection(sid, sid, True) for sid in self._scenario_ids],
                id="export-list",
            )
            yield Input(
                placeholder="Output path (e.g. scenarios.zip)",
                value="scenarios.zip",
                id="export-path",
            )
            with Horizontal():
                yield Button("Export", variant="primary", id="export-btn")
                yield Button("Cancel", id="cancel-btn")

    def action_cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#cancel-btn")
    def _on_cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#export-btn")
    def action_confirm(self) -> None:
        from ..pack.scenarios import export_scenarios

        sel_list = self.query_one("#export-list", SelectionList)
        selected = [str(v) for v in sel_list.selected]
        if not selected:
            self.notify("No scenarios selected", severity="warning")
            return

        output = self.query_one("#export-path", Input).value.strip()
        if not output:
            self.notify("Specify output path", severity="warning")
            return

        out_path = Path(output)
        try:
            result = export_scenarios(TEMPLATE_DIR, selected, out_path)
            self.dismiss(str(result))
        except Exception as exc:
            self.notify(f"Export failed: {exc}", severity="error")


# ═══════════════════════════════════════════════════════════════════════════
# Scenario Import Screen
# ═══════════════════════════════════════════════════════════════════════════


class ScenarioImportScreen(Screen):
    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
        Binding("enter", "confirm", "Import", priority=True),
    ]

    CSS = """
    ScenarioImportScreen {
        align: center middle;
    }
    #import-box {
        width: 60;
        height: auto;
        border: solid $accent;
        padding: 1 2;
    }
    #import-title {
        text-style: bold;
        text-align: center;
        margin-bottom: 1;
    }
    #import-path {
        margin-bottom: 1;
    }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="import-box"):
            yield Label("Import scenario pack", id="import-title")
            yield Input(
                placeholder="Path to .zip file",
                id="import-path",
            )
            with Horizontal():
                yield Button("Import", variant="primary", id="import-btn")
                yield Button("Cancel", id="cancel-btn")

    def action_cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#cancel-btn")
    def _on_cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#import-btn")
    def action_confirm(self) -> None:
        from ..pack.scenarios import PackError, import_scenarios

        zip_path = self.query_one("#import-path", Input).value.strip()
        if not zip_path:
            self.notify("Specify path to .zip", severity="warning")
            return

        try:
            imported = import_scenarios(Path(zip_path), TEMPLATE_DIR)
            if not imported:
                self.notify("No scenarios imported", severity="warning")
                self.dismiss(None)
            else:
                self.dismiss(imported)
        except PackError as exc:
            self.notify(str(exc), severity="error")
        except Exception as exc:
            self.notify(f"Import failed: {exc}", severity="error")


# ═══════════════════════════════════════════════════════════════════════════
# Scenario Edit Screen (Create / Update)
# ═══════════════════════════════════════════════════════════════════════════


class ScenarioEditScreen(Screen):
    BINDINGS = [
        Binding("ctrl+s", "save", "Save"),
        Binding("escape", "cancel", "Cancel"),
    ]

    CSS = """
    ScenarioEditScreen {
        layout: vertical;
    }
    #edit-scroll {
        padding: 1 2;
    }
    .edit-label {
        text-style: bold;
        color: $accent;
        margin-top: 1;
    }
    #edit-id {
        margin-bottom: 1;
    }
    .edit-area {
        min-height: 6;
        height: auto;
        border: solid $surface-lighten-2;
    }
    #edit-scoring {
        min-height: 4;
    }
    """

    def __init__(self, scenario_id: str | None) -> None:
        super().__init__()
        self._scenario_id = scenario_id  # None = create mode
        self._is_new = scenario_id is None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with VerticalScroll(id="edit-scroll"):
            yield Label("ID", classes="edit-label")
            yield Input(
                value=self._scenario_id or "",
                placeholder="scenario-id (e.g. 9-my-scenario)",
                id="edit-id",
                disabled=not self._is_new,
            )
            yield Label("Prompt", classes="edit-label")
            yield TextArea(id="edit-prompt", classes="edit-area")
            yield Label("Task", classes="edit-label")
            yield TextArea(id="edit-task", classes="edit-area")
            yield Label("Scoring (CSV: criterion,score)", classes="edit-label")
            yield TextArea(id="edit-scoring", classes="edit-area")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "New scenario" if self._is_new else f"Edit: {self._scenario_id}"
        if self._is_new:
            self.query_one("#edit-scoring", TextArea).load_text("criterion,score\n")
        else:
            assert self._scenario_id is not None
            scenario_dir = TEMPLATE_DIR / self._scenario_id
            prompt_file = scenario_dir / "prompt.txt"
            task_file = scenario_dir / "task.txt"
            scoring_file = scenario_dir / "scoring.csv"
            if prompt_file.is_file():
                self.query_one("#edit-prompt", TextArea).load_text(
                    prompt_file.read_text(encoding="utf-8")
                )
            if task_file.is_file():
                self.query_one("#edit-task", TextArea).load_text(
                    task_file.read_text(encoding="utf-8")
                )
            if scoring_file.is_file():
                self.query_one("#edit-scoring", TextArea).load_text(
                    scoring_file.read_text(encoding="utf-8")
                )

    def action_save(self) -> None:
        scenario_id = self.query_one("#edit-id", Input).value.strip()
        if not scenario_id:
            self.notify("ID cannot be empty", severity="error")
            return

        scenario_dir = TEMPLATE_DIR / scenario_id
        scenario_dir.mkdir(parents=True, exist_ok=True)

        prompt_text = self.query_one("#edit-prompt", TextArea).text
        task_text = self.query_one("#edit-task", TextArea).text
        scoring_text = self.query_one("#edit-scoring", TextArea).text

        (scenario_dir / "prompt.txt").write_text(prompt_text, encoding="utf-8")
        (scenario_dir / "task.txt").write_text(task_text, encoding="utf-8")
        (scenario_dir / "scoring.csv").write_text(scoring_text, encoding="utf-8")

        # Ensure project/ dir exists
        (scenario_dir / "project").mkdir(exist_ok=True)

        self.dismiss(scenario_id)

    def action_cancel(self) -> None:
        self.dismiss(None)


# ═══════════════════════════════════════════════════════════════════════════
# Confirm Delete Screen
# ═══════════════════════════════════════════════════════════════════════════


class ConfirmDeleteScreen(Screen):
    BINDINGS = [
        Binding("y", "confirm", "Yes"),
        Binding("n", "deny", "No"),
        Binding("escape", "deny", "Cancel"),
    ]

    CSS = """
    ConfirmDeleteScreen {
        align: center middle;
    }
    #confirm-box {
        width: 50;
        height: auto;
        border: solid red;
        padding: 2 4;
    }
    #confirm-msg {
        text-align: center;
        margin-bottom: 1;
    }
    #confirm-hint {
        text-align: center;
        color: $text-muted;
    }
    """

    def __init__(self, scenario_id: str) -> None:
        super().__init__()
        self._scenario_id = scenario_id

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm-box"):
            yield Label(f"Delete '{self._scenario_id}'?", id="confirm-msg")
            yield Label("y = yes / n = cancel", id="confirm-hint")

    def action_confirm(self) -> None:
        import shutil

        scenario_dir = TEMPLATE_DIR / self._scenario_id
        if scenario_dir.is_dir():
            shutil.rmtree(scenario_dir)
        self.dismiss(True)

    def action_deny(self) -> None:
        self.dismiss(False)
