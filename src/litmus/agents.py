"""
Agent registry, detection, and model listing logic.
No UI code — used by the Textual app screens.
"""

import re
import shutil
import subprocess
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import PROJECT_ROOT

CONFIG_PATH = PROJECT_ROOT / "config.yaml"
CACHE_PATH = PROJECT_ROOT / ".agents_cache.yaml"

# ---------------------------------------------------------------------------
# Parsers: stdout → list[str]
# ---------------------------------------------------------------------------


def _parse_lines(stdout: str) -> list[str]:
    """One model per line, skip blanks and headers."""
    models = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line or line.startswith(("─", "=", "#")):
            continue
        line = re.sub(r"\x1b[\[\]][0-9;]*[a-zA-Z]?", "", line).strip()
        if not line:
            continue
        lower = line.lower()
        if lower.startswith(("available", "models", "loading", "fetching")):
            continue
        models.append(line)
    return models


def _parse_aider(stdout: str) -> list[str]:
    models = []
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("- "):
            models.append(line[2:])
        elif line and not line.startswith(("─", "=", "#", "Aider", "Search")):
            models.append(line)
    return models


def _parse_cursor(stdout: str) -> list[str]:
    models = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line or line.startswith(("─", "=", "#")):
            continue
        line = re.sub(r"\x1b[\[\]][0-9;]*[a-zA-Z]?", "", line).strip()
        if not line:
            continue
        lower = line.lower()
        if lower.startswith(("loading", "available", "fetching")):
            continue
        line = re.sub(r"\s*\((current|default)\)", "", line)
        if " - " in line:
            model_id = line.split(" - ", 1)[0].strip()
            models.append(model_id)
        elif line:
            models.append(line)
    return models


# ---------------------------------------------------------------------------
# Agent registry
# ---------------------------------------------------------------------------


@dataclass
class AgentInfo:
    name: str
    binaries: list[str]
    cmd_template: str = ""
    model_cmd: list[str] | None = None
    parse_models: Callable[[str], list[str]] = field(default_factory=lambda: _parse_lines)
    known_models: list[str] = field(default_factory=list)


AGENT_REGISTRY: list[AgentInfo] = [
    AgentInfo(
        name="Claude Code",
        binaries=["claude"],
        cmd_template="claude -p --dangerously-skip-permissions --model {model} {message}",
        model_cmd=None,
        known_models=[
            "claude-sonnet-4-5",
            "claude-opus-4",
            "claude-sonnet-4-6",
            "claude-opus-4-6",
            "claude-haiku-4-5",
        ],
    ),
    AgentInfo(
        name="Codex",
        binaries=["codex"],
        cmd_template="codex exec --json --full-auto -m {model} {message}",
        model_cmd=None,
        known_models=[
            "o4-mini",
            "o3",
            "gpt-4.1",
            "codex-mini",
        ],
    ),
    AgentInfo(
        name="OpenCode",
        binaries=["opencode"],
        cmd_template="opencode run --thinking -q --model {model} {message}",
        model_cmd=["opencode", "models"],
    ),
    AgentInfo(
        name="KiloCode",
        binaries=["kilocode", "kilo"],
        cmd_template="kilocode run --auto --thinking --model {model} {message}",
        model_cmd=["kilocode", "models"],
    ),
    AgentInfo(
        name="Aider",
        binaries=["aider"],
        cmd_template="aider --yes-always --model {model} --message {message}",
        model_cmd=["aider", "--list-models", "*"],
        parse_models=_parse_aider,
    ),
    AgentInfo(
        name="Cursor Agent",
        binaries=["agent"],
        cmd_template="agent --print --force --trust --model {model} {message}",
        model_cmd=["agent", "models"],
        parse_models=_parse_cursor,
    ),
]


# ---------------------------------------------------------------------------
# Detection & model listing
# ---------------------------------------------------------------------------


@dataclass
class DetectedAgent:
    info: AgentInfo
    path: str
    models: list[str] = field(default_factory=list)
    selected: list[str] = field(default_factory=list)
    error: str = ""


def detect_binary(agent: AgentInfo) -> str | None:
    for binary in agent.binaries:
        path = shutil.which(binary)
        if path:
            return path
    return None


def fetch_models(agent: AgentInfo, binary_path: str) -> DetectedAgent:
    detected = DetectedAgent(info=agent, path=binary_path)
    if agent.model_cmd is None:
        detected.models = list(agent.known_models)
        return detected

    cmd = [binary_path, *agent.model_cmd[1:]]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if proc.returncode == 0:
            detected.models = agent.parse_models(proc.stdout)
        else:
            detected.error = f"exit {proc.returncode}"
    except subprocess.TimeoutExpired:
        detected.error = "timeout (30s)"
    except Exception as e:
        detected.error = str(e)
    return detected


