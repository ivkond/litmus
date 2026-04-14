use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};

use crate::app::{App, MatrixBuilderState, Pane, RunScreenState};
use crate::ui::styles;

pub fn render_matrix(frame: &mut Frame, area: Rect, app: &mut App) {
    // Vertical split: content area + summary bar (1 line)
    let vert = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).split(area);
    let content_area = vert[0];
    let summary_area = vert[1];

    // Horizontal split: left 55%, right 45%
    let horiz = Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)])
        .split(content_area);
    let left_area = horiz[0];
    let right_area = horiz[1];

    // Store hit areas for mouse support
    app.hit.matrix_left_area = left_area;
    app.hit.matrix_right_area = right_area;

    // Split left pane: filter input (1 line) + tree block
    let left_chunks =
        Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).split(left_area);
    let filter_area = left_chunks[0];
    let left_tree_area = left_chunks[1];

    // Borrow the state for rendering
    let (left_lines, right_lines, summary_text, filter_line, left_scroll, right_scroll) = {
        let state = match &mut app.run_state {
            Some(RunScreenState::MatrixBuilder(s)) => s,
            _ => return,
        };
        // Visible heights (block borders = 2 lines)
        let left_visible = left_tree_area.height.saturating_sub(2) as usize;
        let right_visible = right_area.height.saturating_sub(2) as usize;
        state.ensure_visible(left_visible, Pane::Left);
        state.ensure_visible(right_visible, Pane::Right);
        let ls = state.left_scroll;
        let rs = state.right_scroll;

        let left = build_left_lines(state);
        let right = build_right_lines(state);
        let summary = build_summary(state);
        let filter = build_filter_line(state);
        (left, right, summary, filter, ls, rs)
    };

    app.hit.matrix_left_y_start = left_tree_area.y + 1; // +1 for block top border
    app.hit.matrix_right_y_start = right_area.y + 1;

    // Determine active pane for label colors
    let (active_pane, filter_active) = match &app.run_state {
        Some(RunScreenState::MatrixBuilder(s)) => (s.active_pane, s.filter_active),
        _ => (Pane::Left, false),
    };

    // Filter input line (always visible above the tree)
    let filter_style = if filter_active {
        Style::default().bg(styles::COLOR_SURFACE_RAISED)
    } else {
        Style::default().bg(styles::COLOR_SURFACE)
    };
    frame.render_widget(Paragraph::new(filter_line).style(filter_style), filter_area);

    // Left pane block
    let left_label_style = if active_pane == Pane::Left {
        Style::default().fg(styles::COLOR_ACCENT)
    } else {
        Style::default().fg(styles::COLOR_DIM)
    };
    let left_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(styles::COLOR_BORDER))
        .style(Style::default().bg(styles::COLOR_SURFACE))
        .title(Span::styled(" agents & models ", left_label_style));

    let left_inner = left_block.inner(left_tree_area);
    frame.render_widget(left_block, left_tree_area);
    frame.render_widget(
        Paragraph::new(left_lines).scroll((left_scroll as u16, 0)),
        left_inner,
    );

    // Right pane block
    let right_label_style = if active_pane == Pane::Right {
        Style::default().fg(styles::COLOR_ACCENT)
    } else {
        Style::default().fg(styles::COLOR_DIM)
    };
    let right_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(styles::COLOR_BORDER))
        .style(Style::default().bg(styles::COLOR_SURFACE))
        .title(Span::styled(" scenarios ", right_label_style));

    let right_inner = right_block.inner(right_area);
    frame.render_widget(right_block, right_area);
    frame.render_widget(
        Paragraph::new(right_lines).scroll((right_scroll as u16, 0)),
        right_inner,
    );

    // Summary bar
    frame.render_widget(
        Paragraph::new(summary_text).style(styles::style_status_bar()),
        summary_area,
    );
}

