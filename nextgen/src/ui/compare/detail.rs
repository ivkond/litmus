use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Cell, Paragraph, Row, Table, TableState},
    Frame,
};

use crate::app::App;
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

    let (agent, model, rows, cursor) = {
        let state = match &app.compare_state {
            Some(s) => s,
            None => return,
        };

        let detail_idx = match state.detail_index {
            Some(i) => i,
            None => return,
        };

        let (agent, model, scenario_results) = match state.matrix.get(detail_idx) {
            Some(entry) => entry,
            None => return,
        };

        let rows: Vec<Row> = scenario_results
            .iter()
            .map(|r| {
                let pass_fail = if r.passed { "✓" } else { "✗" };
                let pass_color = if r.passed {
                    styles::COLOR_GOOD
                } else {
                    styles::COLOR_BAD
                };
                let tests_str = format!("{}/{}", r.tests_passed, r.tests_total);
                let duration_str = format!("{:.1}s", r.duration_secs);
                let score_str = format!("{:.1}", r.score);

                Row::new(vec![
                    Cell::from(r.scenario_id.clone())
                        .style(Style::default().fg(styles::COLOR_SCENARIO)),
                    Cell::from(tests_str).style(Style::default().fg(styles::COLOR_MUTED)),
                    Cell::from(pass_fail).style(Style::default().fg(pass_color)),
                    Cell::from(duration_str).style(Style::default().fg(styles::COLOR_MUTED)),
                    Cell::from(score_str).style(Style::default().fg(styles::COLOR_TEXT)),
                ])
            })
            .collect();

        let cursor = state.cursor;
        (agent.clone(), model.clone(), rows, cursor)
    };

    // Header: agent / model
    let header_line = Line::from(vec![
        Span::styled(agent, Style::default().fg(styles::COLOR_AGENT).add_modifier(Modifier::BOLD)),
        Span::styled(" / ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled(model, Style::default().fg(styles::COLOR_MODEL).add_modifier(Modifier::BOLD)),
    ]);
    frame.render_widget(Paragraph::new(header_line), header_area);

    // Column header
    let header_style = Style::default()
        .fg(styles::COLOR_MUTED)
        .add_modifier(Modifier::BOLD);
    let col_header = Row::new(vec![
        Cell::from("scenario").style(header_style),
        Cell::from("tests").style(header_style),
        Cell::from("status").style(header_style),
        Cell::from("duration").style(header_style),
        Cell::from("score").style(header_style),
    ])
    .height(1);

    let widths = [
        Constraint::Min(20),
        Constraint::Length(8),
        Constraint::Length(8),
        Constraint::Length(10),
        Constraint::Length(8),
    ];

    let highlight_style = Style::default()
        .fg(styles::COLOR_TEXT)
        .bg(styles::COLOR_SURFACE_RAISED);

    let table = Table::new(rows, widths)
        .header(col_header)
        .row_highlight_style(highlight_style)
        .style(Style::default().bg(styles::COLOR_SURFACE));

    let mut table_state = TableState::default().with_selected(Some(cursor));
    frame.render_stateful_widget(table, table_area, &mut table_state);

    // Footer
    let footer_line = Line::from(vec![
        Span::styled("  esc", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" back", Style::default().fg(styles::COLOR_DIM)),
    ]);
    frame.render_widget(
        Paragraph::new(footer_line).style(styles::style_status_bar()),
        footer_area,
    );
}