def scan_agents(
    on_progress: Callable[[int, int, str], None] | None = None,
) -> tuple[list[DetectedAgent], list[AgentInfo]]:
    """
    Detect agents and fetch models.
    on_progress(current, total, agent_name) is called for UI updates.
    Two phases: binary detection, then model fetching — both report progress.
    Returns (detected, not_found).
    """
    found: list[tuple[AgentInfo, str]] = []
    not_found: list[AgentInfo] = []

    # Phase 1: detect binaries (fast)
    agents_with_models = []
    agents_without_models = []
    for agent in AGENT_REGISTRY:
        if on_progress:
            on_progress(0, 0, f"Detecting {agent.name}...")
        path = detect_binary(agent)
        if path:
            found.append((agent, path))
            if agent.model_cmd is not None:
                agents_with_models.append((agent, path))
            else:
                agents_without_models.append((agent, path))
        else:
            not_found.append(agent)

    if not found:
        return [], not_found

    # Phase 2: fetch models (slow — parallel with progress)
    detected: list[DetectedAgent] = []
    for agent, path in agents_without_models:
        detected.append(DetectedAgent(info=agent, path=path, models=list(agent.known_models)))

    if agents_with_models:
        total_fetch = len(agents_with_models)
        done_count = 0
        with ThreadPoolExecutor(max_workers=total_fetch) as executor:
            futures = {
                executor.submit(fetch_models, agent, path): agent
                for agent, path in agents_with_models
            }
            for future in as_completed(futures):
                result = future.result()
                detected.append(result)
                done_count += 1
                if on_progress:
                    on_progress(
                        done_count,
                        total_fetch,
                        f"Models: {result.info.name} ({done_count}/{total_fetch})",
                    )

    # Keep registry order
    order = {a.name: i for i, a in enumerate(AGENT_REGISTRY)}
    detected.sort(key=lambda d: order.get(d.info.name, 999))

    return detected, not_found


# ---------------------------------------------------------------------------
# Config save/load
# ---------------------------------------------------------------------------


def save_config(detected: list[DetectedAgent]) -> Path | None:
    agents_data = []
    for d in detected:
        if not d.selected:
            continue
        agents_data.append(
            {
                "name": d.info.name,
                "binary": d.path,
                "cmd_template": d.info.cmd_template,
                "models": d.selected,
            }
        )
    if not agents_data:
        return None
    # Preserve existing config sections (e.g. analysis)
    config = _load_config_raw()
    config["agents"] = agents_data
    _write_config(config)
    return CONFIG_PATH


def _load_config_raw() -> dict:
    if CONFIG_PATH.is_file():
        data = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    return {}


def _write_config(config: dict) -> None:
    CONFIG_PATH.write_text(
        yaml.dump(config, default_flow_style=False, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def load_config() -> dict | None:
    if not CONFIG_PATH.is_file():
        return None
    return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))


def load_analysis_config() -> dict:
    """Load analysis section from config.yaml. Returns {model, api_key, base_url}."""
    config = _load_config_raw()
    defaults = {"model": "", "api_key": "", "base_url": ""}
    section = config.get("analysis", {})
    if not isinstance(section, dict):
        return defaults
    return {k: section.get(k, "") or "" for k in defaults}


def save_analysis_config(data: dict) -> None:
    """Save analysis section to config.yaml (preserves other sections)."""
    config = _load_config_raw()
    config["analysis"] = {
        "model": data.get("model", ""),
        "api_key": data.get("api_key", ""),
        "base_url": data.get("base_url", ""),
    }
    _write_config(config)


# ---------------------------------------------------------------------------
# Scan cache (agents + models, no selections)
# ---------------------------------------------------------------------------


def save_cache(detected: list[DetectedAgent], not_found: list[AgentInfo]) -> None:
    """Persist scan results so the next open is instant."""
    data = {
        "detected": [
            {
                "name": d.info.name,
                "path": d.path,
                "models": d.models,
                "error": d.error,
            }
            for d in detected
        ],
        "not_found": [a.name for a in not_found],
    }
    CACHE_PATH.write_text(
        yaml.dump(data, default_flow_style=False, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def load_cache() -> tuple[list[DetectedAgent], list[str]] | None:
    """Load cached scan results. Returns (detected, not_found_names) or None."""
    if not CACHE_PATH.is_file():
        return None
    try:
        data = yaml.safe_load(CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not data or "detected" not in data:
        return None

    registry_by_name = {a.name: a for a in AGENT_REGISTRY}
    detected = []
    for item in data["detected"]:
        info = registry_by_name.get(item["name"])
        if info is None:
            continue
        detected.append(
            DetectedAgent(
                info=info,
                path=item.get("path", ""),
                models=item.get("models", []),
                error=item.get("error", ""),
            )
        )
    not_found = data.get("not_found", [])
    return detected, not_found
