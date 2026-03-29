# Phase 2: TUI Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a working ratatui TUI application with tab navigation and a functional Dashboard screen that displays real data from SQLite.

**Architecture:** Ratatui event loop on main thread. App state machine drives which screen renders. Tab bar at top with `Ctrl+1..5` navigation. Dashboard reads from SQLite and shows stats + recent activity. Other tabs show placeholder screens.

**Tech Stack:** `ratatui` 0.29+, `crossterm` 0.28+, `color-eyre` for panic handling. Builds on Phase 1 foundation (config, scenarios, db).

**Spec:** `docs/superpowers/specs/2026-03-26-ux-redesign-ratatui-design.md` — sections: Navigation, Dashboard

---

## File Structure

```
nextgen/src/
├── main.rs              # TUI entry point (replaces smoke test)
├── app.rs               # App struct, Screen enum, event handling
├── ui/
│   ├── mod.rs           # render() dispatcher
│   ├── styles.rs        # Color constants, shared style helpers
│   ├── tabs.rs          # Tab bar widget
│   └── dashboard.rs     # Dashboard screen rendering
```

---

### Task 1: Dependencies and App State Machine

**Files:**
- Modify: `nextgen/Cargo.toml`
- Create: `nextgen/src/app.rs`

- [ ] **Step 1: Add TUI dependencies to Cargo.toml**

Add under `[dependencies]`:
```toml
ratatui = "0.29"
crossterm = "0.28"
color-eyre = "0.6"
```

- [ ] **Step 2: Write unit tests for App state (inline in app.rs)**

- [ ] **Step 3: Implement app.rs**

```rust
use crate::db;
use crate::db::queries::{self, RecentRun, SummaryStats};
use rusqlite::Connection;

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

/// Dashboard data loaded from SQLite.
pub struct DashboardData {
    pub stats: SummaryStats,
    pub recent: Vec<RecentRun>,
}

pub struct App {
    pub screen: Screen,
    pub should_quit: bool,
    pub dashboard: Option<DashboardData>,
    db: Connection,
}

impl App {
    pub fn new(db: Connection) -> Self {
        let mut app = App {
            screen: Screen::Dashboard,
            should_quit: false,
            dashboard: None,
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
}
```

- [ ] **Step 4: Update lib.rs to include app module**

Add to `nextgen/src/lib.rs`:
```rust
pub mod app;
pub mod ui;
```

- [ ] **Step 5: Create stub ui/mod.rs**

Create `nextgen/src/ui/mod.rs`:
```rust
pub mod dashboard;
pub mod styles;
pub mod tabs;
```

Create stubs: `nextgen/src/ui/styles.rs`, `nextgen/src/ui/tabs.rs`, `nextgen/src/ui/dashboard.rs` (empty files).

- [ ] **Step 6: Run tests**

Run: `cd nextgen && cargo test app`
Expected: 4 tests PASS

- [ ] **Step 7: Commit**

```bash
git add nextgen/
git commit -m "feat(nextgen): app state machine with Screen enum and tests"
```

---

### Task 2: Color Constants and Shared Styles

**Files:**
- Modify: `nextgen/src/ui/styles.rs`

- [ ] **Step 1: Implement styles.rs**

```rust
use ratatui::style::{Color, Modifier, Style};

// Score color coding (consistent across all screens)
pub const COLOR_GOOD: Color = Color::Green;        // >=80%
pub const COLOR_WARN: Color = Color::Yellow;       // 60-79%
pub const COLOR_BAD: Color = Color::Red;           // <60%

// Entity colors
pub const COLOR_AGENT: Color = Color::Rgb(240, 160, 60);   // orange
pub const COLOR_MODEL: Color = Color::Rgb(60, 180, 240);   // blue
pub const COLOR_SCENARIO: Color = Color::Green;
pub const COLOR_ACCENT: Color = Color::Rgb(124, 108, 240); // purple
pub const COLOR_DIM: Color = Color::DarkGray;

// Reusable styles
pub fn style_tab_active() -> Style {
    Style::default()
        .fg(COLOR_ACCENT)
        .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
}

pub fn style_tab_inactive() -> Style {
    Style::default().fg(Color::White)
}

pub fn style_header() -> Style {
    Style::default()
        .fg(Color::Cyan)
        .add_modifier(Modifier::BOLD)
}

pub fn style_key_hint() -> Style {
    Style::default().fg(COLOR_ACCENT)
}

pub fn style_dim() -> Style {
    Style::default().fg(COLOR_DIM)
}

/// Return color for a score percentage.
pub fn score_color(pct: f64) -> Color {
    if pct >= 80.0 {
        COLOR_GOOD
    } else if pct >= 60.0 {
        COLOR_WARN
    } else {
        COLOR_BAD
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add nextgen/src/ui/styles.rs
git commit -m "feat(nextgen): shared color constants and style helpers"
```

