//! The app's own [`Services`]: the pane registry, the chat reader, the message outbox, the project list and the question store,
//! reached directly. None of the phone's route handlers, caps or types is used here; the one general route the app has for a
//! terminal (start, keys) is run through `bridge::run_after_pclink`, after `pclink::handle` has decided under its own levels.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use super::services::{EventView, Services};
use super::{Ask, Level};
use crate::bridge::{link_app_handles, link_poll_events_with, run_after_pclink};

/// The window event that makes this PC show "<PC> asks to work on this PC".
pub const FULL_ASK_EVENT: &str = "devices://full-ask";

pub struct AppServices {
    name: Arc<dyn Fn() -> String + Send + Sync>,
}

impl AppServices {
    pub fn new(name: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        Self { name }
    }
}

type Reply = (u16, Value);

fn not_ready() -> Reply {
    (503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" }))
}

fn unknown(session: &str) -> Reply {
    (404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(session) }))
}

fn bad(code: &str, message: &str) -> Reply {
    (400, json!({ "code": code, "error": message }))
}

fn merge(result: Result<Reply, Reply>) -> Reply {
    match result {
        Ok(ok) | Err(ok) => ok,
    }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The folders this PC knows and that still exist, as `(path, name, state)`.
fn known_projects(registry: &Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>) -> Vec<(String, String, String)> {
    let mut others = crate::operations::indexed_project_paths();
    others.push(crate::standby::default_project(registry));
    let store = crate::app_paths::app_data_dir();
    crate::worktrees::folder::recent_light(&store, &others, 12).into_iter().filter(|p| p.state != "missing").map(|p| (p.path, p.name, p.state)).collect()
}

/// The last part of a folder path.
fn folder_name(path: &str) -> String {
    path.trim_end_matches(|c| c == '/' || c == '\\').rsplit(|c| c == '/' || c == '\\').next().unwrap_or("").to_string()
}

fn terminal_agents() -> Vec<(String, String)> {
    let listing = crate::tui::agent_types_listing();
    listing["agents"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| row["modes"]["visible"].as_bool().unwrap_or(false) && row["installed"].as_bool().unwrap_or(true))
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

impl Services for AppServices {
    fn name(&self) -> String {
        (self.name)()
    }

    fn ceiling(&self, session: &str) -> Option<Level> {
        remote_ok(session).then_some(Level::Full)
    }

    fn sessions(&self) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        let panes = registry.lock().list();
        let mut probes = 0usize;
        let rows: Vec<Value> = panes
            .into_iter()
            // A PC serves its own panes only: an id that already names another device is never listed (no hops).
            .filter(|p| !p.id.starts_with("dev:"))
            .map(|p| {
                let mut row = json!({
                    "id": p.id,
                    "agent": clip(&p.agent_type, 40),
                    "title": clip(p.title.as_deref().unwrap_or(""), 80),
                    "status": p.status,
                    // The folder as a name and an opaque id, like `projects`: a path (it can name the person's home folder) never travels.
                    "project": if p.cwd.trim().is_empty() { String::new() } else { project_id(&p.cwd) },
                    "folder": clip(&folder_name(&p.cwd), 120),
                    "chat": p.lane.as_deref() == Some("acp"),
                });
                // Read-only facts so a chat here can look like the local one (`meta.rs` lists exactly what each exposes): a branch NAME,
                // a model display name, and a permission mode as one of three words. Never a path, a setting's raw text or a token.
                row["branch"] = json!(super::meta::BRANCHES.of(&p.cwd, &mut probes, &super::meta::head_branch));
                let chat = crate::acp::chat::get(&p.id);
                let options = chat.as_ref().map(|c| c.session().snapshot().config_options).unwrap_or_default();
                let auto = chat.as_ref().map(|c| c.auto_allowed_kinds()).unwrap_or_default();
                row["model"] = json!(super::meta::model_name(&options));
                row["mode"] = json!(if chat.is_some() { super::meta::mode_word(&options, &auto, message_needs_full) } else { super::meta::MODE_UNKNOWN });
                if let Some(parent) = p.parent_pane_id.as_deref().filter(|s| !s.is_empty()) {
                    row["parent"] = json!(clip(parent, 200));
                }
                row
            })
            .collect();
        (200, json!({ "sessions": rows }))
    }

    fn transcript(&self, session: &str, since: Option<u64>) -> Reply {
        let Some((app, registry)) = link_app_handles() else { return not_ready() };
        let Some(agent_type) = registry.lock().get(session).map(|pane| pane.info.agent_type.clone()) else { return unknown(session) };
        let opening = crate::session_chat::Opening::for_pane(session, &agent_type);
        let watchers = app.state::<crate::commands::SessionChatState>().watchers(&app, &registry);
        (200, crate::session_chat::phone::read(&watchers, session, opening.as_ref(), since))
    }

    fn transcript_earlier(&self, session: &str, before: &str, limit: Option<usize>) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        if registry.lock().get(session).is_none() {
            return unknown(session);
        }
        (200, crate::session_chat::earlier::for_pane(session, before, limit.unwrap_or(crate::session_chat::earlier::DEFAULT_PAGE), true))
    }

    fn picture(&self, session: &str, path: &str) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        let Some(cwd) = registry.lock().get(session).map(|pane| pane.info.cwd.clone()) else { return unknown(session) };
        use crate::session_chat::picture;
        match picture::read(path, &cwd, &picture::roots_for(&cwd), picture::PHONE_MAX_BYTES) {
            Ok(found) => (200, serde_json::to_value(found).unwrap_or(Value::Null)),
            Err(refused) => (if refused.code == "PICTURE_TOO_BIG" { 413 } else { 404 }, picture::refusal_body(&refused)),
        }
    }

    fn screen(&self, session: &str) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        match crate::pty::registry_read_snapshot(&registry, session) {
            Ok(content) => (200, json!({ "content": content })),
            Err(error) => (404, json!({ "code": "UNKNOWN_SESSION", "error": error })),
        }
    }

    fn projects(&self) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        let projects: Vec<Value> = known_projects(&registry)
            .into_iter()
            .map(|(path, name, state)| json!({ "id": project_id(&path), "name": name, "state": state }))
            .collect();
        (200, json!({ "projects": projects }))
    }

    fn usage(&self) -> Reply {
        // This PC's own usage, as its own bar shows it: the cached numbers, read again only when they are old. A lent or borrowed
        // sign-in is somebody else's number and is not shared; a usage page address is this PC's own to open.
        let (snap, _) = crate::usage::snapshot(crate::usage::Refresh::IfStale, false);
        let mut value = serde_json::to_value(&snap).unwrap_or_else(|_| json!({ "rows": [], "refreshed_at_ms": 0 }));
        if let Some(rows) = value.get_mut("rows").and_then(Value::as_array_mut) {
            rows.retain(|row| row.get("link").map_or(true, Value::is_null));
            neutral_sign_ins(rows);
        }
        (200, value)
    }

    fn browse(&self, root: Option<&str>, sub: &str) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        let known: Vec<String> = known_projects(&registry).into_iter().map(|(path, _, _)| path).collect();
        let roots = super::browse::roots(crate::project_path::home_dir().as_deref(), &known, &project_id);
        super::browse::view(&roots, root, sub)
    }

    fn open_folder(&self, root: &str, sub: &str) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        let known: Vec<String> = known_projects(&registry).into_iter().map(|(path, _, _)| path).collect();
        let roots = super::browse::roots(crate::project_path::home_dir().as_deref(), &known, &project_id);
        let (folder, name) = match super::browse::open_target(&roots, root, sub) {
            Ok(found) => found,
            Err(refused) => return refused,
        };
        crate::worktrees::folder::remember(&crate::app_paths::app_data_dir(), &folder);
        // The id is the one `projects` will give from now on; what the folder is (Git or not) is `projects`' to say.
        let state = crate::worktrees::folder::recent_light(&crate::app_paths::app_data_dir(), &[], 12).into_iter().find(|p| project_id(&p.path) == project_id(&folder)).map(|p| p.state).unwrap_or_else(|| "folder".to_string());
        (200, json!({ "project": { "id": project_id(&folder), "name": name, "state": state } }))
    }

    fn agents(&self) -> Reply {
        let terminals = crate::show_terminals::shown();
        let (agents, need_terminals) = offered_agents(&crate::show_terminals::chat_agents(), &terminal_agents(), terminals);
        (200, json!({ "agents": agents, "terminals": terminals, "need_terminals": need_terminals }))
    }

    fn questions(&self, full: bool) -> Reply {
        let list: Vec<Value> = crate::questions::store()
            .list_pending(crate::questions::now_ms())
            .into_iter()
            .filter(may_answer)
            // An agent switched off for other PCs on its own PC shows none of its cards.
            .filter(|q| q.pane_id.as_deref().map_or(true, remote_ok))
            .map(|mut q| {
                // Below Full a tool permission offers only its "no" choices: approving it is what Full means.
                if !full && q.kind.as_deref() == Some(crate::questions::ACP_KIND_PERMISSION) {
                    let pane = q.pane_id.clone();
                    let id = q.id.clone();
                    q.choices.retain(|c| choice_kind_of(pane.as_deref(), &id, &c.id).is_some_and(|k| is_reject(&k)));
                }
                serde_json::to_value(q).unwrap_or(Value::Null)
            })
            .collect();
        (200, json!({ "questions": list }))
    }

    fn outbox(&self, session: &str) -> Reply {
        let Some((app, registry)) = link_app_handles() else { return not_ready() };
        let messages: Vec<_> = crate::pane_outbox::global(&registry, &app).list(session).iter().map(crate::pane_outbox::redacted).collect();
        (200, json!({ "messages": messages }))
    }

    fn send(&self, node: &str, session: &str, text: &str, full: bool) -> Reply {
        let Some((app, registry)) = link_app_handles() else { return not_ready() };
        if !full {
            if let Some(chat) = crate::acp::chat::get(session) {
                if message_needs_full(&chat.session().snapshot().config_options, &chat.auto_allowed_kinds()) {
                    return (403, json!({ "error": "This agent is set to act without asking. Messaging it needs Full on this PC.", "code": "MESSAGE_NEEDS_FULL", "needs": "full" }));
                }
            }
        }
        let from = crate::mobile_pairing::link_device_id(node);
        match crate::pane_outbox::global(&registry, &app).send_from(session, text, &[], Some(&from)) {
            Ok(message) => (200, json!({ "message": crate::pane_outbox::redacted(&message) })),
            Err(error) => {
                let code = if error == crate::acp::chat::TOOK_BACK_SENTENCE { crate::acp::chat::drive::TOOK_BACK_CODE } else { "MESSAGE_REFUSED" };
                (if code == "MESSAGE_REFUSED" { 400 } else { 409 }, json!({ "error": error, "code": code }))
            }
        }
    }

    fn cancel_message(&self, session: &str, message: &str) -> Reply {
        let Some((app, registry)) = link_app_handles() else { return not_ready() };
        match crate::pane_outbox::global(&registry, &app).cancel(session, message) {
            Ok(message) => (200, json!({ "message": crate::pane_outbox::redacted(&message) })),
            Err(error) => (409, json!({ "error": error, "code": "MESSAGE_NOT_CANCELLABLE" })),
        }
    }

    fn interrupt(&self, session: &str) -> Reply {
        let Some((app, registry)) = link_app_handles() else { return not_ready() };
        if !registry.lock().panes.contains_key(session) {
            return unknown(session);
        }
        if crate::acp::chat::is_chat_pane(&registry, session) {
            return merge(crate::acp::chat::api::cancel(session));
        }
        match crate::pty::registry_write_input(&registry, &app, session, "\u{3}", false, false, None, crate::pty::WriteOrigin::User) {
            Ok(_) => (200, json!({ "id": session, "stopped": true })),
            Err(error) => (502, json!({ "error": error, "code": "INTERRUPT_FAILED" })),
        }
    }

    fn answer_question(&self, id: &str, body: &Value, full: bool) -> Reply {
        let Some((app, _)) = link_app_handles() else { return not_ready() };
        let store = crate::questions::store();
        let Some(question) = store.get(id, crate::questions::now_ms()) else {
            return (404, json!({ "code": "QUESTION_NOT_FOUND", "error": "That question is not waiting any more." }));
        };
        if !may_answer(&question) {
            return (403, json!({ "code": "NEEDS_PERSON", "error": "This card is a decision for the person at this PC." }));
        }
        if let Some(pane) = question.pane_id.as_deref() {
            if !remote_ok(pane) {
                return (403, json!({ "error": "This agent is switched off for other PCs on its own PC.", "code": "AGENT_LOCKED" }));
            }
        }
        if question.kind.as_deref() == Some(crate::questions::ACP_KIND_PERMISSION) {
            let choice = body.get("choice_id").and_then(Value::as_str);
            let kind = choice.and_then(|c| choice_kind_of(question.pane_id.as_deref(), id, c));
            if approval_needs_full(true, full, kind.as_deref(), body.get("text").is_some()) {
                return (403, json!({ "error": "That PC may say no to a tool permission. Saying yes (it can run commands, change files or reach the network) needs Full.", "code": "APPROVE_NEEDS_FULL", "needs": "full" }));
            }
        }
        let result = store.answer(id, body.get("choice_id").and_then(Value::as_str), body.get("text").and_then(Value::as_str), "pc", crate::questions::now_ms());
        crate::questions::routes::publish_changed(&app);
        match result {
            Ok(done) => (200, serde_json::to_value(done).unwrap_or(Value::Null)),
            Err(e) => (e.status(), json!({ "code": e.code, "error": e.message })),
        }
    }

    fn set_config(&self, node: &str, session: &str, option: &str, value: &str, hold: bool) -> Reply {
        let Some(chat) = crate::acp::chat::get(session) else {
            return (404, json!({ "code": "UNKNOWN_SESSION", "error": format!("{session} is not a chat session") }));
        };
        let options = chat.session().snapshot().config_options;
        if needs_hold(&options, option, value) && !hold {
            return (409, json!({ "code": "NEEDS_HOLD", "error": "This lets the agent act without asking. Press and hold to allow it." }));
        }
        if let Err(error) = chat.set_config(option, value) {
            return match error {
                crate::acp::error::AcpError::Busy => (409, json!({ "code": "BUSY", "error": "The agent is working. Change this when the turn ends." })),
                crate::acp::error::AcpError::BadOption(what) => bad("INVALID_ARGUMENT", &format!("the agent does not offer {what}")),
                other => (502, json!({ "code": "ACP_CONFIG_FAILED", "error": other.to_string() })),
            };
        }
        crate::acp::chat::default_model::remember_pick(&chat, option, value);
        if hold {
            crate::audit::record(
                crate::audit::Kind::Pairing,
                crate::audit::Who::Device(Some(crate::mobile_pairing::link_device_id(node))),
                "A paired PC gave one agent full access",
                json!({ "pane_id": session }),
            );
        }
        (200, chat.state())
    }

    fn input(&self, node: &str, session: &str, text: &str) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        if registry.lock().get(session).is_none() {
            return unknown(session);
        }
        if crate::acp::chat::is_chat_pane(&registry, session) {
            return (409, json!({ "code": "NOT_A_TERMINAL", "error": "This is a chat. Send it a message instead." }));
        }
        let body = serde_json::to_vec(&json!({ "text": text, "append_newline": true })).unwrap_or_default();
        run_after_pclink(node, "POST", &format!("/panes/{session}/input"), &body)
    }

    fn models(&self, agent: &str) -> Reply {
        match crate::commands::context_agent_id(agent) {
            Ok(id) => (200, serde_json::to_value(crate::commands::model_options_blocking(&id)).unwrap_or(Value::Null)),
            Err(_) => (404, json!({ "code": "UNKNOWN_AGENT", "error": "The PC does not know that agent." })),
        }
    }

    fn start(&self, node: &str, agent: &str, project: &str, lane: &str, body: &Value) -> Reply {
        let Some((app, registry)) = link_app_handles() else { return not_ready() };
        let as_chat = match lane.trim() {
            "chat" | "acp" => true,
            "terminal" => false,
            _ => return bad("INVALID_ARGUMENT", "lane must be chat or terminal"),
        };
        if !as_chat && !crate::show_terminals::shown() {
            return (409, json!({ "code": "TERMINALS_OFF", "error": "Terminals are hidden on the PC. Start a chat instead, or turn on Show terminals in Settings." }));
        }
        let Some(folder) = resolve_project(&known_projects(&registry), project) else {
            return (404, json!({ "code": "UNKNOWN_PROJECT", "error": "The PC does not know that project. Open it on the PC first." }));
        };
        if as_chat {
            let request = json!({ "agent": agent, "folder": folder, "lane": "acp" });
            return match crate::acp::chat::api::start(&request, &crate::commands::acp_chat::live_deps(&app, &registry)) {
                Ok((status, reply)) => {
                    crate::worktrees::folder::remember(&crate::app_paths::app_data_dir(), &folder);
                    (status, reply)
                }
                Err(refused) => refused,
            };
        }
        let mut spawn = json!({ "agent_type": agent, "cwd": folder });
        for key in ["cols", "rows"] {
            if let Some(value) = body.get(key) {
                spawn[key] = value.clone();
            }
        }
        let bytes = serde_json::to_vec(&spawn).unwrap_or_default();
        let (status, reply) = run_after_pclink(node, "POST", "/panes", &bytes);
        if status >= 300 {
            return (status, reply);
        }
        let pane_id = reply["pane_id"].as_str().or_else(|| reply["snapshot"]["pane_id"].as_str()).unwrap_or_default().to_string();
        crate::worktrees::folder::remember(&crate::app_paths::app_data_dir(), &folder);
        (200, json!({ "pane_id": pane_id, "agent": agent, "lane": "terminal" }))
    }

    fn warm(&self, agent: &str, project: &str) -> Reply {
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        let Some(folder) = resolve_project(&known_projects(&registry), project) else {
            return (404, json!({ "code": "UNKNOWN_PROJECT", "error": "The PC does not know that project. Open it on the PC first." }));
        };
        (200, json!({ "warming": crate::acp::warm::hint(agent, std::path::Path::new(&folder), None) }))
    }

    fn known_folder(&self, path: &str) -> bool {
        let Some((_, registry)) = link_app_handles() else { return false };
        let id = project_id(path);
        known_projects(&registry).iter().any(|(known, _, _)| project_id(known) == id)
    }

    fn close(&self, node: &str, session: &str) -> Reply {
        run_after_pclink(node, "DELETE", &format!("/panes/{session}"), &[])
    }

    fn move_work(&self, project: &str, branch: &str, bundle_b64: &str) -> Reply {
        use base64::Engine as _;
        use crate::chat_move::work;
        let refuse = |status: u16, code: &str, message: &str| (status, json!({ "code": code, "error": message }));
        if !work::branch_ok(branch) {
            return refuse(400, "INVALID_ARGUMENT", work::BAD_BRANCH);
        }
        // The base64 text is cut at the cap before it is decoded.
        if bundle_b64.len() > work::BUNDLE_MAX / 3 * 4 + 8 {
            return refuse(413, "PAYLOAD_TOO_LARGE", work::TOO_BIG);
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(bundle_b64) else {
            return refuse(400, "INVALID_ARGUMENT", "The work did not arrive whole.");
        };
        let Some((_, registry)) = link_app_handles() else { return not_ready() };
        let Some(folder) = resolve_project(&known_projects(&registry), project) else {
            return refuse(404, "UNKNOWN_PROJECT", "This PC does not know that project. Open it here first.");
        };
        match work::receive(std::path::Path::new(&folder), branch, &bytes) {
            Ok(got) => (200, json!({ "ok": true, "branch": got.branch, "sha": got.sha })),
            Err(sentence) => refuse(409, "MOVE_REFUSED", &sentence),
        }
    }

    fn notify_full_request(&self, ask: &Ask) {
        if let Some((app, _)) = link_app_handles() {
            let _ = app.emit(FULL_ASK_EVENT, ask);
        }
    }

    fn events(&self, cursor: Option<u64>, wait: std::time::Duration, view: &EventView<'_>) -> (u64, String) {
        link_poll_events_with(cursor, wait, view)
    }
}

