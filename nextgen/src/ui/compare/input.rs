use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};

use crate::app::{App, CompareLens, CompareSort, Screen};

pub fn handle_compare_key(app: &mut App, key: KeyEvent) {
    let Some(ref state) = app.compare_state else {
        return;
    };
    let lens = state.lens;

    match key.code {
        // Switch lenses
        KeyCode::Char('1') => {
            if let Some(ref mut state) = app.compare_state {
                state.lens = CompareLens::Leaderboard;
                state.cursor = 0;
                state.scroll = 0;
            }
            return;
        }
        KeyCode::Char('2') => {
            if let Some(ref mut state) = app.compare_state {
                state.lens = CompareLens::Matrix;
                state.cursor = 0;
                state.scroll = 0;
            }
            return;
        }
        KeyCode::Esc => {
            match lens {
                CompareLens::Detail => {
                    // Back to leaderboard; restore cursor to the detail row
                    if let Some(ref mut state) = app.compare_state {
                        if let Some(idx) = state.detail_index {
                            state.cursor = idx;
                        }
                        state.lens = CompareLens::Leaderboard;
                        state.detail_index = None;
                    }
                }
                _ => {
                    // Back to Dashboard
                    app.switch_screen(Screen::Dashboard);
                }
            }
            return;
        }
        _ => {}
    }

    // Lens-specific handling
    match lens {
        CompareLens::Detail => {
            // Esc already handled above; no other nav for now
        }
        CompareLens::Leaderboard => {
            handle_leaderboard_key(app, key);
        }
        CompareLens::Matrix => {
            handle_matrix_key(app, key);
        }
    }
}

fn handle_leaderboard_key(app: &mut App, key: KeyEvent) {
    let row_count = app
        .compare_state
        .as_ref()
        .map(|s| s.entries.len())
        .unwrap_or(0);

    match key.code {
        KeyCode::Up | KeyCode::Char('k') => {
            move_cursor(app, -1, row_count);
        }
        KeyCode::Down | KeyCode::Char('j') => {
            move_cursor(app, 1, row_count);
        }
        KeyCode::Enter => {
            open_detail(app);
        }
        KeyCode::Char('s') => {
            if let Some(ref mut state) = app.compare_state {
                state.sort_by = match state.sort_by {
                    CompareSort::PassRate => CompareSort::Score,
                    CompareSort::Score => CompareSort::Duration,
                    CompareSort::Duration => CompareSort::Agent,
                    CompareSort::Agent => CompareSort::PassRate,
                };
                state.cursor = 0;
                state.scroll = 0;
                state.sort_entries();
            }
        }
        KeyCode::Char('r') => {
            if let Some(ref mut state) = app.compare_state {
                state.sort_desc = !state.sort_desc;
                state.cursor = 0;
                state.scroll = 0;
                state.sort_entries();
            }
        }
        _ => {}
    }
}

fn handle_matrix_key(app: &mut App, key: KeyEvent) {
    let row_count = app
        .compare_state
        .as_ref()
        .map(|s| s.matrix.len())
        .unwrap_or(0);

    match key.code {
        KeyCode::Up | KeyCode::Char('k') => {
            move_cursor(app, -1, row_count);
        }
        KeyCode::Down | KeyCode::Char('j') => {
            move_cursor(app, 1, row_count);
        }
        KeyCode::Enter => {
            open_detail(app);
        }
        _ => {}
    }
}

fn move_cursor(app: &mut App, delta: i32, row_count: usize) {
    if let Some(ref mut state) = app.compare_state {
        let max = row_count.saturating_sub(1);
        if delta < 0 {
            state.cursor = state.cursor.saturating_sub(delta.unsigned_abs() as usize);
        } else {
            state.cursor = (state.cursor + delta as usize).min(max);
        }
        ensure_visible(state);
    }
}

fn ensure_visible(state: &mut crate::app::CompareScreenState) {
    // Use a default visible height of 20 — actual height is not available here,
    // but will be clamped further during render if needed.
    const VISIBLE_HEIGHT: usize = 20;
    if state.cursor < state.scroll {
        state.scroll = state.cursor;
    } else if state.cursor >= state.scroll + VISIBLE_HEIGHT {
        state.scroll = state.cursor - VISIBLE_HEIGHT + 1;
    }
}

fn open_detail(app: &mut App) {
    if let Some(ref mut state) = app.compare_state {
        let cursor = state.cursor;
        let valid = match state.lens {
            CompareLens::Leaderboard => cursor < state.entries.len(),
            CompareLens::Matrix => cursor < state.matrix.len(),
            CompareLens::Detail => false,
        };
        if valid {
            // For leaderboard, find corresponding matrix entry
            let detail_idx = match state.lens {
                CompareLens::Leaderboard => {
                    // Find the matrix entry matching the leaderboard cursor's agent+model
                    let entry = &state.entries[cursor];
                    let agent = entry.agent.clone();
                    let model = entry.model.clone();
                    state
                        .matrix
                        .iter()
                        .position(|(a, m, _)| a == &agent && m == &model)
                        .unwrap_or(cursor)
                }
                CompareLens::Matrix => cursor,
                CompareLens::Detail => return,
            };
            state.detail_index = Some(detail_idx);
            state.lens = CompareLens::Detail;
            state.cursor = 0;
        }
    }
}

pub fn handle_compare_mouse(app: &mut App, mouse: MouseEvent) {
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            // TODO: row click support (requires hit area tracking)
        }
        MouseEventKind::ScrollUp => {
            let row_count = compare_row_count(app);
            move_cursor(app, -1, row_count);
        }
        MouseEventKind::ScrollDown => {
            let row_count = compare_row_count(app);
            move_cursor(app, 1, row_count);
        }
        _ => {}
    }
}

fn compare_row_count(app: &App) -> usize {
    app.compare_state
        .as_ref()
        .map(|s| match s.lens {
            CompareLens::Leaderboard => s.entries.len(),
            CompareLens::Matrix => s.matrix.len(),
            CompareLens::Detail => 0,
        })
        .unwrap_or(0)
}
