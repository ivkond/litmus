pub mod matrix;
pub mod matrix_input;
pub mod progress;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;

use crate::app::{App, RunScreenState};
use crate::ui::styles;

const SPINNER: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

pub fn render_run(frame: &mut Frame, area: Rect, app: &mut App) {
    match &app.run_state {
        Some(RunScreenState::Loading(_)) => {
            // Tick-based spinner: poll interval is ~100ms, so elapsed renders ≈ frame count
            let tick = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                / 120) as usize;
            let ch = SPINNER[tick % SPINNER.len()];
            let text = format!("{} scanning agents...", ch);
            frame.render_widget(
                Paragraph::new(text).style(Style::default().fg(styles::COLOR_MUTED)),
                area,
            );
        }
        Some(RunScreenState::MatrixBuilder(_)) => matrix::render_matrix(frame, area, app),
        Some(RunScreenState::Progress(_)) => progress::render_progress(frame, area, app),
        None => {
            app.init_matrix_builder();
        }
    }
}
