#[cfg(test)]
use crate::db;
use crate::db::queries::{self, RecentRun, SummaryStats};
use ratatui::layout::Rect;
use ratatui::widgets::TableState;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use uuid::Uuid;
use crate::engine::batch::ProgressEvent;

/// Convert a ScanResult into AgentSelection vec for the matrix builder.
fn scan_to_agents(scan: crate::engine::scanner::ScanResult) -> Vec<AgentSelection> {
    scan.detected
        .into_iter()
        .map(|d| AgentSelection {
            name: d.name,
            binary_path: d.path,
            cmd_template: d.cmd_template,
            expanded: false,
            models: d
                .models
                .into_iter()
                .map(|m| ModelSelection {
                    name: m,
                    selected: false,
                })
                .collect(),
        })
        .collect()
}

/// Clickable regions populated during render, consumed by event handler.
#[derive(Default)]
pub struct HitAreas {
    /// (x_start, x_end) column ranges for each tab on the tab row.
    pub tab_ranges: Vec<(u16, u16)>,
    /// The y-coordinate of the tab row.
    pub tab_y: u16,
    /// Area of the recent-activity table (for scroll hit-testing).
    pub table_area: Rect,
    /// Number of data rows in the table.
    pub table_row_count: usize,
    /// Y offset of the first data row (after header + margin).
    pub table_data_y: u16,
    /// Area of the matrix builder left pane (agents/models tree).
    pub matrix_left_area: Rect,
    /// Area of the matrix builder right pane (scenarios checklist).
    pub matrix_right_area: Rect,
    /// Y coordinate of the first tree row in the left pane (for click→cursor mapping).
    pub matrix_left_y_start: u16,
    /// Y coordinate of the first scenario row in the right pane.
    pub matrix_right_y_start: u16,
    /// Scenario screen: left pane (list) area.
    pub scenario_list_area: Rect,
    /// Scenario screen: y of first list row.
    pub scenario_list_y_start: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Dashboard,
    Run,
    Compare,
    Scenarios,
    Settings,
}

impl Screen {
    pub const ALL: [Screen; 5] = [
        Screen::Dashboard,
        Screen::Run,
        Screen::Compare,
        Screen::Scenarios,
        Screen::Settings,
    ];

    pub fn title(&self) -> &'static str {
        match self {
            Screen::Dashboard => "Dashboard",
            Screen::Run => "Run",
            Screen::Compare => "Compare",
            Screen::Scenarios => "Scenarios",
            Screen::Settings => "Settings",
        }
    }

    pub fn index(&self) -> usize {
        match self {
            Screen::Dashboard => 0,
            Screen::Run => 1,
            Screen::Compare => 2,
            Screen::Scenarios => 3,
            Screen::Settings => 4,
        }
    }
}

pub struct DashboardData {
    pub stats: SummaryStats,
    pub recent: Vec<RecentRun>,
}

// ---------------------------------------------------------------------------
// Run screen state types
// ---------------------------------------------------------------------------

/// Which pane is active in the matrix builder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    Left,
    Right,
}

/// A single model within an agent, with a selection flag.
#[derive(Debug, Clone)]
pub struct ModelSelection {
    pub name: String,
    pub selected: bool,
}

/// An agent with its list of models, displayed as a collapsible tree node.
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

    pub fn has_selection(&self) -> bool {
        self.selected_model_count() > 0
    }
}

/// A scenario with a selection flag.
#[derive(Debug, Clone)]
pub struct ScenarioSelection {
    pub id: String,
    pub name: String,
    pub selected: bool,
}

