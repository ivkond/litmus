# Litmus UX Redesign: TUI → Web, Mode-First Architecture

**Date:** 2026-03-26
**Status:** Draft

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

**Web interface** instead of TUI. Reasons:
- Dashboards, heatmaps, and side-by-side comparisons are natural in web
- Background execution with real-time progress is simpler
- HTML reports already exist — consolidate into one UI
- No terminal rendering limitations for tables and charts

The CLI remains as a launcher: `litmus` starts the web server and opens the browser.

## Screen Architecture

### Navigation (Sidebar)

5 items, always visible:
1. **Dashboard** — overview + quick actions
2. **Run** — matrix builder + execution
3. **Compare** — 4 lens views
4. **Scenarios** — library management
5. **Settings** — agents, judge, preferences

### 1. Dashboard

**First visit (no data):** Two prominent cards — "New Run" and "Compare" (disabled until data exists).

**Returning user:** Summary stats ("42 results, 3 agents, 5 models, 8 scenarios"), quick-action cards (New Run / Compare), and a recent activity feed showing runs with their Agent × Model × scenario count and pass rate.

### 2. Run Screen

#### 2a. Matrix Builder

Single screen replacing the old multi-step wizard. Two columns:

**Left column — Agents & Models:**
- Auto-detected agents listed as expandable cards
- Each agent card shows available models as selectable chips/tags
- Selected agents have an orange left border accent
- **Model filter:** Text input at the top of each agent's model list for filtering by name (agents can have 300+ models). Typing narrows the visible list instantly.
- **Show selected only:** Toggle to hide unselected models — useful after picking models to review the selection without scrolling through hundreds.
- "+ Add agent" at the bottom

**Right column — Scenarios:**
- Checklist with "Select all" toggle
- Each scenario shows name + short tag (e.g., "binary search", "FastAPI")
- Selected count displayed ("6 of 8 selected")

**Bottom — Summary Bar:**
- Live calculation: "2 agents × 5 models × 6 scenarios = **30 runs**"
- "Start Run" button

This reduces the path from 4 steps to 1 screen.

#### 2b. Progress View

Real-time matrix fill during execution:

- **Progress bar** with completion count and ETA
- **Matrix table** — rows = agents, columns = models, cells show scenario progress (e.g., "4/6")
- Color-coded: completed (green), running (amber), pending (gray)
- **"Now running"** indicator showing current Agent × Model × Scenario with elapsed time

### 3. Compare Screen

#### 3a. Lens Picker

2×2 matrix of comparison modes:

**Row 1 — RANKINGS (aggregated across all data):**

| Lens | Fix | Vary | Aggregation | Question answered |
|------|-----|------|-------------|-------------------|
| **Compare Models** | — | Models | Avg score across ALL agents | "Which model is best overall?" |
| **Compare Agents** | — | Agents | Avg score across ALL models | "Which agent is best overall?" |

**Row 2 — DETAILED (fix one entity, explore the rest):**

| Lens | Fix | Vary | Question answered |
|------|-----|------|-------------------|
| **Agent × Models** | One agent | Models | "How does KiloCode work with different models?" |
| **Model × Agents** | One model | Agents | "How does Sonnet 4 behave across different agents?" |

Each card shows available data: "5 models tested across 3 agents", "Sonnet 4 (3 agents)".

#### 3b. Aggregated View (Compare Models / Compare Agents)

- **Leaderboard** — ranked list with medals, average score, number of entities in the average
- **Data coverage warning** — if a model/agent was tested in only 1 counterpart, show: "Gemini 2.5 tested in only 1 agent — ranking may not be representative" with "Run more tests" link
- **Per-scenario heatmap** below the leaderboard — rows = scenarios, columns = models/agents, color-coded cells (green/amber/red), best-in-row bolded
- **TOTAL row** at bottom with averages
- **View toggle**: Heatmap / Radar / Table

#### 3c. Detailed View (Agent × Models / Model × Agents)

Same heatmap table as aggregated, but:
- Filter bar at top to select the anchor entity (dropdown)
- No leaderboard — the focus is on the detailed matrix
- Winner callout at bottom: "Best model for KiloCode: Sonnet 4 (87.5% avg)"

#### 3d. Drill-down (click any cell)

Expands to show:

**Left — Scores:**
- pytest results (12/13 passed)
- LLM judge scores by criterion (Code correctness 9/10, Tool efficiency 7/10, etc.)

**Right — Run Lineage:**
- All Run(s) that produced this data point, ordered by date
- **Latest** (green badge, "used for scores") with: Run ID, date, agent version, scenario version, duration, links to Logs / Code / Full report
- **Previous runs** with their score and "Diff with latest" button
- **Trend indicator**: "+7% from previous run (agent upgraded v2.0 → v2.1)"

### 4. Scenarios Screen

#### 4a. Library

Grid of scenario cards, each showing:
- Name, version badge (v1 green, v2 amber for updated)
- Description (one line)
- Tags: language, category, test count
- Usage stats: "42 runs, avg score 82%", outlier labels ("hardest scenario")

Top actions: "Import pack" and "+ New scenario".

#### 4b. Scenario Detail

- **Tabs**: Prompt / Task / Scoring / Project files / Tests
- **Left**: Content viewer/editor for the active tab
- **Right sidebar**: Scenario stats (version, language, test count, scoring criteria count, total runs) + Performance stats (avg score, best result with agent+model, worst result)
- **Actions**: Edit, Export, Duplicate

### 5. Settings Screen

Minimal — three sections:

**Agents (auto-detected):**
- List of detected agents with version, model count, status indicator (green = found, red = not found)
- "+ Add custom agent" link

**LLM Judge:**
- Model (text input, e.g., "openai/gpt-4o")
- API Key (masked)
- Base URL (optional)

**General:**
- Toggle: Auto-run analysis after benchmark
- Toggle: Parallel execution

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
- A scenario has not been run for a particular combination (gap in matrix)
- Suggest "Run more tests" with pre-filled matrix builder

## Migration from Current TUI

### What changes:
- TUI screens → Web screens
- `litmus` command → starts web server + opens browser
- `litmus init` → unchanged (workspace scaffolding)
- `config.yaml` → unchanged (backward compatible)
- `template/` directory structure → unchanged
- `results/` directory structure → unchanged, but indexed into a local DB for querying

### What's added:
- Local database (SQLite) indexing all run results for fast querying and aggregation
- Web server (FastAPI or similar) serving the UI
- Frontend (could be server-rendered or SPA)

### What's removed:
- TUI framework (textual) dependency
- All TUI screen classes in `src/litmus/screens/`
- Interactive terminal menus

## Design Principles

1. **Run first, compare second** — the path to first benchmark should be 1 screen (matrix builder), not 4 steps
2. **Lenses, not modes** — comparison views are filters on accumulated data, not separate workflows
3. **Show data coverage** — always indicate how much data backs a ranking, warn when sparse
4. **Trace everything** — every score links back to specific Run(s) with version info
5. **Progressive disclosure** — dashboard → lens picker → heatmap → drill-down → logs
