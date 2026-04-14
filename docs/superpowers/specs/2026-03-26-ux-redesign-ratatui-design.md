# Litmus UX Redesign: TUI (Ratatui / Rust), Mode-First Architecture

**Date:** 2026-03-26
**Status:** Draft
**Variant:** TUI (Ratatui, Rust) — alternative to the Web and Textual variants

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

**Rust TUI using Ratatui.** Reasons:
- Single static binary — no Python runtime, no `pip install`, no virtual environments
- Instant startup (<50ms vs Python TUI ~500ms+)
- Cross-platform with zero dependencies for the end user
- Ratatui is the de facto Rust TUI framework (successor to tui-rs), actively maintained
- Rich widget set: Table, Tabs, Gauge, Block, List, Paragraph, Chart (bar charts, sparklines)

Trade-offs:
- Rewrite from Python to Rust — significant effort, different ecosystem
- Agent execution (subprocess spawning, log parsing) needs reimplementation
- LLM judge integration (HTTP calls to OpenAI API) via `reqwest`
- No radar charts, but Ratatui has `BarChart` and `Sparkline` for basic visualization
- Scenario project management (`uv sync`, `pytest`) stays as subprocess calls

**Architecture split:** The Rust binary handles UI + orchestration. Benchmark execution (agent calls, pytest) remains subprocess-based — Rust spawns the same shell commands the Python version does.

**Entry point:** `litmus` opens the TUI directly (single binary, no server).

## Screen Architecture

### Navigation (Tab Bar)

Ratatui `Tabs` widget at the top of the screen:

```
 Dashboard │ Run │ Compare │ Scenarios │ Settings
```

Navigation via `Ctrl+1..5` or `Tab`/`Shift+Tab` to cycle. Active tab highlighted with accent color and underline.

### 1. Dashboard

**Layout:** Vertical chunks via `Layout::vertical`.

**First visit (no data):**
```
┌─ LITMUS ──────────────────────────────────────────┐
│  Dashboard │ Run │ Compare │ Scenarios │ Settings  │
├───────────────────────────────────────────────────┤
│                                                    │
│   Welcome to Litmus                                │
│                                                    │
│   [r] New Run          [c] Compare (no data yet)   │
│                                                    │
│   No benchmark results yet.                        │
│   Press [r] to run your first benchmark.           │
│                                                    │
└────────────────────────────────────────────────────┘
```

**Returning user:**
```
┌─ LITMUS ──────────────────────────────────────────┐
│  Dashboard │ Run │ Compare │ Scenarios │ Settings  │
├───────────────────────────────────────────────────┤
│  42 results · 3 agents · 5 models · 8 scenarios   │
│                                                    │
│  [r] New Run                [c] Compare            │
│                                                    │
│  ── RECENT ACTIVITY ──────────────────────────     │
│  KiloCode × Sonnet 4 × 8 scenarios   2h ago  7/8  │
│  Aider × GPT-4o × 8 scenarios      yesterday 6/8  │
│  Claude Code × Sonnet 4 × 8 scen.   2 days   8/8  │
│                                                    │
│  ↑↓ navigate · Enter view details                  │
└────────────────────────────────────────────────────┘
```

**Ratatui rendering:**
- Stats line: `Paragraph` with styled `Spans` (agent=orange, model=blue, count=green)
- Action hints: `Paragraph` with keybinding highlights
- Recent activity: `Table` widget with columns: description, time ago, pass rate. Row selection with `List` state.

### 2. Run Screen

#### 2a. Matrix Builder

**Layout:** `Layout::horizontal` split — left (agents+models), right (scenarios), bottom bar.

