"""Models screen — agent & model catalog (view, add, remove)."""

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
)
from textual.widgets.option_list import Option

from ..agents import (
    DetectedAgent,
    add_model_to_cache,
    load_cache,
    remove_model_from_cache,
    save_cache,
    scan_agents,
)
from ._common import FilterInput

_ID_MODEL_LIST = "#model-list"
_ID_LOADING_AREA = "#loading-area"
_ID_MODELS_BODY = "#models-body"


class ModelsScreen(Screen):
    BINDINGS = [
        Binding("d", "delete", "Delete model"),
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
    #status-label {
        dock: bottom;
        height: 1;
        padding: 0 1;
        color: $text-muted;
    }
    """

    def __init__(self) -> None:
        super().__init__()
        self._detected: list[DetectedAgent] = []
        self._not_found: list[str] = []
        self._current_agent_idx: int | None = None
        self._scanning = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Vertical(id="loading-area"):
            yield LoadingIndicator()
            yield Label("Scanning for installed agents...", id="loading-status")
        with Horizontal(id="models-body"):
            with Vertical(id="agent-pane"):
                yield Label(" Agents", id="agent-pane-label")
                yield OptionList(id="agent-list")
            with Vertical(id="model-pane"):
                yield FilterInput(
                    placeholder="Filter models / type name + Enter to add...",
                    id="model-search",
                )
                yield Label("Enter = add model, D = delete", id="add-hint")
                yield OptionList(id="model-list")
        yield Label("", id="status-label")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Models"
        cached = load_cache()
        if cached is not None:
            detected, not_found_names = cached
            self.query_one(_ID_LOADING_AREA).display = False
            self.query_one(_ID_MODELS_BODY).display = True
            self._apply_detected(detected, not_found_names)
        else:
            self.query_one(_ID_MODELS_BODY).display = False
            self._start_scan()

    # --- Scanning ---

    @work(thread=True)
    def _start_scan(self) -> None:
        self._scanning = True
        status = self.query_one("#loading-status", Label)

        def on_progress(current: int, total: int, message: str) -> None:
            self.app.call_from_thread(status.update, message)

        detected, not_found = scan_agents(on_progress=on_progress)
        save_cache(detected, not_found)

        not_found_names = [a.name for a in not_found]
        self.app.call_from_thread(self._on_scan_complete, detected, not_found_names)

    def _on_scan_complete(
        self,
        detected: list[DetectedAgent],
        not_found_names: list[str],
    ) -> None:
        self._scanning = False
        self.query_one(_ID_LOADING_AREA).display = False
        self.query_one(_ID_MODELS_BODY).display = True
        self._apply_detected(detected, not_found_names)
        self.notify("Agent scan complete")

    def _apply_detected(
        self,
        detected: list[DetectedAgent],
        not_found_names: list[str],
    ) -> None:
        """Populate screen state from detected agents."""
        self._detected = detected
        self._not_found = not_found_names
        self._current_agent_idx = None

        agent_list = self.query_one("#agent-list", OptionList)
        agent_list.clear_options()
        for d in self._detected:
            agent_list.add_option(Option(self._agent_label(d), id=d.info.name))

        self.query_one(_ID_MODEL_LIST, OptionList).clear_options()

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
        self._current_agent_idx = idx
        d = self._detected[idx]

        search = self.query_one("#model-search", FilterInput)
        search.value = ""
        search.focus()

        self._populate_model_list(d.models)

    def _populate_model_list(self, models: list[str]) -> None:
        model_list = self.query_one(_ID_MODEL_LIST, OptionList)
        model_list.clear_options()
        for m in models:
            model_list.add_option(Option(m, id=m))

    # --- Add custom model ---

    @on(Input.Submitted, "#model-search")
    def _on_add_custom_model(self, event: Input.Submitted) -> None:
        if self._current_agent_idx is None:
            return
        model_name = event.value.strip()
        if not model_name:
            return
        d = self._detected[self._current_agent_idx]
        if model_name in d.models:
            self.notify(f"'{model_name}' already in list", severity="warning")
            return
        d.models.append(model_name)
        add_model_to_cache(d.info.name, model_name)
        search = self.query_one("#model-search", FilterInput)
        search.value = ""
        self._populate_model_list(d.models)
        self._update_agent_label(self._current_agent_idx)
        self.notify(f"Added '{model_name}'")

    # --- Delete model ---

    def action_delete(self) -> None:
        if self._current_agent_idx is None:
            return
        model_list = self.query_one(_ID_MODEL_LIST, OptionList)
        idx = model_list.highlighted
        if idx is None:
            return
        option = model_list.get_option_at_index(idx)
        model_name = option.id
        if model_name is None:
            return
        d = self._detected[self._current_agent_idx]
        if model_name in d.models:
            d.models.remove(model_name)
            remove_model_from_cache(d.info.name, model_name)
        self._populate_model_list(d.models)
        self._update_agent_label(self._current_agent_idx)
        self.notify(f"Removed '{model_name}'")

    # --- Model search/filter ---

    @on(Input.Changed, "#model-search")
    def _on_filter_changed(self, event: Input.Changed) -> None:
        if self._current_agent_idx is None:
            return
        d = self._detected[self._current_agent_idx]
        query = event.value.lower()
        filtered = [m for m in d.models if query in m.lower()] if query else d.models
        self._populate_model_list(filtered)

    # --- Helpers ---

    @staticmethod
    def _agent_label(d: DetectedAgent) -> str:
        n = len(d.models)
        if d.error:
            return f"{d.info.name}  (error)"
        if n:
            return f"{d.info.name}  ({n} models)"
        return d.info.name

    def _update_agent_label(self, idx: int) -> None:
        d = self._detected[idx]
        agent_list = self.query_one("#agent-list", OptionList)
        option = agent_list.get_option_at_index(idx)
        if option.id is not None:
            agent_list.replace_option_prompt(option.id, self._agent_label(d))

    # --- Actions ---

    def action_refresh(self) -> None:
        if self._scanning:
            self.notify("Scan already in progress", severity="warning")
            return
        self.query_one(_ID_LOADING_AREA).display = True
        self.query_one(_ID_MODELS_BODY).display = False
        self._start_scan()

    def action_back(self) -> None:
        self.app.pop_screen()
