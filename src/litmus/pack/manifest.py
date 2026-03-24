"""
Pack manifest — shared metadata for all pack types (scenarios, settings, …).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

CURRENT_FORMAT_VERSION = 1


@dataclass
class ScenarioEntry:
    """One scenario inside a scenarios pack."""

    stem: str
    files: list[str] = field(default_factory=list)


@dataclass
class Manifest:
    """Top-level manifest stored as ``manifest.json`` in a pack ZIP."""

    format_version: int
    kind: str  # "scenarios" | "settings" | …
    exported_at: str
    scenarios: list[ScenarioEntry] = field(default_factory=list)

    # ── serialisation ────────────────────────────────────────────

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, ensure_ascii=False)

    @classmethod
    def from_json(cls, text: str) -> Manifest:
        raw: dict[str, Any] = json.loads(text)
        scenarios = [ScenarioEntry(**s) for s in raw.pop("scenarios", [])]
        return cls(**raw, scenarios=scenarios)

    # ── factory ──────────────────────────────────────────────────

    @classmethod
    def for_scenarios(cls, entries: list[ScenarioEntry]) -> Manifest:
        return cls(
            format_version=CURRENT_FORMAT_VERSION,
            kind="scenarios",
            exported_at=datetime.now(UTC).isoformat(),
            scenarios=entries,
        )