```
┌─ NEW RUN ─────────────────────────────────────────────────────┐
│  Dashboard │ Run │ Compare │ Scenarios │ Settings              │
├────────────────────────────────┬──────────────────────────────┤
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
│                                │                              │
├────────────────────────────────┴──────────────────────────────┤
│ Ready: 2 agents × 5 models × 6 scenarios = 30 runs   [ENTER] │
└───────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:**
- Left pane: Custom stateful tree widget. Each agent is a collapsible node (▼/▶) rendered as a `List` with indented model items. Checkboxes rendered as `[✓]`/`[ ]` text spans.
- Model filter: `tui-input` text input inside each expanded agent node. Typing filters the model list in real-time. Agent header shows `3/312` (selected/total).
- Show selected only: `f` toggles hiding unselected models — critical for agents with 300+ models. After picking models, toggle to review the selection cleanly.
- Right pane: `List` widget with `ListState` for cursor. Checkboxes as styled spans.
- Bottom: `Paragraph` in a `Block` with computed summary. Enter key styled as button-like span.
- Pane focus: `Tab` switches active pane (highlighted border).

**State management:**
```rust
struct MatrixBuilderState {
    agents: Vec<AgentSelection>,    // name, expanded, models with selected flags
    scenarios: Vec<ScenarioSelection>, // name, selected flag
    active_pane: Pane,              // Left | Right
    left_cursor: usize,            // flattened index in agent+model tree
    right_cursor: usize,           // index in scenario list
    model_filter: HashMap<String, String>, // per-agent filter text
    show_selected_only: bool,      // hide unselected models
}
```

**Keybindings:** `Space` toggle, `Enter` start run, `a` select all scenarios, `Tab` switch panes, `←→` collapse/expand agent, `/` focus filter input, `f` toggle show-selected-only.

#### 2b. Progress View

**Layout:** Vertical — gauge, table, status line.

```
┌─ RUNNING ─────────────────────────────────────────────────────┐
│  Progress: ████████░░░░░░░░░░░░  12/30  ~8 min remaining     │
│                                                               │
│              │ Sonnet 4  │ GPT-4o   │ Gemini 2.5             │
│ ─────────────┼───────────┼──────────┼────────────             │
│ KiloCode     │  6/6 ✓    │  4/6 ●   │  2/6 ●                │
│ Aider        │  0/6      │  0/6     │  —                     │
│                                                               │
│ NOW: KiloCode × Gemini 2.5 × 3. Complex Debug       42s ●    │
│                                                               │
│ [Ctrl+C] Cancel                                               │
└───────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:**
- `Gauge` widget for progress bar (green fill, percentage + ETA label)
- `Table` widget with styled cells: `Style::new().fg(Color::Green)` for completed, `Color::Yellow` for running, `Color::DarkGray` for pending
- Status line: `Paragraph` with a `tokio::time::Interval` driving elapsed time updates

**Async execution:** Ratatui's event loop runs on the main thread. Benchmark execution runs on `tokio` async tasks. Progress updates sent via `mpsc::channel` to the UI thread.

### 3. Compare Screen

#### 3a. Lens Picker

**Layout:** 2×2 grid rendered as two rows of two `Block` widgets.

```
┌─ COMPARE ─────────────────────────────────────────────────────┐
│  42 results · 3 agents · 5 models · 8 scenarios               │
│                                                               │
│  ── RANKINGS ─────────────────────────────────────            │
│                                                               │
│  [1] Compare Models            [2] Compare Agents             │
│      Overall model ranking,        Overall agent ranking,     │
│      avg across all agents         avg across all models      │
│      5 models, 3 agents            3 agents, 5 models        │
│                                                               │
│  ── DETAILED ─────────────────────────────────────            │
│                                                               │
│  [3] Agent × Models            [4] Model × Agents             │
│      Pick an agent, see how        Pick a model, see how     │
│      each model performs           each agent handles it     │
│      KiloCode(3) Aider(2)         Sonnet(3) GPT-4o(2)       │
│                                                               │
│  Press 1-4 to select                                          │
└───────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:** Each lens card is a `Block` with `Borders::ALL`. Selected card gets a colored border (accent). Content is `Paragraph` with styled lines. Layout: `Layout::vertical` for rows, `Layout::horizontal` within each row.

#### 3b. Aggregated View (Compare Models / Compare Agents)

**Layout:** Vertical — leaderboard list, optional warning, heatmap table.

```
┌─ COMPARE MODELS (aggregated) ─────────────────────────────────┐
│                                                                │
│  LEADERBOARD                                                   │
│  #1  Claude Sonnet 4     ████████████████████ 88.5%  3 agents  │
│  #2  GPT-4o              ████████████████░░░░ 84.2%  2 agents  │
│  #3  Gemini 2.5 Pro      ██████████████░░░░░░ 70.3%  1 agent   │
│                                                                │
│  ⚠ Gemini 2.5 Pro: only 1 agent — [r] run more tests          │
│                                                                │
│  PER-SCENARIO                                     [t] toggle   │
│  Scenario          │ Sonnet 4 │ GPT-4o  │ Gemini 2.5          │
│                    │ (3 agts) │ (2 agts)│ (1 agt)             │
│  ──────────────────┼──────────┼─────────┼──────────            │
│  1. Data Structure │  91%     │  85%    │  68%                │
│  2. REST API       │  90%     │ *93%*   │  87%                │
│  3. Complex Debug  │ *91%*    │  71%    │  65%                │
│  4. Spec Compliance│  82%     │ *88%*   │  75%                │
│  5. Hallucination  │ *95%*    │  80%    │  45%                │
│  6. Tool Calling   │  78%     │ *85%*   │  82%                │
│  ──────────────────┼──────────┼─────────┼──────────            │
│  AVERAGE           │  87.5%   │  84.2%  │  70.3%              │
│                                                                │
│  Best in row = bold · Enter drill-down · Esc back              │
└────────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:**
- Leaderboard: `List` with inline `Gauge` (bar chart-like) per row. Rank rendered as `#1`, `#2`, `#3` with styled text. Gauge uses `Ratio` for proportional fill.
- Warning: `Paragraph` with `Style::new().fg(Color::Yellow)`.
- Heatmap: `Table` widget with per-cell styling. Coloring logic:
  - `≥80%` → `Color::Green`
  - `60-79%` → `Color::Yellow`
  - `<60%` → `Color::Red`
  - Best in row → `Modifier::BOLD`
