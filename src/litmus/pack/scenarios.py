"""
Export / import scenario packs (ZIP with manifest).
"""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path, PurePosixPath

from .manifest import CURRENT_FORMAT_VERSION, Manifest, ScenarioEntry

MANIFEST_FILE = "manifest.json"

# Directories and extensions to skip during export
_SKIP_DIRS = {"__pycache__", ".pytest_cache", ".venv"}
_SKIP_SUFFIXES = {".pyc", ".pyo"}


def _should_skip(path: Path) -> bool:
    return any(part in _SKIP_DIRS for part in path.parts) or path.suffix in _SKIP_SUFFIXES


def _collect_files(scenario_dir: Path) -> list[Path]:
    """Return list of files relative to *scenario_dir*, filtered."""
    return [
        child
        for child in sorted(scenario_dir.rglob("*"))
        if child.is_file() and not _should_skip(child.relative_to(scenario_dir))
    ]


# ── public API ───────────────────────────────────────────────────


def export_scenarios(
    template_dir: Path,
    scenario_ids: list[str],
    output_path: Path,
) -> Path:
    """Pack selected scenarios into a ZIP archive with manifest.

    Returns the resolved *output_path*.
    Raises ``FileNotFoundError`` if any scenario_id is missing.
    """
    # Validate
    missing = [s for s in scenario_ids if not (template_dir / s).is_dir()]
    if missing:
        raise FileNotFoundError(f"Scenarios not found: {', '.join(missing)}")

    entries: list[ScenarioEntry] = []

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for stem in scenario_ids:
            scenario_dir = template_dir / stem
            files = _collect_files(scenario_dir)
            rel_paths: list[str] = []
            for fpath in files:
                rel = fpath.relative_to(scenario_dir)
                # Always use POSIX paths inside ZIP for cross-platform compat
                arc_name = str(PurePosixPath(stem) / PurePosixPath(*rel.parts))
                zf.write(fpath, arc_name)
                rel_paths.append(str(PurePosixPath(*rel.parts)))
            entries.append(ScenarioEntry(stem=stem, files=rel_paths))

        manifest = Manifest.for_scenarios(entries)
        zf.writestr(MANIFEST_FILE, manifest.to_json())

    return output_path.resolve()


class PackError(Exception):
    """Import validation errors."""


def import_scenarios(
    zip_path: Path,
    template_dir: Path,
) -> list[str]:
    """Unpack a scenarios ZIP into *template_dir*, overwriting existing.

    Returns list of imported scenario stems.
    Raises ``PackError`` on invalid archive.
    """
    if not zip_path.is_file():
        raise PackError(f"File not found: {zip_path}")

    with zipfile.ZipFile(zip_path, "r") as zf:
        # Read & validate manifest
        if MANIFEST_FILE not in zf.namelist():
            raise PackError(f"Archive has no {MANIFEST_FILE} — not a valid scenario pack")

        manifest = Manifest.from_json(zf.read(MANIFEST_FILE).decode("utf-8"))

        if manifest.format_version > CURRENT_FORMAT_VERSION:
            raise PackError(
                f"Unsupported format_version={manifest.format_version} "
                f"(max supported: {CURRENT_FORMAT_VERSION})"
            )

        if manifest.kind != "scenarios":
            raise PackError(f"Expected kind='scenarios', got '{manifest.kind}'")

        imported: list[str] = []
        zip_names = set(zf.namelist())

        for entry in manifest.scenarios:
            if not entry.files:
                continue  # no files declared — skip

            # Build expected archive paths from manifest
            expected = [str(PurePosixPath(entry.stem) / f) for f in entry.files]

            # Validate all manifest-declared files exist in ZIP
            missing = [p for p in expected if p not in zip_names]
            if missing:
                raise PackError(
                    f"Scenario '{entry.stem}': manifest declares files "
                    f"missing from archive: {', '.join(missing)}"
                )

            # Only extract files listed in the manifest
            target = template_dir / entry.stem
            if target.exists():
                shutil.rmtree(target)

            for arc_name in expected:
                zf.extract(arc_name, template_dir)

            imported.append(entry.stem)

    return imported
