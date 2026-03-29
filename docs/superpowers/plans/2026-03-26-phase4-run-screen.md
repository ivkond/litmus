# Phase 4: Run Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Run screen with two sub-views: Matrix Builder (select agents×models×scenarios) and Progress View (live execution tracking). Connect to the Phase 3 engine for actual benchmark execution.

**Architecture:** The Run screen is a state machine: `MatrixBuilder` → user presses Enter → `Progress`. Matrix Builder has two panes (left: agent/model tree, right: scenarios) with keyboard+mouse navigation. Progress View polls `mpsc::Receiver<ProgressEvent>` in the event loop to update a live status table and gauge. State lives in `app.rs` as `RunScreenState` enum.

**Tech Stack:** ratatui widgets (Gauge, Table, List, Block), crossterm events, `std::sync::mpsc` for progress channel. No new crate dependencies.

---

## File Structure

```
nextgen/src/
├── app.rs                    # Modify: add RunScreenState, MatrixBuilderState, ProgressState
├── ui/
│   ├── mod.rs                # Modify: dispatch to run screen
│   ├── run/
│   │   ├── mod.rs            # Run screen dispatcher (matrix vs progress)
│   │   ├── matrix.rs         # Matrix Builder rendering
│   │   ├── matrix_input.rs   # Matrix Builder keyboard/mouse handling
│   │   └── progress.rs       # Progress View rendering
│   └── ...existing...
├── main.rs                   # Modify: event loop polls progress channel, delegates run input
```

---

### Task 1: Run Screen State Types

**Files:**
- Modify: `src/app.rs`
- Test: inline `#[cfg(test)]` additions in `app.rs`

Add state types for the Run screen. The Matrix Builder needs: per-agent selections (expanded, models with selected flags), per-scenario selections, active pane, cursor positions, filter text. Progress needs: completion tracking per agent×model×scenario cell.

- [ ] **Step 1: Write failing tests**

Add to `src/app.rs` tests:
```rust
#[test]
fn test_matrix_builder_initial_state() {
    let state = MatrixBuilderState::new(
        vec![AgentSelection {
            name: "TestAgent".into(),
            binary_path: "/bin/test".into(),
            cmd_template: "test {model} {message}".into(),
            expanded: false,
            models: vec![
                ModelSelection { name: "m1".into(), selected: false },
                ModelSelection { name: "m2".into(), selected: false },
            ],
        }],
        vec![ScenarioSelection { id: "s1".into(), name: "Scenario 1".into(), selected: true }],
    );
    assert_eq!(state.agents.len(), 1);
    assert_eq!(state.scenarios.len(), 1);
    assert_eq!(state.active_pane, Pane::Left);
    assert_eq!(state.total_runs(), 0); // no models selected
}

#[test]
fn test_matrix_builder_total_runs() {
    let mut state = MatrixBuilderState::new(
        vec![AgentSelection {
            name: "A".into(),
            binary_path: "/bin/a".into(),
            cmd_template: "a {model} {message}".into(),
            expanded: false,
            models: vec![
                ModelSelection { name: "m1".into(), selected: true },
                ModelSelection { name: "m2".into(), selected: true },
            ],
        }],
        vec![
            ScenarioSelection { id: "s1".into(), name: "S1".into(), selected: true },
            ScenarioSelection { id: "s2".into(), name: "S2".into(), selected: true },
            ScenarioSelection { id: "s3".into(), name: "S3".into(), selected: false },
        ],
    );
    // 1 agent with 2 models selected × 2 scenarios selected = 4 runs
    assert_eq!(state.total_runs(), 4);
}

#[test]
fn test_matrix_builder_selected_counts() {
    let state = MatrixBuilderState::new(
        vec![AgentSelection {
            name: "A".into(),
            binary_path: "/bin/a".into(),
            cmd_template: "a {model} {message}".into(),
            expanded: false,
            models: vec![
                ModelSelection { name: "m1".into(), selected: true },
                ModelSelection { name: "m2".into(), selected: false },
                ModelSelection { name: "m3".into(), selected: true },
            ],
        }],
        vec![],
    );
    let agent = &state.agents[0];
    assert_eq!(agent.selected_model_count(), 2);
    assert_eq!(agent.total_model_count(), 3);
}

#[test]
fn test_progress_state_initial() {
    let state = ProgressState::new(10);
    assert_eq!(state.total, 10);
    assert_eq!(state.completed, 0);
    assert!(!state.done);
}
```

