use std::collections::BTreeSet;

use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Style},
    text::{Line, Span},
    widgets::{Cell, LineGauge, Paragraph, Row, Table},
    symbols,
};

use crate::app::{App, CellStatus, RunScreenState};
use crate::ui::styles::{
    self,
    COLOR_ACCENT, COLOR_AGENT, COLOR_BAD, COLOR_DIM, COLOR_GOOD, COLOR_MODEL, COLOR_TEXT,
    COLOR_MUTED,
};

pub fn render_progress(frame: &mut Frame, area: Rect, app: &mut App) {
    // Extract state; bail gracefully if we're not in Progress mode.
    let state = match app.run_state.as_ref() {
        Some(RunScreenState::Progress(s)) => s,
        _ => return,
    };

    let done = state.done;
    let completed = state.completed;
    let total = state.total;
    let ratio = if total == 0 {
        0.0_f64
    } else {
        (completed as f64 / total as f64).clamp(0.0, 1.0)
    };
    let current = state.current.clone();
    let cells_snapshot: Vec<((String, String, String), CellStatus)> = state
        .cells
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();

    // ── Layout ────────────────────────────────────────────────────────────
    // [0] header 1 line
    // [1] gauge  1 line
    // [2] spacer 1 line
    // [3] table  remaining
    // [4] current task 1 line
    // [5] footer 1 line
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .split(area);

    // ── Header ────────────────────────────────────────────────────────────
    let (label, count_str) = if done {
        ("done  ", format!("{}/{}", total, total))
    } else {
        ("running  ", format!("{}/{}", completed, total))
    };
    let header_line = Line::from(vec![
        Span::styled(label, Style::default().fg(COLOR_MUTED)),
        Span::styled(count_str, Style::default().fg(COLOR_TEXT)),
    ]);
    frame.render_widget(Paragraph::new(header_line), chunks[0]);

    // ── LineGauge ─────────────────────────────────────────────────────────
    let gauge_color = if done { COLOR_GOOD } else { COLOR_ACCENT };
    let gauge = LineGauge::default()
        .ratio(ratio)
        .line_set(symbols::line::THICK)
        .filled_style(Style::default().fg(gauge_color))
        .unfilled_style(Style::default().fg(COLOR_DIM));
    frame.render_widget(gauge, chunks[1]);

    // chunks[2] — spacer, nothing to render

    // ── Status table ──────────────────────────────────────────────────────
    if cells_snapshot.is_empty() {
        let waiting = Paragraph::new(Span::styled("waiting...", styles::style_dim()));
        frame.render_widget(waiting, chunks[3]);
    } else {
        // Collect unique lanes (agent, model) and unique scenario ids — keep
        // insertion-stable ordering with BTreeSet for determinism.
        let mut lanes: Vec<(String, String)> = Vec::new();
        let mut lanes_set: BTreeSet<(String, String)> = BTreeSet::new();
        let mut scenarios_set: BTreeSet<String> = BTreeSet::new();

        for ((agent, model, scenario_id), _) in &cells_snapshot {
            if lanes_set.insert((agent.clone(), model.clone())) {
                lanes.push((agent.clone(), model.clone()));
            }
            scenarios_set.insert(scenario_id.clone());
        }

        // Sort lanes alphabetically for stability.
        lanes.sort();
        let scenarios: Vec<String> = scenarios_set.into_iter().collect();

        // Build header row: "agent" | "model" | scenario1 | scenario2 | …
        let mut header_cells: Vec<Cell> = vec![
            Cell::from("agent").style(Style::default().fg(COLOR_MUTED)),
            Cell::from("model").style(Style::default().fg(COLOR_MUTED)),
        ];
        for sc in &scenarios {
            // Truncate long scenario ids to keep the table readable.
            let label = if sc.len() > 12 {
                format!("{}…", &sc[..11])
            } else {
                sc.clone()
            };
            header_cells.push(Cell::from(label).style(Style::default().fg(COLOR_MUTED)));
        }
        let header_row = Row::new(header_cells);

        // Build data rows.
        let mut rows: Vec<Row> = Vec::new();
        for (agent, model) in &lanes {
            let mut cells: Vec<Cell> = vec![
                Cell::from(agent.as_str()).style(Style::default().fg(COLOR_AGENT)),
                Cell::from(model.as_str()).style(Style::default().fg(COLOR_MODEL)),
            ];
            for sc in &scenarios {
                let key = (agent.clone(), model.clone(), sc.clone());
                let status = cells_snapshot
                    .iter()
                    .find(|(k, _)| k == &key)
                    .map(|(_, v)| *v)
                    .unwrap_or(CellStatus::Pending);
                let (symbol, color) = match status {
                    CellStatus::Pending => ("·", COLOR_DIM),
                    CellStatus::Running => ("●", COLOR_ACCENT),
                    CellStatus::Passed  => ("✓", COLOR_GOOD),
                    CellStatus::Failed  => ("✗", COLOR_BAD),
                };
                cells.push(Cell::from(symbol).style(Style::default().fg(color)));
            }
            rows.push(Row::new(cells));
        }

        // Column widths: 16 for agent, 20 for model, 14 each for scenarios.
        let mut widths: Vec<Constraint> = vec![
            Constraint::Length(16),
            Constraint::Length(20),
        ];
        for _ in &scenarios {
            widths.push(Constraint::Length(14));
        }

        let table = Table::new(rows, widths)
            .header(header_row)
            .style(Style::default().fg(COLOR_TEXT));
        frame.render_widget(table, chunks[3]);
    }

    // ── Current task line ─────────────────────────────────────────────────
    let task_text = if done {
        Line::from("")
    } else {
        match current {
            Some(ref desc) => Line::from(vec![
                Span::styled("NOW: ", Style::default().fg(COLOR_DIM)),
                Span::styled(desc.as_str(), Style::default().fg(COLOR_TEXT)),
            ]),
            None => Line::from(""),
        }
    };
    frame.render_widget(Paragraph::new(task_text), chunks[4]);

    // ── Footer ────────────────────────────────────────────────────────────
    let footer_text = if done {
        Line::from(vec![
            Span::styled("esc ", styles::style_key_hint()),
            Span::styled("back", styles::style_dim()),
        ])
    } else {
        Line::from("")
    };
    frame.render_widget(Paragraph::new(footer_text), chunks[5]);
}
