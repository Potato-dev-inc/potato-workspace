//! The mark-up bar's live side in the agent browser's window: carries what the person does on the bar (open, close,
//! "Send to chat") out of the page, pauses the agent while they mark up, takes the picture, and sends one message with
//! one picture to the chat. Called every tick of the window's browser-bar loop (`point::window::chrome_loop`), on a worker
//! thread (the picture waits for WebView2).
//!
//! * The bar and its queue live in the page's top document in a closed shadow root; Rust only pulls (`take`) and pushes
//!   (`set`). The page cannot send or fake an event: whatever arrives is cleaned here (`bar::clean_marks`).
//! * Nothing sends itself: a message goes only on the `send` event, which the bar makes only when the person presses
//!   Send (or Enter) in its send row.
//! * The picture is of this window only (`capture::viewport_png`), below the browser bar, with password, card and code
//!   boxes blanked by the bar before it is taken.

use super::bar::{self, Event};
use super::{shot, store};
use crate::audit;
use crate::browser::chrome;
use crate::commands::{refusal, send_with, target_of, with_picture, AppState, LiveOutbox};
use crate::point::capture;
use crate::point::message_marks::{self, MarkIn, PageIs};
use crate::point::target::{self, TargetFacts};
use crate::point::window::{ask_text, target_facts};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

const CAPTURE_WAIT: Duration = Duration::from_secs(8);
/// A short wait after the bar hides itself, so the picture does not catch it.
const HIDE_WAIT: Duration = Duration::from_millis(120);

/// What the loop remembers about one window between ticks.
#[derive(Default)]
pub struct Loop {
    /// This bar paused the agent (so it, and only it, gives the page back).
    we_paused: bool,
    open: bool,
    /// The picture of the last prepare: its pane and id.
    waiting: Option<(String, String)>,
    seq: u32,
}

/// One tick: pull what the bar queued and act on it.
pub fn tick(app: &AppHandle, preview_id: &str, key: &str, window: &WebviewWindow, st: &mut Loop) {
    let Some(raw) = ask_text(window, bar::call(key, "take", "")) else { return };
    for event in bar::parse_events(&raw) {
        match event {
            Event::Open => opened(app, preview_id, key, window, st),
            Event::Close => closed(preview_id, st),
            Event::Prepare { marks, area, vw } => prepare(app, preview_id, key, window, st, &bar::clean_marks(&marks), area.h, vw),
            Event::Send { request, marks, to } => send(app, preview_id, key, window, st, &request, &bar::clean_marks(&marks), &to),
        }
    }
}

fn push(window: &WebviewWindow, key: &str, view: Value) {
    let _ = window.eval(bar::set_script(key, &view));
}

fn opened(app: &AppHandle, preview_id: &str, key: &str, window: &WebviewWindow, st: &mut Loop) {
    st.open = true;
    st.we_paused = crate::browser::live::pause_for_markup(preview_id, true, false) || st.we_paused;
    let theme = crate::settings_store::read_public_settings(app).get("theme").and_then(Value::as_str).map(str::to_string).unwrap_or_default();
    let owner = owner_target(app, preview_id, window);
    let state = app.state::<AppState>();
    let infos = state.registry.lock().list();
    let facts = target_facts(&state.registry, &infos);
    let (list, default) = target::targets(&facts, owner.as_ref().map(|t| t.pane_id.as_str()), None);
    let targets: Vec<Value> = list.iter().map(|t| json!({ "id": t.pane_id, "label": format!("{} \u{b7} {}", t.agent_label, t.title), "ok": t.can_send })).collect();
    push(
        window,
        key,
        json!({
            "theme": if theme == "light" { "light" } else { "dark" },
            "less": super::less_motion(),
            "owner": owner.as_ref().map(|t| format!("{} \u{b7} {}", t.agent_label, t.title)),
            "targets": targets,
            "to": owner.as_ref().map(|t| t.pane_id.clone()).or(default),
        }),
    );
}

fn closed(preview_id: &str, st: &mut Loop) {
    st.open = false;
    if st.we_paused {
        crate::browser::live::pause_for_markup(preview_id, false, true);
        st.we_paused = false;
    }
    if let Some((_, id)) = st.waiting.take() {
        store::drop_id(&id);
    }
}

/// The chat that owns the page: the one of the artifact it shows, else the one of the agent that opened it.
fn owner_target(app: &AppHandle, preview_id: &str, window: &WebviewWindow) -> Option<TargetFacts> {
    let here = ask_text(window, "location.href".to_string()).unwrap_or_default();
    let pane = crate::artifacts::owner_of(&here).map(|(pane, _)| pane).or_else(|| crate::browser::live::owner_pane(preview_id))?;
    target_of(&app.state::<AppState>(), &pane).ok()
}

