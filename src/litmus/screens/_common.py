"""Shared constants, widgets, and utility screens used across all litmus screens."""

from rich.segment import Segment
from rich.style import Style
from textual import events
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.strip import Strip
from textual.widgets import Input, Label, OptionList, SelectionList
from textual.widgets.option_list import Option, OptionDoesNotExist

from .. import PROJECT_ROOT

# ── Paths ────────────────────────────────────────────────────────────────────
TEMPLATE_DIR = PROJECT_ROOT / "template"
RESULTS_DIR = PROJECT_ROOT / "results"

# ── Icons ────────────────────────────────────────────────────────────────────
ICON_SELECTED = "\u25c9"
ICON_UNSELECTED = "\u25cb"


# ═══════════════════════════════════════════════════════════════════════════
# Custom SelectionList: ◉/○ icons instead of X
# ═══════════════════════════════════════════════════════════════════════════


class ModelSelectionList(SelectionList):
    """SelectionList with circle icons instead of X."""

    def render_line(self, y: int) -> Strip:
        line = super(SelectionList, self).render_line(y)

        _, scroll_y = self.scroll_offset
        selection_index = scroll_y + y
        try:
            selection = self.get_option_at_index(selection_index)
        except OptionDoesNotExist:
            return line

        is_selected = selection.value in self._selected
        is_highlighted = self.highlighted == selection_index

        component_style = "selection-list--button"
        if is_selected:
            component_style += "-selected"
        if is_highlighted:
            component_style += "-highlighted"

        underlying_style = next(iter(line)).style or self.rich_style
        assert underlying_style is not None
        button_style = self.get_component_rich_style(component_style)
        meta = Style(meta={"option": selection_index})
        # Pad style matches button background so highlight is seamless
        pad_style = Style.from_color(bgcolor=button_style.bgcolor) + meta
        button_style = button_style + meta

        icon = ICON_SELECTED if is_selected else ICON_UNSELECTED

        return Strip(
            [
                Segment(" ", style=pad_style),
                Segment(icon, style=button_style),
                Segment(" ", style=pad_style),
                Segment(" ", style=underlying_style),
                *line,
            ]
        )

    @property
    def _left_gutter_width(self) -> int:
        return 4  # " ◉ " + space


# ═══════════════════════════════════════════════════════════════════════════
# Custom Input: arrow down/up moves focus to model list
# ═══════════════════════════════════════════════════════════════════════════


class FilterInput(Input):
    """Input that passes arrow down/up to focus the model list below."""

    async def _on_key(self, event: events.Key) -> None:
        if event.key in ("down", "up"):
            model_list = self.screen.query_one("#model-list", ModelSelectionList)
            model_list.focus()
            # Forward the key so the list also processes it
            if event.key == "down":
                model_list.action_cursor_down()
            event.prevent_default()
            event.stop()
            return
        await super()._on_key(event)


# ═══════════════════════════════════════════════════════════════════════════
# Open-with screen
# ═══════════════════════════════════════════════════════════════════════════


class OpenWithScreen(Screen):
    BINDINGS = [
        Binding("escape", "cancel", "Cancel"),
    ]

    CSS = """
    OpenWithScreen {
        align: center middle;
    }
    #open-box {
        width: 45;
        height: auto;
        border: solid $accent;
        padding: 1 2;
    }
    #open-title {
        text-style: bold;
        text-align: center;
        margin-bottom: 1;
    }
    #open-list {
        height: auto;
        max-height: 10;
    }
    """

    def __init__(self, path: str) -> None:
        super().__init__()
        self._path = path

    def compose(self) -> ComposeResult:
        with Vertical(id="open-box"):
            yield Label("Open project with...", id="open-title")
            ol = OptionList(id="open-list")
            ol.add_option(Option("VS Code", id="vscode"))
            ol.add_option(Option("Zed", id="zed"))
            ol.add_option(Option("File Explorer", id="explorer"))
            yield ol

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        import os
        import subprocess
        import sys

        choice = event.option.id
        path = self._path

        try:
            if choice == "vscode":
                if sys.platform == "win32":
                    os.startfile("code", "open", path)
                else:
                    subprocess.Popen(["code", path])
            elif choice == "zed":
                if sys.platform == "win32":
                    subprocess.Popen(f'zed "{path}"', shell=True)
                else:
                    subprocess.Popen(["zed", path])
            elif choice == "explorer":
                if sys.platform == "win32":
                    os.startfile(path)
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", path])
                else:
                    subprocess.Popen(["xdg-open", path])
        except Exception as exc:
            self.notify(str(exc), severity="error")
            return

        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)
