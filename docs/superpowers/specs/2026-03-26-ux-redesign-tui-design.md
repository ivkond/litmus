# Litmus UX Redesign: TUI (Textual), Mode-First Architecture

**Date:** 2026-03-26
**Status:** Draft
**Variant:** TUI (Textual) — alternative to the Web variant

## Problem

Current Litmus TUI presents a labyrinth of 7+ screens and ~8 abstractions (Agent, Model, Scenario, Suite, Session, Run, Evaluation, Judge). Users — team leads evaluating which agent/model to adopt — get lost before reaching their first benchmark run. There is no explicit comparison mode; users must mentally map what to compare with what.

## Target Users

- **Team lead / tech lead** choosing an agent+model combination for their team
- **Researcher within a team** running comparisons and publishing results

These users need fast answers ("which model is best for us?"), not framework flexibility.

## Core Insight

The atomic entity is **Run Result = Agent(version) × Model × Scenario(version)**. Users accumulate these "bricks" over time. Comparison modes are visual lenses over the same result database, not separate workflows.

## Architecture: Run + Lenses

Two primary actions replace the current multi-screen TUI:

| Action | Purpose | Metaphor |
|--------|---------|----------|
| **Run** | Collect data — add bricks to the result database | Scientist running experiments |
| **Compare** | Analyze data — slice results with lenses | Scientist reviewing data |

## Technology Decision

**Redesigned TUI using Textual.** Reasons:
- Zero-dependency user experience — no browser, no server, just `litmus`
- Textual supports rich widgets: DataTable, tabs, progress bars, split layouts, color-coded cells
- Stays true to the developer-in-terminal workflow
- Existing Textual expertise in the codebase

Trade-offs vs web:
- No radar charts or complex visualizations (heatmap tables with color-coded text suffice)
- Side-by-side layouts limited to terminal width (mitigated by tab switching)
- No shareable URL — but HTML report export covers this need

The CLI entry point remains: `litmus` opens the TUI directly (no server).

## Screen Architecture

### Navigation (Sidebar / Tab Bar)

Textual `TabbedContent` or sidebar `Tree` widget with 5 items:

1. **Dashboard** — overview + quick actions
2. **Run** — matrix builder + execution
3. **Compare** — 4 lens views
4. **Scenarios** — library management
5. **Settings** — agents, judge, preferences

Navigation via mouse click or keyboard shortcut (Ctrl+1..5 or configurable keybindings). Active tab highlighted. Sidebar can be toggled with `Ctrl+B` to reclaim horizontal space.

### 1. Dashboard

**Layout:** Vertical stack.

**First visit (no data):**
```
┌─ LITMUS ──────────────────────────────────────────┐
│                                                    │
│   Welcome to Litmus                                │
│                                                    │
│   [R] New Run          [C] Compare (no data yet)   │
│                                                    │
│   No benchmark results yet.                        │
│   Press [R] to run your first benchmark.           │
│                                                    │
└────────────────────────────────────────────────────┘
```

**Returning user:**
```
┌─ LITMUS ──────────────────────────────────────────┐
│  42 results · 3 agents · 5 models · 8 scenarios   │
│                                                    │
│  [R] New Run                [C] Compare            │
│                                                    │
│  ── RECENT ACTIVITY ──────────────────────────     │
│  KiloCode × Sonnet 4 × 8 scenarios   2h ago  7/8  │
│  Aider × GPT-4o × 8 scenarios      yesterday 6/8  │
│  Claude Code × Sonnet 4 × 8 scen.   2 days   8/8  │
│                                                    │
│  Press Enter on a run to view details              │
└────────────────────────────────────────────────────┘
```

**Textual widgets:** `Static` for stats, `Button` for actions, `ListView` for recent runs with `ListItem` rows. Color-coded pass rates (green/amber/red via Rich markup).

### 2. Run Screen

#### 2a. Matrix Builder

**Layout:** Horizontal split — left pane (agents+models), right pane (scenarios), bottom bar (summary).

```
┌─ NEW RUN ─────────────────────────────────────────────────────┐
│ AGENTS & MODELS                │ SCENARIOS                    │
│                                │                              │
│ ▼ ✓ KiloCode    3/312 models  │ 6 of 8 selected   [a] All   │
│   Filter: son█                 │                              │
│   [✓] Sonnet 4                 │ [✓] 1. Data Structure        │
│   [✓] Sonnet 3.5              │ [✓] 2. REST API              │
│   [ ] Sonnet 3                 │ [✓] 3. Complex Debug         │
│   [f] show selected only       │ [✓] 4. Spec Compliance       │
│                                │ [✓] 5. Hallucination         │
│ ▶ ✓ Aider       2/48 models   │ [✓] 6. Tool Calling          │
│ ▶   Claude Code  0/3 models   │ [ ] 7. Architecture          │
│                                │ [ ] 8. Long Context          │
│ [+ Add agent]                  │                              │
├────────────────────────────────┴──────────────────────────────┤
│ Ready: 2 agents × 5 models × 6 scenarios = 30 runs   [START] │
└───────────────────────────────────────────────────────────────┘
```

