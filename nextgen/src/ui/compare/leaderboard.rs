use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Cell, Paragraph, Row, Table, TableState},
    Frame,
};

use crate::app::{App, CompareSort, CompareLens};
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
    let header_line = build_lens_header(CompareLens::Leaderboard);
    frame.render_widget(Paragraph::new(header_line), header_area);

    // Borrow state for rendering
    let (rows, widths, sort_by, sort_desc, cursor, scroll) = {
        let state = match &app.compare_state {
            Some(s) => s,
            None => return,
        };
        let rows = build_leaderboard_rows(state);
        let sort_by = state.sort_by;
        let sort_desc = state.sort_desc;
        let cursor = state.cursor;
        let scroll = state.scroll;
        let widths = [
            Constraint::Length(4),  // rank
            Constraint::Length(14), // agent
            Constraint::Length(20), // model
            Constraint::Length(10), // pass rate
            Constraint::Length(10), // avg time
            Constraint::Length(8),  // score
            Constraint::Length(10), // scenarios
        ];
        (rows, widths, sort_by, sort_desc, cursor, scroll)
    };

    // Column header row
    let sort_arrow = if sort_desc { " ↓" } else { " ↑" };
    let pass_rate_label = if sort_by == CompareSort::PassRate {
        format!("pass rate{}", sort_arrow)
    } else {
        "pass rate".to_string()
    };
    let score_label = if sort_by == CompareSort::Score {
        format!("score{}", sort_arrow)
    } else {
        "score".to_string()
    };
    let duration_label = if sort_by == CompareSort::Duration {
        format!("avg time{}", sort_arrow)
    } else {
        "avg time".to_string()
    };
    let agent_label = if sort_by == CompareSort::Agent {
        format!("agent{}", sort_arrow)
    } else {
        "agent".to_string()
    };

    let header_style = Style::default()
        .fg(styles::COLOR_MUTED)
        .add_modifier(Modifier::BOLD);
    let col_header = Row::new(vec![
        Cell::from("#").style(header_style),
        Cell::from(agent_label).style(if sort_by == CompareSort::Agent {
            Style::default().fg(styles::COLOR_ACCENT).add_modifier(Modifier::BOLD)
        } else {
            header_style
        }),
        Cell::from("model").style(header_style),
        Cell::from(pass_rate_label).style(if sort_by == CompareSort::PassRate {
            Style::default().fg(styles::COLOR_ACCENT).add_modifier(Modifier::BOLD)
        } else {
            header_style
        }),
        Cell::from(duration_label).style(if sort_by == CompareSort::Duration {
            Style::default().fg(styles::COLOR_ACCENT).add_modifier(Modifier::BOLD)
        } else {
            header_style
        }),
        Cell::from(score_label).style(if sort_by == CompareSort::Score {
            Style::default().fg(styles::COLOR_ACCENT).add_modifier(Modifier::BOLD)
        } else {
            header_style
        }),
        Cell::from("scenarios").style(header_style),
    ])
    .height(1);

    let highlight_style = Style::default()
        .fg(styles::COLOR_TEXT)
        .bg(styles::COLOR_SURFACE_RAISED);

    let table = Table::new(rows, widths)
        .header(col_header)
        .row_highlight_style(highlight_style)
        .style(Style::default().bg(styles::COLOR_SURFACE));

    let mut table_state = TableState::default().with_selected(Some(cursor));
    // Apply scroll offset
    *table_state.offset_mut() = scroll;

    frame.render_stateful_widget(table, table_area, &mut table_state);

    // Footer: sort hints
    let footer_line = build_footer_line(sort_by, sort_desc);
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
        Span::styled("leaderboard", leaderboard_style),
        Span::styled("  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("[1]", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" board  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("[2]", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" matrix  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("matrix", matrix_style),
    ])
}

pub fn build_lens_header_for(active: CompareLens) -> Line<'static> {
    build_lens_header(active)
}

fn build_leaderboard_rows(state: &crate::app::CompareScreenState) -> Vec<Row<'static>> {
    state
        .entries
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let rank = format!("{}", i + 1);
            let pass_pct = entry.pass_rate * 100.0;
            let pass_str = format!("{:.1}%", pass_pct);
            let pass_color = if pass_pct >= 90.0 {
                styles::COLOR_GOOD
            } else if pass_pct >= 70.0 {
                styles::COLOR_WARN
            } else {
                styles::COLOR_BAD
            };
            let duration_str = format!("{:.1}s", entry.avg_duration_secs);
            let score_str = format!("{:.1}", entry.total_score);
            let scenarios_str = format!("{}", entry.scenarios_run);

            Row::new(vec![
                Cell::from(rank).style(Style::default().fg(styles::COLOR_DIM)),
                Cell::from(entry.agent.clone()).style(Style::default().fg(styles::COLOR_AGENT)),
                Cell::from(entry.model.clone()).style(Style::default().fg(styles::COLOR_MODEL)),
                Cell::from(pass_str).style(Style::default().fg(pass_color)),
                Cell::from(duration_str).style(Style::default().fg(styles::COLOR_MUTED)),
                Cell::from(score_str).style(Style::default().fg(styles::COLOR_TEXT)),
                Cell::from(scenarios_str).style(Style::default().fg(styles::COLOR_DIM)),
            ])
        })
        .collect()
}

fn build_footer_line(sort_by: CompareSort, sort_desc: bool) -> Line<'static> {
    let dir_label = if sort_desc { "desc" } else { "asc" };
    let sort_label = match sort_by {
        CompareSort::PassRate => "pass rate",
        CompareSort::Score => "score",
        CompareSort::Duration => "duration",
        CompareSort::Agent => "agent",
    };

    Line::from(vec![
        Span::styled("  s", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" cycle sort  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("r", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(format!(" reverse ({})  ", dir_label), Style::default().fg(styles::COLOR_DIM)),
        Span::styled("↑↓ / jk", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" navigate  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("enter", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" detail  ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled("sorted by: ", Style::default().fg(styles::COLOR_DIM)),
        Span::styled(sort_label, Style::default().fg(styles::COLOR_ACCENT)),
    ])
}
