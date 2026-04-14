use ratatui::{
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Padding},
};

// ── Palette: Instrument Panel ──────────────────────────────────────
// Near-monochrome with warm amber accent. Neutral undertones only.

// Surfaces
pub const COLOR_SURFACE: Color = Color::Rgb(16, 17, 20);
pub const COLOR_SURFACE_RAISED: Color = Color::Rgb(26, 28, 32);
pub const COLOR_BORDER: Color = Color::Rgb(50, 54, 60);

// Text
pub const COLOR_TEXT: Color = Color::Rgb(200, 204, 210);
pub const COLOR_DIM: Color = Color::Rgb(90, 95, 105);
pub const COLOR_MUTED: Color = Color::Rgb(130, 135, 142);

// Accent — warm amber, the only "loud" color
pub const COLOR_ACCENT: Color = Color::Rgb(218, 172, 74);

// Semantic entity colors — desaturated, harmonized
pub const COLOR_AGENT: Color = Color::Rgb(185, 148, 108);
pub const COLOR_MODEL: Color = Color::Rgb(125, 158, 180);
pub const COLOR_SCENARIO: Color = Color::Rgb(138, 168, 128);

// Status — muted, not screaming
pub const COLOR_GOOD: Color = Color::Rgb(96, 176, 116);
pub const COLOR_WARN: Color = Color::Rgb(200, 168, 78);
pub const COLOR_BAD: Color = Color::Rgb(196, 98, 88);

// ── Style helpers ──────────────────────────────────────────────────

pub fn style_tab_active() -> Style {
    Style::default()
        .fg(COLOR_ACCENT)
        .add_modifier(Modifier::BOLD)
}

pub fn style_tab_inactive() -> Style {
    Style::default().fg(COLOR_DIM)
}

pub fn style_header() -> Style {
    Style::default()
        .fg(COLOR_TEXT)
        .add_modifier(Modifier::BOLD)
}

pub fn style_key_hint() -> Style {
    Style::default().fg(COLOR_ACCENT)
}

pub fn style_dim() -> Style {
    Style::default().fg(COLOR_DIM)
}

pub fn style_muted() -> Style {
    Style::default().fg(COLOR_MUTED)
}

pub fn style_surface() -> Style {
    Style::default().bg(COLOR_SURFACE)
}

/// Minimal section block — top border only, no box. Title in accent.
pub fn style_block<'a>(title: &'a str) -> Block<'a> {
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(COLOR_BORDER))
        .style(Style::default().bg(COLOR_SURFACE))
        .padding(Padding::horizontal(1));
    if title.is_empty() {
        block
    } else {
        block
            .title(format!(" {} ", title))
            .title_style(Style::default().fg(COLOR_MUTED))
    }
}

pub fn style_status_bar() -> Style {
    Style::default()
        .fg(COLOR_DIM)
        .bg(COLOR_SURFACE_RAISED)
}

pub fn score_color(pct: f64) -> Color {
    if pct >= 80.0 {
        COLOR_GOOD
    } else if pct >= 60.0 {
        COLOR_WARN
    } else {
        COLOR_BAD
    }
}