**Textual widgets:**
- Left: `Tree` widget with agent nodes and model checkboxes as leaves. Collapsible agent groups (▼/▶).
- Model filter: `Input` widget inside each expanded agent node. Typing filters the model list in real-time. Agent header shows `3/312 models` (selected/total).
- Show selected only: `f` toggles hiding unselected models — useful after picking models to review the selection without scrolling through 300+ entries.
- Right: `SelectionList` or `OptionList` with checkboxes.
- Bottom: `Footer`-style bar with live-computed `Static` label + `Button`.

**Keybindings:** `Space` to toggle selection, `Enter` or `s` to start, `a` to select all scenarios, `Tab` to switch panes, `/` to focus filter input, `f` to toggle show-selected-only.

#### 2b. Progress View

**Layout:** Vertical stack — progress bar, matrix table, current activity.

```
┌─ RUNNING ─────────────────────────────────────────────────────┐
│ Progress: ████████░░░░░░░░░░░░  12/30  ~8 min remaining      │
│                                                               │
│              │ Sonnet 4  │ GPT-4o   │ Gemini 2.5             │
│ ─────────────┼───────────┼──────────┼────────────             │
│ KiloCode     │  6/6 ✓    │  4/6 ●   │  2/6 ●                │
│ Aider        │  0/6      │  0/6     │  —                     │
│                                                               │
│ ── NOW RUNNING ───────────────────────────────────            │
│ KiloCode × Gemini 2.5 × 3. Complex Debug        42s ●        │
│                                                               │
│ [Ctrl+C] Cancel                                               │
└───────────────────────────────────────────────────────────────┘
```

**Textual widgets:** `ProgressBar`, `DataTable` with color-coded cells (Rich text: `[green]6/6 ✓[/]`, `[yellow]4/6 ●[/]`, `[dim]0/6[/]`), `Static` for current activity with a `Timer` for elapsed time.

### 3. Compare Screen

#### 3a. Lens Picker

**Layout:** 2×2 grid of selectable options.

```
┌─ COMPARE ─────────────────────────────────────────────────────┐
│ 42 results · 3 agents · 5 models · 8 scenarios               │
│                                                               │
│ ── RANKINGS ──────────────────────────────────────            │
│                                                               │
│ [1] 🧪 Compare Models         [2] 🤖 Compare Agents          │
│     Overall model ranking,         Overall agent ranking,     │
│     averaged across all agents     averaged across all models │
│     5 models, 3 agents             3 agents, 5 models        │
│                                                               │
│ ── DETAILED ──────────────────────────────────────            │
│                                                               │
│ [3] 🔍 Agent × Models         [4] 🔄 Model × Agents          │
│     Pick an agent, see how         Pick a model, see how     │
│     each model performs in it      each agent handles it     │
│     KiloCode(3) Aider(2) CC(2)    Sonnet(3) GPT-4o(2)       │
│                                                               │
│ Press 1-4 or Enter to select                                  │
└───────────────────────────────────────────────────────────────┘
```

**Textual widgets:** `OptionList` with 4 items, or 4 `Button` widgets in a `Grid` layout. Keyboard: `1`-`4` for direct access.

#### 3b. Aggregated View (Compare Models / Compare Agents)

**Layout:** Vertical stack — leaderboard, then heatmap table.

