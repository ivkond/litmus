use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Cell, HighlightSpacing, Paragraph, Row, Table},
    Frame,
};

use crate::app::App;
use super::styles;

pub fn render_dashboard(frame: &mut Frame, area: Rect, app: &mut App) {
    let data = match &app.dashboard {
        Some(d) => d,
        None => {
            frame.render_widget(
                Paragraph::new("Loading...").style(styles::style_dim()),
                area,
            );
            return;
        }
    };

    if data.stats.total_results == 0 {
        render_empty_state(frame, area);
        app.hit.table_area = Rect::default();
        app.hit.table_row_count = 0;
    } else {
        render_populated(frame, area, app);
    }
}

fn render_empty_state(frame: &mut Frame, area: Rect) {
    let chunks = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(1),
        Constraint::Length(2),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
    ])
    .split(area);

    let welcome = Paragraph::new("litmus")
        .style(Style::default().fg(styles::COLOR_ACCENT).add_modifier(Modifier::BOLD));
    frame.render_widget(welcome, chunks[1]);

    let actions = Line::from(vec![
        Span::styled("r", styles::style_key_hint()),
        Span::styled(" run  ", styles::style_muted()),
        Span::styled("c", styles::style_key_hint()),
        Span::styled(" compare", styles::style_muted()),
    ]);
    frame.render_widget(Paragraph::new(actions), chunks[3]);

    let hint = Paragraph::new("No results yet. Press r to start.")
        .style(styles::style_dim());
    frame.render_widget(hint, chunks[4]);
}

fn render_populated(frame: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::vertical([
        Constraint::Length(1), // stats
        Constraint::Length(1), // spacer
        Constraint::Length(1), // actions
        Constraint::Length(1), // spacer
        Constraint::Length(1), // section label
        Constraint::Min(4),   // table
        Constraint::Length(1), // footer
    ])
    .split(area);

    let data = app.dashboard.as_ref().unwrap();

    // Stats
    let stats = &data.stats;
    let stats_line = Line::from(vec![
        Span::styled(
            format!("{}", stats.total_results),
            Style::default().fg(styles::COLOR_TEXT),
        ),
        Span::styled(" results  ", styles::style_dim()),
        Span::styled(
            format!("{}", stats.unique_agents),
            Style::default().fg(styles::COLOR_AGENT),
        ),
        Span::styled(" agents  ", styles::style_dim()),
        Span::styled(
            format!("{}", stats.unique_models),
            Style::default().fg(styles::COLOR_MODEL),
        ),
        Span::styled(" models  ", styles::style_dim()),
        Span::styled(
            format!("{}", stats.unique_scenarios),
            Style::default().fg(styles::COLOR_SCENARIO),
        ),
        Span::styled(" scenarios", styles::style_dim()),
    ]);
    frame.render_widget(Paragraph::new(stats_line), chunks[0]);

    // Actions
    let actions = Line::from(vec![
        Span::styled("r", styles::style_key_hint()),
        Span::styled(" run  ", styles::style_muted()),
        Span::styled("c", styles::style_key_hint()),
        Span::styled(" compare", styles::style_muted()),
    ]);
    frame.render_widget(Paragraph::new(actions), chunks[2]);

    // Section label
    let label = Paragraph::new("recent")
        .style(styles::style_dim().add_modifier(Modifier::BOLD));
    frame.render_widget(label, chunks[4]);

    // Table
    let table_area = chunks[5];
    if data.recent.is_empty() {
        frame.render_widget(
            Paragraph::new("no runs yet").style(styles::style_dim()),
            table_area,
        );
        app.hit.table_area = Rect::default();
        app.hit.table_row_count = 0;
    } else {
        let row_count = data.recent.len();

        let header_row = Row::new(vec![
            Cell::from("agent"),
            Cell::from("model"),
            Cell::from("scn"),
            Cell::from("pass"),
            Cell::from("time"),
        ])
        .style(styles::style_dim())
        .bottom_margin(1);

        let rows: Vec<Row> = data
            .recent
            .iter()
            .map(|r| {
                let pass_rate = if r.tests_total > 0 {
                    format!("{}/{}", r.tests_passed, r.tests_total)
                } else {
                    "\u{2014}".into()
                };
                Row::new(vec![
                    Cell::from(r.agent.as_str())
                        .style(Style::default().fg(styles::COLOR_AGENT)),
                    Cell::from(r.model.as_str())
                        .style(Style::default().fg(styles::COLOR_MODEL)),
                    Cell::from(format!("{}", r.scenarios_count))
                        .style(Style::default().fg(styles::COLOR_TEXT)),
                    Cell::from(pass_rate)
                        .style(Style::default().fg(styles::COLOR_TEXT)),
                    Cell::from(r.timestamp.as_str())
                        .style(styles::style_dim()),
                ])
            })
            .collect();

        let table = Table::new(
            rows,
            [
                Constraint::Percentage(20),
                Constraint::Percentage(28),
                Constraint::Percentage(10),
                Constraint::Percentage(12),
                Constraint::Percentage(30),
            ],
        )
        .header(header_row)
        .row_highlight_style(
            Style::default()
                .fg(styles::COLOR_TEXT)
                .bg(styles::COLOR_SURFACE_RAISED)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_spacing(HighlightSpacing::Always)
        .highlight_symbol("> ");

        // Store hit info: header (1 row) + margin (1 row) = data starts at +2
        app.hit.table_area = table_area;
        app.hit.table_row_count = row_count;
        app.hit.table_data_y = table_area.y + 2;

        frame.render_stateful_widget(table, table_area, &mut app.table_state);
    }

    // Footer
    let footer = Line::from(vec![
        Span::styled("\u{2191}\u{2193}", styles::style_dim()),
        Span::styled(" navigate  ", Style::default().fg(styles::COLOR_BORDER)),
        Span::styled("enter", styles::style_dim()),
        Span::styled(" details", Style::default().fg(styles::COLOR_BORDER)),
    ]);
    frame.render_widget(Paragraph::new(footer), chunks[6]);
}