/// State for the matrix builder UI (left = agents/models, right = scenarios).
pub struct MatrixBuilderState {
    pub agents: Vec<AgentSelection>,
    pub scenarios: Vec<ScenarioSelection>,
    pub active_pane: Pane,
    pub left_cursor: usize,
    pub right_cursor: usize,
    pub left_scroll: usize,
    pub right_scroll: usize,
    /// Global filter text — filters models across all agents.
    pub filter: String,
    /// Whether the filter input field is focused (captures keypresses).
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
            left_scroll: 0,
            right_scroll: 0,
            filter: String::new(),
            filter_active: false,
            show_selected_only: false,
        }
    }

    /// Adjust scroll offset so the cursor stays within the visible viewport.
    pub fn ensure_visible(&mut self, visible_height: usize, pane: Pane) {
        let (cursor, scroll) = match pane {
            Pane::Left => (&self.left_cursor, &mut self.left_scroll),
            Pane::Right => (&self.right_cursor, &mut self.right_scroll),
        };
        if visible_height == 0 {
            return;
        }
        if *cursor < *scroll {
            *scroll = *cursor;
        } else if *cursor >= *scroll + visible_height {
            *scroll = *cursor - visible_height + 1;
        }
    }

    /// Total number of runs = selected models (across all agents) × selected scenarios.
    pub fn total_runs(&self) -> usize {
        let selected_models: usize = self.agents.iter().map(|a| a.selected_model_count()).sum();
        let selected_scenarios = self.selected_scenario_count();
        selected_models * selected_scenarios
    }

    /// Number of selected scenarios.
    pub fn selected_scenario_count(&self) -> usize {
        self.scenarios.iter().filter(|s| s.selected).count()
    }

    /// Number of rows in the left pane flattened tree:
    /// one row per visible agent header + one row per visible (expanded) model.
    /// When filtering, agents with no matching models are hidden.
    pub fn left_row_count(&self) -> usize {
        let filtering = self.is_filtering();
        self.agents
            .iter()
            .filter(|a| !filtering || self.agent_has_visible_models(a))
            .map(|a| {
                let expanded = a.expanded || filtering; // auto-expand when filtering
                1 + if expanded {
                    self.visible_models(a).count()
                } else {
                    0
                }
            })
            .sum()
    }

    /// Iterator over models for the given agent, respecting global filter and show_selected_only.
    pub fn visible_models<'a>(
        &'a self,
        agent: &'a AgentSelection,
    ) -> impl Iterator<Item = &'a ModelSelection> {
        let filter = self.filter.to_lowercase();
        let show_selected_only = self.show_selected_only;

        agent.models.iter().filter(move |m| {
            let name_match = filter.is_empty() || m.name.to_lowercase().contains(&filter);
            let sel_match = !show_selected_only || m.selected;
            name_match && sel_match
        })
    }

    /// Whether an agent has any models matching the current filter.
    pub fn agent_has_visible_models(&self, agent: &AgentSelection) -> bool {
        self.visible_models(agent).next().is_some()
    }

    /// Whether the filter is non-empty (i.e. actively filtering).
    pub fn is_filtering(&self) -> bool {
        !self.filter.is_empty()
    }
}

/// Status of a single (agent, model, scenario) cell in the progress grid.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CellStatus {
    Pending,
    Running,
    Passed,
    Failed,
}

/// State for the progress view shown while a batch run is executing.
pub struct ProgressState {
    pub total: usize,
    pub completed: usize,
    pub done: bool,
    pub run_id: Option<Uuid>,
    pub cells: HashMap<(String, String, String), CellStatus>,
    pub current: Option<String>,
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
        if self.total == 0 {
            return 0.0;
        }
        (self.completed as f64 / self.total as f64) * 100.0
    }
}

/// Scan result sent from the background scanner thread.
pub struct ScanPayload {
    pub agents: Vec<AgentSelection>,
    pub scenarios: Vec<ScenarioSelection>,
}

/// Top-level run screen state — loading, matrix builder, or progress view.
pub enum RunScreenState {
    Loading(Receiver<ScanPayload>),
    MatrixBuilder(MatrixBuilderState),
    Progress(ProgressState),
}

// ---------------------------------------------------------------------------
// Compare screen state types
// ---------------------------------------------------------------------------

/// Which view the Compare screen is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareLens {
    Leaderboard, // flat table sorted by metric
    Matrix,      // heatmap: agent×model rows, scenario columns
    Detail,      // drill-down for one agent×model pair
}