- `t` toggles between percentage view and raw score view.

**Leaderboard bar visualization** uses Ratatui's built-in `BarChart` as an alternative:
```rust
BarChart::default()
    .data(&[("Sonnet 4", 885), ("GPT-4o", 842), ("Gemini", 703)])
    .bar_width(3)
    .bar_gap(1)
    .value_style(Style::new().fg(Color::Green))
```

#### 3c. Detailed View (Agent × Models / Model × Agents)

Same `Table` as aggregated, with an anchor selector at top:

```
┌─ AGENT × MODELS ──────────────────────────────────────────────┐
│  Agent: < KiloCode >                    ←→ switch              │
│                                                                │
│  Scenario          │ Sonnet 4 │ GPT-4o  │ Gemini 2.5          │
│  ──────────────────┼──────────┼─────────┼──────────            │
│  1. Data Structure │ *92%*    │  85%    │  68%                │
│  2. REST API       │  88%     │ *95%*   │  87%                │
│  ...               │          │         │                      │
│  ──────────────────┼──────────┼─────────┼──────────            │
│  AVERAGE           │  87.5%   │  84.2%  │  70.3%              │
│                                                                │
│  Best model for KiloCode: Sonnet 4 (87.5%)                    │
│                                                                │
│  Enter drill-down · ←→ switch anchor · Esc back                │
└────────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:** Anchor selector rendered as `< name >` with `←→` cycling (no dropdown — Ratatui has no native dropdown; inline cycling is idiomatic). `Table` and `Paragraph` for winner callout as before.

#### 3d. Drill-down (Enter on any cell)

**Layout:** Pushed screen (full-screen overlay). Vertical: scores section, then run lineage.

```
┌─ KiloCode × Sonnet 4 × Data Structure ── 92% ────────────────┐
│                                                                │
│  SCORES                                                        │
│  pytest                    12/13 passed                        │
│  Code correctness          ████████░░ 9/10                     │
│  Instruction following     ██████████ 10/10                    │
│  Hallucination resistance  ████████░░ 8/10                     │
│  Tool efficiency           ███████░░░ 7/10                     │
│                                                                │
│  SOURCE RUNS (2)                                               │
│                                                                │
│  ● Latest (used for scores)                                    │
│    Run #14 · Mar 25, 15:21 · KiloCode v2.1 · Scenario v1 · 47s│
│    [l] Logs  [c] Code  [f] Full report                         │
│                                                                │
│  ○ Previous — score: 85%                                       │
│    Run #8 · Mar 20, 10:45 · KiloCode v2.0 · Scenario v1 · 52s │
│    [l] Logs  [c] Code  [d] Diff with latest                    │
│                                                                │
│  ↑ +7% from previous (agent v2.0 → v2.1)                      │
│                                                                │
│  Esc back                                                      │
└────────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:**
- Score bars: Ratatui `Gauge` or `LineGauge` per criterion, labeled inline.
- Run lineage: `List` with styled items (green `●` for latest, dim `○` for previous).
- Trend: `Paragraph` with green `↑` / red `↓` styled text.
- Logs/Code: Opens in `$EDITOR` via `std::process::Command`. If no editor, falls back to a scrollable `Paragraph` view.

