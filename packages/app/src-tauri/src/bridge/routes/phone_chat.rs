//! The phone's chat routes (phone-acp): start a chat, pick the agent's settings, bring a closed chat back.
//!
//! - `GET /phone/new-chat`: what the new-chat screen offers: the agents that can run (each with `chat` and `terminal`,
//!   so the screen shows a Chat / Terminal choice only when both are true) and the PC's recent projects. A project has an
//!   opaque `id` and its folder name, never the path. Needs `watch` (the default of a GET).
//! - `POST /phone/chats {agent, project, lane}`: starts the chat on the PC. `project` is an `id` from the list above, so a
//!   phone can only start work in a folder the PC already knows. `lane` is `chat` or `terminal`. Needs `control` (the
//!   default of a POST). The first message is sent by the phone afterwards through the pane's message route, which checks
//!   `type` and the agent's own rule.
//! - `POST /acp/sessions/{pane}/config {option_id, value, hold?}`: the agent's model, mode or effort, the same call as the
//!   desktop's chip (`AcpChat::set_config`). Needs `control`, and the agent's own remote rule applies because the path
//!   names the pane (`pane_rules::pane_of_route`). A mode that lets the agent act with no questions asked is refused
//!   unless `hold: true` says the person pressed and held.
//! - `GET /acp/closed`: the closed chats (agent, folder name, first message). Needs `watch`.
//! - `POST /acp/closed/{id}/reopen`: the chat is live again, like the desktop's Reopen. Needs `control`; the agent's own
//!   rule applies (`pane_of_route`).
//!
//! None of these is an MCP tool, so an agent session cannot reach them (`mcp_sessions::authorize`).

use serde_json::{json, Value};
use tauri::Emitter;

use super::{Ctx, RouteResult};
use crate::acp::chat;
use crate::commands::acp_chat::live_deps;

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("GET", ["phone", "new-chat"]) => Some(new_chat_options(cx)),
        ("POST", ["phone", "chats"]) => Some(start_chat(cx)),
        ("POST", ["acp", "sessions", pane_id, "config"]) => Some(set_config(cx, pane_id)),
        ("GET", ["acp", "closed"]) => Some(closed_list()),
        ("POST", ["acp", "closed", id, "reopen"]) => Some(reopen(cx, id)),
        _ => None,
    }
}

fn bad(code: &str, message: &str) -> (u16, Value) {
    (400, json!({ "code": code, "error": message }))
}

// ---------------------------------------------------------------------------------------------------- projects

/// A stable id for a folder, so the phone names a project without the path ever leaving the PC (FNV-1a over the lowercase,
/// slash-normalised path). It is recomputed from the PC's own list on every call; nothing is stored.
pub(crate) fn project_id(path: &str) -> String {
    let normal = path.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normal.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("p{hash:016x}")
}

/// The projects the PC knows and that still exist, as `(path, name, state)`.
fn known_projects(cx: &Ctx) -> Vec<(String, String, String)> {
    let mut others = crate::operations::indexed_project_paths();
    others.push(crate::standby::default_project(cx.registry));
    let store = crate::app_paths::app_data_dir();
    crate::worktrees::folder::recent_light(&store, &others, 12)
        .into_iter()
        .filter(|p| p.state != "missing")
        .map(|p| (p.path, p.name, p.state))
        .collect()
}

/// The path behind a project id, or `None` for an id the PC does not know.
pub(crate) fn resolve_project(projects: &[(String, String, String)], id: &str) -> Option<String> {
    projects.iter().find(|(path, _, _)| project_id(path) == id).map(|(path, _, _)| path.clone())
}

// ---------------------------------------------------------------------------------------------------- new chat

/// One agent the new-chat screen lists: `chat` (a chat session can start) and `terminal` (a terminal pane can).
pub(crate) fn merge_agents(chat_agents: &[(String, String)], terminal_agents: &[(String, String)]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut add = |id: &str, label: &str, chat: bool, terminal: bool| {
        if let Some(found) = out.iter_mut().find(|row| row["id"] == id) {
            if chat {
                found["chat"] = json!(true);
            }
            if terminal {
                found["terminal"] = json!(true);
            }
        } else {
            out.push(json!({ "id": id, "label": label, "chat": chat, "terminal": terminal }));
        }
    };
    for (id, label) in chat_agents {
        add(id, label, true, false);
    }
    for (id, label) in terminal_agents {
        add(id, label, false, true);
    }
    out
}

