use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};
use crate::app::{App, MatrixBuilderState, Pane, RunScreenState};

pub fn handle_matrix_key(app: &mut App, key: KeyEvent) {
    // Handle keys that call methods on App (borrow conflict with run_state)
    if key.code == KeyCode::Enter {
        let can_start = match &app.run_state {
            Some(RunScreenState::MatrixBuilder(s)) => s.total_runs() > 0,
            _ => false,
        };
        if can_start {
            app.start_run();
        }
        return;
    }

    // R = force-refresh agents (rescan, ignore cache)
    if key.code == KeyCode::Char('R') {
        let is_matrix = matches!(&app.run_state, Some(RunScreenState::MatrixBuilder(_)));
        if is_matrix {
            app.refresh_agents();
            return;
        }
    }

    // Get mutable reference to matrix state
    let state = match &mut app.run_state {
        Some(RunScreenState::MatrixBuilder(s)) => s,
        _ => return,
    };

    // If filter input is focused, capture all keypresses
    if state.filter_active {
        match key.code {
            KeyCode::Esc => {
                state.filter.clear();
                state.filter_active = false;
                clamp_left_cursor(state);
            }
            KeyCode::Backspace => {
                state.filter.pop();
                clamp_left_cursor(state);
            }
            KeyCode::Up | KeyCode::Down => {
                let delta = if key.code == KeyCode::Up { -1 } else { 1 };
                move_cursor(state, delta);
            }
            KeyCode::Char(' ') => toggle_current(state),
            KeyCode::Tab | KeyCode::BackTab => {
                state.filter_active = false;
                state.active_pane = Pane::Right;
            }
            KeyCode::Char(c) => {
                state.filter.push(c);
                state.left_cursor = 0;
                state.left_scroll = 0;
            }
            _ => {}
        }
        return;
    }

    match key.code {
        // Navigation
        KeyCode::Up | KeyCode::Char('k') => move_cursor(state, -1),
        KeyCode::Down | KeyCode::Char('j') => move_cursor(state, 1),
        KeyCode::Tab | KeyCode::BackTab => {
            state.active_pane = match state.active_pane {
                Pane::Left => Pane::Right,
                Pane::Right => Pane::Left,
            };
        }

        // Toggle selection
        KeyCode::Char(' ') => toggle_current(state),

        // Expand/collapse (left pane)
        KeyCode::Right | KeyCode::Char('l') if state.active_pane == Pane::Left => {
            toggle_expand(state, true);
        }
        KeyCode::Left | KeyCode::Char('h') if state.active_pane == Pane::Left => {
            toggle_expand(state, false);
        }

        // Select all scenarios
        KeyCode::Char('a') if state.active_pane == Pane::Right => {
            let all_selected = state.scenarios.iter().all(|s| s.selected);
            for s in &mut state.scenarios {
                s.selected = !all_selected;
            }
        }

        // Activate filter input
        KeyCode::Char('/') => {
            state.filter_active = true;
            state.active_pane = Pane::Left;
        }

        // Show selected only
        KeyCode::Char('f') => {
            state.show_selected_only = !state.show_selected_only;
            clamp_left_cursor(state);
        }

        // Back to dashboard
        KeyCode::Esc => {
            app.run_state = None;
            app.switch_screen(crate::app::Screen::Dashboard);
        }

        _ => {}
    }
}

pub fn handle_matrix_mouse(app: &mut App, mouse: MouseEvent) {
    let col = mouse.column;
    let row = mouse.row;

    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            // Left pane click
            if app.hit.matrix_left_area.contains((col, row).into()) {
                if let Some(RunScreenState::MatrixBuilder(state)) = &mut app.run_state {
                    state.active_pane = Pane::Left;
                    let y_offset = row.saturating_sub(app.hit.matrix_left_y_start) as usize;
                    state.left_cursor = y_offset + state.left_scroll;
                    let max = state.left_row_count().saturating_sub(1);
                    if state.left_cursor > max {
                        state.left_cursor = max;
                    }
                    toggle_current(state);
                }
            }
            // Right pane click
            else if app.hit.matrix_right_area.contains((col, row).into()) {
                if let Some(RunScreenState::MatrixBuilder(state)) = &mut app.run_state {
                    state.active_pane = Pane::Right;
                    let y_offset = row.saturating_sub(app.hit.matrix_right_y_start) as usize;
                    let idx = y_offset + state.right_scroll;
                    if idx < state.scenarios.len() {
                        state.right_cursor = idx;
                        state.scenarios[idx].selected = !state.scenarios[idx].selected;
                    }
                }
            }
        }
        MouseEventKind::ScrollUp => {
            if let Some(RunScreenState::MatrixBuilder(state)) = &mut app.run_state {
                if app.hit.matrix_left_area.contains((col, row).into()) {
                    move_cursor(state, -1);
                } else if app.hit.matrix_right_area.contains((col, row).into()) {
                    state.active_pane = Pane::Right;
                    move_cursor(state, -1);
                }
            }
        }
        MouseEventKind::ScrollDown => {
            if let Some(RunScreenState::MatrixBuilder(state)) = &mut app.run_state {
                if app.hit.matrix_left_area.contains((col, row).into()) {
                    move_cursor(state, 1);
                } else if app.hit.matrix_right_area.contains((col, row).into()) {
                    state.active_pane = Pane::Right;
                    move_cursor(state, 1);
                }
            }
        }
        _ => {}
    }
}

