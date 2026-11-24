//! "Save chat as page" and "Save as Markdown" (the chat's header menu): the pane's chat as one self-contained HTML
//! file, or as one Markdown file. The text is shown in a preview and written where the person picks. Desktop only;
//! nothing is uploaded, and nothing here is reachable through the bridge, the phone or MCP. A paired PC may ask for the text of a chat
//! it may watch (`pclink::calls_p4a`, no token, 5 MB at most); it never writes a file here: the Save dialog is on the asking PC.

use super::session_chat::SessionChatState;
use super::AppState;
use crate::redact::RedactContext;
use crate::session_chat::export::{self, Meta, TurnRange};
use crate::session_chat::export_save::PageKind;
use crate::session_chat::model::ChatItem;
use crate::session_chat::{Hold, Opening};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};

const NO_SOURCE: &str = "Chat is not available for this pane: it has no agent to read a conversation from.";
/// The export holds the pane's reader only while it reads the items; it lets go at once.
const HOLDER: &str = "chat-export";
const HOLD_FOR: Duration = Duration::from_secs(30);

/// A chat page for the preview, and the one-time token that saves exactly this page (`chat_export_save`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPage {
    pub html: String,
    pub token: String,
}

/// A chat as Markdown for the preview, and the one-time token that saves exactly this file (`chat_export_save`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMarkdown {
    pub markdown: String,
    pub token: String,
}

/// The items of a pane's chat, read once, with the pane's agent type and folder. `holder` names the lease that keeps
/// the reader open while it reads; it lets go at once. Shared by the chat exports.
pub(crate) async fn read_items(
    app: &AppHandle,
    state: &AppState,
    chat: &SessionChatState,
    pane_id: &str,
    holder: &'static str,
) -> Result<(Vec<ChatItem>, String, String), String> {
    let watchers = chat.watchers(app, &state.registry);
    let registry = state.registry.clone();
    let pane = pane_id.to_string();
    tauri::async_runtime::spawn_blocking(move || read_items_blocking(&watchers, &registry, &pane, holder)).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// The blocking body of `read_items`, also run for a paired PC (`pclink::calls_p4a`, which is already on a blocking thread).
pub(crate) fn read_items_blocking(
    watchers: &Arc<crate::session_chat::Watchers>,
    registry: &Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>,
    pane_id: &str,
    holder: &str,
) -> Result<(Vec<ChatItem>, String, String), String> {
    let (agent_type, cwd) = {
        let registry = registry.lock();
        let pane = registry.get(pane_id).ok_or_else(|| format!("unknown pane: {pane_id}"))?;
        (pane.info.agent_type.clone(), pane.info.cwd.clone())
    };
    let opening = Opening::for_pane(pane_id, &agent_type).ok_or_else(|| NO_SOURCE.to_string())?;
    opening.open(watchers, pane_id, Hold::lease(holder, HOLD_FOR));
    let items = watchers.since(pane_id, None, usize::MAX).map(|delta| delta.items).unwrap_or_default();
    watchers.close(pane_id, holder);
    Ok((items, agent_type, cwd))
}

/// The chat of a pane, read once: its items, the header facts and the redaction context they were made with.
pub(crate) fn gather_blocking(
    watchers: &Arc<crate::session_chat::Watchers>,
    registry: &Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>,
    pane_id: &str,
) -> Result<(Vec<ChatItem>, Meta, Arc<RedactContext>), String> {
    let (items, agent_type, cwd) = read_items_blocking(watchers, registry, pane_id, HOLDER)?;
    let ctx = crate::redact::known::context();
    let meta = Meta {
        agent: crate::ambient::agent_label(&agent_type),
        folder: export::folder_of(&cwd, ctx.home.as_deref()),
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
    };
    Ok((items, meta, ctx))
}

/// The chat as one HTML page (`html: true`) or one Markdown file, in `range`. Both the window's commands and a paired PC's export rows
/// make the text here, so the file is the same whoever asks.
pub(crate) fn export_text(
    watchers: &Arc<crate::session_chat::Watchers>,
    registry: &Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>,
    pane_id: &str,
    html: bool,
    range: TurnRange,
    title: Option<&str>,
) -> Result<String, String> {
    range.check()?;
    let (items, mut meta, ctx) = gather_blocking(watchers, registry, pane_id)?;
    // The page is headed with the chat's own name ("Claude 8"), not just the agent's ("Claude").
    if let Some(name) = title.map(|t| t.trim().chars().filter(|c| !c.is_control()).take(80).collect::<String>()).filter(|t| !t.is_empty()) {
        meta.agent = name;
    }
    Ok(if html { export::page(&items, &meta, range, &ctx) } else { crate::session_chat::export_md::markdown(&items, &meta, range, &ctx) })
}

/// The chat of a pane as one HTML page (see `session_chat::export`). `from_turn` / `to_turn` keep those turns
/// (inclusive, numbered by the person's messages); both optional.
#[tauri::command]
pub async fn chat_export_html(
    app: AppHandle,
    state: State<'_, AppState>,
    chat: State<'_, SessionChatState>,
    pane_id: String,
    from_turn: Option<u32>,
    to_turn: Option<u32>,
    title: Option<String>,
) -> Result<ExportPage, String> {
    let html = export_async(&app, &state, &chat, &pane_id, true, from_turn, to_turn, title).await?;
    let token = chat.pages().keep(&pane_id, PageKind::Html, &html)?;
    Ok(ExportPage { html, token })
}

/// The chat of a pane as one Markdown file (see `session_chat::export_md`). Same turn range as the page.
#[tauri::command]
pub async fn chat_export_markdown(
    app: AppHandle,
    state: State<'_, AppState>,
    chat: State<'_, SessionChatState>,
    pane_id: String,
    from_turn: Option<u32>,
    to_turn: Option<u32>,
    title: Option<String>,
) -> Result<ExportMarkdown, String> {
    let markdown = export_async(&app, &state, &chat, &pane_id, false, from_turn, to_turn, title).await?;
    let token = chat.pages().keep(&pane_id, PageKind::Markdown, &markdown)?;
    Ok(ExportMarkdown { markdown, token })
}

async fn export_async(app: &AppHandle, state: &AppState, chat: &SessionChatState, pane_id: &str, html: bool, from_turn: Option<u32>, to_turn: Option<u32>, title: Option<String>) -> Result<String, String> {
    let range = TurnRange { from: from_turn, to: to_turn };
    range.check()?;
    let watchers = chat.watchers(app, &state.registry);
    let registry = state.registry.clone();
    let pane = pane_id.to_string();
    tauri::async_runtime::spawn_blocking(move || export_text(&watchers, &registry, &pane, html, range, title.as_deref())).await.map_err(|e| format!("INTERNAL: {e}"))?
}

/// Writes the page or Markdown file the preview showed to `path`, a place the save dialog returned. The text is not
/// sent back by the window: it is the one Rust made and kept under `token` (see `session_chat::export_save`), so only
/// that text can be written, once, under a name of its own kind. Returns the path written.
#[tauri::command]
pub async fn chat_export_save(chat: State<'_, SessionChatState>, token: String, path: String) -> Result<String, String> {
    chat.pages().save(&token, &path).map(|dest| dest.to_string_lossy().to_string())
}