- [ ] **Step 2: Implement state types**

Add to `src/app.rs` (above the existing `App` struct):

```rust
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use uuid::Uuid;
use crate::engine::batch::ProgressEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    Left,
    Right,
}

#[derive(Debug, Clone)]
pub struct ModelSelection {
    pub name: String,
    pub selected: bool,
}

#[derive(Debug, Clone)]
pub struct AgentSelection {
    pub name: String,
    pub binary_path: String,
    pub cmd_template: String,
    pub expanded: bool,
    pub models: Vec<ModelSelection>,
}

impl AgentSelection {
    pub fn selected_model_count(&self) -> usize {
        self.models.iter().filter(|m| m.selected).count()
    }

    pub fn total_model_count(&self) -> usize {
        self.models.len()
    }

    /// Does this agent have at least one model selected?
    pub fn has_selection(&self) -> bool {
        self.models.iter().any(|m| m.selected)
    }
}

#[derive(Debug, Clone)]
pub struct ScenarioSelection {
    pub id: String,
    pub name: String,
    pub selected: bool,
}

pub struct MatrixBuilderState {
    pub agents: Vec<AgentSelection>,
    pub scenarios: Vec<ScenarioSelection>,
    pub active_pane: Pane,
    pub left_cursor: usize,
    pub right_cursor: usize,
    pub filter_text: HashMap<String, String>,
    pub filter_active: bool,
    pub show_selected_only: bool,
}

impl MatrixBuilderState {
    pub fn new(agents: Vec<AgentSelection>, scenarios: Vec<ScenarioSelection>) -> Self {
        Self {
            agents,
            scenarios,
            active_pane: Pane::Left,
            left_cursor: 0,
            right_cursor: 0,
            filter_text: HashMap::new(),
            filter_active: false,
            show_selected_only: false,
        }
    }

    /// Total number of runs = agents_with_selected_models × selected_models × selected_scenarios.
    pub fn total_runs(&self) -> usize {
        let selected_models: usize = self.agents.iter()
            .map(|a| a.selected_model_count())
            .sum();
        let selected_scenarios = self.scenarios.iter().filter(|s| s.selected).count();
        selected_models * selected_scenarios
    }

    pub fn selected_scenario_count(&self) -> usize {
        self.scenarios.iter().filter(|s| s.selected).count()
    }

    /// Flattened row count for the left pane tree.
    pub fn left_row_count(&self) -> usize {
        let mut count = 0;
        for agent in &self.agents {
            count += 1; // agent header row
            if agent.expanded {
                count += self.visible_models(agent).count();
            }
        }
        count
    }

    /// Models visible for an agent (respecting filter and show_selected_only).
    pub fn visible_models<'a>(&'a self, agent: &'a AgentSelection) -> impl Iterator<Item = &'a ModelSelection> {
        let filter = self.filter_text.get(&agent.name).cloned().unwrap_or_default();
        let filter_lower = filter.to_lowercase();
        let show_selected = self.show_selected_only;
        agent.models.iter().filter(move |m| {
            if show_selected && !m.selected {
                return false;
            }
            if !filter_lower.is_empty() {
                return m.name.to_lowercase().contains(&filter_lower);
            }
            true
        })
    }
}

/// Cell status in the progress matrix.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CellStatus {
    Pending,
    Running,
    Passed,
    Failed,
}

pub struct ProgressState {
    pub total: usize,
    pub completed: usize,
    pub done: bool,
    pub run_id: Option<Uuid>,
    /// Status of each (agent, model, scenario) cell.
    pub cells: HashMap<(String, String, String), CellStatus>,
    /// Currently running scenario description.
    pub current: Option<String>,
    /// Progress event receiver (not clonable, moved in).
    pub rx: Option<Receiver<ProgressEvent>>,
    pub session_dir: Option<PathBuf>,
}

impl ProgressState {
    pub fn new(total: usize) -> Self {
        Self {
            total,
            completed: 0,
            done: false,
            run_id: None,
            cells: HashMap::new(),
            current: None,
            rx: None,
            session_dir: None,
        }
    }

    pub fn progress_pct(&self) -> f64 {
        if self.total == 0 { return 0.0; }
        (self.completed as f64 / self.total as f64) * 100.0
    }
}

pub enum RunScreenState {
    MatrixBuilder(MatrixBuilderState),
    Progress(ProgressState),
}
```

