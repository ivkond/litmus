# Split app.py into screens/ package

**Date:** 2026-03-25
**Status:** Approved
**Addresses:** TODO.md > Architecture

## Problem

`app.py` is 2414 lines containing 19 classes (screens, widgets, data classes). This makes navigation, testing, and maintenance difficult.

## Design

### Approach: Move & re-export

Move screen classes into `src/litmus/screens/` package. Keep `MainMenuScreen` and `HarnessApp` in `app.py` (they form the app shell and import all screens for navigation). Shared constants and the utility `OpenWithScreen` live in `screens/_common.py` to prevent circular imports.

### Module layout

| Module | Classes | Lines (approx) |
|--------|---------|-----------------|
| `screens/_common.py` | `TEMPLATE_DIR`, `RESULTS_DIR`, `ModelSelectionList`, `FilterInput`, `OpenWithScreen` | 120 |
| `screens/models.py` | `ModelsScreen` | 400 |
| `screens/scenarios.py` | `ScenariosScreen`, `ScenarioExportScreen`, `ScenarioImportScreen`, `ScenarioEditScreen`, `ConfirmDeleteScreen` | 600 |
| `screens/run.py` | `RunState`, `RunConfigScreen`, `RunProgressScreen`, `RunViewerScreen`, `RunDetailScreen` | 690 |
| `screens/results.py` | `ResultsBrowserScreen` | 290 |
| `screens/analysis.py` | `AnalysisModal`, `SettingsScreen` | 200 |
| `screens/__init__.py` | Re-exports: `ModelSelectionList`, `FilterInput`, `OpenWithScreen`, `ModelsScreen`, `ScenariosScreen`, `ScenarioExportScreen`, `ScenarioImportScreen`, `ScenarioEditScreen`, `ConfirmDeleteScreen`, `RunState`, `RunConfigScreen`, `RunProgressScreen`, `RunViewerScreen`, `RunDetailScreen`, `ResultsBrowserScreen`, `AnalysisModal`, `SettingsScreen`, `TEMPLATE_DIR`, `RESULTS_DIR` | 20 |
| `app.py` (trimmed) | `MainMenuScreen`, `HarnessApp` | 120 |

### Import graph (acyclic)

```
_common.py         <-- no internal deps
models.py          <-- agents, _common (ModelSelectionList, FilterInput)
scenarios.py       <-- agents, pack, _common (TEMPLATE_DIR, OpenWithScreen)
run.py             <-- run (root), agents, _common (ModelSelectionList, OpenWithScreen)
results.py         <-- _common (OpenWithScreen), screens.run (RunDetailScreen), screens.analysis (AnalysisModal)
analysis.py        <-- agents, _common
app.py             <-- screens (all via __init__)
```

No module imports `app.py` -- cycle impossible.

### What changes

- Classes move verbatim (no API/CSS changes)
- Each module gets its own imports from textual, rich, and litmus internals
- `TEMPLATE_DIR` / `RESULTS_DIR` move from `app.py` to `screens/_common.py`
- `ModelSelectionList` / `FilterInput` move to `screens/_common.py` (shared widgets used by models and run modules)
- `OpenWithScreen` moves to `screens/_common.py` (used by scenarios, run, and results modules)

### What does NOT change

- Class interfaces, methods, attributes, CSS
- Root `__init__.py` (`from .app import HarnessApp`)
- Sibling modules: `agents.py`, `run.py`, `analysis.py`, `report.py`

## Success criteria

1. `python -m litmus` launches and all screens navigate correctly
2. No circular import errors
3. `app.py` < 150 lines
4. Each `screens/*.py` module is self-contained with its own imports