/// The ONE place that says whether the person has shut an agent for other PCs on this PC (its own "not for remote use" switch).
/// Sessions, questions and answers all read it here, so they cannot drift. It only shuts; it never caps a level.
fn remote_ok(pane: &str) -> bool {
    crate::mobile_pairing::pane_rules::rule(pane).remote
}

/// Whether a message would run with no card at all: a mode that lets the agent act with no questions asked (the same words as the
/// press-and-hold rule), or kinds of action allowed without asking. For an Answer PC that is Full by another name.
/// (A terminal agent started with a skip-permissions flag cannot be told yet; this reads chat sessions only.)
pub(crate) fn message_needs_full(options: &[Value], auto_allowed: &[String]) -> bool {
    !auto_allowed.is_empty()
        || options.iter().any(|o| {
            o["category"].as_str() == Some("mode")
                && match (o["id"].as_str(), o["currentValue"].as_str()) {
                    (Some(id), Some(current)) => needs_hold(options, id, current),
                    _ => false,
                }
        })
}

/// What a choice on a permission card means in the agent's own words, from the chat that holds the card.
fn choice_kind_of(pane: Option<&str>, question_id: &str, choice_id: &str) -> Option<String> {
    crate::acp::chat::get(pane?)?.card_choice_kind(question_id, choice_id)
}