---

### Task 3: Tab Bar Rendering

**Files:**
- Modify: `nextgen/src/ui/tabs.rs`

- [ ] **Step 1: Implement tabs.rs**

```rust
use ratatui::{
    layout::Rect,
    style::Modifier,
    text::Line,
    widgets::{Block, Borders, Tabs as RatatuiTabs},
    Frame,
};

use crate::app::Screen;
use super::styles;

/// Render the top tab bar.
pub fn render_tabs(frame: &mut Frame, area: Rect, active: Screen) {
    let titles: Vec<Line> = Screen::ALL
        .iter()
        .map(|s| {
            let style = if *s == active {
                styles::style_tab_active()
            } else {
                styles::style_tab_inactive()
            };
            Line::styled(s.title(), style)
        })
        .collect();

    let tabs = RatatuiTabs::new(titles)
        .block(
            Block::default()
                .title(" LITMUS ")
                .title_style(
                    styles::style_header()
                        .add_modifier(Modifier::BOLD),
                )
                .borders(Borders::BOTTOM),
        )
        .select(active.index())
        .highlight_style(styles::style_tab_active())
        .divider(" │ ");

    frame.render_widget(tabs, area);
}
```

- [ ] **Step 2: Commit**

```bash
git add nextgen/src/ui/tabs.rs
git commit -m "feat(nextgen): tab bar rendering with active highlight"
```

---

### Task 4: Dashboard Screen Rendering

**Files:**
- Modify: `nextgen/src/ui/dashboard.rs`

- [ ] **Step 1: Implement dashboard.rs**