/// The picture for the send row. The bar hides itself and blanks secret boxes, the window is captured, the bar comes back.
#[allow(clippy::too_many_arguments)]
fn prepare(app: &AppHandle, preview_id: &str, key: &str, window: &WebviewWindow, st: &mut Loop, _marks: &[MarkIn], height: f64, vw: f64) {
    let shown = |on: bool| {
        let _ = window.eval(bar::call(key, "shoot", if on { "true" } else { "false" }));
    };
    let Some(target) = owner_target(app, preview_id, window).or_else(|| default_target(app)) else {
        return push(window, key, json!({ "taking": false, "noPicture": true }));
    };
    shown(true);
    std::thread::sleep(HIDE_WAIT);
    let taken = capture::viewport_png(window, CAPTURE_WAIT);
    shown(false);
    let result = taken.map_err(str::to_string).and_then(|png| {
        let area = shot::Area { x: 0.0, y: f64::from(chrome::HEIGHT), w: vw, h: height };
        let (cropped, _, _) = shot::crop_area(&png, area, vw)?;
        st.seq += 1;
        let now = audit::now_ms();
        let (abs, rel) = shot::save(std::path::Path::new(&target.cwd), &cropped, now, st.seq).map_err(|_| "The picture could not be saved.".to_string())?;
        let thumb = shot::thumbnail(&cropped).map(|b| shot::data_url(&b));
        Ok((store::keep(&target.pane_id, abs, rel), thumb))
    });
    match result {
        Ok((id, thumb)) => {
            if let Some((_, old)) = st.waiting.replace((target.pane_id.clone(), id)) {
                store::drop_id(&old);
            }
            push(window, key, json!({ "taking": false, "noPicture": false, "thumb": thumb.unwrap_or_default() }));
        }
        Err(_) => push(window, key, json!({ "taking": false, "noPicture": true })),
    }
}

/// The default pane of the "To:" list for a window nobody owns.
fn default_target(app: &AppHandle) -> Option<TargetFacts> {
    let state = app.state::<AppState>();
    let infos = state.registry.lock().list();
    let facts = target_facts(&state.registry, &infos);
    let (_, default) = target::targets(&facts, None, None);
    facts.into_iter().find(|t| Some(&t.pane_id) == default.as_ref())
}

#[allow(clippy::too_many_arguments)]
fn send(app: &AppHandle, preview_id: &str, key: &str, window: &WebviewWindow, st: &mut Loop, request: &str, marks: &[MarkIn], to: &str) {
    let fail = |why: String| push(window, key, json!({ "status": why }));
    let state = app.state::<AppState>();
    let target = match owner_target(app, preview_id, window) {
        Some(t) => t,
        None => match target_of(&state, to) {
            Ok(t) => t,
            Err(why) => return fail(why),
        },
    };
    if let Some(why) = refusal(&target) {
        return fail(why);
    }
    let here = ask_text(window, "location.href".to_string()).unwrap_or_default();
    let title = ask_text(window, "document.title".to_string()).unwrap_or_default();
    let (title, page) = match crate::artifacts::owner_of(&here) {
        Some((pane, id)) => {
            let read = state.registry.lock().get(&pane).map(|p| std::path::PathBuf::from(p.info.cwd.clone())).and_then(|project| crate::artifacts::read_for_mark(&project, &id));
            match read {
                Some((name, version)) => (name, PageIs::Artifact { id, version }),
                None => return fail("That page is not there any more.".to_string()),
            }
        }
        None => (title, PageIs::Site { url: message_marks::address_for_message(&here) }),
    };
    // The agent's own ids for the marked things, when it has read the page (a browser-only line).
    let marks: Vec<MarkIn> = marks
        .iter()
        .cloned()
        .map(|mut m| {
            if let Some(near) = &m.near {
                m.reference = crate::browser::live::ref_for(preview_id, &near.text, "");
            }
            m
        })
        .collect();
    let text = match message_marks::compose_marks(&title, &page, &marks, request) {
        Ok(t) => t,
        Err(why) => return fail(why),
    };
    let waiting = st.waiting.as_ref().filter(|(pane, _)| *pane == target.pane_id).and_then(|(pane, id)| store::get(pane, id));
    let (text, attachments) = with_picture(&target, waiting.as_ref(), &text);
    let host = LiveOutbox { app: app.clone(), registry: state.registry.clone() };
    match send_with(&host, &target.pane_id, &text, &attachments) {
        Ok(_) => {
            if let Some((_, id)) = st.waiting.take() {
                store::drop_id(&id);
            }
            push(window, key, json!({ "sent": true }));
        }
        Err(why) => fail(why),
    }
}

/// The window is gone: give the page back if this bar had paused the agent, and forget the picture.
pub fn end(preview_id: &str, st: &mut Loop) {
    closed(preview_id, st);
}