Then add `run_state: Option<RunScreenState>` to the `App` struct, initialized to `None`. Populate it when switching to the Run screen.

- [ ] **Step 3: Run tests, verify pass**

Run: `cargo test --lib app`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(run): state types for Matrix Builder and Progress view"
```

---

### Task 2: Matrix Builder Rendering

**Files:**
- Create: `src/ui/run/mod.rs`
- Create: `src/ui/run/matrix.rs`
- Modify: `src/ui/mod.rs` (add `pub mod run;`, dispatch to run screen)
- Test: visual inspection (rendering tests are impractical for TUI)

Render the two-pane Matrix Builder: left pane shows agent/model tree with checkboxes, right pane shows scenarios, bottom bar shows run summary.

- [ ] **Step 1: Create `src/ui/run/mod.rs`**

```rust
pub mod matrix;
pub mod progress;

use ratatui::Frame;
use ratatui::layout::Rect;

use crate::app::{App, RunScreenState};

pub fn render_run(frame: &mut Frame, area: Rect, app: &mut App) {
    match &app.run_state {
        Some(RunScreenState::MatrixBuilder(_)) => matrix::render_matrix(frame, area, app),
        Some(RunScreenState::Progress(_)) => progress::render_progress(frame, area, app),
        None => {
            // Initialize matrix builder on first visit
            app.init_matrix_builder();
            matrix::render_matrix(frame, area, app);
        }
    }
}
```

- [ ] **Step 2: Create `src/ui/run/matrix.rs`**

Layout: vertical split into [content area, summary bar]. Content area: horizontal split into [left pane (60%), right pane (40%)].

**Left pane** renders a flattened tree:
- Agent header: `▼ ✓ AgentName    3/312 models` (or `▶` if collapsed, `✓` if any selected)
- If expanded: filter line + model rows with checkboxes
- Active item highlighted with cursor marker `>`

**Right pane** renders scenario list:
- Each row: `[✓] scenario_name` or `[ ] scenario_name`
- Active item highlighted

**Bottom bar**: `Ready: X agents × Y models × Z scenarios = N runs   [Enter] Start`

Key implementation details:
- Use `Paragraph` with styled `Line`/`Span` for each row (not `List` widget — we need per-character styling control)
- Active pane border uses `COLOR_ACCENT`, inactive uses `COLOR_BORDER`
- Cursor row gets `COLOR_SURFACE_RAISED` background

- [ ] **Step 3: Update `src/ui/mod.rs` to dispatch Run screen**

Add `pub mod run;` and change the match arm:
```rust
Screen::Run => run::render_run(frame, content_area, app),
```

- [ ] **Step 4: Add `init_matrix_builder` to App**

In `app.rs`, add method that creates `MatrixBuilderState` from detected agents and loaded scenarios. For now, use a stub that scans agents on first call:

```rust
pub fn init_matrix_builder(&mut self) {
    let scan = crate::engine::scanner::scan_agents();
    let agents: Vec<AgentSelection> = scan.detected.into_iter().map(|d| {
        AgentSelection {
            name: d.name,
            binary_path: d.path,
            cmd_template: d.cmd_template,
            expanded: false,
            models: d.models.into_iter().map(|m| ModelSelection {
                name: m,
                selected: false,
            }).collect(),
        }
    }).collect();

    let scenarios = crate::scenario::load_scenarios(std::path::Path::new("template"))
        .unwrap_or_default()
        .into_iter()
        .map(|s| ScenarioSelection {
            id: s.id.clone(),
            name: s.id,
            selected: true,
        })
        .collect();

    self.run_state = Some(RunScreenState::MatrixBuilder(
        MatrixBuilderState::new(agents, scenarios),
    ));
}
```

- [ ] **Step 5: Build and verify**

Run: `cargo check`
Expected: compiles without errors.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(run): Matrix Builder two-pane rendering"
```