fn build_filter_line<'a>(state: &MatrixBuilderState) -> Line<'a> {
    let cursor = if state.filter_active { "█" } else { "" };
    if state.filter.is_empty() && !state.filter_active {
        // Hint when idle
        Line::from(vec![
            Span::styled(" /", Style::default().fg(styles::COLOR_DIM)),
            Span::styled(" filter models", Style::default().fg(styles::COLOR_DIM)),
        ])
    } else {
        Line::from(vec![
            Span::styled(
                " / ",
                Style::default()
                    .fg(styles::COLOR_ACCENT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(state.filter.clone(), Style::default().fg(styles::COLOR_TEXT)),
            Span::styled(cursor.to_string(), Style::default().fg(styles::COLOR_MUTED)),
        ])
    }
}

fn build_left_lines<'a>(state: &MatrixBuilderState) -> Vec<Line<'a>> {
    let mut lines: Vec<Line> = Vec::new();
    let mut pos: usize = 0;
    let filtering = state.is_filtering();

    for agent in &state.agents {
        // When filtering, hide agents with no matching models
        if filtering && !state.agent_has_visible_models(agent) {
            continue;
        }

        // Agent header line
        let expanded = agent.expanded || filtering; // auto-expand when filtering
        let expand_icon = if expanded { "▼" } else { "▶" };
        let sel_icon = if agent.has_selection() { "✓" } else { " " };
        let visible_count = state.visible_models(agent).count();
        let count_str = format!("{}/{}", agent.selected_model_count(), visible_count);
        let label = format!("{} {} {}  {}", expand_icon, sel_icon, agent.name, count_str);

        let is_cursor = pos == state.left_cursor && state.active_pane == Pane::Left;
        let line = if is_cursor {
            Line::styled(
                label,
                Style::default()
                    .fg(styles::COLOR_TEXT)
                    .bg(styles::COLOR_SURFACE_RAISED),
            )
        } else {
            Line::styled(label, Style::default().fg(styles::COLOR_AGENT))
        };
        lines.push(line);
        pos += 1;

        if expanded {
            for model in state.visible_models(agent) {
                let check = if model.selected { "✓" } else { " " };
                let label = format!("    [{}] {}", check, model.name);

                let is_cursor = pos == state.left_cursor && state.active_pane == Pane::Left;
                let line = if is_cursor {
                    Line::styled(
                        label,
                        Style::default()
                            .fg(styles::COLOR_TEXT)
                            .bg(styles::COLOR_SURFACE_RAISED),
                    )
                } else {
                    Line::styled(label, Style::default().fg(styles::COLOR_MODEL))
                };
                lines.push(line);
                pos += 1;
            }
        }
    }

    lines
}

fn build_right_lines<'a>(state: &MatrixBuilderState) -> Vec<Line<'a>> {
    let mut lines: Vec<Line> = Vec::new();

    // Header
    let selected_count = state.selected_scenario_count();
    let total_count = state.scenarios.len();
    let header = format!("{}/{} scenarios  [a] all", selected_count, total_count);
    lines.push(Line::styled(
        header,
        Style::default().fg(styles::COLOR_MUTED),
    ));

    // Scenario rows
    for (idx, scenario) in state.scenarios.iter().enumerate() {
        let check = if scenario.selected { "✓" } else { " " };
        let label = format!("[{}] {}", check, scenario.id);

        let is_cursor = idx == state.right_cursor && state.active_pane == Pane::Right;
        let line = if is_cursor {
            Line::styled(
                label,
                Style::default()
                    .fg(styles::COLOR_TEXT)
                    .bg(styles::COLOR_SURFACE_RAISED),
            )
        } else {
            Line::styled(label, Style::default().fg(styles::COLOR_SCENARIO))
        };
        lines.push(line);
    }

    lines
}

fn build_summary(state: &MatrixBuilderState) -> Line<'static> {
    let total_runs = state.total_runs();
    if total_runs == 0 {
        Line::styled(
            "  Select agents and scenarios to begin",
            Style::default().fg(styles::COLOR_DIM),
        )
    } else {
        let selected_models: usize = state.agents.iter().map(|a| a.selected_model_count()).sum();
        let selected_agents = state
            .agents
            .iter()
            .filter(|a| a.has_selection())
            .count();
        let selected_scenarios = state.selected_scenario_count();
        let text = format!(
            "  Ready: {} agents × {} models × {} scenarios = {} runs   Enter start",
            selected_agents, selected_models, selected_scenarios, total_runs
        );
        Line::styled(text, Style::default().fg(styles::COLOR_TEXT))
    }
}