fn is_reject(kind: &str) -> bool {
    kind.starts_with("reject")
}

/// The one rule for tool permissions: below Full a PC may only DENY. An unknown choice (no card, no such option, free text) counts as a
/// yes, so it is refused: the rule fails closed.
pub(crate) fn approval_needs_full(is_permission: bool, full: bool, choice_kind: Option<&str>, has_text: bool) -> bool {
    is_permission && !full && (has_text || !choice_kind.is_some_and(is_reject))
}

/// A card a paired PC may answer: an agent's own question, or its permission to run a tool. Consent, usage-limit, budget,
/// issue, CI and helper-login cards are decisions for the person at this PC.
fn may_answer(q: &crate::questions::Question) -> bool {
    q.consent.is_none() && q.limit.is_none() && (q.kind.is_none() || q.kind.as_deref() == Some(crate::questions::ACP_KIND_PERMISSION))
}


// ----- small pure helpers (this module's own; the phone's are not shared) -----

/// A stable opaque id for a folder, so a PC names a project without its path ever leaving this one (FNV-1a over the lowercase,
/// slash-normalised path). Recomputed from this PC's own list on every call; nothing is stored.
fn project_id(path: &str) -> String {
    let normal = path.replace('\\', "/").trim_end_matches('/').to_lowercase();
    project_id_with(&install_key(), &normal)
}

