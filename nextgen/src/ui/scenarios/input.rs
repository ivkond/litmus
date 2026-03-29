use crossterm::event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind};

use crate::app::{App, ScenarioPrompt, ScenarioPromptAction, ScenarioScreenState, Screen};
use crate::{pack, scenario};

pub fn handle_scenario_key(app: &mut App, key: KeyEvent) {
    let state = match &mut app.scenario_state {
        Some(s) => s,
        None => return,
    };

    // Handle active prompt first
    if state.prompt.is_some() {
        handle_prompt_key(state, key);
        return;
    }

    match key.code {
        // Navigation
        KeyCode::Up | KeyCode::Char('k') => {
            if state.cursor > 0 {
                state.cursor -= 1;
            }
        }
        KeyCode::Down | KeyCode::Char('j') => {
            if state.cursor + 1 < state.scenarios.len() {
                state.cursor += 1;
            }
        }
        KeyCode::Home => state.cursor = 0,
        KeyCode::End => {
            if !state.scenarios.is_empty() {
                state.cursor = state.scenarios.len() - 1;
            }
        }

        // New scenario
        KeyCode::Char('n') => {
            state.prompt = Some(ScenarioPrompt::Input {
                label: "New scenario ID:".into(),
                text: String::new(),
                action: ScenarioPromptAction::Create,
            });
        }

        // Duplicate
        KeyCode::Char('D') => {
            if let Some(s) = state.selected() {
                let source_id = s.id.clone();
                state.prompt = Some(ScenarioPrompt::Input {
                    label: format!("Duplicate '{}' as:", source_id),
                    text: String::new(),
                    action: ScenarioPromptAction::Duplicate(source_id),
                });
            }
        }

        // Delete
        KeyCode::Char('d') => {
            if let Some(s) = state.selected() {
                let id = s.id.clone();
                state.prompt = Some(ScenarioPrompt::ConfirmDelete(id));
            }
        }

        // Edit in $EDITOR
        KeyCode::Char('e') => {
            if let Some(s) = state.selected() {
                let dir = state.template_dir.join(&s.id);
                // We can't launch $EDITOR from TUI easily, so open the directory
                #[cfg(target_os = "windows")]
                {
                    let _ = std::process::Command::new("explorer")
                        .arg(&dir)
                        .spawn();
                }
                #[cfg(not(target_os = "windows"))]
                {
                    if let Ok(editor) = std::env::var("EDITOR") {
                        let _ = std::process::Command::new(editor)
                            .arg(dir.join("prompt.txt"))
                            .status();
                    }
                }
            }
        }

        // Import from .litmus-pack
        KeyCode::Char('i') => {
            state.prompt = Some(ScenarioPrompt::ImportPath(String::new()));
        }

        // Export selected as .litmus-pack
        KeyCode::Char('x') => {
            if let Some(s) = state.selected() {
                let id = s.id.clone();
                let out_path = state.template_dir.join(format!("{}.litmus-pack", id));
                match pack::export_pack(&state.template_dir, &[id.clone()], &out_path) {
                    Ok(_) => {
                        state.prompt = Some(ScenarioPrompt::Status(format!(
                            "Exported to {}",
                            out_path.display()
                        )));
                    }
                    Err(e) => {
                        state.prompt =
                            Some(ScenarioPrompt::Status(format!("Export error: {}", e)));
                    }
                }
            }
        }

        // Export all as .litmus-pack
        KeyCode::Char('X') => {
            let out_path = pack::default_pack_path(&state.template_dir);
            match pack::export_all(&state.template_dir, &out_path) {
                Ok(count) => {
                    state.prompt = Some(ScenarioPrompt::Status(format!(
                        "Exported {} scenarios to {}",
                        count,
                        out_path.display()
                    )));
                }
                Err(e) => {
                    state.prompt = Some(ScenarioPrompt::Status(format!("Export error: {}", e)));
                }
            }
        }

        // Back
        KeyCode::Esc => {
            app.scenario_state = None;
            app.switch_screen(Screen::Dashboard);
        }

        _ => {}
    }
}