```
┌─ COMPARE MODELS (aggregated) ─────────────────────────────────┐
│                                                                │
│ ── LEADERBOARD ───────────────────────────────────             │
│ 🥇 Claude Sonnet 4     88.5%  (avg across 3 agents)           │
│ 🥈 GPT-4o              84.2%  (avg across 2 agents)           │
│ 🥉 Gemini 2.5 Pro      70.3%  (avg across 1 agent)            │
│                                                                │
│ ⚠ Gemini 2.5 Pro tested in only 1 agent — may not be          │
│   representative. Press [r] to run more tests.                 │
│                                                                │
│ ── PER-SCENARIO ────────────────────────────────── [t] toggle  │
│ Scenario          │ Sonnet 4 │ GPT-4o  │ Gemini 2.5           │
│                   │ (3 agts) │ (2 agts)│ (1 agt)              │
│ ──────────────────┼──────────┼─────────┼──────────             │
│ 1. Data Structure │  91%     │  85%    │  68%                 │
│ 2. REST API       │  90%     │ *93%*   │  87%                 │
│ 3. Complex Debug  │ *91%*    │  71%    │  65%                 │
│ 4. Spec Compliance│  82%     │ *88%*   │  75%                 │
│ 5. Hallucination  │ *95%*    │  80%    │  45%                 │
│ 6. Tool Calling   │  78%     │ *85%*   │  82%                 │
│ ──────────────────┼──────────┼─────────┼──────────             │
│ AVERAGE           │  87.5%   │  84.2%  │  70.3%               │
│                                                                │
│ Best in row = bold · [Enter] drill-down · [Esc] back           │
└────────────────────────────────────────────────────────────────┘
```

**Textual widgets:** `ListView` for leaderboard, `DataTable` for heatmap. Color coding via Rich: green (≥80%), yellow (60-79%), red (<60%). Best-in-row: bold. `t` key toggles between table and raw numbers view.

Note: Radar chart not available in TUI. Replace **View toggle (Heatmap / Radar / Table)** with **Table / Compact** toggle. Detailed chart visualizations available via HTML export (`e` key).

#### 3c. Detailed View (Agent × Models / Model × Agents)

Same `DataTable` as aggregated, preceded by an anchor selector:

```
┌─ AGENT × MODELS ──────────────────────────────────────────────┐
│ Agent: [KiloCode ▼]                                           │
│                                                                │
│ Scenario          │ Sonnet 4 │ GPT-4o  │ Gemini 2.5           │
│ ──────────────────┼──────────┼─────────┼──────────             │
│ 1. Data Structure │ *92%*    │  85%    │  68%                 │
│ 2. REST API       │  88%     │ *95%*   │  87%                 │
│ ...               │          │         │                       │
│ ──────────────────┼──────────┼─────────┼──────────             │
│ AVERAGE           │  87.5%   │  84.2%  │  70.3%               │
│                                                                │
│ 🏆 Best model for KiloCode: Sonnet 4 (87.5%)                  │
│                                                                │
│ [Enter] drill-down · [Tab] switch anchor · [Esc] back          │
└────────────────────────────────────────────────────────────────┘
```

**Textual widgets:** `Select` dropdown for anchor entity, `DataTable` for matrix, `Static` for winner callout. `Tab` cycles through available anchors without opening dropdown.

#### 3d. Drill-down (Enter on any cell)

**Layout:** Modal or pushed screen. Vertical stack — scores, then run lineage.

```
┌─ KiloCode × Sonnet 4 × Data Structure ── 92% ────────────────┐
│                                                                │
│ ── SCORES ────────────────────────────────────────             │
│ pytest                    12/13 passed                         │
│ Code correctness          9/10                                 │
│ Instruction following     10/10                                │
│ Hallucination resistance  8/10                                 │
│ Tool efficiency           7/10                                 │
│                                                                │
│ ── SOURCE RUNS (2) ──────────────────────────────              │
│                                                                │
│ ● Latest (used for scores)                                     │
│   Run #14 · Mar 25, 15:21 · KiloCode v2.1 · Scenario v1 · 47s│
│   [l] Logs  [c] Code  [f] Full report                         │
│                                                                │
│ ○ Previous — score: 85%                                        │
│   Run #8 · Mar 20, 10:45 · KiloCode v2.0 · Scenario v1 · 52s │
│   [l] Logs  [c] Code  [d] Diff with latest                    │
│                                                                │
│ ↑ +7% from previous (agent v2.0 → v2.1)                       │
│                                                                │
│ [Esc] back                                                     │
└────────────────────────────────────────────────────────────────┘
```

**Textual widgets:** Pushed `Screen`. Score list as `Static` with Rich markup. Run lineage as `ListView` with expandable items. Logs/Code open in `$EDITOR` or a Textual `TextArea` (read-only). Diff opens `diff` in pager.

### 4. Scenarios Screen

#### 4a. Library

**Layout:** `DataTable` list view (grid layout impractical in TUI).

