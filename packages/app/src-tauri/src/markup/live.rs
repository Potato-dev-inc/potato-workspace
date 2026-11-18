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
use crate::point::message_marks::{self, Intent, MarkIn, PageIs};
use crate::point::target::{self, TargetFacts};
use crate::point::window::{ask_text, target_facts};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Webview};

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
pub fn tick(app: &AppHandle, preview_id: &str, key: &str, window: &Webview, st: &mut Loop) {
    let Some(raw) = ask_text(window, bar::call(key, "take", "")) else { return };
    for event in bar::parse_events(&raw) {
        match event {
            Event::Open => opened(app, preview_id, key, window, st),
            Event::Close => closed(preview_id, st),
            Event::NewAgent => new_agent(app),
            Event::Prepare { marks, area, vw } => prepare(app, preview_id, key, window, st, &bar::clean_marks(&marks), area.h, vw),
            Event::Send { request, marks, to, fix } => send(app, preview_id, key, window, st, &request, &bar::clean_marks(&marks), &to, fix),
        }
    }
}

fn push(window: &Webview, key: &str, view: Value) {
    let _ = window.eval(bar::set_script(key, &view));
}

fn opened(app: &AppHandle, preview_id: &str, key: &str, window: &Webview, st: &mut Loop) {
    st.open = true;
    st.we_paused = crate::browser::live::pause_for_markup(preview_id, true, false) || st.we_paused;
    let theme = crate::settings_store::read_public_settings(app).get("theme").and_then(Value::as_str).map(str::to_string).unwrap_or_default();
    let owner = owner_target(app, preview_id, window);
    let state = app.state::<AppState>();
    let infos = state.registry.lock().list();
    let facts = target_facts(&state.registry, &infos);
    let (rows, default) = super::targets::rows(&facts, &infos, owner.as_ref().map(|t| t.pane_id.as_str()));
    let targets: Vec<Value> = rows
        .iter()
        .map(|r| json!({ "id": r.id, "agent": r.agent_id, "name": r.name, "task": r.task, "project": r.project, "status": r.status, "ok": r.ok, "reason": r.reason }))
        .collect();
    push(
        window,
        key,
        json!({
            "theme": if theme == "light" { "light" } else { "dark" },
            "less": super::less_motion(),
            "owner": owner.as_ref().map(|t| format!("{} \u{b7} {}", t.agent_label, t.title)),
            "targets": targets,
            "to": owner.as_ref().map(|t| t.pane_id.clone()).or(default),
            "ownerId": owner.as_ref().map(|t| t.pane_id.clone()),
        }),
    );
}

/// "New agent" in the bar's list: show the New agent page in the main window.
fn new_agent(app: &AppHandle) {
    use tauri::Emitter;
    crate::app_windows::open_cockpit_window(app, None, true);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        let _ = app.emit("cockpit://view", json!({ "view": "newagent" }));
    });
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
fn owner_target(app: &AppHandle, preview_id: &str, window: &Webview) -> Option<TargetFacts> {
    let here = ask_text(window, "location.href".to_string()).unwrap_or_default();
    let pane = crate::artifacts::owner_of(&here).map(|(pane, _)| pane).or_else(|| crate::browser::live::owner_pane(preview_id))?;
    target_of(&app.state::<AppState>(), &pane).ok()
}

/// The picture for the send row. The bar hides itself and blanks secret boxes, the window is captured, the bar comes back.
#[allow(clippy::too_many_arguments)]
fn prepare(app: &AppHandle, preview_id: &str, key: &str, window: &Webview, st: &mut Loop, _marks: &[MarkIn], height: f64, vw: f64) {
    let shown = |on: bool| {
        let _ = window.eval(bar::call(key, "shoot", if on { "true" } else { "false" }));
    };
    let Some(target) = owner_target(app, preview_id, window).or_else(|| default_target(app)) else {
        tracing::warn!(preview = %preview_id, "markup: no chat to keep the picture for");
        return push(window, key, json!({ "taking": false, "noPicture": true }));
    };
    // A page the agent made is the project's own: the bar hides its Ask / Fix choice there.
    let own_page = ask_text(window, "location.href".to_string()).is_some_and(|here| crate::artifacts::owner_of(&here).is_some());
    push(window, key, json!({ "ownPage": own_page }));
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
        Err(why) => {
            tracing::warn!(preview = %preview_id, "markup: the picture could not be taken: {why}");
            push(window, key, json!({ "taking": false, "noPicture": true }))
        }
    }
}

/// The default pane of the "To:" list for a window nobody owns.
fn default_target(app: &AppHandle) -> Option<TargetFacts> {
    let state = app.state::<AppState>();
    let infos = state.registry.lock().list();
    let facts = target_facts(&state.registry, &infos);
    // `target::targets` names no default without an opener or a folder, so a window nobody owns never had a chat to keep
    // its picture for ("The picture could not be taken"). The picture only needs a project folder to be filed in.
    let (list, _) = target::targets(&facts, None, None);
    let keeper = super::targets::keeper(&list)?;
    facts.into_iter().find(|t| t.pane_id == keeper)
}

#[allow(clippy::too_many_arguments)]
fn send(app: &AppHandle, preview_id: &str, key: &str, window: &Webview, st: &mut Loop, request: &str, marks: &[MarkIn], to: &str, fix: bool) {
    let fail = |why: String| push(window, key, json!({ "status": why }));
    let state = app.state::<AppState>();
    // The person's pick wins; with none, the chat that owns the page.
    let picked = if to.trim().is_empty() { None } else { Some(target_of(&state, to)) };
    let target = match picked {
        Some(Ok(t)) => t,
        Some(Err(why)) => return fail(why),
        None => match owner_target(app, preview_id, window) {
            Some(t) => t,
            None => return fail("Choose an agent to send to.".to_string()),
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
    let composed = match message_marks::compose_parts(&title, &page, &marks, request, if fix { Intent::Fix } else { Intent::Ask }) {
        Ok(c) => c,
        Err(why) => return fail(why),
    };
    // The picture belongs to the window, not to one agent: it goes with the message to whoever was picked.
    let waiting = st.waiting.as_ref().and_then(|(pane, id)| store::get(pane, id)).map(|w| refile(w, &target.cwd, st.seq));
    let (text, attachments) = with_picture(&target, waiting.as_ref(), &composed.text);
    // The chat screen folds this exact message into one card. It is told before the message goes, so the card is ready when the message shows.
    let _ = app.emit("markup://sent", json!({ "paneId": target.pane_id, "text": text, "head": composed.head, "comment": composed.comment, "page": composed.page, "marks": marks.len() }));
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

/// The picture was filed in the project of the agent that was first in the list when it was taken. When the person picked an
/// agent of another project, the picture is copied into that project, so the path in the message is one the agent can open.
fn refile(w: store::Waiting, cwd: &str, seq: u32) -> store::Waiting {
    if w.abs_path.starts_with(cwd) {
        return w;
    }
    let copied = std::fs::read(&w.abs_path).ok().and_then(|png| shot::save(std::path::Path::new(cwd), &png, audit::now_ms(), seq).ok());
    match copied {
        Some((abs_path, rel_path)) => store::Waiting { abs_path, rel_path, ..w },
        None => w,
    }
}

/// The window is gone: give the page back if this bar had paused the agent, and forget the picture.
pub fn end(preview_id: &str, st: &mut Loop) {
    closed(preview_id, st);
}
