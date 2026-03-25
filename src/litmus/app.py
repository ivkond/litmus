"""Litmus — Textual TUI application."""

from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Footer, Label, OptionList
from textual.widgets.option_list import Option

from .run import cleanup_children
from .screens import (
    ModelsScreen,
    ResultsBrowserScreen,
    RunConfigScreen,
    RunState,
    RunViewerScreen,
    ScenariosScreen,
    SettingsScreen,
)


class MainMenuScreen(Screen):
    BINDINGS = [
        Binding("q", "quit", "Quit"),
    ]

    CSS = """
    MainMenuScreen {
        align: center middle;
    }
    #menu-container {
        width: 60;
        height: auto;
        max-height: 20;
        border: solid $accent;
        padding: 1 2;
    }
    #menu-title {
        text-align: center;
        text-style: bold;
        margin-bottom: 1;
    }
    #main-menu {
        height: auto;
    }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="menu-container"):
            yield Label("Litmus", id="menu-title")
            yield OptionList(id="main-menu")
        yield Footer()

    def on_mount(self) -> None:
        self._rebuild_menu()

    def on_screen_resume(self) -> None:
        """Refresh menu when returning from another screen."""
        self._rebuild_menu()

    def _rebuild_menu(self) -> None:
        menu = self.query_one("#main-menu", OptionList)
        menu.clear_options()

        # Show "Current run" only while running
        active = getattr(self.app, "active_run", None)
        if active is not None and active.running:
            st = active
            icon = "▸"
            menu.add_option(
                Option(
                    f"{icon} Current run ({st.done_count}/{len(st.tasks)})",
                    id="current_run",
                )
            )
            menu.add_option(Option("─" * 40, disabled=True))

        def _item(name: str, desc: str, id: str) -> Option:
            return Option(Text.assemble(name, (f" — {desc}", "dim")), id=id)

        menu.add_option(_item("Models", "view agents & models catalog", "models"))
        menu.add_option(_item("Scenarios", "browse test scenarios", "scenarios"))
        menu.add_option(_item("Run tests", "execute test scenarios", "run"))
        menu.add_option(_item("Results", "browse previous runs", "results"))
        menu.add_option(_item("Settings", "LLM analysis configuration", "settings"))

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        match event.option.id:
            case "current_run":
                active = getattr(self.app, "active_run", None)
                if active is not None:
                    self.app.push_screen(RunViewerScreen(active))
            case "models":
                self.app.push_screen(ModelsScreen())
            case "scenarios":
                self.app.push_screen(ScenariosScreen())
            case "run":
                self.app.push_screen(RunConfigScreen())
            case "results":
                self.app.push_screen(ResultsBrowserScreen())
            case "settings":
                self.app.push_screen(SettingsScreen())
            case unknown:
                self.notify(f"Unknown menu option: {unknown}", severity="warning")

    def action_quit(self) -> None:
        self.app.exit()


class HarnessApp(App):
    TITLE = "Litmus"
    CSS = """
    Screen {
        background: $surface;
    }
    """

    # Active run state (shared between RunProgressScreen and RunViewerScreen)
    active_run: RunState | None = None

    def on_mount(self) -> None:
        self.push_screen(MainMenuScreen())

    def on_unmount(self) -> None:
        cleanup_children()