### 4. Scenarios Screen

#### 4a. Library

**Layout:** `Table` widget with sortable columns.

```
┌─ SCENARIOS ───────────────────────────────────────────────────┐
│  8 scenarios                    [i] Import   [n] New          │
│                                                                │
│  Name              │ Ver │ Tags             │ Runs │ Avg Score │
│  ──────────────────┼─────┼──────────────────┼──────┼────────── │
│  1. Data Structure │ v1  │ python, algo     │   42 │ 82%       │
│  2. REST API       │ v1  │ python, web      │   38 │ 88%       │
│  3. Complex Debug  │ v1  │ python, debug    │   35 │ 74%       │
│  4. Spec Compliance│ v1  │ python, spec     │   32 │ 79%       │
│> 5. Hallucination  │ v2  │ python, halluc.  │   30 │ 68% worst │
│  6. Tool Calling   │ v1  │ python, tools    │   28 │ 81%       │
│  7. Architecture   │ v1  │ python, design   │   25 │ 76%       │
│  8. Long Context   │ v1  │ python, context  │   20 │ 72%       │
│                                                                │
│  Enter details · s sort · e export · d duplicate               │
└────────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:** `Table` with `TableState` for row selection. Version column styled: `v1` = green, `v2+` = yellow. "worst" label = yellow bold. `s` key cycles sort column. `>` marker for selected row.

#### 4b. Scenario Detail

**Layout:** Full-screen overlay. Top: tab bar (Paragraph sections). Center: content. Bottom: stats.

```
┌─ SCENARIO: 1. Data Structure (v1) ───── [e] Edit [x] Export  ─┐
│                                                                │
│  Prompt │ Task │ Scoring │ Project │ Tests                     │
│  ──────────────────────────────────────────────────────        │
│  Implement a TimeBasedKeyValueStore class that stores          │
│  key-value pairs with timestamps.                              │
│                                                                │
│  Requirements:                                                 │
│  - set(key, value, timestamp) stores the value                 │
│  - get(key, timestamp) returns the value with the              │
│    largest timestamp <= given timestamp                         │
│  - Use binary search for O(log n) get operations               │
│  - Handle edge cases: no value before timestamp,               │
│    empty store                                                 │
│                                                                │
│  ─────────────────────────────────────────────────             │
│  Python · 13 tests · 5 criteria · 42 runs                      │
│  Best: 96% (Claude Code + Sonnet) · Worst: 45% (Kilo + Gemini)│
│                                                                │
│  ←→ tabs · e edit in $EDITOR · Esc back                        │
└────────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:** Custom tab bar as `Tabs` widget. Content: scrollable `Paragraph`. Stats: `Paragraph` in bottom `Block`. Edit launches `$EDITOR` on the file, TUI suspends and resumes after editor closes (standard Ratatui pattern via `terminal.draw()` pause/resume).

### 5. Settings Screen

**Layout:** Vertical sections.

```
┌─ SETTINGS ────────────────────────────────────────────────────┐
│                                                                │
│  AGENTS (auto-detected)                                        │
│  ● KiloCode          v2.1   12 models                         │
│  ● Aider             v0.82   8 models                         │
│  ● Claude Code       v1.0    3 models                         │
│  ✗ Cursor Agent      not found                                 │
│  [+] Add custom agent                                          │
│                                                                │
│  LLM JUDGE                                                     │
│  Model:    openai/gpt-4o                                       │
│  API Key:  sk-•••7x4f                                          │
│  Base URL: https://api.openai.com/v1                           │
│                                                                │
│  GENERAL                                                       │
│  [✓] Auto-run analysis after benchmark                         │
│  [ ] Parallel execution                                        │
│                                                                │
│  Tab navigate · Enter edit field · Space toggle · s save       │
└────────────────────────────────────────────────────────────────┘
```

**Ratatui rendering:**
- Agents: `List` with colored `●`/`✗` spans.
- Input fields: Inline editable text. Ratatui doesn't have a built-in input widget — use `tui-input` crate or custom implementation (captures keystrokes when focused, renders cursor). API key masked with `•`.
- Toggles: `[✓]`/`[ ]` as styled text, toggled with `Space`.
- Focus navigation via `Tab` between fields, `Enter` to activate edit mode for text inputs.

## Data Model

### Core Entity: Run Result

