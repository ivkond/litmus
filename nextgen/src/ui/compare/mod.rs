pub mod detail;
pub mod input;
pub mod leaderboard;
pub mod matrix;

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use crate::app::{App, CompareLens};
use crate::ui::styles;

pub fn render_compare(frame: &mut Frame, area: Rect, app: &mut App) {
    let Some(ref state) = app.compare_state else {
        frame.render_widget(
            Paragraph::new("no results yet. run benchmarks first.")
                .style(Style::default().fg(styles::COLOR_DIM)),
            area,
        );
        return;
    };

    if state.entries.is_empty() {
        frame.render_widget(
            Paragraph::new("no results yet. run benchmarks first.")
                .style(Style::default().fg(styles::COLOR_DIM)),
            area,
        );
        return;
    }

    match state.lens {
        CompareLens::Leaderboard => leaderboard::render(frame, area, app),
        CompareLens::Matrix => matrix::render(frame, area, app),
        CompareLens::Detail => detail::render(frame, area, app),
    }
}