```rust
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table},
    Frame,
};

use crate::app::{App, DashboardData};
use super::styles;

/// Render the Dashboard screen.
pub fn render_dashboard(frame: &mut Frame, area: Rect, app: &App) {
    let data = match &app.dashboard {
        Some(d) => d,
        None => {
            frame.render_widget(Paragraph::new("Loading..."), area);
            return;
        }
    };

    if data.stats.total_results == 0 {
        render_empty_state(frame, area);
    } else {
        render_populated(frame, area, data);
    }
}

fn render_empty_state(frame: &mut Frame, area: Rect) {
    let chunks = Layout::vertical([
        Constraint::Length(3),  // spacer
        Constraint::Length(3),  // welcome
        Constraint::Length(2),  // spacer
        Constraint::Length(2),  // actions
        Constraint::Length(2),  // spacer
        Constraint::Length(2),  // hint
        Constraint::Min(0),    // fill
    ])
    .split(area);

    let welcome = Paragraph::new("Welcome to Litmus")
        .style(styles::style_header());
    frame.render_widget(welcome, chunks[1]);

    let actions = Line::from(vec![
        Span::styled("[r]", styles::style_key_hint()),
        Span::raw(" New Run          "),
        Span::styled("[c]", styles::style_key_hint()),
        Span::raw(" Compare (no data yet)"),
    ]);
    frame.render_widget(Paragraph::new(actions), chunks[3]);

    let hint = Paragraph::new("No benchmark results yet. Press [r] to run your first benchmark.")
        .style(styles::style_dim());
    frame.render_widget(hint, chunks[5]);
}

fn render_populated(frame: &mut Frame, area: Rect, data: &DashboardData) {
    let chunks = Layout::vertical([
        Constraint::Length(1),  // stats line
        Constraint::Length(1),  // spacer
        Constraint::Length(2),  // actions
        Constraint::Length(1),  // spacer
        Constraint::Length(1),  // section header
        Constraint::Min(5),    // recent activity table
        Constraint::Length(1),  // footer hint
    ])
    .split(area);

    // Stats line
    let stats = &data.stats;
    let stats_line = Line::from(vec![
        Span::styled(
            format!("{}", stats.total_results),
            Style::default().fg(styles::COLOR_GOOD),
        ),
        Span::raw(" results · "),
        Span::styled(
            format!("{}", stats.unique_agents),
            Style::default().fg(styles::COLOR_AGENT),
        ),
        Span::raw(" agents · "),
        Span::styled(
            format!("{}", stats.unique_models),
            Style::default().fg(styles::COLOR_MODEL),
        ),
        Span::raw(" models · "),
        Span::styled(
            format!("{}", stats.unique_scenarios),
            Style::default().fg(styles::COLOR_SCENARIO),
        ),
        Span::raw(" scenarios"),
    ]);
    frame.render_widget(Paragraph::new(stats_line), chunks[0]);

    // Action hints
    let actions = Line::from(vec![
        Span::styled("[r]", styles::style_key_hint()),
        Span::raw(" New Run                "),
        Span::styled("[c]", styles::style_key_hint()),
        Span::raw(" Compare"),
    ]);
    frame.render_widget(Paragraph::new(actions), chunks[2]);

    // Section header
    let header = Paragraph::new("RECENT ACTIVITY")
        .style(styles::style_dim().add_modifier(Modifier::BOLD));
    frame.render_widget(header, chunks[4]);

    // Recent activity table
    if data.recent.is_empty() {
        frame.render_widget(
            Paragraph::new("No recent runs").style(styles::style_dim()),
            chunks[5],
        );
    } else {
        let header_row = Row::new(vec![
            Cell::from("Agent"),
            Cell::from("Model"),
            Cell::from("Scenarios"),
            Cell::from("Pass Rate"),
            Cell::from("Time"),
        ])
        .style(styles::style_dim().add_modifier(Modifier::BOLD))
        .bottom_margin(1);

        let rows: Vec<Row> = data
            .recent
            .iter()
            .map(|r| {
                let pass_rate = if r.tests_total > 0 {
                    format!(
                        "{}/{}",
                        r.tests_passed, r.tests_total
                    )
                } else {
                    "—".to_string()
                };
                Row::new(vec![
                    Cell::from(r.agent.as_str())
                        .style(Style::default().fg(styles::COLOR_AGENT)),
                    Cell::from(r.model.as_str())
                        .style(Style::default().fg(styles::COLOR_MODEL)),
                    Cell::from(format!("{}", r.scenarios_count)),
                    Cell::from(pass_rate),
                    Cell::from(r.timestamp.as_str())
                        .style(styles::style_dim()),
                ])
            })
            .collect();

        let table = Table::new(
            rows,
            [
                Constraint::Percentage(20),
                Constraint::Percentage(25),
                Constraint::Percentage(15),
                Constraint::Percentage(15),
                Constraint::Percentage(25),
            ],
        )
        .header(header_row)
        .block(Block::default().borders(Borders::TOP));

        frame.render_widget(table, chunks[5]);
    }

    // Footer hint
    let footer = Paragraph::new("↑↓ navigate · Enter view details")
        .style(styles::style_dim());
    frame.render_widget(footer, chunks[6]);
}
```

- [ ] **Step 2: Commit**

```bash
git add nextgen/src/ui/dashboard.rs
git commit -m "feat(nextgen): dashboard screen with empty + populated states"
```

---

### Task 5: UI Render Dispatcher and Main Entry Point

**Files:**
- Modify: `nextgen/src/ui/mod.rs`
- Modify: `nextgen/src/main.rs`

- [ ] **Step 1: Implement ui/mod.rs render dispatcher**