```rust
struct RunResult {
    id: Uuid,
    run_id: Uuid,           // groups results from same execution
    agent: String,
    agent_version: String,
    model: String,
    scenario: String,
    scenario_version: String,
    timestamp: DateTime<Utc>,

    // Automated
    test_passed: u32,
    test_total: u32,

    // LLM Judge (optional)
    judge_scores: HashMap<String, f64>,
    judge_model: Option<String>,

    // Artifacts
    logs_path: PathBuf,
    code_path: PathBuf,

    // Computed
    total_score: f64,       // weighted combination
    duration_seconds: u64,
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
- A scenario has not been run for a particular combination (gap in matrix, shown as `—`)
- Suggest "Run more tests" via `r` keybinding that jumps to Run screen with pre-filled matrix

## Rust-Specific Architecture

### Crate Structure

```
litmus/
├── Cargo.toml
├── src/
│   ├── main.rs              # entry point, terminal setup
│   ├── app.rs               # App state machine, event loop
│   ├── ui/
│   │   ├── mod.rs
│   │   ├── dashboard.rs     # Dashboard rendering
│   │   ├── run.rs           # Matrix builder + progress
│   │   ├── compare.rs       # Lens picker + views
│   │   ├── scenarios.rs     # Library + detail
│   │   ├── settings.rs      # Settings form
│   │   ├── drilldown.rs     # Cell drill-down overlay
│   │   └── widgets/         # Custom reusable widgets
│   │       ├── tree.rs      # Collapsible tree (agents+models)
│   │       ├── heatmap.rs   # Color-coded table wrapper
│   │       └── input.rs     # Text input widget
│   ├── engine/
│   │   ├── mod.rs
│   │   ├── runner.rs        # Benchmark execution (subprocess)
│   │   ├── agents.rs        # Agent detection + model listing
│   │   ├── analysis.rs      # LLM judge scoring (reqwest)
│   │   └── scenarios.rs     # Scenario loading from template/
│   ├── db/
│   │   ├── mod.rs
│   │   ├── schema.rs        # SQLite schema + migrations
│   │   └── queries.rs       # Aggregation queries
│   └── config.rs            # config.yaml parsing (serde)
```

### Key Dependencies

```toml
[dependencies]
ratatui = "0.29"             # TUI framework
crossterm = "0.28"           # Terminal backend
tokio = { version = "1", features = ["full"] }  # Async runtime
rusqlite = { version = "0.32", features = ["bundled"] }  # SQLite
reqwest = { version = "0.12", features = ["json"] }  # HTTP for judge API
serde = { version = "1", features = ["derive"] }
serde_yaml = "0.9"           # config.yaml
uuid = { version = "1", features = ["v4"] }
chrono = "0.4"
tui-input = "0.11"           # Text input widget
```

### Event Loop Pattern

```rust
// Standard Ratatui async pattern
loop {
    terminal.draw(|frame| ui::render(frame, &app))?;

    // Poll for events with timeout (enables async progress updates)
    if crossterm::event::poll(Duration::from_millis(100))? {
        let event = crossterm::event::read()?;
        app.handle_event(event);
    }

    // Check for benchmark progress updates (non-blocking)
    while let Ok(update) = progress_rx.try_recv() {
        app.handle_progress(update);
    }

    if app.should_quit {
        break;
    }
}
```

### Screen State Machine

```rust
enum Screen {
    Dashboard,
    Run(RunScreen),        // MatrixBuilder | Progress
    Compare(CompareScreen), // LensPicker | Aggregated | Detailed | Drilldown
    Scenarios(ScenarioScreen), // Library | Detail
    Settings,
}

enum RunScreen {
    MatrixBuilder(MatrixBuilderState),
    Progress(ProgressState),
}

