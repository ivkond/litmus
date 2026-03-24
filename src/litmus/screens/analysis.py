"""Analysis modal and settings screens for LLM analysis."""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING

from textual import work
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Footer, Input, Label, LoadingIndicator

from ..agents import load_analysis_config, save_analysis_config

if TYPE_CHECKING:
    from pathlib import Path

    from textual.app import ComposeResult

# ═══════════════════════════════════════════════════════════════════════════
# Analysis Modal — blocking LLM analysis with progress
# ═══════════════════════════════════════════════════════════════════════════


class AnalysisModal(Screen):
    """Modal screen that runs LLM analysis and shows progress."""

    BINDINGS = [
        Binding("escape", "back", "Close"),
    ]

    CSS = """
    AnalysisModal {
        align: center middle;
    }
    #analysis-box {
        width: 70;
        height: auto;
        border: solid $accent;
        padding: 1 2;
    }
    #analysis-title {
        text-align: center;
        text-style: bold;
        margin-bottom: 1;
    }
    #analysis-status {
        text-align: center;
        width: 1fr;
        color: $text-muted;
    }
    #analysis-error {
        width: 1fr;
        color: $error;
        margin-top: 1;
    }
    #analysis-hint {
        text-align: center;
        width: 1fr;
        color: $text-muted;
        margin-top: 1;
    }
    #analysis-box LoadingIndicator {
        height: 3;
    }
    """

    def __init__(self, session_dir: Path, cfg: dict) -> None:
        super().__init__()
        self._session_dir = session_dir
        self._cfg = cfg
        self._done = False

    def compose(self) -> ComposeResult:
        with Vertical(id="analysis-box"):
            yield Label("LLM Analysis", id="analysis-title")
            yield LoadingIndicator()
            yield Label("Starting...", id="analysis-status")
            yield Label("", id="analysis-error")
            yield Label("", id="analysis-hint")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Analysis"
        self._run()

    def action_back(self) -> None:
        self.app.pop_screen()

    @staticmethod
    def _esc(text: str) -> str:
        return text.replace("[", "\\[").replace("<", "&lt;").replace(">", "&gt;")

    def _show_error(self, short_msg: str, detail: str = "") -> None:
        """Show error state: hide spinner, show message + hint."""
        try:
            self.query_one(LoadingIndicator).display = False
            self.query_one("#analysis-status", Label).update(short_msg)
            if detail:
                self.query_one("#analysis-error", Label).update(self._esc(detail))
            self.query_one("#analysis-hint", Label).update("Press escape to close")
        except Exception:
            pass

    @work(thread=True)
    def _run(self) -> None:
        from ..analysis import generate_analysis

        def on_progress(msg: str) -> None:
            with contextlib.suppress(Exception):
                self.app.call_from_thread(
                    self.query_one("#analysis-status", Label).update,
                    self._esc(msg),
                )

        try:
            path = generate_analysis(
                self._session_dir,
                model=self._cfg["model"],
                api_key=self._cfg.get("api_key", ""),
                base_url=self._cfg.get("base_url", ""),
                on_progress=on_progress,
            )
        except Exception as exc:
            log_path = self._session_dir / "analysis.log"
            self.app.call_from_thread(
                self._show_error,
                "Analysis failed",
                f"{exc}\n\nSee {log_path}",
            )
            return

        if path:
            self.app.call_from_thread(self.app.pop_screen)
            self.app.call_from_thread(
                self.notify,
                f"Analysis: {self._esc(path.name)}",
                title="Done",
            )
            import webbrowser

            webbrowser.open(path.as_uri())
        else:
            self.app.call_from_thread(
                self._show_error,
                "No data found",
                "",
            )


# ═══════════════════════════════════════════════════════════════════════════
# Settings Screen — LLM analysis configuration
# ═══════════════════════════════════════════════════════════════════════════


class SettingsScreen(Screen):
    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("s", "save", "Save", priority=True),
    ]

    CSS = """
    SettingsScreen { align: center middle; }
    #settings-container {
        width: 70;
        height: auto;
        max-height: 20;
        border: solid $accent;
        padding: 1 2;
    }
    #settings-title {
        text-align: center;
        text-style: bold;
        margin-bottom: 1;
    }
    .field-label {
        margin-top: 1;
        color: $text-muted;
    }
    #settings-status {
        margin-top: 1;
        color: $text-muted;
        text-align: center;
    }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="settings-container"):
            yield Label("LLM Analysis Settings", id="settings-title")
            yield Label("Model (litellm format)", classes="field-label")
            yield Input(
                placeholder="anthropic/claude-sonnet-4-20250514",
                id="settings-model",
            )
            yield Label("API Key (leave empty to use env var)", classes="field-label")
            yield Input(
                placeholder="sk-...",
                id="settings-api-key",
                password=True,
            )
            yield Label("Base URL (optional, for custom endpoints)", classes="field-label")
            yield Input(
                placeholder="https://...",
                id="settings-base-url",
            )
            yield Label("", id="settings-status")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "Settings"
        cfg = load_analysis_config()
        self.query_one("#settings-model", Input).value = cfg.get("model", "")
        self.query_one("#settings-api-key", Input).value = cfg.get("api_key", "")
        self.query_one("#settings-base-url", Input).value = cfg.get("base_url", "")

    def action_save(self) -> None:
        data = {
            "model": self.query_one("#settings-model", Input).value.strip(),
            "api_key": self.query_one("#settings-api-key", Input).value.strip(),
            "base_url": self.query_one("#settings-base-url", Input).value.strip(),
        }
        save_analysis_config(data)
        self.notify("Settings saved", title="Saved")

    def action_back(self) -> None:
        self.action_save()
        self.app.pop_screen()
