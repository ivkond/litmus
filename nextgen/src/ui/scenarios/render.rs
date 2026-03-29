use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

use crate::app::{App, ScenarioPrompt, ScenarioScreenState};
use crate::ui::styles;

pub fn render_scenarios(frame: &mut Frame, area: Rect, app: &mut App) {
    let state = match &mut app.scenario_state {
        Some(s) => s,
        None => return,
    };

    // Vertical: content + prompt/status bar (1 line)
    let vert = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).split(area);
    let content_area = vert[0];
    let bar_area = vert[1];

    // Horizontal: list (35%) + preview (65%)
    let horiz = Layout::horizontal([Constraint::Percentage(35), Constraint::Percentage(65)])
        .split(content_area);
    let list_area = horiz[0];
    let preview_area = horiz[1];

    // Store hit areas
    app.hit.scenario_list_area = list_area;

    // Build list lines & preview before borrowing frame
    let (list_lines, preview_lines, bar_line, list_scroll, list_y_start) = {
        let visible_h = list_area.height.saturating_sub(2) as usize;
        state.ensure_visible(visible_h);
        let ls = state.scroll;
        let list = build_list_lines(state);
        let preview = build_preview_lines(state, preview_area.width.saturating_sub(2) as usize);
        let bar = build_bar_line(state);
        let y_start = list_area.y + 1; // +1 for block border
        (list, preview, bar, ls, y_start)
    };
    app.hit.scenario_list_y_start = list_y_start;

    // Left: scenario list
    let list_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(styles::COLOR_BORDER))
        .style(Style::default().bg(styles::COLOR_SURFACE))
        .title(Span::styled(
            format!(" scenarios ({}) ", app.scenario_state.as_ref().map_or(0, |s| s.scenarios.len())),
            Style::default().fg(styles::COLOR_ACCENT),
        ));
    let list_inner = list_block.inner(list_area);
    frame.render_widget(list_block, list_area);
    frame.render_widget(
        Paragraph::new(list_lines).scroll((list_scroll as u16, 0)),
        list_inner,
    );

    // Right: preview
    let preview_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(styles::COLOR_BORDER))
        .style(Style::default().bg(styles::COLOR_SURFACE))
        .title(Span::styled(" preview ", Style::default().fg(styles::COLOR_DIM)));
    let preview_inner = preview_block.inner(preview_area);
    frame.render_widget(preview_block, preview_area);
    frame.render_widget(
        Paragraph::new(preview_lines).wrap(Wrap { trim: false }),
        preview_inner,
    );

    // Bottom bar: prompt or hints
    frame.render_widget(
        Paragraph::new(bar_line).style(styles::style_status_bar()),
        bar_area,
    );
}

fn build_list_lines(state: &ScenarioScreenState) -> Vec<Line<'static>> {
    state
        .scenarios
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let icons = if s.has_project { "■" } else { "□" };
            let score_str = if s.max_score > 0 {
                format!(" ({}pt)", s.max_score)
            } else {
                String::new()
            };
            let label = format!(" {} {}{}", icons, s.id, score_str);

            if i == state.cursor {
                Line::styled(
                    label,
                    Style::default()
                        .fg(styles::COLOR_TEXT)
                        .bg(styles::COLOR_SURFACE_RAISED),
                )
            } else {
                Line::styled(label, Style::default().fg(styles::COLOR_SCENARIO))
            }
        })
        .collect()
}