---

### Task 3: Matrix Builder Input Handling

**Files:**
- Create: `src/ui/run/matrix_input.rs`
- Modify: `src/main.rs` (delegate key/mouse events to run screen handler)

Implement all keyboard and mouse interactions for the Matrix Builder.

- [ ] **Step 1: Create `src/ui/run/matrix_input.rs`**

```rust
pub fn handle_matrix_key(app: &mut App, key: KeyEvent) { ... }
pub fn handle_matrix_mouse(app: &mut App, mouse: MouseEvent) { ... }
```

**Keyboard bindings:**
- `↑/↓` or `j/k` — move cursor in active pane
- `Space` — toggle selection (model or scenario)
- `Tab` — switch active pane (Left ↔ Right)
- `←/→` — collapse/expand agent (left pane only)
- `Enter` — start run (if total_runs > 0)
- `a` — select/deselect all scenarios (right pane)
- `/` — activate filter input for current agent (left pane)
- `f` — toggle show_selected_only
- `Esc` — deactivate filter input, or go back to Dashboard

**Left pane cursor logic:** The tree is flattened — cursor index maps to agent headers and model rows. Need a helper `resolve_left_cursor(state, index) -> LeftItem` that returns which agent/model the cursor is on.

```rust
enum LeftItem {
    AgentHeader(usize),           // agent index
    ModelRow(usize, usize),       // agent index, visible model index
}
```

**Filter input:** When `filter_active` is true, printable key characters are appended to the filter text for the expanded agent. Backspace removes. Esc exits filter mode.

**Starting a run:** Build `Vec<BatchTask>` from selected agents×models×scenarios, create session dir, call `engine::batch::run_batch()`, switch to `RunScreenState::Progress`.

- [ ] **Step 2: Wire up in `src/main.rs`**

Modify `handle_key` to delegate to the run screen handler when `app.screen == Screen::Run`:
```rust
KeyCode::... if app.screen == Screen::Run => {
    matrix_input::handle_matrix_key(app, key);
}
```

Similarly for mouse events.

- [ ] **Step 3: Build and test manually**

Run: `cargo check`
Then `cargo run` — navigate to Run tab, verify:
- Agents/models appear (from scan)
- Arrow keys move cursor
- Space toggles
- Tab switches panes
- Enter starts run (creates session dir)

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(run): Matrix Builder keyboard and mouse input handling"
```

---

### Task 4: Progress View Rendering

**Files:**
- Create: `src/ui/run/progress.rs`
- Modify: `src/main.rs` (poll progress channel in event loop)

Render the live progress view: gauge at top, agent×model status table, current task line.

- [ ] **Step 1: Create `src/ui/run/progress.rs`**

Layout: vertical [gauge (2 lines), spacer (1), status table (Min), current task (1), footer (1)].

**Gauge:** `LineGauge` or `Gauge` showing `completed/total` with percentage. Color: accent when running, good when done.

**Status table:** Rows = agents, columns = models. Each cell shows:
- `—` (pending, dim)
- `●` (running, accent/yellow)
- `✓ X/Y` (passed, good color)
- `✗ X/Y` (failed, bad color)

**Current task line:** `NOW: AgentName × ModelName × ScenarioId    Xs ●`

**Footer:** `Ctrl+C cancel`

- [ ] **Step 2: Poll progress channel in event loop**

In `main.rs`, change the event loop to use `crossterm::event::poll` with a 100ms timeout instead of blocking `event::read()`. After processing input events, drain the progress channel:

```rust
while !app.should_quit {
    terminal.draw(|frame| litmus_nextgen::ui::render(frame, app))?;

    if crossterm::event::poll(Duration::from_millis(100))? {
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press => handle_key(app, key),
            Event::Mouse(mouse) => handle_mouse(app, mouse),
            _ => {}
        }
    }

    // Drain progress events
    app.poll_progress();
}
```

Add `poll_progress()` to App:
```rust
pub fn poll_progress(&mut self) {
    if let Some(RunScreenState::Progress(ref mut state)) = self.run_state {
        if let Some(ref rx) = state.rx {
            while let Ok(event) = rx.try_recv() {
                match event {
                    ProgressEvent::ScenarioStarted { agent, model, scenario_id } => {
                        state.cells.insert(
                            (agent.clone(), model.clone(), scenario_id.clone()),
                            CellStatus::Running,
                        );
                        state.current = Some(format!("{} × {} × {}", agent, model, scenario_id));
                    }
                    ProgressEvent::ScenarioFinished { agent, model, scenario_id, result } => {
                        let status = if result.passed { CellStatus::Passed } else { CellStatus::Failed };
                        state.cells.insert((agent, model, scenario_id), status);
                        state.completed += 1;
                    }
                    ProgressEvent::AllDone { run_id } => {
                        state.done = true;
                        state.run_id = Some(run_id);
                        state.current = None;
                    }
                    _ => {}
                }
            }
        }
    }
}
```

- [ ] **Step 3: Build and test manually**

Run: `cargo check`, then `cargo run`. Select agents+models+scenarios, press Enter, verify progress view updates live.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(run): Progress view with live gauge and status table"
```

