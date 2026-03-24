# Split app.py into screens/ package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 2414-line `app.py` into a `screens/` package with 6 focused modules, leaving only the app shell in `app.py`.

**Architecture:** Move classes verbatim into `src/litmus/screens/` submodules grouped by domain (models, scenarios, run, results, analysis). Shared constants (`TEMPLATE_DIR`, `RESULTS_DIR`) and shared widgets (`ModelSelectionList`, `FilterInput`, `OpenWithScreen`) live in `screens/_common.py`. A `screens/__init__.py` re-exports everything so `app.py` imports from one place.

**Tech Stack:** Python, Textual TUI framework

**Spec:** `docs/superpowers/specs/2026-03-25-split-app-into-screens-design.md`

---

## Important notes

- This is a **pure structural refactor** — no logic changes, no API changes, no CSS changes.
- Each task creates one module. Copy the class code verbatim, adjusting only the import block at the top.
- After each task, verify with `python -c "from litmus.screens.<module> import <Class>"`.
- The old `app.py` is only trimmed in the final task, so the app remains runnable throughout (import errors from new modules don't break the old code).
- Deferred imports inside methods (e.g., `from .pack.scenarios import export_scenarios`) become `from ..pack.scenarios import ...` inside the `screens/` package.

---

### Task 1: Create `screens/` package with `__init__.py` and `_common.py`

**Files:**
- Create: `src/litmus/screens/__init__.py`
- Create: `src/litmus/screens/_common.py`

**Source lines from `app.py`:** 56–113, 893–966 (constants, `ModelSelectionList`, `FilterInput`, `OpenWithScreen`)

- [ ] **Step 1: Create `_common.py`**

```python
"""Shared constants and widgets for screens."""

from pathlib import Path

from textual import events
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Input, OptionList, SelectionList
from textual.widgets.option_list import Option, OptionDoesNotExist
from textual.strip import Strip, Segment

from rich.style import Style

from .. import PROJECT_ROOT

TEMPLATE_DIR = PROJECT_ROOT / "template"
RESULTS_DIR = PROJECT_ROOT / "results"

# --- Custom SelectionList: circle icons ---

ICON_SELECTED = "◉"
ICON_UNSELECTED = "○"


class ModelSelectionList(SelectionList):
    # ... (lines 68–112 from app.py, verbatim)


class FilterInput(Input):
    # ... (lines 120–133 from app.py, verbatim)


class OpenWithScreen(Screen):
    # ... (lines 893–965 from app.py, verbatim)
    # NOTE: deferred imports (os, subprocess, sys) stay inside the method
```

- [ ] **Step 2: Create `__init__.py` with re-exports**

```python
"""Screens package — re-exports all public screen classes and shared symbols."""

from ._common import (
    TEMPLATE_DIR,
    RESULTS_DIR,
    ModelSelectionList,
    FilterInput,
    OpenWithScreen,
)
# Remaining imports added in subsequent tasks as modules are created
```

- [ ] **Step 3: Verify imports**

Run: `cd C:/projects/moex/experiments/model-selection/litmus && python -c "from litmus.screens._common import TEMPLATE_DIR, ModelSelectionList, FilterInput, OpenWithScreen; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/litmus/screens/__init__.py src/litmus/screens/_common.py
git commit -m "refactor: create screens/ package with shared constants and widgets"
```

---

### Task 2: Create `screens/models.py`

**Files:**
- Create: `src/litmus/screens/models.py`
- Modify: `src/litmus/screens/__init__.py` — add ModelsScreen re-export

**Source lines from `app.py`:** 141–482 (`ModelsScreen`)

- [ ] **Step 1: Create `models.py`**

Imports needed:
```python
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import (
    Footer, Header, Input, Label, LoadingIndicator, OptionList, SelectionList,
)
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from ..agents import (
    DetectedAgent, load_cache, load_config, save_cache, save_config, scan_agents,
)
from ._common import FilterInput, ModelSelectionList
```

Then paste `class ModelsScreen(Screen):` (lines 141–482) verbatim.

- [ ] **Step 2: Update `__init__.py`** — add:

```python
from .models import ModelsScreen
```

- [ ] **Step 3: Verify**

Run: `python -c "from litmus.screens import ModelsScreen; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/litmus/screens/models.py src/litmus/screens/__init__.py
git commit -m "refactor: extract ModelsScreen into screens/models.py"
```

---

### Task 3: Create `screens/scenarios.py`

**Files:**
- Create: `src/litmus/screens/scenarios.py`
- Modify: `src/litmus/screens/__init__.py`

**Source lines from `app.py`:** 489–728 (`ScenariosScreen`), 735–815 (`ScenarioExportScreen`), 822–886 (`ScenarioImportScreen`), 973–1076 (`ScenarioEditScreen`), 1083–1128 (`ConfirmDeleteScreen`)

- [ ] **Step 1: Create `scenarios.py`**

Imports needed:
```python
from pathlib import Path

from textual import on
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import (
    Button, DataTable, Footer, Header, Input, Label,
    OptionList, SelectionList, Static, TextArea,
)
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from ..run import get_scenario_ids
from ._common import TEMPLATE_DIR, OpenWithScreen
```

Then paste these classes in order:
1. `ScenariosScreen` (lines 489–728)
2. `ScenarioExportScreen` (lines 735–815) — change `from .pack.scenarios` → `from ..pack.scenarios`
3. `ScenarioImportScreen` (lines 822–886) — change `from .pack.scenarios` → `from ..pack.scenarios`
4. `ScenarioEditScreen` (lines 973–1076)
5. `ConfirmDeleteScreen` (lines 1083–1128)

- [ ] **Step 2: Update `__init__.py`** — add:

```python
from .scenarios import (
    ScenariosScreen,
    ScenarioExportScreen,
    ScenarioImportScreen,
    ScenarioEditScreen,
    ConfirmDeleteScreen,
)
```

- [ ] **Step 3: Verify**

Run: `python -c "from litmus.screens import ScenariosScreen, ScenarioEditScreen, ConfirmDeleteScreen; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/litmus/screens/scenarios.py src/litmus/screens/__init__.py
git commit -m "refactor: extract scenario screens into screens/scenarios.py"
```

---

### Task 4: Create `screens/run.py`

**Files:**
- Create: `src/litmus/screens/run.py`
- Modify: `src/litmus/screens/__init__.py`

**Source lines from `app.py`:** 1135–1222 (`RunConfigScreen`), 1229–1256 (`RunState`), 1263–1534 (`RunProgressScreen`), 1541–1651 (`RunViewerScreen`), 1658–1810 (`RunDetailScreen`)

- [ ] **Step 1: Create `run.py`**

Imports needed:
```python
from pathlib import Path

from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import (
    DataTable, Footer, Header, Label, OptionList, ProgressBar, Static, Tree,
)
from textual.widgets.option_list import Option
from textual.widgets.selection_list import Selection

from rich.text import Text

from ..agents import load_analysis_config, load_config
from ..run import (
    CancelledError, get_scenario_ids, make_model_safe, run_single_scenario,
)
from ._common import ModelSelectionList, OpenWithScreen, RESULTS_DIR, TEMPLATE_DIR
```

Then paste these classes in order:
1. `RunConfigScreen` (lines 1135–1222)
2. `RunState` (lines 1229–1256)
3. `RunProgressScreen` (lines 1263–1534) — change `from .report` → `from ..report`, `from .analysis` → `from ..analysis`, `from .agents` → `from ..agents`
4. `RunViewerScreen` (lines 1541–1651)
5. `RunDetailScreen` (lines 1658–1810)

- [ ] **Step 2: Update `__init__.py`** — add:

```python
from .run import (
    RunState,
    RunConfigScreen,
    RunProgressScreen,
    RunViewerScreen,
    RunDetailScreen,
)
```

- [ ] **Step 3: Verify**

Run: `python -c "from litmus.screens import RunState, RunConfigScreen, RunProgressScreen, RunViewerScreen, RunDetailScreen; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/litmus/screens/run.py src/litmus/screens/__init__.py
git commit -m "refactor: extract run screens into screens/run.py"
```

---

### Task 5: Create `screens/results.py`

**Files:**
- Create: `src/litmus/screens/results.py`
- Modify: `src/litmus/screens/__init__.py`

**Source lines from `app.py`:** 1817–2099 (`ResultsBrowserScreen`)

- [ ] **Step 1: Create `results.py`**

Imports needed:
```python
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import DataTable, Footer, Header, Label, OptionList
from textual.widgets.option_list import Option

from ..agents import load_analysis_config
from ._common import RESULTS_DIR, OpenWithScreen
from .run import RunDetailScreen
from .analysis import AnalysisModal
```

Then paste `ResultsBrowserScreen` (lines 1817–2099) verbatim.
Change `from .report` → `from ..report` inside `action_report`.

- [ ] **Step 2: Update `__init__.py`** — add:

```python
from .results import ResultsBrowserScreen
```

- [ ] **Step 3: Verify**

Run: `python -c "from litmus.screens import ResultsBrowserScreen; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/litmus/screens/results.py src/litmus/screens/__init__.py
git commit -m "refactor: extract ResultsBrowserScreen into screens/results.py"
```

---

### Task 6: Create `screens/analysis.py`

**Files:**
- Create: `src/litmus/screens/analysis.py`
- Modify: `src/litmus/screens/__init__.py`

**Source lines from `app.py`:** 2106–2227 (`AnalysisModal`), 2234–2306 (`SettingsScreen`)

**IMPORTANT:** This task must be done BEFORE Task 5, because `results.py` imports `AnalysisModal` from `screens.analysis`. Alternatively, do Task 5 and Task 6 together.

- [ ] **Step 1: Create `analysis.py`**

Imports needed:
```python
from pathlib import Path

from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Footer, Input, Label, LoadingIndicator

from ..agents import load_analysis_config, save_analysis_config
```

Then paste:
1. `AnalysisModal` (lines 2106–2227) — change `from .analysis` → `from ..analysis`
2. `SettingsScreen` (lines 2234–2306)

- [ ] **Step 2: Update `__init__.py`** — add:

```python
from .analysis import AnalysisModal, SettingsScreen
```

- [ ] **Step 3: Verify**

Run: `python -c "from litmus.screens import AnalysisModal, SettingsScreen; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/litmus/screens/analysis.py src/litmus/screens/__init__.py
git commit -m "refactor: extract AnalysisModal and SettingsScreen into screens/analysis.py"
```

---

### Task 7: Trim `app.py` to app shell

**Files:**
- Modify: `src/litmus/app.py` — replace 2414 lines with ~120 lines

- [ ] **Step 1: Rewrite `app.py`**

Replace entire contents with:

```python
"""Litmus — Textual TUI application."""

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Footer, Label, OptionList
from textual.widgets.option_list import Option

from rich.text import Text

from .screens import (
    ModelsScreen,
    ScenariosScreen,
    RunConfigScreen,
    RunViewerScreen,
    ResultsBrowserScreen,
    SettingsScreen,
    RunState,
)
from .run import cleanup_children


# (MainMenuScreen class — lines 2313–2392 from original, verbatim)
class MainMenuScreen(Screen):
    ...


# (HarnessApp class — lines 2399–2415 from original, verbatim)
class HarnessApp(App):
    ...
```

- [ ] **Step 2: Verify the app launches**

Run: `cd C:/projects/moex/experiments/model-selection/litmus && python -c "from litmus.app import HarnessApp; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Verify line count**

Run: `wc -l src/litmus/app.py`
Expected: < 150

- [ ] **Step 4: Commit**

```bash
git add src/litmus/app.py
git commit -m "refactor: trim app.py to app shell (~120 lines)"
```

---

### Task 8: Final verification

- [ ] **Step 1: Check all imports resolve**

Run: `python -c "from litmus.app import HarnessApp; from litmus.screens import ModelsScreen, ScenariosScreen, RunConfigScreen, RunProgressScreen, RunViewerScreen, RunDetailScreen, ResultsBrowserScreen, AnalysisModal, SettingsScreen, RunState, ModelSelectionList, FilterInput, OpenWithScreen, TEMPLATE_DIR, RESULTS_DIR; print('ALL OK')"`

- [ ] **Step 2: Check no circular imports**

Run: `python -c "import litmus; print('No circular imports')"`

- [ ] **Step 3: Verify line counts**

Run: `wc -l src/litmus/app.py src/litmus/screens/*.py`
Expected: `app.py` < 150, no single `screens/*.py` > 700

- [ ] **Step 4: Commit (if any fixups needed)**

---

## Execution order

**CRITICAL:** Task 6 (analysis.py) must be completed BEFORE Task 5 (results.py), because `results.py` imports `AnalysisModal` from `screens.analysis`.

Recommended order: **1 → 2 → 3 → 4 → 6 → 5 → 7 → 8**

Tasks 2, 3, 4, and 6 are independent of each other (they only depend on Task 1) and can be parallelized.