/// One row in the leaderboard / one entity in comparisons.
#[derive(Debug, Clone)]
pub struct CompareEntry {
    pub agent: String,
    pub model: String,
    pub scenarios_run: u32,
    pub tests_passed: u32,
    pub tests_total: u32,
    pub pass_rate: f64, // 0.0..1.0
    pub avg_duration_secs: f64,
    pub total_score: f64,
}

/// Per-scenario result for the matrix/detail views.
#[derive(Debug, Clone)]
pub struct ScenarioResult {
    pub scenario_id: String,
    pub tests_passed: u32,
    pub tests_total: u32,
    pub passed: bool, // all tests passed
    pub duration_secs: f64,
    pub score: f64,
}

/// Sort column for leaderboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareSort {
    PassRate,
    Score,
    Duration,
    Agent,
}

/// Full state for the Compare screen.
pub struct CompareScreenState {
    pub lens: CompareLens,
    pub entries: Vec<CompareEntry>,
    /// Matrix data: for each (agent, model) → per-scenario results
    pub matrix: Vec<(String, String, Vec<ScenarioResult>)>,
    /// All scenario IDs in stable order (columns for the matrix)
    pub scenario_ids: Vec<String>,
    /// Cursor position in the leaderboard/matrix
    pub cursor: usize,
    pub scroll: usize,
    /// Sort column for leaderboard
    pub sort_by: CompareSort,
    pub sort_desc: bool,
    /// Detail view: which entry is being inspected
    pub detail_index: Option<usize>,
}

impl CompareScreenState {
    pub fn new(
        entries: Vec<CompareEntry>,
        matrix: Vec<(String, String, Vec<ScenarioResult>)>,
        scenario_ids: Vec<String>,
    ) -> Self {
        let mut state = Self {
            lens: CompareLens::Leaderboard,
            entries,
            matrix,
            scenario_ids,
            cursor: 0,
            scroll: 0,
            sort_by: CompareSort::PassRate,
            sort_desc: true,
            detail_index: None,
        };
        state.sort_entries();
        state
    }