---

### Task 5: Integration and Polish

**Files:**
- Modify: `src/app.rs` (start_run method)
- Modify: `src/main.rs` (Esc handling from progress to dashboard)
- Modify: `src/ui/run/matrix.rs` (mouse hit areas for checkboxes)

Wire everything together: starting a run creates a session, builds batch tasks, launches the batch runner, switches to Progress view. When done, Esc returns to Dashboard.

- [ ] **Step 1: Implement `start_run` in App**

```rust
pub fn start_run(&mut self) {
    let matrix = match &self.run_state {
        Some(RunScreenState::MatrixBuilder(m)) => m,
        _ => return,
    };

    let tasks = build_batch_tasks(matrix);
    if tasks.is_empty() { return; }

    let total = tasks.len();
    let session = crate::engine::session::create_session(
        std::path::Path::new("results"),
    ).expect("failed to create session");

    let (tx, rx) = std::sync::mpsc::channel();
    let run_id = crate::engine::batch::run_batch(tasks, &session.path, tx);

    let mut progress = ProgressState::new(total);
    progress.run_id = Some(run_id);
    progress.rx = Some(rx);
    progress.session_dir = Some(session.path);

    self.run_state = Some(RunScreenState::Progress(progress));
}
```

With helper:
```rust
fn build_batch_tasks(matrix: &MatrixBuilderState) -> Vec<crate::engine::batch::BatchTask> {
    let mut tasks = Vec::new();
    let selected_scenarios: Vec<_> = matrix.scenarios.iter()
        .filter(|s| s.selected)
        .collect();

    for agent in &matrix.agents {
        for model in &agent.models {
            if !model.selected { continue; }
            for scenario in &selected_scenarios {
                tasks.push(crate::engine::batch::BatchTask {
                    agent_name: agent.name.clone(),
                    binary_path: agent.binary_path.clone(),
                    cmd_template: agent.cmd_template.clone(),
                    model: model.name.clone(),
                    scenario_id: scenario.id.clone(),
                    prompt: String::new(), // loaded at runtime by runner
                    template_dir: std::path::PathBuf::from("template").join(&scenario.id),
                });
            }
        }
    }
    tasks
}
```

- [ ] **Step 2: Handle Esc from Progress**

When progress is done and user presses Esc: store results to DB, switch back to Dashboard.

- [ ] **Step 3: Load scenario prompts**

The `prompt` field in `BatchTask` needs to be populated. Modify `build_batch_tasks` to read `template/<id>/prompt.txt`.

- [ ] **Step 4: Final build and test**

Run: `cargo check`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(run): wire Matrix Builder → batch engine → Progress view"
```

---

## Deferred

- **Model filter text input** — visual cursor, per-agent filter. Functional but basic in Phase 4; polish in Phase 6.
- **DB writes after run** — store `RunResult` records after each scenario finishes. Phase 4 tracks progress; DB persistence in Phase 4b or Phase 5.
- **Cancel running batch** — requires cancellation token threaded through. Phase 6 polish.
