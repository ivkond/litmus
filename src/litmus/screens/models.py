"""Models screen — agent discovery and model selection."""

from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import (
    Footer,
    Header,
    Input,
    Label,
    LoadingIndicator,
    OptionList,
    SelectionList,
)
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from ..agents import DetectedAgent, load_cache, load_config, save_cache, save_config, scan_agents
from ._common import FilterInput, ModelSelectionList


class ModelsScreen(Screen):
    BINDINGS = [
        Binding("s", "save", "Save config", priority=True),
        Binding("r", "refresh", "Refresh"),
        Binding("escape", "back", "Back"),
    ]

    CSS = """
    ModelsScreen {
        layout: vertical;
    }
    #loading-area {
        width: 1fr;
        height: 1fr;
        align: center middle;
    }
    #loading-area LoadingIndicator {
        height: 3;
    }
    #loading-status {
        text-align: center;
        width: 1fr;
        color: $text-muted;
    }
    #models-body {
        height: 1fr;
    }
    #agent-pane {
        width: 1fr;
        max-width: 40;
        border-right: solid $surface-lighten-2;
    }
    #agent-list {
        height: 1fr;
    }
    #model-pane {
        width: 3fr;
    }
    #model-search {
        margin: 0 1;
        height: 3;
    }
    #add-hint {
        height: 1;
        margin: 0 1;
        color: $text-muted;
        text-style: italic;
    }
    #model-list {
        height: 1fr;
    }
    /* Custom selection icons */
    ModelSelectionList > .selection-list--button {
        color: $text-muted;
    }
    ModelSelectionList > .selection-list--button-selected {
        color: $success;
    }
    ModelSelectionList > .selection-list--button-highlighted {
        color: $text;
        background: $accent;
    }
    ModelSelectionList > .selection-list--button-selected-highlighted {
        color: $success;
        background: $accent;
    }
    #status-label {
        dock: bottom;
        height: 1;
        padding: 0 1;
        color: $text-muted;
    }
    """

    COMPONENT_CLASSES = {
        "selection-list--button",
        "selection-list--button-selected",
        "selection-list--button-highlighted",
        "selection-list--button-selected-highlighted",
    }

    def __init__(self) -> None:
        super().__init__()
        self._detected: list[DetectedAgent] = []
        self._not_found: list[str] = []
        self._current_agent_idx: int | None = None
        self._scanning = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        # Loading state — shown during scanning
        with Vertical(id="loading-area"):
            yield LoadingIndicator()
            yield Label("Scanning for installed agents...", id="loading-status")
        # Main UI — hidden until scan completes
        with Horizontal(id="models-body"):
            with Vertical(id="agent-pane"):
                yield Label(" Agents", id="agent-pane-label")
                yield OptionList(id="agent-list")
            with Vertical(id="model-pane"):
                yield FilterInput(
                    placeholder="Filter models / type name + Enter to add...",
                    id="model-search",
                )
                yield Label("Enter = add custom model", id="add-hint")
                yield ModelSelectionList(id="model-list")
        yield Label("", id="status-label")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Models"

        # Try cache first — instant open
        cached = load_cache()
        if cached is not None:
            detected, not_found_names = cached
            self.query_one("#loading-area").display = False
            self.query_one("#models-body").display = True
            self._apply_detected(detected, not_found_names)
        else:
            # No cache — show spinner and scan
            self.query_one("#models-body").display = False
            self._start_scan()

    # --- Scanning ---

    @work(thread=True)
    def _start_scan(self) -> None:
        self._scanning = True
        status = self.query_one("#loading-status", Label)

        def on_progress(current: int, total: int, message: str) -> None:
            self.app.call_from_thread(status.update, message)

        detected, not_found = scan_agents(on_progress=on_progress)

        # Save cache for next time
        save_cache(detected, not_found)

        not_found_names = [a.name for a in not_found]
        self.app.call_from_thread(self._on_scan_complete, detected, not_found_names)

    def _on_scan_complete(
        self,
        detected: list[DetectedAgent],
        not_found_names: list[str],
    ) -> None:
        self._scanning = False

        # Switch from loading to main UI
        self.query_one("#loading-area").display = False
        self.query_one("#models-body").display = True

        self._apply_detected(detected, not_found_names)
        self.notify("Agent scan complete")

    def _apply_detected(
        self,
        detected: list[DetectedAgent],
        not_found_names: list[str],
    ) -> None:
        """Populate screen state from detected agents (cache or fresh scan)."""
        self._detected = detected
        self._not_found = not_found_names
        self._current_agent_idx = None

        # Restore previously selected models from config.yaml
        saved = load_config()
        if saved and "agents" in saved:
            saved_by_name = {a["name"]: a for a in saved["agents"]}
            for d in self._detected:
                cfg = saved_by_name.get(d.info.name)
                if cfg and "models" in cfg:
                    saved_models = cfg["models"]
                    # Add any custom models that aren't in the detected list
                    known = set(d.models)
                    for m in saved_models:
                        if m not in known:
                            d.models.append(m)
                    d.selected = list(saved_models)

        # Populate agent list
        agent_list = self.query_one("#agent-list", OptionList)
        agent_list.clear_options()
        for d in self._detected:
            agent_list.add_option(Option(self._agent_label(d), id=d.info.name))

        # Clear model list
        self.query_one("#model-list", ModelSelectionList).clear_options()

        if self._not_found:
            names = ", ".join(self._not_found)
            self.query_one("#status-label", Label).update(f"Not found: {names}")
        else:
            self.query_one("#status-label", Label).update("")

    # --- Agent selection ---

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_list.id != "agent-list":
            return
        idx = self._find_agent_idx(event.option.id)
        if idx is not None:
            self._show_models_for(idx)

    def _find_agent_idx(self, agent_name: str | None) -> int | None:
        if agent_name is None:
            return None
        for i, d in enumerate(self._detected):
            if d.info.name == agent_name:
                return i
        return None

    def _show_models_for(self, idx: int) -> None:
        self._save_current_selection()
        self._current_agent_idx = idx
        d = self._detected[idx]

        search = self.query_one("#model-search", FilterInput)
        search.value = ""
        search.focus()

        self._populate_model_list(d.models, d.selected)

    def _populate_model_list(self, models: list[str], selected: list[str]) -> None:
        sel_list = self.query_one("#model-list", ModelSelectionList)
        selected_set = set(selected)
        sel_list.clear_options()
        for m in models:
            sel_list.add_option(Selection(m, m, m in selected_set))

    # --- Add custom model ---

    @on(Input.Submitted, "#model-search")
    def _on_add_custom_model(self, event: Input.Submitted) -> None:
        if self._current_agent_idx is None:
            return
        model_name = event.value.strip()
        if not model_name:
            return
        d = self._detected[self._current_agent_idx]
        # Don't add duplicates
        if model_name in d.models:
            self.notify(f"'{model_name}' already in list", severity="warning")
            return
        # Add to agent's model list and select it
        d.models.append(model_name)
        d.selected.append(model_name)
        # Clear filter and refresh
        search = self.query_one("#model-search", FilterInput)
        search.value = ""
        self._populate_model_list(d.models, d.selected)
        self._update_agent_label(self._current_agent_idx)
        self.notify(f"Added '{model_name}'")

    # --- Model search/filter ---

    @on(Input.Changed, "#model-search")
    def _on_filter_changed(self, event: Input.Changed) -> None:
        if self._current_agent_idx is None:
            return
        d = self._detected[self._current_agent_idx]
        query = event.value.lower()
        filtered = [m for m in d.models if query in m.lower()] if query else d.models
        self._save_current_selection()
        self._populate_model_list(filtered, d.selected)

    # --- Selection tracking ---

    def _save_current_selection(self) -> None:
        """Read SelectionList state back into DetectedAgent.selected."""
        if self._current_agent_idx is None:
            return
        d = self._detected[self._current_agent_idx]
        sel_list = self.query_one("#model-list", ModelSelectionList)

        visible_selected = set(sel_list.selected)
        visible_models = set()
        for i in range(sel_list.option_count):
            val = sel_list.get_option_at_index(i).value
            visible_models.add(val)

        kept = [m for m in d.selected if m not in visible_models]
        d.selected = kept + list(visible_selected)

        self._update_agent_label(self._current_agent_idx)

    @on(SelectionList.SelectedChanged)
    def _on_selection_changed(self, event: SelectionList.SelectedChanged) -> None:
        if self._current_agent_idx is None:
            return
        self._save_current_selection()

    def _update_agent_label(self, idx: int) -> None:
        d = self._detected[idx]
        agent_list = self.query_one("#agent-list", OptionList)
        option = agent_list.get_option_at_index(idx)
        if option.id is not None:
            agent_list.replace_option_prompt(option.id, self._agent_label(d))

    # --- Helpers ---

    @staticmethod
    def _agent_label(d: DetectedAgent) -> str:
        n_avail = len(d.models)
        n_sel = len(d.selected)
        if d.error:
            return f"{d.info.name}  (error)"
        if not d.models and d.info.model_cmd is None:
            if n_sel:
                return f"{d.info.name}  ({n_sel} manual)"
            return d.info.name
        if n_sel:
            return f"{d.info.name}  ({n_sel}/{n_avail})"
        return f"{d.info.name}  (0/{n_avail})"

    # --- Actions ---

    def action_save(self) -> None:
        self._save_current_selection()
        path = save_config(self._detected)
        if path:
            self.notify(f"Config saved: {path}", title="Saved")
        else:
            self.notify("No models selected", severity="warning")

    def action_refresh(self) -> None:
        if self._scanning:
            self.notify("Scan already in progress", severity="warning")
            return
        self._save_current_selection()
        # Show loading, hide main UI
        self.query_one("#loading-area").display = True
        self.query_one("#models-body").display = False
        self._start_scan()

    def action_back(self) -> None:
        self._save_current_selection()
        self.app.pop_screen()
