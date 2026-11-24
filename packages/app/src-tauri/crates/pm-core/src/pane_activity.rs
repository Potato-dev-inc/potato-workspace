//! The visible tail of a screen (moved out of the app's `pane_activity`, which re-exports it).

pub const TAIL_LINES: usize = 24;

/// The last `TAIL_LINES` non-empty lines of a screen.
pub fn visible_tail(screen: &str) -> String {
    let mut lines: Vec<&str> = screen.lines().filter(|l| !l.trim().is_empty()).rev().take(TAIL_LINES).collect();
    lines.reverse();
    lines.join("\n")
}

