use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Cell, Paragraph, Row, Table, TableState},
    Frame,
};

use crate::app::{App, CompareLens};
use crate::ui::styles;

pub fn render(frame: &mut Frame, area: Rect, app: &mut App) {
    // Layout: header (1) + spacer (1) + table (min) + footer (1)
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .split(area);

    let header_area = chunks[0];
    let table_area = chunks[2];
    let footer_area = chunks[3];

    // Header: lens switcher
    let header_line = build_lens_header(CompareLens::Matrix);
    frame.render_widget(Paragraph::new(header_line), header_area);

    let (rows, widths, col_headers, cursor, scroll) = {
        let state = match &app.compare_state {
            Some(s) => s,
            None => return,
        };

        let scenario_ids = &state.scenario_ids;
        let matrix = &state.matrix;

        // Build column widths: agent(14) + model(18) + each scenario(6)
        let mut widths: Vec<Constraint> = vec![
            Constraint::Length(14),
            Constraint::Length(18),
        ];
        for _ in scenario_ids {
            widths.push(Constraint::Length(6));
        }

        // Build column header row
        let mut col_header_cells = vec![
            Cell::from("agent").style(Style::default().fg(styles::COLOR_MUTED).add_modifier(Modifier::BOLD)),
            Cell::from("model").style(Style::default().fg(styles::COLOR_MUTED).add_modifier(Modifier::BOLD)),
        ];
        for sid in scenario_ids {
            let truncated = truncate_scenario_id(sid, 12);
            col_header_cells.push(
                Cell::from(truncated)
                    .style(Style::default().fg(styles::COLOR_SCENARIO).add_modifier(Modifier::BOLD)),
            );
        }

        // Build data rows
        let rows: Vec<Row> = matrix
            .iter()
            .map(|(agent, model, scenario_results)| {
                let mut cells = vec![
                    Cell::from(truncate_str(agent, 13))
                        .style(Style::default().fg(styles::COLOR_AGENT)),
                    Cell::from(truncate_str(model, 17))
                        .style(Style::default().fg(styles::COLOR_MODEL)),
                ];

                for sid in scenario_ids {
                    let result = scenario_results.iter().find(|r| &r.scenario_id == sid);
                    match result {
                        Some(r) if r.passed => {
                            cells.push(
                                Cell::from("✓").style(Style::default().fg(styles::COLOR_GOOD)),
                            );
                        }
                        Some(_) => {
                            cells.push(
                                Cell::from("✗").style(Style::default().fg(styles::COLOR_BAD)),
                            );
                        }
                        None => {
                            cells.push(
                                Cell::from("·").style(Style::default().fg(styles::COLOR_DIM)),
                            );
                        }
                    }
                }

                Row::new(cells)
            })
            .collect();

        let cursor = state.cursor;
        let scroll = state.scroll;

        (rows, widths, col_header_cells, cursor, scroll)
    };

    let header_row = Row::new(col_headers).height(1);

    let highlight_style = Style::default()
        .fg(styles::COLOR_TEXT)
        .bg(styles::COLOR_SURFACE_RAISED);

    let table = Table::new(rows, widths)
        .header(header_row)
        .row_highlight_style(highlight_style)
        .style(Style::default().bg(styles::COLOR_SURFACE));

    let mut table_state = TableState::default().with_selected(Some(cursor));
    *table_state.offset_mut() = scroll;

    frame.render_stateful_widget(table, table_area, &mut table_state);

    // Footer
    let footer_line = Line::from(vec![
        Span::styled("  ↑↓ / jk", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" navigate  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("enter", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" detail  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("1", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" leaderboard  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("esc", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" back", Style::default().fg(styles::COLOR_DIM)),
    ]);
    frame.render_widget(
        Paragraph::new(footer_line).style(styles::style_status_bar()),
        footer_area,
    );
}

fn build_lens_header(active: CompareLens) -> Line<'static> {
    let leaderboard_style = if active == CompareLens::Leaderboard {
        Style::default()
            .fg(styles::COLOR_ACCENT)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(styles::COLOR_DIM)
    };
    let matrix_style = if active == CompareLens::Matrix {
        Style::default()
            .fg(styles::COLOR_ACCENT)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(styles::COLOR_DIM)
    };

    Line::from(vec![
        Span::styled("matrix", matrix_style),
        Span::styled("  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("[1]", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" board  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("[2]", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" matrix  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("leaderboard", leaderboard_style),
    ])
}

/// Truncate a scenario ID to max_chars, appending "…" if truncated.
fn truncate_scenario_id(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{}…", truncated)
    }
}

/// Truncate a string to max_chars (no ellipsis — used for fixed-width cells).
fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}
