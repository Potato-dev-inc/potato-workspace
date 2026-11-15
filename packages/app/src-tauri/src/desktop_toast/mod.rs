//! Windows desktop notifications for what needs you, with buttons.
//!
//! When something needs the person and the app is not in front, a toast says so. The buttons follow the
//! phone's rules (`push::hub::buttons_for`): a calm command approval gets Allow / Deny, a plain yes / no
//! question gets Yes / No, everything risky or unclear gets only Open. A button answers through the same
//! `attention::answer` route as the phone card, with its audit line; Open brings the app forward on that
//! chat. The bells, quiet hours and snooze (`notify_levels`) decide first, and "Notifications on this PC"
//! (Settings) turns the whole thing off.
//!
//! Flow: `push::dispatch` -> [`offer`] -> `rules` (buttons, words, one-time grants) -> `win::show`.
//! A button is a `potato-workspace://toast/<act>/<nonce>` link: Windows starts the protocol handler, the
//! single-instance plugin hands it to the running app (`deep_link::deliver`) and `activate` decides.
//!
//! Only an installed build has the AppUserModelID Windows needs (the bundle identifier, set on the Start
//! menu shortcut by the installer), so a debug build, a named profile and other systems show no toast.

pub mod activate;
pub mod rules;
#[cfg(windows)]
mod win;

#[cfg(test)]
mod tests;

use crate::push::hub::Candidate;
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use rules::{Act, Grant, Grants, Shown, Spec};

/// The AppUserModelID of the installed app: the bundle identifier (`tauri.conf.json`).
pub const AUMID: &str = "com.potatodev.workspace";

static APP: OnceCell<tauri::AppHandle> = OnceCell::new();
static GRANTS: Lazy<Mutex<Grants>> = Lazy::new(|| Mutex::new(Grants::default()));
static SHOWN: Lazy<Mutex<Shown>> = Lazy::new(|| Mutex::new(Shown::default()));

pub(crate) fn grants() -> &'static Mutex<Grants> {
    &GRANTS
}

/// Remember the app (call once from `setup`).
pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// Can this build show a toast at all?
pub fn available() -> bool {
    cfg!(windows) && !cfg!(debug_assertions) && crate::app_paths::profile().is_none()
}

/// A toast would be shown for a needs-you alert right now (the switch is on, the build can).
pub fn listening() -> bool {
    available() && APP.get().is_some() && crate::notify_levels::store().get().desktop_toasts
}

#[cfg(not(test))]
fn app_in_front() -> bool {
    use tauri::Manager;
    APP.get().is_some_and(|app| app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false)))
}

/// The unit tests never show a window, and a test binary that reaches the real window code needs the Windows
/// common-controls manifest the test harness does not have (it would not start).
#[cfg(test)]
fn app_in_front() -> bool {
    false
}

/// What a candidate is about, to tell "the same thing again" from "a new thing".
fn subject(candidate: &Candidate) -> String {
    candidate
        .item
        .as_ref()
        .map(|i| format!("{}:{}", i.id, i.occurrence))
        .or_else(|| candidate.prompt.as_ref().map(|p| p.prompt_id.clone()).filter(|id| !id.is_empty()))
        .unwrap_or_else(|| candidate.kind.as_str().to_string())
}

/// Hook for `push::dispatch`, after the notification levels said yes: toast it on its own thread when the app is
/// not in front.
pub fn offer(candidate: &Candidate) {
    if !listening() || !rules::wants_toast(candidate.kind) || app_in_front() {
        return;
    }
    let now = crate::push::now_ms();
    if !SHOWN.lock().admit(&candidate.key, &subject(candidate), now) {
        return;
    }
    let spec = build(candidate, now, &mut GRANTS.lock(), rules::new_nonce);
    let spawned = std::thread::Builder::new().name("desktop-toast".into()).spawn(move || show_spec(&spec));
    drop(spawned);
}