```rust
pub mod dashboard;
pub mod styles;
pub mod tabs;

use ratatui::{
    layout::{Constraint, Layout},
    widgets::Paragraph,
    Frame,
};

use crate::app::{App, Screen};

/// Render the entire UI.
pub fn render(frame: &mut Frame, app: &App) {
    let chunks = Layout::vertical([
        Constraint::Length(2),  // tab bar
        Constraint::Min(0),    // screen content
    ])
    .split(frame.area());

    // Tab bar
    tabs::render_tabs(frame, chunks[0], app.screen);

    // Active screen
    let content_area = chunks[1];
    match app.screen {
        Screen::Dashboard => dashboard::render_dashboard(frame, content_area, app),
        screen => {
            // Placeholder for screens not yet implemented
            let msg = format!("{} — coming in Phase 3+", screen.title());
            frame.render_widget(
                Paragraph::new(msg).style(styles::style_dim()),
                content_area,
            );
        }
    }
}
```

- [ ] **Step 2: Implement main.rs with full TUI entry point**

Replace the contents of `nextgen/src/main.rs`:

```rust
use std::path::Path;

use color_eyre::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::DefaultTerminal;

use litmus_nextgen::app::{App, Screen};
use litmus_nextgen::db;

fn main() -> Result<()> {
    color_eyre::install()?;

    // Open or create the database
    let db_path = Path::new("litmus.db");
    let conn = db::open_db(db_path)?;

    let mut app = App::new(conn);

    // Init terminal and run
    let mut terminal = ratatui::init();
    let result = run(&mut terminal, &mut app);
    ratatui::restore();

    result
}

fn run(terminal: &mut DefaultTerminal, app: &mut App) -> Result<()> {
    while !app.should_quit {
        terminal.draw(|frame| litmus_nextgen::ui::render(frame, app))?;

        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            handle_key(app, key);
        }
    }
    Ok(())
}

fn handle_key(app: &mut App, key: KeyEvent) {
    // Global keybindings
    match key.code {
        KeyCode::Char('q') => app.should_quit = true,
        KeyCode::Char('1') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.switch_screen(Screen::Dashboard);
        }
        KeyCode::Char('2') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.switch_screen(Screen::Run);
        }
        KeyCode::Char('3') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.switch_screen(Screen::Compare);
        }
        KeyCode::Char('4') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.switch_screen(Screen::Scenarios);
        }
        KeyCode::Char('5') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.switch_screen(Screen::Settings);
        }
        // Dashboard shortcuts
        KeyCode::Char('r') if app.screen == Screen::Dashboard => {
            app.switch_screen(Screen::Run);
        }
        KeyCode::Char('c') if app.screen == Screen::Dashboard => {
            app.switch_screen(Screen::Compare);
        }
        _ => {}
    }
}
```

- [ ] **Step 3: Run cargo check**

Run: `cd nextgen && cargo check`
Expected: compiles with no errors

- [ ] **Step 4: Run all tests**

Run: `cd nextgen && cargo test`
Expected: all existing tests still pass (18 + 4 new app tests = 22)

- [ ] **Step 5: Manual test — launch TUI**

Run: `cd nextgen && cargo run`
Expected: TUI launches showing Dashboard with tab bar. Press `q` to quit. Press `Ctrl+2` to switch to Run tab (shows placeholder). `Ctrl+1` back to Dashboard.

- [ ] **Step 6: Commit**

```bash
git add nextgen/
git commit -m "feat(nextgen): TUI shell with tab navigation and dashboard screen"
```

---

## Summary

After Phase 2, we have:

| Component | Status |
|-----------|--------|
| Ratatui TUI app launches | Working |
| Tab bar with 5 tabs | Working + Ctrl+1..5 navigation |
| Dashboard (empty state) | Working |
| Dashboard (with data from SQLite) | Working |
| Color scheme + shared styles | Working |
| Placeholder screens for Run/Compare/Scenarios/Settings | Working |
| App state machine | Working + 4 unit tests |
| Total tests | 22 (18 Phase 1 + 4 Phase 2) |

**Next phase:** Phase 3 — Engine (agent detection, benchmark execution, result storage)
