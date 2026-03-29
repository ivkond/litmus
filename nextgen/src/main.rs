use std::io;
use std::path::Path;
use std::time::Duration;

use color_eyre::Result;
use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent,
    KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::execute;
use ratatui::DefaultTerminal;

use litmus_nextgen::app::{App, RunScreenState, Screen};
use litmus_nextgen::db;

fn main() -> Result<()> {
    color_eyre::install()?;

    let db_path = Path::new("litmus.db");
    let conn = db::open_db(db_path)?;

    let mut app = App::new(conn);

    let mut terminal = ratatui::init();
    execute!(io::stdout(), EnableMouseCapture)?;

    let result = run(&mut terminal, &mut app);

    execute!(io::stdout(), DisableMouseCapture)?;
    ratatui::restore();

    result
}

fn run(terminal: &mut DefaultTerminal, app: &mut App) -> Result<()> {
    while !app.should_quit {
        terminal.draw(|frame| litmus_nextgen::ui::render(frame, app))?;

        if crossterm::event::poll(Duration::from_millis(100))? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    handle_key(app, key);
                }
                Event::Mouse(mouse) => {
                    handle_mouse(app, mouse);
                }
                _ => {}
            }
        }

        app.poll_scan();
        app.poll_progress();
    }
    Ok(())
}

fn handle_key(app: &mut App, key: KeyEvent) {
    // Delegate to compare input when on Compare screen
    if app.screen == Screen::Compare {
        litmus_nextgen::ui::compare::input::handle_compare_key(app, key);
        return;
    }

    // Delegate to scenarios screen input
    if app.screen == Screen::Scenarios {
        litmus_nextgen::ui::scenarios::input::handle_scenario_key(app, key);
        return;
    }

    // Delegate to matrix builder input when on Run screen with matrix state
    if app.screen == Screen::Run {
        // Progress view: Esc goes back to dashboard when done
        if let Some(RunScreenState::Progress(state)) = &app.run_state {
            if state.done && matches!(key.code, KeyCode::Esc) {
                app.run_state = None;
                app.switch_screen(Screen::Dashboard);
                return;
            }
        }
        if let Some(RunScreenState::MatrixBuilder(_)) = &app.run_state {
            litmus_nextgen::ui::run::matrix_input::handle_matrix_key(app, key);
            return;
        }
    }

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
        // Table navigation
        KeyCode::Up | KeyCode::Char('k') => app.scroll_table(-1),
        KeyCode::Down | KeyCode::Char('j') => app.scroll_table(1),
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

fn handle_mouse(app: &mut App, mouse: MouseEvent) {
    let col = mouse.column;
    let row = mouse.row;

    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            // Tab click (always active — checked first)
            if row == app.hit.tab_y {
                if let Some(screen) = app.tab_at_col(col) {
                    app.switch_screen(screen);
                    return;
                }
            }

            // Screen-specific mouse handling
            if app.screen == Screen::Scenarios {
                litmus_nextgen::ui::scenarios::input::handle_scenario_mouse(app, mouse);
                return;
            }

            if app.screen == Screen::Run {
                if let Some(RunScreenState::MatrixBuilder(_)) = &app.run_state {
                    litmus_nextgen::ui::run::matrix_input::handle_matrix_mouse(app, mouse);
                    return;
                }
            }

            // Dashboard table row click
            if app.hit.table_area.contains((col, row).into()) {
                app.click_table_row(row);
            }
        }
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            if app.screen == Screen::Scenarios {
                litmus_nextgen::ui::scenarios::input::handle_scenario_mouse(app, mouse);
                return;
            }
            if app.screen == Screen::Compare {
                litmus_nextgen::ui::compare::input::handle_compare_mouse(app, mouse);
                return;
            }
            if app.screen == Screen::Run {
                if let Some(RunScreenState::MatrixBuilder(_)) = &app.run_state {
                    litmus_nextgen::ui::run::matrix_input::handle_matrix_mouse(app, mouse);
                    return;
                }
            }
            if app.hit.table_area.contains((col, row).into()) {
                if matches!(mouse.kind, MouseEventKind::ScrollUp) {
                    app.scroll_table(-1);
                } else {
                    app.scroll_table(1);
                }
            }
        }
        _ => {}
    }
}