/// The toast for a candidate, and the grants its buttons redeem. Pure but for the nonce source.
pub fn build(candidate: &Candidate, now_ms: u64, grants: &mut Grants, mut nonce: impl FnMut() -> String) -> Spec {
    let words = rules::words(candidate);
    let (title, lines) = rules::lines(&words);
    let acts = rules::buttons(candidate);
    let group = nonce();
    let item = candidate.item.as_ref();
    let yes_no = item.and_then(|i| i.yes_no.as_ref());
    let mut issue = |act: Act| {
        let choice = match act {
            Act::Allow => Some("allow_once".to_string()),
            Act::Deny => Some("deny".to_string()),
            Act::Yes => yes_no.map(|p| p.yes.clone()),
            Act::No => yes_no.map(|p| p.no.clone()),
            Act::Open => None,
        };
        let token = nonce();
        grants.add(
            token.clone(),
            Grant {
                act,
                group: group.clone(),
                item_id: item.map(|i| i.id.clone()).unwrap_or_default(),
                pane_id: candidate.pane_id.clone(),
                prompt_id: candidate.prompt.as_ref().map(|p| p.prompt_id.clone()).unwrap_or_default(),
                occurrence: item.map(|i| i.occurrence).unwrap_or(0),
                fingerprint: item.map(|i| i.fingerprint.clone()).unwrap_or_default(),
                choice,
                expires_ms: now_ms + rules::GRANT_TTL_MS,
            },
            now_ms,
        );
        rules::link(act, &token)
    };
    let buttons: Vec<(Act, String)> = acts.iter().map(|act| (*act, issue(*act))).collect();
    // Clicking the toast itself opens the app, unless Open is already a button (then it is the same thing).
    let open_link = match buttons.iter().find(|(act, _)| *act == Act::Open) {
        Some((_, link)) => link.clone(),
        None => issue(Act::Open),
    };
    let tag: String = format!("pm-{}", candidate.key).chars().take(64).collect();
    Spec { tag, title, lines, buttons, open_link }
}

fn show_spec(spec: &Spec) {
    #[cfg(windows)]
    {
        let xml = rules::toast_xml(spec);
        if let Err(e) = win::show(&xml, Some(&spec.tag)) {
            tracing::warn!(error = %e, "desktop toast: could not show it");
        }
    }
    #[cfg(not(windows))]
    let _ = spec;
}

/// A short message toast (the result of a button press).
pub(crate) fn show_note(text: &str) {
    #[cfg(windows)]
    if available() {
        if let Err(e) = win::show(&rules::note_xml(text), None) {
            tracing::debug!(error = %e, "desktop toast: could not show a note");
        }
    }
    #[cfg(not(windows))]
    let _ = text;
}

/// The pane left the state its toast was about (`push::notify_pane_status`): its buttons stop working, and the
/// same thing asked again is toasted again.
pub fn note_pane_status(pane_id: &str, status: &str) {
    if status != "waiting_input" {
        GRANTS.lock().drop_pane(pane_id);
    }
    if status != "waiting_input" && status != "error" {
        SHOWN.lock().forget(pane_id);
    }
}

/// Links the OS handed to the app (`deep_link::deliver`). Returns true when one of them was a toast link:
/// those are handled here, on their own thread, and never open anything else.
pub fn handle_links<S: AsRef<str>>(app: &tauri::AppHandle, urls: &[S]) -> bool {
    let mine: Vec<String> = urls.iter().map(|u| u.as_ref().to_string()).filter(|u| rules::is_toast_link(u)).collect();
    if mine.is_empty() {
        return false;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("toast-activate".into()).spawn(move || {
        let env = activate::LiveEnv { app };
        for url in mine {
            let outcome = activate::activate(&env, &url);
            tracing::info!(?outcome, "desktop toast: a button was pressed");
        }
    });
    drop(spawned);
    true
}
