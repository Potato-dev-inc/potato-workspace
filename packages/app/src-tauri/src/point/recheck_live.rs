//! The windows side of "Check it again" (N5-21): wait for the chat agent's turn to end, reload the preview, shoot the
//! same element again and show the before and after strip in the Point box. The rules live in `recheck.rs`.
//!
//! The preview window is the one `window.rs` opened; nothing here makes a window of its own, so the later agent
//! browser can reuse the same preview window.

use super::recheck::{self, Delivery, Pending, RecheckView, TurnHost, Wait};
use super::session::SESSION;
use super::window;
use super::{box_window, shot};
use crate::pane_outbox;
use crate::pty::PaneRegistry;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Webview};

/// After a reload, how often and how long to look for the element again.
const LOCATE_EVERY: Duration = Duration::from_millis(500);
const LOCATE_LOOKS: u32 = 24;
/// The sentences the strip can carry.
const PREVIEW_CLOSED: &str = "The preview is closed. Open it again to check.";
const NOT_FOUND: &str = "The page loaded, but that element is not there now.";
const NO_PICTURE: &str = "The page loaded, but the picture could not be taken.";

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The sent message and the chat, as the wait sees them.
struct LiveTurn {
    app: AppHandle,
    registry: Arc<Mutex<PaneRegistry>>,
    pane_id: String,
    message_id: String,
}

impl TurnHost for LiveTurn {
    fn delivery(&self) -> Delivery {
        let list = pane_outbox::global(&self.registry).list(&self.pane_id);
        match list.into_iter().find(|m| m.id == self.message_id) {
            None => Delivery::Lost,
            Some(m) if matches!(m.state, pane_outbox::State::Failed | pane_outbox::State::Cancelled) => Delivery::Lost,
            Some(m) if m.state.active() => Delivery::Waiting,
            Some(_) => Delivery::Delivered,
        }
    }

    fn busy(&self) -> Option<bool> {
        let chat = crate::acp::chat::get(&self.pane_id)?;
        Some(chat.readiness() == crate::acp::chat::Readiness::Busy)
    }
}

/// Starts the wait for the end of the agent's turn. Replaces any recheck that was waiting.
pub fn start(app: &AppHandle, registry: Arc<Mutex<PaneRegistry>>, pending: Pending, pane_id: String, message_id: String) {
    let generation = recheck::begin(pending);
    let app = app.clone();
    std::thread::spawn(move || {
        let host = LiveTurn { app: app.clone(), registry, pane_id, message_id };
        let wait = recheck::wait_for_turn_end(&host, recheck::Timing::default(), &|| recheck::is_current(generation));
        if wait == Wait::Ended && recheck::is_current(generation) {
            run(&app);
        }
    });
}

/// Reloads the preview, shoots the element again and shows the strip. Safe to call again ("Check again").
pub fn run(app: &AppHandle) {
    let Some(pending) = recheck::pending() else { return };
    publish(app, &pending, None, None, true);
    let Some(window) = window::preview_window(app, &pending.preview_id) else {
        return publish(app, &pending, None, Some(PREVIEW_CLOSED), false);
    };
    let _ = window.eval("location.reload()");
    // The page starts over: give it a moment before the first look.
    std::thread::sleep(Duration::from_millis(1_200));
    let (after, note) = match shoot(&window, &pending) {
        Ok(path) => (Some(path), None),
        Err(note) => (None, Some(note)),
    };
    publish(app, &pending, after, note, false);
    show_box(app, &window);
}

/// The element after the reload, saved as a screenshot in the project's shots folder (its path).
fn shoot(window: &Webview, pending: &Pending) -> Result<std::path::PathBuf, &'static str> {
    let mut found = None;
    for look in 0..LOCATE_LOOKS {
        if look > 0 {
            std::thread::sleep(LOCATE_EVERY);
        }
        if let Some(text) = window::ask_text(window, recheck::locate_script(&pending.selector)) {
            if let Some(located) = recheck::parse_located(&text) {
                found = Some(located);
                break;
            }
        }
    }
    let (rect, viewport) = found.ok_or(NOT_FOUND)?;
    let png = window::capture_png(window).map_err(|_| NO_PICTURE)?;
    let (bytes, _, _) = shot::crop(&png, rect, viewport, 24.0).map_err(|_| NO_PICTURE)?;
    let seq = SESSION.lock().next_seq();
    let (abs, _rel) = shot::save(&pending.project, &bytes, now_ms(), seq).map_err(|_| NO_PICTURE)?;
    shot::prune(&shot::shots_dir(&pending.project), super::KEEP_SHOTS);
    Ok(abs)
}

/// Stores the strip and tells the Point box.
fn publish(app: &AppHandle, pending: &Pending, after: Option<std::path::PathBuf>, note: Option<&str>, busy: bool) {
    let thumb = |p: &std::path::PathBuf| std::fs::read(p).ok().and_then(|b| shot::thumb_data_url(&b));
    let view = RecheckView {
        agent: pending.agent.clone(),
        label: pending.label.clone(),
        before: pending.before.as_ref().and_then(thumb),
        after: after.as_ref().and_then(thumb),
        note: note.map(str::to_string),
        busy,
    };
    recheck::set_view(Some(view));
    box_window::emit_state(app, &window::current_state(app));
}

/// Shows the box beside the preview window.
fn show_box(app: &AppHandle, window: &Webview) {
    let Some(rect) = window::view_box(window) else { return };
    box_window::show_near(app, rect);
    box_window::emit_state(app, &window::current_state(app));
}

/// The person closed the strip.
pub fn dismiss(app: &AppHandle) {
    recheck::clear();
    box_window::emit_state(app, &window::current_state(app));
    box_window::hide(app);
}
