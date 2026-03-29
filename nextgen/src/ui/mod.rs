pub mod compare;
pub mod dashboard;
pub mod run;
pub mod scenarios;
pub mod styles;
pub mod tabs;

use ratatui::{
    layout::{Constraint, Layout},
    style::Style,
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::app::{App, Screen};

pub fn render(frame: &mut Frame, app: &mut App) {
    let full_area = frame.area();

    frame.render_widget(
        Block::default().style(styles::style_surface()),
        full_area,
    );

    let chunks = Layout::vertical([
        Constraint::Length(1), // tab bar
        Constraint::Length(1), // separator
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .split(full_area);

    tabs::render_tabs(frame, chunks[0], app);

    frame.render_widget(
        Block::default()
            .borders(Borders::TOP)
            .border_style(Style::default().fg(styles::COLOR_BORDER))
            .style(styles::style_surface()),
        chunks[1],
    );

    let content_area = chunks[2];
    match app.screen {
        Screen::Dashboard => dashboard::render_dashboard(frame, content_area, app),
        Screen::Run => run::render_run(frame, content_area, app),
        Screen::Compare => compare::render_compare(frame, content_area, app),
        Screen::Scenarios => scenarios::render_scenarios(frame, content_area, app),
        screen => {
            let msg = format!("{} \u{2014} coming soon", screen.title());
            frame.render_widget(
                Paragraph::new(msg).style(styles::style_dim()),
                content_area,
            );
        }
    }

    let mut hints = vec![
        Span::styled(" q", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" quit  ", styles::style_dim()),
        Span::styled("tab", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" switch  ", styles::style_dim()),
    ];
    // Context-sensitive hints for Run screen
    if app.screen == Screen::Run {
        if matches!(&app.run_state, Some(crate::app::RunScreenState::MatrixBuilder(_))) {
            hints.extend([
                Span::styled("/", Style::default().fg(styles::COLOR_MUTED)),
                Span::styled(" filter  ", styles::style_dim()),
                Span::styled("R", Style::default().fg(styles::COLOR_MUTED)),
                Span::styled(" refresh  ", styles::style_dim()),
                Span::styled("Enter", Style::default().fg(styles::COLOR_MUTED)),
                Span::styled(" start", styles::style_dim()),
            ]);
        }
    }
    hints.extend([
        Span::styled("?", Style::default().fg(styles::COLOR_MUTED)),
        Span::styled(" help", styles::style_dim()),
    ]);
    let status = Line::from(hints);
    frame.render_widget(
        Paragraph::new(status).style(styles::style_status_bar()),
        chunks[3],
    );
}