/// The id of an already normalised path under `key`: SHA-256(key, path), 16 hex digits. Without the key a peer cannot work out an id from a guessed path.
pub(crate) fn project_id_with(key: &[u8; 16], normal: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(normal.as_bytes());
    let digest = hasher.finalize();
    format!("p{}", digest.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>())
}

/// Writes the key to a temp file next to `file` (owner-only on unix) and renames it into place, so a crash never leaves half a key.
fn write_key_file(file: &std::path::Path, text: &str) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(file.parent().unwrap_or_else(|| std::path::Path::new(".")));
    let temp = file.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&temp).and_then(|mut f| f.write_all(text.as_bytes()).and_then(|_| f.sync_all()));
    if written.is_err() || std::fs::rename(&temp, file).is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}

/// A secret of this install (created on first use under the app data folder, kept across restarts), so the ids of folders are not a
/// plain hash of their path. Ids stay stable for as long as the file does; they were never stored anywhere else (a page asks for the list again).
fn install_key() -> [u8; 16] {
    static KEY: std::sync::OnceLock<[u8; 16]> = std::sync::OnceLock::new();
    *KEY.get_or_init(|| {
        let file = crate::app_paths::app_data_dir().join("pclink-id-key");
        match std::fs::read_to_string(&file) {
            Ok(text) => {
                if let Ok(id) = uuid::Uuid::parse_str(text.trim()) {
                    return *id.as_bytes();
                }
                // Present but not a key (corrupt): never overwritten here. This run uses a key of its own; ids change next start.
                eprintln!("pclink: the id key file is not readable as a key; using a key for this run only");
                *uuid::Uuid::new_v4().as_bytes()
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let id = uuid::Uuid::new_v4();
                write_key_file(&file, &id.to_string());
                *id.as_bytes()
            }
            Err(e) => {
                // Locked or unreadable for now: not replaced either.
                eprintln!("pclink: the id key file could not be read ({e}); using a key for this run only");
                *uuid::Uuid::new_v4().as_bytes()
            }
        }
    })
}