fn build_preview_lines(state: &ScenarioScreenState, _width: usize) -> Vec<Line<'static>> {
    let scenario = match state.selected() {
        Some(s) => s,
        None => {
            return vec![Line::styled(
                "No scenarios found in template/",
                Style::default().fg(styles::COLOR_DIM),
            )];
        }
    };

    let mut lines: Vec<Line> = Vec::new();

    // Header
    let project_label = if scenario.has_project {
        "  ■ has project files"
    } else {
        "  □ no project files"
    };
    lines.push(Line::from(vec![
        Span::styled(
            scenario.id.clone(),
            Style::default()
                .fg(styles::COLOR_ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(project_label, Style::default().fg(styles::COLOR_DIM)),
    ]));
    lines.push(Line::default());

    // Task
    if !scenario.task.is_empty() {
        lines.push(Line::styled(
            "task:",
            Style::default()
                .fg(styles::COLOR_MUTED)
                .add_modifier(Modifier::BOLD),
        ));
        for l in scenario.task.lines() {
            lines.push(Line::styled(
                format!("  {}", l),
                Style::default().fg(styles::COLOR_TEXT),
            ));
        }
        lines.push(Line::default());
    }

    // Prompt
    let prompt_lines: Vec<&str> = scenario.prompt.lines().collect();
    lines.push(Line::styled(
        "prompt:",
        Style::default()
            .fg(styles::COLOR_MUTED)
            .add_modifier(Modifier::BOLD),
    ));
    for l in prompt_lines.iter().take(20) {
        lines.push(Line::styled(
            format!("  {}", l),
            Style::default().fg(styles::COLOR_TEXT),
        ));
    }
    if prompt_lines.len() > 20 {
        lines.push(Line::styled(
            "  ... (truncated)",
            Style::default().fg(styles::COLOR_DIM),
        ));
    }
    lines.push(Line::default());

    // Scoring
    if !scenario.scoring.is_empty() {
        lines.push(Line::styled(
            format!("scoring: (max {}pt)", scenario.max_score),
            Style::default()
                .fg(styles::COLOR_MUTED)
                .add_modifier(Modifier::BOLD),
        ));
        for sc in &scenario.scoring {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("  {:>2}pt  ", sc.score),
                    Style::default().fg(styles::COLOR_WARN),
                ),
                Span::styled(sc.criterion.clone(), Style::default().fg(styles::COLOR_TEXT)),
            ]));
        }
    }

    lines
}

fn build_bar_line(state: &ScenarioScreenState) -> Line<'static> {
    match &state.prompt {
        Some(ScenarioPrompt::ConfirmDelete(id)) => Line::from(vec![
            Span::styled(
                format!(" Delete '{}'? ", id),
                Style::default().fg(styles::COLOR_BAD),
            ),
            Span::styled(
                "y/n",
                Style::default()
                    .fg(styles::COLOR_TEXT)
                    .add_modifier(Modifier::BOLD),
            ),
        ]),
        Some(ScenarioPrompt::Input { label, text, .. }) => Line::from(vec![
            Span::styled(
                format!(" {} ", label),
                Style::default().fg(styles::COLOR_ACCENT),
            ),
            Span::styled(text.clone(), Style::default().fg(styles::COLOR_TEXT)),
            Span::styled("█", Style::default().fg(styles::COLOR_MUTED)),
        ]),
        Some(ScenarioPrompt::ImportPath(text)) => Line::from(vec![
            Span::styled(" Import .litmus-pack: ", Style::default().fg(styles::COLOR_ACCENT)),
            Span::styled(text.clone(), Style::default().fg(styles::COLOR_TEXT)),
            Span::styled("█", Style::default().fg(styles::COLOR_MUTED)),
        ]),
        Some(ScenarioPrompt::Status(msg)) => {
            Line::styled(format!(" {}", msg), Style::default().fg(styles::COLOR_GOOD))
        }
        None => Line::from(vec![
            Span::styled(" n", Style::default().fg(styles::COLOR_MUTED)),
            Span::styled(" new  ", styles::style_dim()),
            Span::styled("D", Style::default().fg(styles::COLOR_MUTED)),
            Span::styled(" dup  ", styles::style_dim()),
            Span::styled("d", Style::default().fg(styles::COLOR_MUTED)),
            Span::styled(" del  ", styles::style_dim()),
            Span::styled("e", Style::default().fg(styles::COLOR_MUTED)),
            Span::styled(" edit  ", styles::style_dim()),
            Span::styled("i", Style::default().fg(styles::COLOR_MUTED)),
            Span::styled(" import  ", styles::style_dim()),
            Span::styled("x", Style::default().fg(styles::COLOR_MUTED)),
            Span::styled(" export  ", styles::style_dim()),
            Span::styled("X", Style::default().fg(styles::COLOR_MUTED)),
            Span::styled(" export all", styles::style_dim()),
        ]),
    }
}
