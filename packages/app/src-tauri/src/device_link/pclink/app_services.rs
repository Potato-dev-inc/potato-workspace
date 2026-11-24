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

pub(super) use pm_core::device_link::pclink::calls_files::{bad, command_error, Reply};

pub(super) use pm_core::device_link::pclink::engine_services::{not_ready, remote_refusal};
use pm_core::device_link::pclink::engine_services::{self as engine, folder_name, offered_agents, ChatEnv};

/// The folders this PC knows and that still exist, as `(path, name, state)`.
pub(super) fn known_projects(registry: &Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>) -> Vec<(String, String, String)> {
    let mut others = crate::operations::indexed_project_paths();
    others.push(crate::standby::default_project(registry));
    let store = crate::app_paths::app_data_dir();
    crate::worktrees::folder::recent_light(&store, &others, 12).into_iter().filter(|p| p.state != "missing").map(|p| (p.path, p.name, p.state)).collect()
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
        engine::sessions(&AppChatEnv)
    }

    fn transcript(&self, session: &str, since: Option<u64>) -> Reply {
        engine::transcript(&AppChatEnv, session, since)
    }

    fn transcript_earlier(&self, session: &str, before: &str, limit: Option<usize>) -> Reply {
        engine::transcript_earlier(&AppChatEnv, session, before, limit)
    }

    fn picture(&self, session: &str, path: &str) -> Reply {
        engine::picture(&AppChatEnv, session, path)
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
        engine::questions(&AppChatEnv, full)
    }

    fn outbox(&self, session: &str) -> Reply {
        outbox_list(session)
    }

    fn send(&self, node: &str, session: &str, text: &str, full: bool) -> Reply {
        send_message(node, session, text, full, &[])
    }

    fn cancel_message(&self, session: &str, message: &str) -> Reply {
        engine::cancel_message(&AppChatEnv, session, message)
    }

    fn interrupt(&self, session: &str) -> Reply {
        engine::interrupt(&AppChatEnv, session)
    }

    fn answer_question(&self, id: &str, body: &Value, full: bool) -> Reply {
        engine::answer_question(&AppChatEnv, id, body, full)
    }

    fn set_config(&self, node: &str, session: &str, option: &str, value: &str, hold: bool) -> Reply {
        engine::set_config_as(&AppChatEnv, node, session, option, value, hold, hold)
    }

    fn models(&self, agent: &str) -> Reply {
        match crate::commands::context_agent_id(agent) {
            Ok(id) => (200, serde_json::to_value(crate::commands::model_options_blocking(&id)).unwrap_or(Value::Null)),
            Err(_) => (404, json!({ "code": "UNKNOWN_AGENT", "error": "The PC does not know that agent." })),
        }
    }

    fn start(&self, node: &str, agent: &str, project: &str, lane: &str, body: &Value) -> Reply {
        let Some((_app, registry)) = link_app_handles() else { return not_ready() };
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
        // "Use my own agents": the chat runs on a sign-in lent by the calling PC. Nothing else can be named from outside.
        let account = match body.get("account").and_then(Value::as_str).map(str::trim).filter(|a| !a.is_empty()) {
            Some(account) => match super::calls_lend::start_account(node, agent, account) {
                Ok(account) => Some(account),
                Err(refused) => return refused,
            },
            // No sign-in named: when this PC's own login is signed out and the caller lent this agent to it, run on that lend (as a start on this PC does).
            None => crate::capacity_proxy::default_account(agent, Some(node)),
        };
        if as_chat {
            return engine::start_chat(&AppChatEnv, agent, &folder, account);
        }
        let mut spawn = json!({ "agent_type": agent, "cwd": folder });
        // A terminal on a lent sign-in: the pane's own launch env points the agent at this PC's shim (`accounts::Store::launch_env`).
        if let Some(account) = &account {
            spawn["account"] = json!(account);
        }
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
        engine::warm(&AppChatEnv, agent, project)
    }

    fn call(&self, node: &str, cmd: &str, args: &Value) -> Reply {
        use super::calls::text_arg;
        if let Some(reply) = super::calls_agents::run(cmd, args) {
            return reply;
        }
        if let Some(done) = super::calls_chat::dispatch(node, cmd, args) {
            return done;
        }
        if let Some(done) = super::calls_lend::dispatch(node, cmd, args) {
            return done;
        }
        if super::calls_files::mine(cmd) {
            return super::calls_files::run(node, cmd, args);
        }
        match cmd {
            // The far usage bar: the numbers `GET /pclink/usage` gives (this PC's own sign-ins only).
            "usage_snapshot" => return self.usage(),
            "pane_previews" => {
                let seen = crate::pane_preview::snapshot().into_iter().map(|(pane, urls)| (pane, urls.into_iter().map(|u| (u.url, u.port)).collect())).collect();
                return (200, super::preview::rows(seen, &|pane| remote_ok(pane)));
            }
            _ => {}
        }
        if let Some(done) = super::calls_p4a::dispatch(node, cmd, args) {
            return done;
        }
        if super::calls_workflows::mine(cmd) {
            return super::calls_workflows::run(node, cmd, args);
        }
        if super::calls_attach::mine(cmd) {
            return super::calls_attach::run(node, cmd, args);
        }
        // A person's own PC (`_marked`, set by `pclink::handle`) is not asked to press and hold; any other PC must hold.
        let held = args.get("hold").and_then(Value::as_bool).unwrap_or(false);
        let hold = held || args.get("_marked").and_then(Value::as_bool).unwrap_or(false);
        if super::terminal::handles(cmd) {
            let Some((_app, registry)) = link_app_handles() else { return not_ready() };
            let folder = |path: &str| {
                let projects = known_projects(&registry);
                resolve_project(&projects, path).or_else(|| resolve_project(&projects, &project_id(path)))
            };
            return super::terminal::call(&super::terminal::Env { registry: &registry, folder: &folder }, node, cmd, args).unwrap_or_else(|| (404, json!({ "error": "not found", "code": "UNKNOWN_ROUTE" })));
        }
        if cmd == "agent_model_options" {
            return match text_arg(args, "agentId") {
                Some(agent) => self.models(&agent),
                None => bad("INVALID_ARGUMENT", "agentId is required"),
            };
        }
        if let Some(reply) = super::calls_install::run(node, cmd, args) {
            return reply;
        }
        if let Some(reply) = super::calls_signin::agent_call(node, cmd, args) {
            return reply;
        }
        let Some(pane) = text_arg(args, "paneId") else { return bad("INVALID_ARGUMENT", "paneId is required") };
        if let Some(refused) = remote_refusal(&pane) {
            return refused;
        }
        match cmd {
            "acp_chat_state" => (200, engine::chat_state(&pane)),
            "acp_chat_set_config" => match (text_arg(args, "optionId"), text_arg(args, "value")) {
                (Some(option), Some(value)) => engine::set_config_as(&AppChatEnv, node, &pane, &option, &value, hold, held),
                _ => bad("INVALID_ARGUMENT", "optionId and value are required"),
            },
            "acp_chat_set_force_yes" => {
                let Some(on) = super::calls::arg(args, "on").and_then(Value::as_bool) else { return bad("INVALID_ARGUMENT", "on is required") };
                engine::set_force_yes(&AppChatEnv, node, &pane, on, hold, held)
            }
            "pane_set_title" => {
                // The name is the far PC's text: `set_user_title` cleans and cuts it; a blank one clears it (automatic titles resume).
                let title = super::calls::arg(args, "title").and_then(Value::as_str).unwrap_or_default();
                let Some((app, registry)) = link_app_handles() else { return not_ready() };
                if registry.lock().get(&pane).is_none() {
                    return (404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(&pane) }));
                }
                let stored = crate::ambient::store::set_user_title(&pane, title);
                crate::ambient::announce_title_change(&app, &pane);
                (200, json!(stored))
            }
            _ => super::calls_signin::pane_call(node, cmd, &pane).unwrap_or_else(|| (404, json!({ "error": "not found", "code": "UNKNOWN_ROUTE" }))),
        }
    }

    fn preview(&self, _node: &str, body: &Value) -> Reply {
        let req = match super::preview::parse(body) {
            Ok(req) => req,
            Err(refused) => return refused,
        };
        if let Some(refused) = remote_refusal(&req.pane) {
            return refused;
        }
        if !remote_ok(&req.pane) {
            return (403, json!({ "error": "This agent is switched off for other PCs on its own PC.", "code": "AGENT_LOCKED" }));
        }
        // Only a port this chat's own screen printed (S8), and never one of Potato Workspace's own (S1): the same list `pane_previews` gives.
        let urls = crate::pane_preview::snapshot().remove(&req.pane).unwrap_or_default();
        match super::preview::check_port(&urls, req.port) {
            Ok(host) => super::preview::fetch(&host, &req),
            Err(refused) => refused,
        }
    }

    fn known_folder(&self, path: &str) -> bool {
        let Some((_, registry)) = link_app_handles() else { return false };
        let id = project_id(path);
        known_projects(&registry).iter().any(|(known, _, _)| project_id(known) == id)
    }

    fn close(&self, node: &str, session: &str) -> Reply {
        if let Some(refused) = remote_refusal(session) {
            return refused;
        }
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

    fn frame_for(&self, node: &str, frame: String) -> Option<String> {
        super::terminal::throttle(node, frame)
    }
}