```
┌─ SCENARIOS ───────────────────────────────────────────────────┐
│ 8 scenarios                   [i] Import pack  [n] New        │
│                                                                │
│ Name              │ Ver │ Tags             │ Runs │ Avg Score  │
│ ──────────────────┼─────┼──────────────────┼──────┼──────────  │
│ 1. Data Structure │ v1  │ python, algo     │   42 │ 82%        │
│ 2. REST API       │ v1  │ python, web      │   38 │ 88%        │
│ 3. Complex Debug  │ v1  │ python, debug    │   35 │ 74%        │
│ 4. Spec Compliance│ v1  │ python, spec     │   32 │ 79%        │
│ 5. Hallucination  │ v2  │ python, halluc.  │   30 │ 68% worst  │
│ 6. Tool Calling   │ v1  │ python, tools    │   28 │ 81%        │
│ 7. Architecture   │ v1  │ python, design   │   25 │ 76%        │
│ 8. Long Context   │ v1  │ python, context  │   20 │ 72%        │
│                                                                │
│ [Enter] View details · [e] Export · [d] Duplicate              │
└────────────────────────────────────────────────────────────────┘
```

**Textual widgets:** `DataTable` with sortable columns. Version column: Rich color (green for v1, yellow for v2+). "worst" label rendered as `[yellow]worst[/]`.

#### 4b. Scenario Detail

**Layout:** Pushed screen with `TabbedContent`.

```
┌─ SCENARIO: 1. Data Structure (v1) ───── [Edit] [Export] [Dup] ┐
│                                                                │
│ [Prompt] [Task] [Scoring] [Project] [Tests]                    │
│ ──────────────────────────────────────────────────────         │
│ Implement a TimeBasedKeyValueStore class that stores           │
│ key-value pairs with timestamps.                               │
│                                                                │
│ Requirements:                                                  │
│ - set(key, value, timestamp) stores the value                  │
│ - get(key, timestamp) returns the value with the               │
│   largest timestamp <= given timestamp                         │
│ - Use binary search for O(log n) get operations                │
│ - Handle edge cases: no value before timestamp,                │
│   empty store                                                  │
│                                                                │
│ ── STATS ─────────────────────────────                         │
│ Language: Python · Tests: 13 · Criteria: 5 · Runs: 42         │
│ Best: 96% (Claude Code + Sonnet) · Worst: 45% (Kilo + Gemini) │
│                                                                │
│ [Tab] switch tab · [Esc] back                                  │
└────────────────────────────────────────────────────────────────┘
```

**Textual widgets:** `TabbedContent` for tabs, `TextArea` (read-only) for content, `Static` for stats bar at bottom. Edit action opens content in `$EDITOR`.

### 5. Settings Screen

**Layout:** Vertical sections with `Static` labels and input widgets.

```
┌─ SETTINGS ────────────────────────────────────────────────────┐
│                                                                │
│ ── AGENTS (auto-detected) ────────────────────────             │
│ ● KiloCode          v2.1   12 models                          │
│ ● Aider             v0.82   8 models                          │
│ ● Claude Code       v1.0    3 models                          │
│ ✗ Cursor Agent      not found                                  │
│ [+ Add custom agent]                                           │
│                                                                │
│ ── LLM JUDGE ─────────────────────────────────────             │
│ Model:    [openai/gpt-4o                        ]              │
│ API Key:  [sk-...7x4f                           ]              │
│ Base URL: [https://api.openai.com/v1            ]              │
│                                                                │
│ ── GENERAL ───────────────────────────────────────             │
│ [✓] Auto-run analysis after benchmark                          │
│ [ ] Parallel execution                                         │
│                                                                │
│ [s] Save  [Esc] back                                           │
└────────────────────────────────────────────────────────────────┘
```

**Textual widgets:** `ListView` for agents (green/red `●`/`✗` via Rich), `Input` for text fields, `Switch` for toggles, `Button` for save.

## Data Model

### Core Entity: Run Result

```
RunResult {
  id: UUID
  run_id: UUID          # groups results from same execution
  agent: string         # agent name
  agent_version: string # agent version at time of run
  model: string         # model identifier
  scenario: string      # scenario ID
  scenario_version: string
  timestamp: datetime

  # Automated
  test_passed: int
  test_total: int

  # LLM Judge (optional, run separately)
  judge_scores: Map<criterion, score>
  judge_model: string

  # Artifacts
  logs_path: string
  code_path: string

  # Computed
  total_score: float    # weighted combination
  duration_seconds: int
}
```

### Aggregation Rules

- **Compare Models (aggregated):** For each model × scenario, average the score across all agents that tested that combination. Per-model total = average across all scenarios.
- **Compare Agents (aggregated):** For each agent × scenario, average the score across all models that tested that combination. Per-agent total = average across all scenarios.
- **Detailed views:** No aggregation — show per-cell scores for the selected anchor.
- **Multiple runs of same combo:** Use latest run's score for display. All runs accessible via drill-down lineage.