/// People name their sign-ins after emails: another PC gets no account id and no account label, only "Sign-in 1", "Sign-in 2" ... per agent
/// for the extra sign-ins (the agent's main sign-in stays unlabelled), and no usage page address.
pub(crate) fn neutral_sign_ins(rows: &mut [Value]) {
    let mut count: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for row in rows.iter_mut() {
        let Some(obj) = row.as_object_mut() else { continue };
        let agent = obj.get("agent_id").and_then(Value::as_str).unwrap_or("").to_string();
        let extra = obj.get("account_id").is_some_and(|v| !v.is_null()) || obj.get("account_label").is_some_and(|v| !v.is_null());
        if extra {
            let n = count.entry(agent).or_insert(0);
            *n += 1;
            obj.insert("account_id".into(), Value::String(n.to_string()));
            obj.insert("account_label".into(), Value::String(format!("Sign-in {n}")));
        } else {
            obj.insert("account_id".into(), Value::Null);
            obj.insert("account_label".into(), Value::Null);
        }
        obj.insert("page".into(), Value::Null);
        obj.remove("same_as_main");
    }
}

fn resolve_project(projects: &[(String, String, String)], id: &str) -> Option<String> {
    projects.iter().find(|(path, _, _)| project_id(path) == id).map(|(path, _, _)| path.clone())
}

