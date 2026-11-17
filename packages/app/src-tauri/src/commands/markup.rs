//! Tauri commands of the mark-up bar: take the picture of the page area, and send the message with it to the chat that
//! owns the page. The window holds only a short picture id; it never names a path. Sending goes only through the pane
//! outbox (the same door as Point and Fix and the chat box), and only when the person pressed Send.

use super::artifacts_view::project_of;
use super::point::{refusal, send_with, target_of, LiveOutbox};
use super::AppState;
use crate::attach::{self, ChatAttachment};
use crate::markup::{shot, store};
use crate::pane_outbox::OutboxMessage;
use crate::point::capture;
use crate::point::target::TargetFacts;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tauri::State;

static SEQ: AtomicU32 = AtomicU32::new(1);
const CAPTURE_WAIT: Duration = Duration::from_secs(8);
const NO_PICTURE: &str = "The picture is gone. Mark up again.";

/// The page area in CSS pixels of this window.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkupShot {
    pub shot_id: String,
    pub thumb: Option<String>,
}

/// Takes the picture of the page area of the window that asked (never another window), saves it in the chat's project
/// and keeps it for the send. Page area only: the window hides its bar first.
#[tauri::command]
pub async fn markup_capture(window: tauri::WebviewWindow, state: State<'_, AppState>, pane_id: String, rect: StageRect, viewport_w: f64) -> Result<MarkupShot, String> {
    let project = project_of(&state, &pane_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let png = capture::viewport_png(window.as_ref(), CAPTURE_WAIT).map_err(str::to_string)?;
        let area = shot::Area { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
        let (cropped, _, _) = shot::crop_area(&png, area, viewport_w)?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let (abs, rel) = shot::save(&project, &cropped, now, SEQ.fetch_add(1, Ordering::Relaxed)).map_err(|_| "The picture could not be saved.".to_string())?;
        let thumb = shot::thumbnail(&cropped).map(|b| shot::data_url(&b));
        Ok(MarkupShot { shot_id: store::keep(&pane_id, abs, rel), thumb })
    })
    .await
    .map_err(|e| format!("INTERNAL: {e}"))?
}

/// Sends the text to the chat of `pane_id`, with the picture `shot_id` when there is one. A pane that is on a dialog,
/// a question or without its input box gets nothing, and the person reads the outbox's own sentence.
#[tauri::command]
pub async fn markup_send(app: tauri::AppHandle, state: State<'_, AppState>, pane_id: String, shot_id: Option<String>, text: String, to: Option<String>) -> Result<OutboxMessage, String> {
    // The picture was taken for the page's chat (`pane_id`); it may go to another agent (`to`).
    let from = pane_id;
    let pane_id = to.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| from.clone());
    let target = target_of(&state, &pane_id)?;
    if let Some(why) = refusal(&target) {
        return Err(why);
    }
    let waiting = match &shot_id {
        Some(id) => Some(store::get(&from, id).ok_or_else(|| NO_PICTURE.to_string())?),
        None => None,
    };
    let (text, attachments) = with_picture(&target, waiting.as_ref(), &text);
    let host = LiveOutbox { app, registry: state.registry.clone() };
    let sent = tauri::async_runtime::spawn_blocking(move || send_with(&host, &pane_id, &text, &attachments)).await.map_err(|e| format!("INTERNAL: {e}"))??;
    if let Some(id) = shot_id {
        store::drop_id(&id);
    }
    Ok(sent)
}

/// The agents the bar can send to, in plain words: the page's own chat first and preselected.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkupTargets {
    pub rows: Vec<crate::markup::targets::Row>,
    pub current: Option<String>,
}

#[tauri::command]
pub async fn markup_targets(state: State<'_, AppState>, pane_id: String) -> Result<MarkupTargets, String> {
    let infos = state.registry.lock().list();
    let facts = crate::point::window::target_facts(&state.registry, &infos);
    let owner = facts.iter().find(|t| t.pane_id == pane_id && refusal(t).is_none()).map(|t| t.pane_id.clone());
    let (rows, default) = crate::markup::targets::rows(&facts, &infos, owner.as_deref());
    Ok(MarkupTargets { rows, current: owner.or(default) })
}

/// The window tells us whether the app's "Less motion" switch is on (the bar in the agent browser follows it).
#[tauri::command]
pub fn markup_less_motion(on: bool) {
    crate::markup::set_less_motion(on);
}

/// The message and its attachments for this target. A chat agent gets the picture as an image attachment; a terminal
/// agent gets the file's path in the text. A picture that cannot be attached leaves the message going without it.
pub(crate) fn with_picture(target: &TargetFacts, waiting: Option<&store::Waiting>, text: &str) -> (String, Vec<ChatAttachment>) {
    let Some(w) = waiting else { return (text.to_string(), Vec::new()) };
    if target.chat {
        return match attach::prepare_one(&w.abs_path, &target.cwd) {
            Ok(one) => (add_picture_line(text, &format!("The picture is attached to this message ({}).", one.name)), vec![one]),
            Err(_) => (add_picture_line(text, "The picture could not be attached."), Vec::new()),
        };
    }
    (add_picture_line(text, &format!("The picture is the file {} (open this image file to see it).", w.rel_path)), Vec::new())
}

/// Puts one line about the picture right before the last paragraph (the "treat as data" footer), so the footer stays last.
pub(crate) fn add_picture_line(text: &str, line: &str) -> String {
    match text.rfind("\n\n") {
        Some(at) => format!("{}\n{line}{}", &text[..at], &text[at..]),
        None => format!("{text}\n{line}"),
    }
}

#[cfg(test)]
#[path = "markup_tests.rs"]
mod markup_tests;