// ── Helpers ──

fn move_cursor(state: &mut MatrixBuilderState, delta: i32) {
    match state.active_pane {
        Pane::Left => {
            let max = state.left_row_count().saturating_sub(1);
            if delta < 0 {
                state.left_cursor =
                    state.left_cursor.saturating_sub(delta.unsigned_abs() as usize);
            } else {
                state.left_cursor = (state.left_cursor + delta as usize).min(max);
            }
        }
        Pane::Right => {
            let max = state.scenarios.len().saturating_sub(1);
            if delta < 0 {
                state.right_cursor =
                    state.right_cursor.saturating_sub(delta.unsigned_abs() as usize);
            } else {
                state.right_cursor = (state.right_cursor + delta as usize).min(max);
            }
        }
    }
}

/// Clamp left cursor to valid range after filter/tree changes.
fn clamp_left_cursor(state: &mut MatrixBuilderState) {
    let max = state.left_row_count().saturating_sub(1);
    if state.left_cursor > max {
        state.left_cursor = max;
    }
}

/// Resolve left cursor to (agent_index, Option<model_visible_index>).
/// Respects filtering: skips hidden agents, auto-expands when filtering.
fn resolve_left_cursor(state: &MatrixBuilderState) -> Option<(usize, Option<usize>)> {
    let mut pos = 0;
    let filtering = state.is_filtering();
    for (ai, agent) in state.agents.iter().enumerate() {
        if filtering && !state.agent_has_visible_models(agent) {
            continue;
        }
        if pos == state.left_cursor {
            return Some((ai, None)); // on agent header
        }
        pos += 1;
        let expanded = agent.expanded || filtering;
        if expanded {
            let visible: Vec<_> = state.visible_models(agent).collect();
            for (mi, _) in visible.iter().enumerate() {
                if pos == state.left_cursor {
                    return Some((ai, Some(mi)));
                }
                pos += 1;
            }
        }
    }
    None
}

fn toggle_current(state: &mut MatrixBuilderState) {
    match state.active_pane {
        Pane::Left => {
            if let Some((ai, model_idx)) = resolve_left_cursor(state) {
                match model_idx {
                    Some(mi) => {
                        // Toggle model selection — map visible index to actual model
                        let filter_lower = state.filter.to_lowercase();
                        let show_selected = state.show_selected_only;
                        let mut visible_idx = 0;
                        for model in &mut state.agents[ai].models {
                            let visible = if show_selected && !model.selected {
                                false
                            } else if !filter_lower.is_empty() {
                                model.name.to_lowercase().contains(&filter_lower)
                            } else {
                                true
                            };
                            if visible {
                                if visible_idx == mi {
                                    model.selected = !model.selected;
                                    break;
                                }
                                visible_idx += 1;
                            }
                        }
                    }
                    None => {
                        // Toggle agent expand/collapse (only when not filtering)
                        if !state.is_filtering() {
                            state.agents[ai].expanded = !state.agents[ai].expanded;
                            clamp_left_cursor(state);
                        }
                    }
                }
            }
        }
        Pane::Right => {
            let idx = state.right_cursor;
            if idx < state.scenarios.len() {
                state.scenarios[idx].selected = !state.scenarios[idx].selected;
            }
        }
    }
}

fn toggle_expand(state: &mut MatrixBuilderState, expand: bool) {
    if state.is_filtering() {
        return; // agents are auto-expanded when filtering
    }
    if let Some((ai, _)) = resolve_left_cursor(state) {
        state.agents[ai].expanded = expand;
        clamp_left_cursor(state);
    }
}