/// The agents a PC may start: a chat, a terminal, or both. With terminals hidden on this PC only agents that can chat are listed.
fn offered_agents(chat_agents: &[(String, String)], terminal_agents: &[(String, String)], terminals: bool) -> (Vec<Value>, usize) {
    let mut all: Vec<Value> = Vec::new();
    let mut add = |id: &str, label: &str, chat: bool, terminal: bool| {
        if let Some(found) = all.iter_mut().find(|row| row["id"] == id) {
            if chat {
                found["chat"] = json!(true);
            }
            if terminal {
                found["terminal"] = json!(true);
            }
        } else {
            all.push(json!({ "id": id, "label": label, "chat": chat, "terminal": terminal }));
        }
    };
    for (id, label) in chat_agents {
        add(id, label, true, false);
    }
    for (id, label) in terminal_agents {
        add(id, label, false, true);
    }
    if terminals {
        return (all, 0);
    }
    let hidden = all.iter().filter(|row| row["chat"] != true).count();
    let listed = all
        .into_iter()
        .filter(|row| row["chat"] == true)
        .map(|mut row| {
            row["terminal"] = json!(false);
            row
        })
        .collect();
    (listed, hidden)
}

const FULL_ACCESS: &str = r"(?i)full[\s_-]*access|bypass|yolo|dangerous|skip[\s_-]*permission|auto[\s_-]*approve|never[\s_-]*ask";

