//! The mark-up bar's PC side: take the picture of a window's page area, keep it for the send, and send one message with
//! one picture to the chat that owns the page.
//!
//! Decisions (design: `design-1117/MARKUP-BAR.md`):
//! 1. The page never takes the picture. The app asks WebView2 for the window it is in (`point::capture`), so only that
//!    window is in it: never another window or the desktop.
//! 2. The picture is cropped to the page area, saved as `mark-<time>-<n>.png` in `<project>/.potato-workspace/shots/`
//!    (names made here, never taken from the window), and the newest 50 are kept.
//! 3. The window only ever holds a short id (`shot_id`) for a picture. It never names a path.
//! 4. Nothing sends itself. `markup_send` runs only when the person pressed Send in the bar's send row.
//! 5. A chat agent gets the picture as an attachment; a terminal agent gets its file name in the text.
//! 6. The text is composed by the window (`lib/markup/model.ts`) and by `point::message::compose_marks` for the agent
//!    browser; one golden test pins both to the same words.

use std::sync::atomic::{AtomicBool, Ordering};

/// The app's "Less motion" switch (Look and feel), told to us by the window (`markup_less_motion`), so the bar inside the
/// agent browser's window can follow it too. The system setting is read by the bar itself.
static LESS_MOTION: AtomicBool = AtomicBool::new(false);

pub fn set_less_motion(on: bool) {
    LESS_MOTION.store(on, Ordering::Relaxed);
}

pub fn less_motion() -> bool {
    LESS_MOTION.load(Ordering::Relaxed)
}

pub mod bar;
pub mod live;
pub mod shot;
pub mod store;
pub mod targets;

#[cfg(test)]
mod tests;