    /// Sort `self.entries` according to `self.sort_by` and `self.sort_desc`.
    pub fn sort_entries(&mut self) {
        let desc = self.sort_desc;
        match self.sort_by {
            CompareSort::PassRate => {
                self.entries.sort_by(|a, b| {
                    let cmp = a.pass_rate.partial_cmp(&b.pass_rate).unwrap_or(std::cmp::Ordering::Equal);
                    if desc { cmp.reverse() } else { cmp }
                });
            }
            CompareSort::Score => {
                self.entries.sort_by(|a, b| {
                    let cmp = a.total_score.partial_cmp(&b.total_score).unwrap_or(std::cmp::Ordering::Equal);
                    if desc { cmp.reverse() } else { cmp }
                });
            }
            CompareSort::Duration => {
                self.entries.sort_by(|a, b| {
                    let cmp = a.avg_duration_secs.partial_cmp(&b.avg_duration_secs).unwrap_or(std::cmp::Ordering::Equal);
                    if desc { cmp.reverse() } else { cmp }
                });
            }
            CompareSort::Agent => {
                self.entries.sort_by(|a, b| {
                    let cmp = a.agent.cmp(&b.agent).then_with(|| a.model.cmp(&b.model));
                    if desc { cmp.reverse() } else { cmp }
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Scenario screen state types
// ---------------------------------------------------------------------------

/// Inline prompt shown for confirm/input operations.
#[derive(Debug, Clone)]
pub enum ScenarioPrompt {
    /// Confirm delete: "Delete scenario X?"
    ConfirmDelete(String),
    /// Text input for new scenario ID or duplicate ID
    Input { label: String, text: String, action: ScenarioPromptAction },
    /// Path input for import file
    ImportPath(String),
    /// Status message (shown briefly)
    Status(String),
}

#[derive(Debug, Clone)]
pub enum ScenarioPromptAction {
    Create,
    Duplicate(String), // source ID
}

pub struct ScenarioScreenState {
    pub scenarios: Vec<crate::model::Scenario>,
    pub cursor: usize,
    pub scroll: usize,
    /// Active inline prompt (overrides normal input)
    pub prompt: Option<ScenarioPrompt>,
    /// Template directory path
    pub template_dir: PathBuf,
}

impl ScenarioScreenState {
    pub fn new(template_dir: PathBuf) -> Self {
        let scenarios = crate::scenario::load_scenarios(&template_dir).unwrap_or_default();
        Self {
            scenarios,
            cursor: 0,
            scroll: 0,
            prompt: None,
            template_dir,
        }
    }

    pub fn reload(&mut self) {
        self.scenarios = crate::scenario::load_scenarios(&self.template_dir).unwrap_or_default();
        if self.cursor >= self.scenarios.len() && !self.scenarios.is_empty() {
            self.cursor = self.scenarios.len() - 1;
        }
    }

    pub fn selected(&self) -> Option<&crate::model::Scenario> {
        self.scenarios.get(self.cursor)
    }

    pub fn ensure_visible(&mut self, visible_height: usize) {
        if visible_height == 0 {
            return;
        }
        if self.cursor < self.scroll {
            self.scroll = self.cursor;
        } else if self.cursor >= self.scroll + visible_height {
            self.scroll = self.cursor - visible_height + 1;
        }
    }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

pub struct App {
    pub screen: Screen,
    pub should_quit: bool,
    pub dashboard: Option<DashboardData>,
    pub table_state: TableState,
    pub hit: HitAreas,
    pub run_state: Option<RunScreenState>,
    pub compare_state: Option<CompareScreenState>,
    pub scenario_state: Option<ScenarioScreenState>,
    db: Connection,
}

impl App {
    pub fn new(db: Connection) -> Self {
        let mut app = App {
            screen: Screen::Dashboard,
            should_quit: false,
            dashboard: None,
            table_state: TableState::default(),
            hit: HitAreas::default(),
            run_state: None,
            compare_state: None,
            scenario_state: None,
            db,
        };
        app.refresh_dashboard();
        app
    }

    pub fn switch_screen(&mut self, screen: Screen) {
        self.screen = screen;
        if screen == Screen::Dashboard {
            self.refresh_dashboard();
        }
        if screen == Screen::Run && self.run_state.is_none() {
            self.init_matrix_builder();
        }
        if screen == Screen::Compare {
            self.init_compare();
        }
        if screen == Screen::Scenarios && self.scenario_state.is_none() {
            self.scenario_state = Some(ScenarioScreenState::new(PathBuf::from("template")));
        }
        self.table_state.select(None);
    }

    /// Load Compare screen data from the database and populate `compare_state`.
    pub fn init_compare(&mut self) {
        let entries = queries::compare_entries(&self.db).unwrap_or_default();
        let (matrix, scenario_ids) = queries::compare_matrix(&self.db).unwrap_or_default();
        self.compare_state = Some(CompareScreenState::new(entries, matrix, scenario_ids));
    }

    /// Kick off agent scanning. Uses cache if fresh; falls back to background scan.
    pub fn init_matrix_builder(&mut self) {
        self.init_matrix_builder_inner(false);
    }

    /// Force-refresh: ignore cache, rescan agents from scratch.
    pub fn refresh_agents(&mut self) {
        self.init_matrix_builder_inner(true);
    }

    fn init_matrix_builder_inner(&mut self, force_refresh: bool) {
        // Try cache first (unless forcing refresh)
        let cached = if force_refresh {
            None
        } else {
            crate::engine::scanner::load_cached()
        };

        let scenarios: Vec<ScenarioSelection> =
            crate::scenario::load_scenarios(std::path::Path::new("template"))
                .unwrap_or_default()
                .into_iter()
                .map(|s| ScenarioSelection {
                    id: s.id.clone(),
                    name: s.id,
                    selected: true,
                })
                .collect();

        if let Some(scan) = cached {
            // Instant — use cached data, no loading screen
            let agents = scan_to_agents(scan);
            self.run_state = Some(RunScreenState::MatrixBuilder(
                MatrixBuilderState::new(agents, scenarios),
            ));
            return;
        }

        // No cache or stale — scan in background thread
        let (tx, rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            let scan = crate::engine::scanner::scan_agents_fresh();
            let agents = scan_to_agents(scan);
            let _ = tx.send(ScanPayload { agents, scenarios });
        });

        self.run_state = Some(RunScreenState::Loading(rx));
    }

    /// Check if the background scan has finished; if so, transition to MatrixBuilder.
    pub fn poll_scan(&mut self) {
        let ready = match &self.run_state {
            Some(RunScreenState::Loading(rx)) => rx.try_recv().ok(),
            _ => None,
        };
        if let Some(payload) = ready {
            self.run_state = Some(RunScreenState::MatrixBuilder(
                MatrixBuilderState::new(payload.agents, payload.scenarios),
            ));
        }
    }

    pub fn refresh_dashboard(&mut self) {
        let stats = queries::summary_stats(&self.db).unwrap_or(SummaryStats {
            total_results: 0,
            unique_agents: 0,
            unique_models: 0,
            unique_scenarios: 0,
        });
        let recent = queries::recent_runs(&self.db, 10).unwrap_or_default();
        self.dashboard = Some(DashboardData { stats, recent });
    }

    /// Which tab was clicked given terminal column position on the tab row?
    pub fn tab_at_col(&self, col: u16) -> Option<Screen> {
        for (i, &(x_start, x_end)) in self.hit.tab_ranges.iter().enumerate() {
            if col >= x_start && col < x_end {
                return Screen::ALL.get(i).copied();
            }
        }
        None
    }

    /// Select a table row by click position (terminal row coordinate).
    pub fn click_table_row(&mut self, term_row: u16) {
        if self.hit.table_row_count == 0 {
            return;
        }
        let data_y = self.hit.table_data_y;
        if term_row >= data_y {
            let row_idx = (term_row - data_y) as usize;
            if row_idx < self.hit.table_row_count {
                self.table_state.select(Some(row_idx));
            }
        }
    }

    /// Poll progress events from the batch runner channel (non-blocking).
    pub fn poll_progress(&mut self) {
        if let Some(RunScreenState::Progress(ref mut state)) = self.run_state {
            if let Some(ref rx) = state.rx {
                while let Ok(event) = rx.try_recv() {
                    match event {
                        crate::engine::batch::ProgressEvent::ScenarioStarted { agent, model, scenario_id } => {
                            state.cells.insert(
                                (agent.clone(), model.clone(), scenario_id.clone()),
                                CellStatus::Running,
                            );
                            state.current = Some(format!("{} × {} × {}", agent, model, scenario_id));
                        }
                        crate::engine::batch::ProgressEvent::ScenarioFinished { agent, model, scenario_id, result } => {
                            let status = if result.passed { CellStatus::Passed } else { CellStatus::Failed };
                            state.cells.insert((agent, model, scenario_id), status);
                            state.completed += 1;
                        }
                        crate::engine::batch::ProgressEvent::AllDone { run_id } => {
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

    pub fn start_run(&mut self) {
        // Extract matrix state (take ownership)
        let matrix = match self.run_state.take() {
            Some(RunScreenState::MatrixBuilder(m)) => m,
            other => {
                self.run_state = other; // put it back
                return;
            }
        };

        let tasks = build_batch_tasks(&matrix);
        if tasks.is_empty() {
            // Nothing to run, put matrix back
            self.run_state = Some(RunScreenState::MatrixBuilder(matrix));
            return;
        }

        let total = tasks.len();
        let session = match crate::engine::session::create_session(
            std::path::Path::new("results"),
        ) {
            Ok(s) => s,
            Err(_) => {
                self.run_state = Some(RunScreenState::MatrixBuilder(matrix));
                return;
            }
        };

        // Save run config for reproducibility
        let config = crate::engine::session::RunConfig {
            agents: matrix.agents.iter()
                .filter(|a| a.has_selection())
                .map(|a| crate::engine::session::RunAgentConfig {
                    name: a.name.clone(),
                    cmd_template: a.cmd_template.clone(),
                    models: a.models.iter().filter(|m| m.selected).map(|m| m.name.clone()).collect(),
                })
                .collect(),
            scenarios: matrix.scenarios.iter().filter(|s| s.selected).map(|s| s.id.clone()).collect(),
        };
        let _ = crate::engine::session::save_run_config(&session.path, &config);

        let (tx, rx) = std::sync::mpsc::channel();
        let run_id = crate::engine::batch::run_batch(tasks, &session.path, tx);

        let mut progress = ProgressState::new(total);
        progress.run_id = Some(run_id);
        progress.rx = Some(rx);
        progress.session_dir = Some(session.path);

        self.run_state = Some(RunScreenState::Progress(progress));
    }

    /// Scroll the table selection up/down by delta rows.
    pub fn scroll_table(&mut self, delta: i32) {
        if self.hit.table_row_count == 0 {
            return;
        }
        let max = self.hit.table_row_count.saturating_sub(1);
        let current = self.table_state.selected().unwrap_or(0);
        let next = if delta < 0 {
            current.saturating_sub(delta.unsigned_abs() as usize)
        } else {
            (current + delta as usize).min(max)
        };
        self.table_state.select(Some(next));
    }
}

fn build_batch_tasks(matrix: &MatrixBuilderState) -> Vec<crate::engine::batch::BatchTask> {
    let selected_scenarios: Vec<_> = matrix.scenarios.iter()
        .filter(|s| s.selected)
        .collect();

    let mut tasks = Vec::new();
    for agent in &matrix.agents {
        for model in &agent.models {
            if !model.selected { continue; }
            for scenario in &selected_scenarios {
                // Read prompt from template dir
                let template_dir = std::path::PathBuf::from("template").join(&scenario.id);
                let prompt = std::fs::read_to_string(template_dir.join("prompt.txt"))
                    .unwrap_or_default();

                tasks.push(crate::engine::batch::BatchTask {
                    agent_name: agent.name.clone(),
                    binary_path: agent.binary_path.clone(),
                    cmd_template: agent.cmd_template.clone(),
                    model: model.name.clone(),
                    scenario_id: scenario.id.clone(),
                    prompt,
                    template_dir,
                });
            }
        }
    }
    tasks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_screen_titles() {
        assert_eq!(Screen::Dashboard.title(), "Dashboard");
        assert_eq!(Screen::Run.title(), "Run");
        assert_eq!(Screen::Compare.title(), "Compare");
        assert_eq!(Screen::Scenarios.title(), "Scenarios");
        assert_eq!(Screen::Settings.title(), "Settings");
    }

    #[test]
    fn test_screen_indices() {
        for (i, screen) in Screen::ALL.iter().enumerate() {
            assert_eq!(screen.index(), i);
        }
    }

    #[test]
    fn test_app_new_starts_on_dashboard() {
        let conn = db::open_memory_db().unwrap();
        let app = App::new(conn);
        assert_eq!(app.screen, Screen::Dashboard);
        assert!(!app.should_quit);
        assert!(app.dashboard.is_some());
    }

    #[test]
    fn test_switch_screen() {
        let conn = db::open_memory_db().unwrap();
        let mut app = App::new(conn);
        app.switch_screen(Screen::Run);
        assert_eq!(app.screen, Screen::Run);
        app.switch_screen(Screen::Compare);
        assert_eq!(app.screen, Screen::Compare);
    }

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
        assert_eq!(state.total_runs(), 0);
    }

    #[test]
    fn test_matrix_builder_total_runs() {
        let state = MatrixBuilderState::new(
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
        assert_eq!(state.agents[0].selected_model_count(), 2);
        assert_eq!(state.agents[0].total_model_count(), 3);
    }

    #[test]
    fn test_progress_state_initial() {
        let state = ProgressState::new(10);
        assert_eq!(state.total, 10);
        assert_eq!(state.completed, 0);
        assert!(!state.done);
        assert!((state.progress_pct() - 0.0).abs() < f64::EPSILON);
    }
}