/// Whether picking `value` for the mode setting `option_id` lets the agent act with no questions asked (it then needs a press and hold).
fn needs_hold(options: &[Value], option_id: &str, value: &str) -> bool {
    let Some(option) = options.iter().find(|o| o["id"].as_str() == Some(option_id)) else { return false };
    if option["category"].as_str() != Some("mode") {
        return false;
    }
    let name = option["options"].as_array().and_then(|list| list.iter().find(|c| c["value"].as_str() == Some(value))).and_then(|c| c["name"].as_str()).unwrap_or("");
    let Ok(re) = regex::Regex::new(FULL_ACCESS) else { return false };
    re.is_match(value) || re.is_match(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_pairing::pane_rules::{self, Level as RuleLevel, PaneRule};
    use crate::questions::{store, Choice, NewQuestion, ACP_KIND_PERMISSION};

    fn ask(pane: &str, kind: Option<&str>) -> String {
        let new = NewQuestion {
            pane_id: Some(pane.into()),
            question: "Run it?".into(),
            choices: vec![Choice { id: "allow".into(), label: "Allow".into() }, Choice { id: "deny".into(), label: "Deny".into() }],
            allow_free_text: Some(false),
            timeout_s: Some(600),
            kind: kind.map(str::to_string),
            ..Default::default()
        };
        store().create(new, crate::questions::now_ms()).unwrap().id
    }

    fn listed(full: bool) -> Vec<Value> {
        AppServices::new(Arc::new(|| "Desk".into())).questions(full).1["questions"].as_array().cloned().unwrap_or_default()
    }

    fn mode_options(current: &str) -> Vec<Value> {
        vec![json!({ "id": "mode", "category": "mode", "currentValue": current, "options": [
            { "value": "default", "name": "Ask before changes" },
            { "value": "plan", "name": "Plan" },
            { "value": "bypassPermissions", "name": "Bypass permissions" },
            { "value": "full-auto", "name": "Full access" },
        ] }), json!({ "id": "model", "category": "model", "currentValue": "bypass-model", "options": [] })]
    }

    #[test]
    fn a_message_for_an_agent_that_would_act_with_no_card_needs_full() {
        // Normal modes: an Answer PC may message it (every action still raises a card for the person).
        for mode in ["default", "plan"] {
            assert!(!message_needs_full(&mode_options(mode), &[]), "{mode}");
        }
        // A mode that lets the agent act with no questions asked: refused below Full.
        for mode in ["bypassPermissions", "full-auto"] {
            assert!(message_needs_full(&mode_options(mode), &[]), "{mode}");
        }
        // Kinds of action allowed without asking (`don't ask again`): refused below Full, even in a normal mode.
        assert!(message_needs_full(&mode_options("default"), &["execute".to_string()]));
        // Only the mode setting counts, not another option that happens to carry such a word.
        assert!(!message_needs_full(&[json!({ "id": "model", "category": "model", "currentValue": "yolo", "options": [] })], &[]));
        // No options known at all: nothing to say it is unsafe.
        assert!(!message_needs_full(&[], &[]));
    }

    #[test]
    fn below_full_a_permission_can_only_be_denied() {
        // (is a permission, asker is Full, the choice's kind in the agent's words, free text sent) -> refused
        for (kind, text, refused) in [
            (Some("allow_once"), false, true),
            (Some("allow_always"), false, true),
            (Some("reject_once"), false, false),
            (Some("reject_always"), false, false),
            (Some("something_new"), false, true),
            (None, false, true),
            (Some("reject_once"), true, true),
        ] {
            assert_eq!(approval_needs_full(true, false, kind, text), refused, "{kind:?} text={text}");
        }
        // Full may approve; an ordinary question is not a permission at all.
        assert!(!approval_needs_full(true, true, Some("allow_always"), false));
        assert!(!approval_needs_full(false, false, None, true));
    }

    #[test]
    fn a_permission_card_offers_an_answer_pc_no_choice_it_cannot_resolve_and_full_sees_all() {
        let id = ask("pane-perm-1", Some(ACP_KIND_PERMISSION));
        let find = |full| listed(full).into_iter().find(|q| q["id"] == id.as_str()).unwrap();
        // No chat holds this card here, so no choice can be shown to be a "no": none is offered below Full (fails closed).
        assert_eq!(find(false)["choices"].as_array().unwrap().len(), 0);
        assert_eq!(find(true)["choices"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn usage_rows_for_another_pc_carry_no_account_id_label_or_page() {
        let mut rows = vec![
            json!({ "agent_id": "claude", "account_id": null, "account_label": null, "page": "https://x", "same_as_main": true }),
            json!({ "agent_id": "claude", "account_id": "acc-7f", "account_label": "ren@example.com", "page": "https://x" }),
            json!({ "agent_id": "claude", "account_id": "acc-9a", "account_label": "work@example.com", "page": null }),
            json!({ "agent_id": "codex", "account_id": "acc-1", "account_label": "me@x.org", "page": null }),
        ];
        neutral_sign_ins(&mut rows);
        let text = serde_json::to_string(&rows).unwrap();
        assert!(!text.contains("example.com") && !text.contains("acc-") && !text.contains("me@x.org") && !text.contains("https://x") && !text.contains("same_as_main"), "{text}");
        assert_eq!(rows[0]["account_label"], Value::Null, "the main sign-in stays unlabelled");
        assert_eq!((rows[1]["account_label"].as_str(), rows[1]["account_id"].as_str()), (Some("Sign-in 1"), Some("1")));
        assert_eq!(rows[2]["account_label"], "Sign-in 2");
        assert_eq!(rows[3]["account_label"], "Sign-in 1", "numbered per agent");
    }

    #[test]
    fn the_key_file_is_written_whole_by_rename_and_owner_only_on_unix() {
        let dir = std::env::temp_dir().join(format!("pm-key-{}", uuid::Uuid::new_v4()));
        let file = dir.join("pclink-id-key");
        write_key_file(&file, "abc");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "abc");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temp file left behind");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_ids_depend_on_the_install_key_and_not_on_case_of_the_stored_path() {
        let (a, b) = ([1u8; 16], [2u8; 16]);
        assert_eq!(project_id_with(&a, "d:/code/x"), project_id_with(&a, "d:/code/x"));
        assert_ne!(project_id_with(&a, "d:/code/x"), project_id_with(&b, "d:/code/x"), "another install gives another id");
        assert_ne!(project_id_with(&a, "d:/code/x"), project_id_with(&a, "d:/code/y"));
        assert!(project_id_with(&a, "d:/code/x").starts_with('p') && project_id_with(&a, "d:/code/x").len() == 17);
    }

    #[test]
    fn the_questions_list_leaves_out_an_agent_switched_off_for_other_pcs() {
        let (open, shut) = (ask("pane-open-1", None), ask("pane-shut-1", None));
        pane_rules::set("pane-shut-1", PaneRule { remote: false, level: RuleLevel::Full }).unwrap();
        let ids: Vec<String> = listed(true).iter().filter_map(|q| q["id"].as_str().map(str::to_string)).collect();
        assert!(ids.contains(&open), "an ordinary agent's question is listed");
        assert!(!ids.contains(&shut), "a locked agent's question is not");
        pane_rules::set("pane-shut-1", PaneRule::default()).unwrap();
    }
}
