use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::app::{App, Screen};
use super::styles;

pub fn render_tabs(frame: &mut Frame, area: Rect, app: &mut App) {
    let mut spans: Vec<Span> = Vec::new();
    let mut tab_ranges: Vec<(u16, u16)> = Vec::new();

    // "litmus" prefix
    let prefix = "litmus   ";
    spans.push(Span::styled(
        &prefix[..6],
        Style::default()
            .fg(styles::COLOR_ACCENT)
            .add_modifier(Modifier::BOLD),
    ));
    spans.push(Span::raw(&prefix[6..]));

    let mut x = area.x + prefix.len() as u16;

    for (i, s) in Screen::ALL.iter().enumerate() {
        if i > 0 {
            let gap = "  ";
            spans.push(Span::raw(gap));
            x += gap.len() as u16;
        }

        let title = s.title();
        let x_start = x;
        let x_end = x + title.len() as u16;
        tab_ranges.push((x_start, x_end));

        let style = if *s == app.screen {
            Style::default()
                .fg(styles::COLOR_TEXT)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(styles::COLOR_MUTED)
        };
        spans.push(Span::styled(title, style));
        x = x_end;
    }

    // Store hit areas
    app.hit.tab_y = area.y;
    app.hit.tab_ranges = tab_ranges;

    let line = Line::from(spans);
    frame.render_widget(
        Paragraph::new(line).style(Style::default().bg(styles::COLOR_SURFACE)),
        area,
    );
}