enum CompareScreen {
    LensPicker,
    Aggregated { lens: AggregatedLens, state: TableState },
    Detailed { lens: DetailedLens, anchor: String, state: TableState },
    Drilldown(DrilldownState),
}
```

## Ratatui-Specific Design Constraints

### Layout Adaptation

| Web concept | Ratatui equivalent |
|-------------|-------------------|
| Sidebar navigation | `Tabs` widget at top |
| Cards in grid | `Block` widgets in `Layout::horizontal` |
| Heatmap with background colors | `Table` with per-cell `Style` (fg color, bold) |
| Dropdown / Select | Inline `< value >` with `←→` cycling |
| Toggle switch | `[✓]`/`[ ]` text, `Space` to toggle |
| Modal dialog | Full-screen overlay (clear + redraw) |
| Charts | `BarChart`, `Sparkline`, `Gauge` widgets |
| Hover effects | Row selection highlight via `TableState` / `ListState` |
| Text input | `tui-input` crate or custom keystroke capture |

### Keybinding Scheme

| Key | Global action |
|-----|---------------|
| `Ctrl+1..5` | Switch to Dashboard/Run/Compare/Scenarios/Settings |
| `Enter` | Open / drill-down / confirm |
| `Esc` | Back / close overlay |
| `Space` | Toggle checkbox / selection |
| `q` | Quit (with confirmation if run in progress) |
| `?` | Show help overlay |

| Key | Context-specific |
|-----|------------------|
| `r` | Dashboard: New Run / Compare: Run more tests |
| `c` | Dashboard: Compare |
| `s` | Run: Start / Settings: Save / Scenarios: Sort |
| `a` | Run: Select all scenarios |
| `t` | Compare: Toggle table view |
| `e` | Compare: Export HTML / Scenarios: Edit in $EDITOR |
| `x` | Scenarios: Export pack |
| `l` | Drill-down: Open logs |
| `d` | Drill-down: Diff with latest / Scenarios: Duplicate |
| `1-4` | Lens picker: Direct selection |
| `←→` | Detailed view: Cycle anchor / Tree: collapse/expand |
| `Tab` | Switch panes (Matrix Builder) |

### Terminal Width Handling

Ratatui `Layout` constraints handle responsive sizing:
- **Minimum 80 columns:** Single-column layout, tables scroll horizontally
- **120+ columns:** Two-pane Matrix Builder
- **160+ columns:** Generous table column widths

```rust
let chunks = if area.width >= 120 {
    Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)])
} else {
    Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)])
};
```

### Color Coding (consistent across all screens)

```rust
const COLOR_GOOD: Color = Color::Green;       // ≥80%
const COLOR_WARN: Color = Color::Yellow;      // 60-79%
const COLOR_BAD: Color = Color::Red;          // <60%
const COLOR_AGENT: Color = Color::Rgb(240, 160, 60);  // orange
const COLOR_MODEL: Color = Color::Rgb(60, 180, 240);  // blue
const COLOR_SCENARIO: Color = Color::Green;
const COLOR_ACCENT: Color = Color::Rgb(124, 108, 240); // purple
const COLOR_DIM: Color = Color::DarkGray;
```

## Migration from Current Python TUI

### What changes:
- Entire codebase rewritten from Python to Rust
- Textual framework → Ratatui
- Agent detection reimplemented (same logic: detect binaries, call `--models` etc.)
- LLM judge calls reimplemented via `reqwest` instead of Python HTTP
- Config parsing reimplemented via `serde_yaml`

### What stays:
- `litmus` command → opens TUI directly
- `litmus init` → workspace scaffolding (reimplemented)
- `config.yaml` format → backward compatible (same YAML schema)
- `template/` directory structure → unchanged (scenarios are language-agnostic files)
- `results/` directory structure → unchanged, indexed into SQLite
- Benchmark execution remains subprocess-based (`uv sync`, agent CLI, `pytest`)

### What's added:
- SQLite database for result indexing and aggregation queries
- HTML export from Compare views (via template rendering, e.g., `askama` or `tera`)
- Single static binary distribution

### What's removed:
- Python runtime dependency
- Textual framework
- All Python source in `src/litmus/`
- `pyproject.toml` (replaced by `Cargo.toml` — but kept for scenario projects that use `uv`)

### Distribution

The Rust binary compiles to a single executable:
```bash
cargo build --release
# → target/release/litmus (or litmus.exe on Windows)
```

Cross-compilation via `cross` for Linux/macOS/Windows. Can also publish to `crates.io` for `cargo install litmus`.

## Design Principles

1. **Run first, compare second** — the path to first benchmark should be 1 screen (matrix builder), not 4 steps
2. **Lenses, not modes** — comparison views are filters on accumulated data, not separate workflows
3. **Show data coverage** — always indicate how much data backs a ranking, warn when sparse
4. **Trace everything** — every score links back to specific Run(s) with version info
5. **Progressive disclosure** — dashboard → lens picker → heatmap → drill-down → logs
6. **Keyboard-first** — every action reachable via keyboard; mouse optional but supported
7. **Terminal-native** — no external dependencies (browser, server); single binary
8. **Instant** — sub-50ms startup, zero runtime dependencies for the user