### Data Coverage

Show warnings when:
- A model/agent has been tested with fewer counterparts than others
- A scenario has not been run for a particular combination (gap in matrix, shown as `—` in table)
- Suggest "Run more tests" via keybinding that jumps to Run screen with pre-filled matrix

## TUI-Specific Design Constraints

### Layout Adaptation

| Web concept | TUI equivalent |
|-------------|----------------|
| Sidebar navigation | `TabbedContent` header or collapsible sidebar `Tree` |
| Cards in grid | `DataTable` rows or `ListView` items |
| Heatmap with background colors | `DataTable` cells with Rich color markup (`[green]92%[/]`) |
| Dropdown / Select | Textual `Select` widget |
| Toggle switch | Textual `Switch` widget |
| Modal dialog | Pushed `Screen` |
| Charts (radar, bar) | Not available — use tables + HTML export for charts |
| Hover effects | Cursor row highlighting in `DataTable` |

### Keybinding Scheme

| Key | Global action |
|-----|---------------|
| `Ctrl+1..5` | Switch to Dashboard/Run/Compare/Scenarios/Settings |
| `Ctrl+B` | Toggle sidebar |
| `Enter` | Open / drill-down / confirm |
| `Esc` | Back / close modal |
| `Space` | Toggle checkbox / selection |
| `?` | Show help overlay |

| Key | Context-specific |
|-----|------------------|
| `r` | Dashboard: New Run |
| `c` | Dashboard: Compare |
| `s` | Run: Start / Settings: Save |
| `a` | Run: Select all scenarios |
| `t` | Compare: Toggle table view |
| `e` | Compare: Export HTML report / Scenarios: Export |
| `l` | Drill-down: Open logs |
| `d` | Drill-down: Diff with latest / Scenarios: Duplicate |
| `1-4` | Lens picker: Direct lens selection |
| `Tab` | Switch panes / cycle anchor |

### Terminal Width Handling

- **Minimum:** 80 columns — single-pane layout, tables scroll horizontally
- **Comfortable:** 120 columns — two-pane layout for Matrix Builder
- **Wide:** 160+ — full two-pane with generous spacing

Textual's responsive layout adapts automatically. The Matrix Builder switches from horizontal split to vertical stack below 100 columns.

### Color Coding (consistent across all screens)

| Meaning | Color | Rich markup |
|---------|-------|-------------|
| Good (≥80%) | Green | `[green]` |
| Warning (60-79%) | Yellow | `[yellow]` |
| Bad (<60%) | Red | `[red]` |
| Agent name | Orange | `[dark_orange]` |
| Model name | Blue | `[dodger_blue1]` |
| Scenario name | Green | `[green]` |
| Inactive / pending | Dim | `[dim]` |
| Accent / branding | Purple | `[medium_purple1]` |

## Migration from Current TUI

### What changes:
- All TUI screens rewritten with new navigation structure
- Main menu replaced with tabbed/sidebar navigation
- Run configuration → single Matrix Builder screen
- Results browsing → Compare screen with 4 lenses
- Analysis → integrated into Compare drill-down

### What stays:
- `litmus` command → opens redesigned TUI directly
- `litmus init` → unchanged (workspace scaffolding)
- `config.yaml` → unchanged (backward compatible)
- `template/` directory structure → unchanged
- `results/` directory structure → unchanged, but indexed into a local DB for querying
- Textual framework dependency (upgraded if needed)

### What's added:
- Local database (SQLite) indexing all run results for fast querying and aggregation
- HTML export from Compare views (for sharing/charts)
- New screen classes replacing current ones

### What's removed:
- Current screen classes in `src/litmus/screens/` (replaced, not patched)
- Suite concept (replaced by ad-hoc scenario selection in Matrix Builder)
- Session concept from UI (replaced by Run with lineage tracking)

## Design Principles

1. **Run first, compare second** — the path to first benchmark should be 1 screen (matrix builder), not 4 steps
2. **Lenses, not modes** — comparison views are filters on accumulated data, not separate workflows
3. **Show data coverage** — always indicate how much data backs a ranking, warn when sparse
4. **Trace everything** — every score links back to specific Run(s) with version info
5. **Progressive disclosure** — dashboard → lens picker → heatmap → drill-down → logs
6. **Keyboard-first** — every action reachable via keyboard; mouse optional but supported
7. **Terminal-native** — no external dependencies (browser, server); everything runs in the terminal