fn chat_agents() -> Vec<(String, String)> {
    if !crate::acp::chat_enabled() {
        return Vec::new();
    }
    let overlay = crate::acp::overlay::OverlayStore::in_app_data();
    let mut all = crate::acp::config::builtin_agents();
    all.extend(crate::acp::overlay::overlay_agents(&overlay));
    all.into_iter()
        .filter(|cfg| !cfg.disabled && !crate::acp::install::is_missing(cfg, &crate::acp::config::RealHost))
        .map(|cfg| (cfg.id, cfg.label))
        .collect()
}

fn terminal_agents() -> Vec<(String, String)> {
    let listing = crate::tui::agent_types_listing();
    listing["agents"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| row["modes"]["visible"].as_bool().unwrap_or(false) && row["installed"].as_bool().unwrap_or(true))
                // A bare shell is not an agent to chat with from a phone.
                .filter(|row| row["kind"].as_str() != Some("shell"))
                .filter_map(|row| {
                    let id = row["id"].as_str()?.to_string();
                    let label = row["label"].as_str().filter(|l| !l.is_empty()).unwrap_or(&id).to_string();
                    Some((id, label))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn new_chat_options(cx: &Ctx) -> RouteResult {
    let agents = merge_agents(&chat_agents(), &terminal_agents());
    let projects: Vec<Value> = known_projects(cx).into_iter().map(|(path, name, state)| json!({ "id": project_id(&path), "name": name, "state": state })).collect();
    Ok((200, json!({ "agents": agents, "projects": projects })))
}

/// The word the phone sends for the lane, as `(chat, terminal)`.
pub(crate) fn parse_lane(word: &str) -> Option<bool> {
    match word.trim() {
        "chat" | "acp" => Some(true),
        "terminal" => Some(false),
        _ => None,
    }
}

fn start_chat(cx: &Ctx) -> RouteResult {
    let text = |key: &str| cx.request_body.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let agent = text("agent").ok_or_else(|| bad("INVALID_ARGUMENT", "agent is required"))?;
    let project = text("project").ok_or_else(|| bad("INVALID_ARGUMENT", "project is required"))?;
    let lane = text("lane").unwrap_or_else(|| "chat".to_string());
    let as_chat = parse_lane(&lane).ok_or_else(|| bad("INVALID_ARGUMENT", "lane must be chat or terminal"))?;
    let Some(folder) = resolve_project(&known_projects(cx), &project) else {
        return Err((404, json!({ "code": "UNKNOWN_PROJECT", "error": "The PC does not know that project. Open it on the PC first." })));
    };
    if as_chat {
        let body = json!({ "agent": agent, "folder": folder, "lane": "acp" });
        let (status, reply) = chat::api::start(&body, &live_deps(cx.app, cx.registry))?;
        crate::worktrees::folder::remember(&crate::app_paths::app_data_dir(), &folder);
        return Ok((status, reply));
    }
    let mut spawn = json!({ "agent_type": agent, "cwd": folder });
    for key in ["cols", "rows", "viewer"] {
        if let Some(value) = cx.request_body.get(key) {
            spawn[key] = value.clone();
        }
    }
    let bytes = serde_json::to_vec(&spawn).unwrap_or_default();
    let inner = Ctx {
        method: "POST",
        segments: &["panes"],
        query: "",
        body: &bytes,
        request_body: spawn,
        headers: cx.headers,
        peer_loopback: cx.peer_loopback,
        peer: cx.peer,
        session: cx.session,
        registry: cx.registry,
        app: cx.app,
    };
    let (status, reply) = super::panes::spawn(&inner)?;
    let pane_id = reply["pane_id"].as_str().or_else(|| reply["snapshot"]["pane_id"].as_str()).unwrap_or_default().to_string();
    crate::worktrees::folder::remember(&crate::app_paths::app_data_dir(), &folder);
    Ok((status, json!({ "pane_id": pane_id, "agent": agent, "lane": "terminal" })))
}

// ---------------------------------------------------------------------------------------------------- settings

const FULL_ACCESS: &str = r"(?i)full[\s_-]*access|bypass|yolo|dangerous|skip[\s_-]*permission|auto[\s_-]*approve|never[\s_-]*ask";

/// `true` when picking `value` for the mode setting `option_id` lets the agent act with no questions asked (the same words the
/// desktop's chip turns yellow for, `permissionChip.ts`). Only a setting of category `mode` counts.
pub(crate) fn needs_hold(options: &[Value], option_id: &str, value: &str) -> bool {
    let Some(option) = options.iter().find(|o| o["id"].as_str() == Some(option_id)) else { return false };
    if option["category"].as_str() != Some("mode") {
        return false;
    }
    let name = option["options"].as_array().and_then(|list| list.iter().find(|c| c["value"].as_str() == Some(value))).and_then(|c| c["name"].as_str()).unwrap_or("");
    let Ok(re) = regex::Regex::new(FULL_ACCESS) else { return false };
    re.is_match(value) || re.is_match(name)
}

fn set_config(cx: &Ctx, pane_id: &str) -> RouteResult {
    let text = |key: &str| cx.request_body.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let option_id = text("option_id").ok_or_else(|| bad("INVALID_ARGUMENT", "option_id is required"))?;
    let value = text("value").ok_or_else(|| bad("INVALID_ARGUMENT", "value is required"))?;
    let held = cx.request_body.get("hold").and_then(Value::as_bool).unwrap_or(false);
    let session = chat::get(pane_id).ok_or_else(|| (404, json!({ "code": "PANE_NOT_FOUND", "error": format!("{pane_id} is not a chat session") })))?;
    let options = session.session().snapshot().config_options;
    if needs_hold(&options, &option_id, &value) && !held {
        return Err((409, json!({ "code": "NEEDS_HOLD", "error": "This lets the agent act without asking. Press and hold to allow it." })));
    }
    session.set_config(&option_id, &value).map_err(|error| match error {
        crate::acp::error::AcpError::Busy => (409, json!({ "code": "BUSY", "error": "The agent is working. Change this when the turn ends." })),
        crate::acp::error::AcpError::BadOption(what) => (400, json!({ "code": "INVALID_ARGUMENT", "error": format!("the agent does not offer {what}") })),
        other => (502, json!({ "code": "ACP_CONFIG_FAILED", "error": other.to_string() })),
    })?;
    chat::default_model::remember_pick(&session, &option_id, &value);
    if held {
        if let Some(device_id) = super::phone_control::paired_device(cx) {
            crate::audit::record(crate::audit::Kind::Pairing, crate::audit::Who::Device(Some(device_id)), "A phone gave one agent full access", json!({ "pane_id": pane_id }));
        }
    }
    Ok((200, session.state()))
}

// ---------------------------------------------------------------------------------------------------- closed chats

fn closed_list() -> RouteResult {
    let rows: Vec<Value> = crate::acp::conversations::global()
        .closed_list()
        .into_iter()
        .map(|c| {
            let folder = std::path::Path::new(c.cwd.trim_end_matches(['/', '\\'])).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            json!({ "id": c.id, "agent": c.agent, "label": c.label, "folder": folder, "updated_ms": c.updated_ms, "title": c.title })
        })
        .collect();
    Ok((200, json!({ "chats": rows })))
}

fn reopen(cx: &Ctx, id: &str) -> RouteResult {
    if !crate::acp::chat_enabled() {
        return Err((409, json!({ "code": "FEATURE_OFF", "error": "Chat is switched off on the PC." })));
    }
    let deps = live_deps(cx.app, cx.registry);
    crate::acp::conversations::global().reopen_closed(id).map_err(|error| match error {
        crate::acp::conversations::ConversationError::Unknown => (404, json!({ "code": "NOT_CLOSED", "error": "This chat is not closed any more." })),
        other => (409, json!({ "code": "REOPEN_FAILED", "error": other.to_string() })),
    })?;
    chat::restore_panes(&deps);
    let _ = cx.app.emit("acp-conversations-changed", ());
    Ok((200, json!({ "pane_id": id })))
}

#[cfg(test)]
#[path = "phone_chat_tests.rs"]
mod tests;