// The two message-box routes' bodies, free of the trait: the far call rows (`calls_chat.rs`) run them without making a `dyn Services`.
pub(super) fn outbox_list(session: &str) -> Reply {
    engine::outbox_list(&AppChatEnv, session)
}

pub(super) fn send_message(node: &str, session: &str, text: &str, full: bool, attachments: &[crate::attach::ChatAttachment]) -> Reply {
    engine::send_message(&AppChatEnv, node, session, text, full, attachments)
}

/// The ONE place that says whether the person has shut an agent for other PCs on this PC (its own "not for remote use" switch).
/// Sessions, questions and answers all read it here, so they cannot drift. It only shuts; it never caps a level.
pub(super) fn remote_ok(pane: &str) -> bool {
    // A chat on another computer (SSH) is never offered to another PC, whatever the per-agent switch says.
    !crate::acp::chat::is_remote_pane(pane) && crate::mobile_pairing::pane_rules::rule(pane).remote
}

#[cfg(test)]
pub(crate) use pm_core::device_link::pclink::engine_services::{approval_needs_full, message_needs_full};

// ----- small pure helpers (this module's own; the phone's are not shared) -----

/// A stable opaque id for a folder, so a PC names a project without its path ever leaving this one (FNV-1a over the lowercase,
/// slash-normalised path). Recomputed from this PC's own list on every call; nothing is stored.
pub(super) fn project_id(path: &str) -> String {
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

pub(super) fn resolve_project(projects: &[(String, String, String)], id: &str) -> Option<String> {
    projects.iter().find(|(path, _, _)| project_id(path) == id).map(|(path, _, _)| path.clone())
}

/// The app's answers for the shared chat rows (`pm_core::device_link::pclink::engine_services`).
pub(super) struct AppChatEnv;

impl ChatEnv for AppChatEnv {
    fn registry(&self) -> Option<Arc<parking_lot::Mutex<crate::pty::PaneRegistry>>> {
        link_app_handles().map(|(_, registry)| registry)
    }
    fn watchers(&self) -> Option<Arc<crate::session_chat::Watchers>> {
        let (app, registry) = link_app_handles()?;
        Some(app.state::<crate::commands::SessionChatState>().watchers(&app, &registry))
    }
    fn remote_ok(&self, pane: &str) -> bool {
        remote_ok(pane)
    }
    fn project_id(&self, path: &str) -> String {
        project_id(path)
    }
    fn project_folder(&self, id: &str) -> Option<String> {
        let (_, registry) = link_app_handles()?;
        resolve_project(&known_projects(&registry), id)
    }
    fn device_id(&self, node: &str) -> String {
        crate::mobile_pairing::link_device_id(node)
    }
    fn start_deps(&self) -> Option<crate::acp::chat::StartDeps> {
        let (_, registry) = link_app_handles()?;
        Some(engine::live_deps(&registry))
    }
    fn remember_folder(&self, folder: &str) {
        crate::worktrees::folder::remember(&crate::app_paths::app_data_dir(), folder);
    }
    fn extend_row(&self, row: &mut Value, pane: &crate::pty::PaneInfo) {
        super::sessions_rows::extend(row, pane, project_id, folder_name);
    }
    fn vouch_attachments(&self, pane: &str, named: &[crate::attach::ChatAttachment]) -> Result<Vec<crate::attach::ChatAttachment>, Reply> {
        super::calls_attach::cwd_of(pane).and_then(|cwd| super::calls_attach::vouch_all(named, &cwd).map_err(|e| command_error(&e)))
    }
    fn start_account(&self, node: &str, agent: &str, account: &str) -> Result<String, Reply> {
        super::calls_lend::start_account(node, agent, account)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_pairing::pane_rules::{self, Level as RuleLevel, PaneRule};
    use crate::questions::{store, Choice, NewQuestion, ACP_KIND_PERMISSION};

    #[test]
    fn the_mode_is_one_of_three_words() {
        use super::super::meta::{mode_word, MODE_ACTS, MODE_ASKS, MODE_UNKNOWN};
        let options = |mode: &str, model: &str| {
            vec![
                json!({ "id": "mode", "category": "mode", "currentValue": mode, "options": [{ "value": "default", "name": "Ask" }, { "value": "bypassPermissions", "name": "Full access" }] }),
                json!({ "id": "model", "category": "model", "currentValue": model, "options": [{ "value": "sonnet", "name": "Sonnet 5.5" }] }),
            ]
        };
        let needs = message_needs_full;
        assert_eq!(mode_word(&options("default", "sonnet"), &[], needs), MODE_ASKS);
        assert_eq!(mode_word(&options("bypassPermissions", "sonnet"), &[], needs), MODE_ACTS);
        assert_eq!(mode_word(&options("default", "sonnet"), &["execute".to_string()], needs), MODE_ACTS, "kinds allowed without asking");
        assert_eq!(mode_word(&[], &[], needs), MODE_UNKNOWN);
        assert_eq!(mode_word(&[json!({ "id": "model", "category": "model", "currentValue": "x" })], &[], needs), MODE_UNKNOWN);
    }

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

#[cfg(test)]
mod call_tests {
    use super::*;

    fn services() -> AppServices {
        AppServices::new(Arc::new(|| "Desk".into()))
    }

    #[test]
    fn force_yes_on_needs_the_press_and_hold_on_the_far_pc_and_turning_it_off_does_not() {
        let svc = services();
        let (status, body) = svc.call("aa", "acp_chat_set_force_yes", &json!({ "paneId": "no-such-pane", "on": true }));
        assert_eq!((status, body["code"].as_str()), (409, Some("NEEDS_HOLD")));
        // Held (or off): it gets to the chat, which is not there, and says so in the PC link's error shape.
        // The person's own PC (`_marked`, put there by `handle`) is not asked to hold: it goes through to the chat too.
        for args in [json!({ "paneId": "no-such-pane", "on": true, "hold": true }), json!({ "paneId": "no-such-pane", "on": true, "_marked": true }), json!({ "paneId": "no-such-pane", "on": false })] {
            let (status, body) = svc.call("aa", "acp_chat_set_force_yes", &args);
            assert_eq!((status, body["code"].as_str()), (404, Some("PANE_NOT_FOUND")), "{args}");
        }
        assert_eq!(svc.call("aa", "acp_chat_set_force_yes", &json!({ "paneId": "p" })).1["code"], "INVALID_ARGUMENT", "on is required");
        assert_eq!(svc.call("aa", "acp_chat_state", &json!({ "paneId": "no-such-pane" })), (200, Value::Null));
        assert_eq!(svc.call("aa", "acp_chat_set_config", &json!({ "paneId": "p", "optionId": "effort" })).1["code"], "INVALID_ARGUMENT");
        assert_eq!(svc.call("aa", "acp_chat_copy_keep", &json!({ "paneId": "p" })).0, 404, "a command that is not a row");
    }

    #[test]
    fn the_real_call_path_asks_a_hold_of_an_unmarked_pc_only_for_the_chat_switches() {
        let svc = services();
        for (cmd, key) in [("acp_chat_set_auto_allow", "on"), ("acp_chat_set_agent_answering", "allowed")] {
            let body = |extra: Value| {
                let mut b = json!({ "paneId": "no-such-pane", "kind": "edit", key: true });
                b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
                b
            };
            assert_eq!(svc.call("aa", cmd, &body(json!({}))).1["code"], "NEEDS_HOLD", "{cmd}: an unmarked PC that did not hold");
            // Held, or the person's own PC: past the gate (the rows' implementation is not installed in a unit test, so the table's own 404).
            for extra in [json!({ "hold": true }), json!({ "_marked": true })] {
                assert_ne!(svc.call("aa", cmd, &body(extra.clone())).1["code"], "NEEDS_HOLD", "{cmd} {extra}");
            }
        }
    }

    #[test]
    fn a_command_error_keeps_its_code_and_gets_a_status() {
        assert_eq!(command_error("BUSY: The agent is working."), (409, json!({ "code": "BUSY", "error": "The agent is working." })));
        assert_eq!(command_error("INVALID_ARGUMENT: the agent does not offer x").0, 400);
        assert_eq!(command_error("ACP_CONFIG_FAILED: it broke").0, 502);
        assert_eq!(command_error("something odd: here"), (400, json!({ "code": "COMMAND_FAILED", "error": "something odd: here" })));
    }
}