fn handle_prompt_key(state: &mut ScenarioScreenState, key: KeyEvent) {
    let prompt = match &mut state.prompt {
        Some(p) => p,
        None => return,
    };

    match prompt {
        ScenarioPrompt::ConfirmDelete(id) => match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                let id = id.clone();
                let result = scenario::delete_scenario(&state.template_dir, &id);
                state.prompt = match result {
                    Ok(_) => {
                        state.reload();
                        Some(ScenarioPrompt::Status(format!("Deleted '{}'", id)))
                    }
                    Err(e) => Some(ScenarioPrompt::Status(format!("Error: {}", e))),
                };
            }
            _ => state.prompt = None,
        },

        ScenarioPrompt::Input { text, action, .. } => match key.code {
            KeyCode::Esc => state.prompt = None,
            KeyCode::Backspace => {
                text.pop();
            }
            KeyCode::Enter => {
                let new_id = text.trim().to_string();
                if new_id.is_empty() {
                    state.prompt = None;
                    return;
                }
                let result = match action {
                    ScenarioPromptAction::Create => {
                        scenario::create_scenario(&state.template_dir, &new_id).map(|_| ())
                    }
                    ScenarioPromptAction::Duplicate(source_id) => {
                        scenario::duplicate_scenario(&state.template_dir, source_id, &new_id)
                            .map(|_| ())
                    }
                };
                state.prompt = match result {
                    Ok(_) => {
                        state.reload();
                        // Move cursor to the new scenario
                        if let Some(pos) = state.scenarios.iter().position(|s| s.id == new_id) {
                            state.cursor = pos;
                        }
                        Some(ScenarioPrompt::Status(format!("Created '{}'", new_id)))
                    }
                    Err(e) => Some(ScenarioPrompt::Status(format!("Error: {}", e))),
                };
            }
            KeyCode::Char(c) => {
                // Only allow valid directory name chars
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    text.push(c);
                }
            }
            _ => {}
        },

        ScenarioPrompt::ImportPath(text) => match key.code {
            KeyCode::Esc => state.prompt = None,
            KeyCode::Backspace => {
                text.pop();
            }
            KeyCode::Enter => {
                let path = text.trim().to_string();
                if path.is_empty() {
                    state.prompt = None;
                    return;
                }
                let file_path = std::path::Path::new(&path);
                let result = pack::import_pack(&state.template_dir, file_path);
                state.prompt = match result {
                    Ok(ids) => {
                        state.reload();
                        Some(ScenarioPrompt::Status(format!(
                            "Imported {} scenario(s)",
                            ids.len()
                        )))
                    }
                    Err(e) => Some(ScenarioPrompt::Status(format!("Import error: {}", e))),
                };
            }
            KeyCode::Char(c) => text.push(c),
            _ => {}
        },

        ScenarioPrompt::Status(_) => {
            // Any key dismisses the status
            state.prompt = None;
        }
    }
}

pub fn handle_scenario_mouse(app: &mut App, mouse: MouseEvent) {
    let col = mouse.column;
    let row = mouse.row;

    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            if app.hit.scenario_list_area.contains((col, row).into()) {
                if let Some(state) = &mut app.scenario_state {
                    let y_offset = row.saturating_sub(app.hit.scenario_list_y_start) as usize;
                    let idx = y_offset + state.scroll;
                    if idx < state.scenarios.len() {
                        state.cursor = idx;
                    }
                }
            }
        }
        MouseEventKind::ScrollUp => {
            if app.hit.scenario_list_area.contains((col, row).into()) {
                if let Some(state) = &mut app.scenario_state {
                    if state.cursor > 0 {
                        state.cursor -= 1;
                    }
                }
            }
        }
        MouseEventKind::ScrollDown => {
            if app.hit.scenario_list_area.contains((col, row).into()) {
                if let Some(state) = &mut app.scenario_state {
                    if state.cursor + 1 < state.scenarios.len() {
                        state.cursor += 1;
                    }
                }
            }
        }
        _ => {}
    }
}
