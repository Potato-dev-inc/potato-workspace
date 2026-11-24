//! The chat half of the PC link's [`Services`](super::Services): sessions, transcript, picture, the cards a PC may answer, the message
//! box, Stop, a chat's settings, start and warm. The app's `AppServices` and the screen-less host's `HostServices` both call these
//! functions, so a far PC gets one behaviour (and one set of rights rules) from either machine.
//!
//! What differs per machine is [`ChatEnv`]: where the pane table and the chat readers are, how a folder is named and found by id, which
//! panes the person shut for other PCs, and how a chat is started. Every function answers `(status, json)` in the PC link's own shapes.
//! None of them checks a level: `pclink::handle` did that before calling.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::calls_files::{bad, command_error, Reply};
use crate::acp::chat::{self, StartDeps};
use crate::pty::PaneRegistry;
use crate::session_chat::Watchers;

/// What one machine answers for the chat rows.
pub trait ChatEnv: Send + Sync {
    /// The pane table, or `None` while this machine is not ready (every row then answers 503).
    fn registry(&self) -> Option<Arc<Mutex<PaneRegistry>>>;
    /// The readers of the stored and live chats.
    fn watchers(&self) -> Option<Arc<Watchers>>;
    /// Whether the person has left this pane open to other PCs (their own "not for remote use" switch). It only shuts; it never caps a level.
    fn remote_ok(&self, pane: &str) -> bool;
    /// The opaque id of a folder, as `GET /pclink/projects` lists it (a path never travels).
    fn project_id(&self, path: &str) -> String;
    /// The folder of a project this machine knows, by its id. Never a path the asker sent: an id this machine did not hand out is `None`.
    fn project_folder(&self, id: &str) -> Option<String>;
    /// The id of the paired PC `node` as the audit trail and the message box name it.
    fn device_id(&self, node: &str) -> String {
        super::calls_files::link_device_id(node)
    }
    /// The chat config an agent id names on this machine (a machine, or a test, with agents of its own overrides it).
    fn find_agent(&self, agent: &str) -> Option<crate::acp::config::AgentConfig> {
        crate::acp::config::find_builtin(agent)
    }
    /// What a chat start needs from this machine (its pane table, its event sink, its conversations).
    fn start_deps(&self) -> Option<StartDeps>;
    /// A folder a chat was started in is one this machine now remembers as recent.
    fn remember_folder(&self, _folder: &str) {}
    /// The fields a screen adds to a session row beyond the shared ones (helper of, workflow mark, copy). Nothing by default.
    fn extend_row(&self, _row: &mut Value, _pane: &crate::pty::PaneInfo) {}
    /// A chat on a borrowed sign-in: the account id this PC may use for `agent`, or the refusal. This machine has none by default.
    fn start_account(&self, _node: &str, _agent: &str, _account: &str) -> Result<String, Reply> {
        Err((403, json!({ "code": "LEND_NOT_HERE", "error": "Sharing an agent is not available on this computer." })))
    }
    /// The files a far PC attached to a message, vouched for from this machine's disk inside the chat's project (the asker's own paths mean
    /// nothing here). This machine takes none by default.
    fn vouch_attachments(&self, _pane: &str, _named: &[crate::attach::ChatAttachment]) -> Result<Vec<crate::attach::ChatAttachment>, Reply> {
        Err((404, json!({ "code": "NOT_ON_THIS_MACHINE", "error": "Not on this machine yet." })))
    }
    /// One Full change from a paired PC, for the audit trail: which setting and which chat, never its value.
    fn audit_call(&self, node: &str, pane: &str, what: &str, held: bool) {
        let (kind, summary) = if held {
            (crate::audit::Kind::Pairing, format!("A paired PC gave one agent full access ({what}, held to allow)"))
        } else {
            (crate::audit::Kind::Setting, format!("A paired PC changed a setting of one agent ({what})"))
        };
        crate::audit::record(kind, crate::audit::Who::Device(Some(self.device_id(node))), &summary, json!({ "pane_id": pane }));
    }
}

pub fn not_ready() -> Reply {
    (503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" }))
}

pub fn unknown(session: &str) -> Reply {
    (404, json!({ "code": "UNKNOWN_SESSION", "error": crate::pty::registry::unknown_pane_message(session) }))
}

pub fn needs_hold_reply() -> Reply {
    (409, json!({ "code": "NEEDS_HOLD", "error": "This lets the agent act without asking. Turn it on from the PC the agent runs on." }))
}

fn merge(result: Result<Reply, Reply>) -> Reply {
    match result {
        Ok(ok) | Err(ok) => ok,
    }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The last part of a folder path.
pub fn folder_name(path: &str) -> String {
    path.trim_end_matches(|c| c == '/' || c == '\\').rsplit(|c| c == '/' || c == '\\').next().unwrap_or("").to_string()
}

/// A refusal when `session` is a chat that runs on another computer: another PC may not list, read, message, stop or approve it.
pub fn remote_refusal(session: &str) -> Option<Reply> {
    chat::is_remote_pane(session).then(chat::remote_refusal)
}

/// The refusal for a pane the person shut for other PCs.
pub fn locked() -> Reply {
    (403, json!({ "error": "This agent is switched off for other PCs on its own PC.", "code": "AGENT_LOCKED" }))
}

// ----- Watch -----

/// `{ sessions: [{ id, agent, title, status, project, folder, chat, branch, model, mode, parent? ... }] }`.
/// `(n, of)` per pane id: the place of a pane among the panes of its agent in this PC's own list (oldest first, a standby's own chat
/// uncounted), as the window numbers them (`paneNames`). Chats on other computers count here as they do in the window.
pub fn agent_numbers(registry: &Mutex<PaneRegistry>) -> std::collections::HashMap<String, (usize, usize)> {
    static BOOK: std::sync::OnceLock<std::sync::Mutex<Ordinals>> = std::sync::OnceLock::new();
    let mut book = BOOK.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    numbers_with(&mut book, registry.lock().list_including_remote())
}

/// The numbers this PC has handed out: a chat keeps its number for as long as it lives (closing "Claude 5" renumbers nobody), a new
/// chat takes the next one for its agent. Kept in memory for the run, like the window's own `paneNames`.
#[derive(Default)]
pub struct Ordinals {
    by_pane: std::collections::HashMap<String, usize>,
    last: std::collections::HashMap<String, usize>,
}

#[cfg(test)]
fn numbers_of(all: Vec<crate::pty::PaneInfo>) -> std::collections::HashMap<String, (usize, usize)> {
    numbers_with(&mut Ordinals::default(), all)
}

fn numbers_with(book: &mut Ordinals, mut all: Vec<crate::pty::PaneInfo>) -> std::collections::HashMap<String, (usize, usize)> {
    all.retain(|p| p.standby_seat.is_none());
    all.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    let mut total: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for p in &all {
        *total.entry(p.agent_type.clone()).or_default() += 1;
    }
    let live: std::collections::HashSet<&str> = all.iter().map(|p| p.id.as_str()).collect();
    book.by_pane.retain(|id, _| live.contains(id.as_str()));
    all.iter()
        .map(|p| {
            let n = match book.by_pane.get(&p.id) {
                Some(n) => *n,
                None => {
                    let n = book.last.get(&p.agent_type).copied().unwrap_or(0) + 1;
                    book.last.insert(p.agent_type.clone(), n);
                    book.by_pane.insert(p.id.clone(), n);
                    n
                }
            };
            (p.id.clone(), (n, total[&p.agent_type]))
        })
        .collect()
}

pub fn sessions(env: &dyn ChatEnv) -> Reply {
    let Some(registry) = env.registry() else { return not_ready() };
    let mut panes = chat::external_panes(&registry);
    // The same order at every ask (oldest first, then by id), never the order the table happened to hold: the far sidebar must not reshuffle.
    panes.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    let numbers = agent_numbers(&registry);
    let mut probes = 0usize;
    let rows: Vec<Value> = panes
        .into_iter()
        // A machine serves its own panes only: an id that already names another device is never listed (no hops).
        .filter(|p| !p.id.starts_with("dev:"))
        .map(|p| {
            let mut row = json!({
                "id": p.id,
                "agent": clip(&p.agent_type, 40),
                "title": clip(p.title.as_deref().unwrap_or(""), 80),
                "status": p.status,
                // The folder as a name and an opaque id, like `projects`: a path (it can name the person's home folder) never travels.
                "project": if p.cwd.trim().is_empty() { String::new() } else { env.project_id(&p.cwd) },
                "folder": clip(&folder_name(&p.cwd), 120),
                "chat": p.lane.as_deref() == Some("acp"),
            });
            // Read-only facts so a chat here can look like the local one (`meta.rs` lists exactly what each exposes): a branch NAME,
            // a model display name, and a permission mode as one of three words. Never a path, a setting's raw text or a token.
            row["branch"] = json!(super::meta::BRANCHES.of(&p.cwd, &mut probes, &super::meta::head_branch));
            let live = chat::get(&p.id);
            let options = live.as_ref().map(|c| c.session().snapshot().config_options).unwrap_or_default();
            let auto = live.as_ref().map(|c| c.auto_allowed_kinds()).unwrap_or_default();
            row["model"] = json!(super::meta::model_name(&options));
            row["mode"] = json!(if live.is_some() { super::meta::mode_word(&options, &auto, message_needs_full) } else { super::meta::MODE_UNKNOWN });
            if let Some(parent) = p.parent_pane_id.as_deref().filter(|s| !s.is_empty()) {
                row["parent"] = json!(clip(parent, 200));
            }
            // The number this PC's own sidebar gives the chat ("Claude 5" is `agent_n` 5 of `agent_of`): the name comes from the owning PC.
            if let Some((n, of)) = numbers.get(&p.id) {
                row["agent_n"] = json!(n);
                row["agent_of"] = json!(of);
            }
            env.extend_row(&mut row, &p);
            row
        })
        .collect();
    (200, json!({ "sessions": rows }))
}

pub fn transcript(env: &dyn ChatEnv, session: &str, since: Option<u64>) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(registry) = env.registry() else { return not_ready() };
    let Some(watchers) = env.watchers() else { return not_ready() };
    let Some(agent_type) = registry.lock().get(session).map(|pane| pane.info.agent_type.clone()) else { return unknown(session) };
    let opening = crate::session_chat::Opening::for_pane(session, &agent_type);
    (200, crate::session_chat::phone::read(&watchers, session, opening.as_ref(), since))
}

pub fn transcript_earlier(env: &dyn ChatEnv, session: &str, before: &str, limit: Option<usize>) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(registry) = env.registry() else { return not_ready() };
    if registry.lock().get(session).is_none() {
        return unknown(session);
    }
    (200, crate::session_chat::earlier::for_pane(session, before, limit.unwrap_or(crate::session_chat::earlier::DEFAULT_PAGE), true))
}

pub fn picture(env: &dyn ChatEnv, session: &str, path: &str) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(registry) = env.registry() else { return not_ready() };
    let Some(cwd) = registry.lock().get(session).map(|pane| pane.info.cwd.clone()) else { return unknown(session) };
    use crate::session_chat::picture;
    match picture::read(path, &cwd, &picture::roots_for(&cwd), picture::PHONE_MAX_BYTES) {
        Ok(found) => (200, serde_json::to_value(found).unwrap_or(Value::Null)),
        Err(refused) => (if refused.code == "PICTURE_TOO_BIG" { 413 } else { 404 }, picture::refusal_body(&refused)),
    }
}

/// `{ questions: [...] }`: the ones a PC may answer (an agent's own question or permission, never a person-only card).
/// Below Full (`full` false) a permission card shows only its "no" choices.
pub fn questions(env: &dyn ChatEnv, full: bool) -> Reply {
    let list: Vec<Value> = crate::questions::store()
        .list_pending(crate::questions::now_ms())
        .into_iter()
        .filter(may_answer)
        // An agent switched off for other PCs on its own PC shows none of its cards.
        .filter(|q| q.pane_id.as_deref().map_or(true, |pane| env.remote_ok(pane)))
        .map(|mut q| {
            // Below Full a tool permission offers only its "no" choices: approving it is what Full means.
            if !full && q.kind.as_deref() == Some(crate::questions::ACP_KIND_PERMISSION) {
                let pane = q.pane_id.clone();
                let id = q.id.clone();
                q.choices.retain(|c| choice_kind_of(pane.as_deref(), &id, &c.id).is_some_and(|k| is_reject(&k)));
            }
            let left = force_yes_left(q.context.as_deref());
            let mut row = serde_json::to_value(q).unwrap_or(Value::Null);
            // Why Force yes left this card to the person (a short code), so a far card can say it too.
            if let (Some(code), Some(obj)) = (left, row.as_object_mut()) {
                obj.insert("force_yes_left".into(), json!(code));
            }
            row
        })
        .collect();
    (200, json!({ "questions": list }))
}

/// The code after `Force yes asked: ` in a card's context (`acp::chat::rules::LEFT_PREFIX`): letters, digits and `_` only.
pub fn force_yes_left(context: Option<&str>) -> Option<String> {
    let code = context?.lines().find_map(|l| l.strip_prefix(crate::acp::chat::rules::LEFT_PREFIX))?.trim();
    (!code.is_empty() && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).then(|| code.to_string())
}

#[cfg(test)]
mod left_tests {
    use super::{force_yes_left, numbers_of, numbers_with, Ordinals};

    fn pane(id: &str, agent: &str, at: i64, standby: bool) -> crate::pty::PaneInfo {
        let mut p: crate::pty::PaneInfo = serde_json::from_value(serde_json::json!({ "id": id, "agent_type": agent, "pid": 1, "status": "idle", "created_at": at, "last_output_at": null, "cwd": "/w", "cols": 80, "rows": 24 })).unwrap();
        if standby {
            p.standby_seat = Some("seat".into());
        }
        p
    }

    #[test]
    fn a_chat_is_numbered_the_way_its_own_window_numbers_it() {
        // Oldest first, per agent; a standby's own chat takes no number and makes no other one take one.
        let n = numbers_of(vec![pane("c", "claude", 30, false), pane("a", "claude", 10, false), pane("s", "claude", 20, true), pane("x", "codex", 5, false), pane("b", "claude", 25, false)]);
        assert_eq!((n["a"], n["b"], n["c"], n["x"]), ((1, 3), (2, 3), (3, 3), (1, 1)));
        assert!(!n.contains_key("s"));
    }
    #[test]
    fn closing_a_chat_renumbers_nobody_and_a_new_one_takes_the_next_number() {
        let mut book = Ordinals::default();
        let all = |ids: &[(&str, i64)]| ids.iter().map(|(id, at)| pane(id, "claude", *at, false)).collect::<Vec<_>>();
        let first = numbers_with(&mut book, all(&[("a", 1), ("b", 2), ("c", 3)]));
        assert_eq!((first["a"].0, first["b"].0, first["c"].0), (1, 2, 3));
        // "b" (Claude 2) closes: "c" stays 3 (of 2 now), and the next chat is 4, never a reused 2 or 3.
        let after = numbers_with(&mut book, all(&[("a", 1), ("c", 3), ("d", 4)]));
        assert_eq!((after["a"], after["c"], after["d"]), ((1, 3), (3, 3), (4, 3)));
        // Same created_at: the order is by id, not by arrival.
        let tie = numbers_with(&mut Ordinals::default(), all(&[("z", 5), ("m", 5)]));
        assert_eq!((tie["m"].0, tie["z"].0), (1, 2));
    }
    use crate::p2p::{endpoint::NodeId, trust::TrustList};

    #[test]
    fn the_force_yes_reason_is_read_from_the_card_context_and_nothing_else() {
        assert_eq!(force_yes_left(Some("Kind of action: execute\nForce yes asked: risky")).as_deref(), Some("risky"));
        assert_eq!(force_yes_left(Some("Kind of action: execute")), None);
        assert_eq!(force_yes_left(Some("Force yes asked: <b>x</b>")), None);
        assert_eq!(force_yes_left(None), None);
    }

    #[test]
    fn a_pc_that_set_this_one_up_over_ssh_is_the_persons_own_pc_but_a_plain_pair_is_not() {
        let keys = crate::keys::KeyStore::with_backend(std::sync::Arc::new(crate::secrets::MemoryBackend::new()), "t");
        let t = TrustList::open(crate::p2p::trust::MemoryTrustStorage::new(), std::sync::Arc::new(crate::p2p::trust::KeyStoreSigner::new(keys)));
        let (ssh, account, plain) = (NodeId([1; 32]), NodeId([2; 32]), NodeId([3; 32]));
        for (n, name) in [(ssh, "a"), (account, "b"), (plain, "c")] {
            t.add(n, [9; 32], name, 1).unwrap();
        }
        t.grant_ssh_full(&ssh).unwrap();
        t.grant_account_default(&account).unwrap();
        assert!(t.own_pc(&ssh) && t.own_pc(&account) && !t.own_pc(&plain));
    }
}

// ----- Answer -----

pub fn outbox_list(env: &dyn ChatEnv, session: &str) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(registry) = env.registry() else { return not_ready() };
    let messages: Vec<_> = crate::pane_outbox::global(&registry).list(session).iter().map(crate::pane_outbox::redacted).collect();
    (200, json!({ "messages": messages }))
}

pub fn send_message(env: &dyn ChatEnv, node: &str, session: &str, text: &str, full: bool, attachments: &[crate::attach::ChatAttachment]) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(registry) = env.registry() else { return not_ready() };
    if !full {
        if let Some(live) = chat::get(session) {
            if message_needs_full(&live.session().snapshot().config_options, &live.auto_allowed_kinds()) {
                return (403, json!({ "error": "This agent is set to act without asking. Messaging it needs Full on this PC.", "code": "MESSAGE_NEEDS_FULL", "needs": "full" }));
            }
        }
    }
    let from = env.device_id(node);
    match crate::pane_outbox::global(&registry).send_from(session, text, attachments, Some(&from)) {
        Ok(message) => (200, json!({ "message": crate::pane_outbox::redacted(&message) })),
        Err(error) => {
            let code = if error == chat::TOOK_BACK_SENTENCE { chat::drive::TOOK_BACK_CODE } else { "MESSAGE_REFUSED" };
            (if code == "MESSAGE_REFUSED" { 400 } else { 409 }, json!({ "error": error, "code": code }))
        }
    }
}

pub fn cancel_message(env: &dyn ChatEnv, session: &str, message: &str) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(registry) = env.registry() else { return not_ready() };
    match crate::pane_outbox::global(&registry).cancel(session, message) {
        Ok(message) => (200, json!({ "message": crate::pane_outbox::redacted(&message) })),
        Err(error) => (409, json!({ "error": error, "code": "MESSAGE_NOT_CANCELLABLE" })),
    }
}

/// Stop: a chat's turn, or Ctrl+C in a terminal.
pub fn interrupt(env: &dyn ChatEnv, session: &str) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(registry) = env.registry() else { return not_ready() };
    if !registry.lock().panes.contains_key(session) {
        return unknown(session);
    }
    if chat::is_chat_pane(&registry, session) {
        return merge(chat::api::cancel(session));
    }
    match crate::pty::registry_write_input(&registry, session, "\u{3}", false, false, None, crate::pty::WriteOrigin::User) {
        Ok(_) => (200, json!({ "id": session, "stopped": true })),
        Err(error) => (502, json!({ "error": error, "code": "INTERRUPT_FAILED" })),
    }
}

/// Answers a card. `full`: the asker is at Full; below Full a tool permission can only be DENIED.
pub fn answer_question(env: &dyn ChatEnv, id: &str, body: &Value, full: bool) -> Reply {
    let store = crate::questions::store();
    let Some(question) = store.get(id, crate::questions::now_ms()) else {
        return (404, json!({ "code": "QUESTION_NOT_FOUND", "error": "That question is not waiting any more." }));
    };
    if !may_answer(&question) {
        return (403, json!({ "code": "NEEDS_PERSON", "error": "This card is a decision for the person at this PC." }));
    }
    if let Some(pane) = question.pane_id.as_deref() {
        if let Some(refused) = remote_refusal(pane) {
            return refused;
        }
        if !env.remote_ok(pane) {
            return locked();
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
    crate::questions::routes::publish_changed();
    match result {
        Ok(done) => (200, serde_json::to_value(done).unwrap_or(Value::Null)),
        Err(e) => (e.status(), json!({ "code": e.code, "error": e.message })),
    }
}

// ----- Full -----

/// `allow`: the asker may do what needs a hold (it held, or it is the person's own PC). `held`: it really held; only that is audited as held.
pub fn set_config_as(env: &dyn ChatEnv, node: &str, session: &str, option: &str, value: &str, allow: bool, held: bool) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(live) = chat::get(session) else {
        return (404, json!({ "code": "UNKNOWN_SESSION", "error": format!("{session} is not a chat session") }));
    };
    let options = live.session().snapshot().config_options;
    let wants_hold = needs_hold(&options, option, value);
    if wants_hold && !allow {
        return needs_hold_reply();
    }
    let state = match chat_set_config(session, option, value) {
        Ok(state) => state,
        Err(text) => return command_error(&text),
    };
    env.audit_call(node, session, "chat setting", wants_hold && held);
    (200, state)
}

/// The Force yes switch of a chat. Turning it ON lets the agent act without asking: the same press and hold as "Full access".
pub fn set_force_yes(env: &dyn ChatEnv, node: &str, pane: &str, on: bool, hold: bool, held: bool) -> Reply {
    if on && !hold {
        return needs_hold_reply();
    }
    match chat_set_force_yes(pane, on) {
        Ok(state) => {
            env.audit_call(node, pane, "Force yes", on && held);
            (200, state)
        }
        Err(text) => command_error(&text),
    }
}

/// Starts a chat in `folder` (already resolved from a project id by the caller). `account`: a borrowed sign-in the caller has checked.
pub fn start_chat(env: &dyn ChatEnv, agent: &str, folder: &str, account: Option<String>) -> Reply {
    let Some(deps) = env.start_deps() else { return not_ready() };
    let request = json!({ "agent": agent, "folder": folder, "lane": "acp" });
    match chat::api::start_with_agents(&request, &deps, account, &|agent| env.find_agent(agent)) {
        Ok((status, reply)) => {
            env.remember_folder(folder);
            (status, reply)
        }
        Err(refused) => refused,
    }
}

/// The unknown-project refusal of every row that names a project.
pub fn unknown_project() -> Reply {
    (404, json!({ "code": "UNKNOWN_PROJECT", "error": "The PC does not know that project. Open it on the PC first." }))
}

/// The message box's warm-up: tell the pool a chat in `project` is likely next.
pub fn warm(env: &dyn ChatEnv, agent: &str, project: &str) -> Reply {
    let Some(folder) = env.project_folder(project) else { return unknown_project() };
    (200, json!({ "warming": crate::acp::warm::hint(agent, std::path::Path::new(&folder), None) }))
}

// ----- The inner functions of the chat commands -----

/// The session behind a chat pane: phase, stopping, what waits on the person, settings. `null` for a pane that is not a chat session.
pub fn chat_state(pane_id: &str) -> Value {
    match chat::get(pane_id) {
        Some(session) => {
            session.reconcile_cards();
            session.state()
        }
        None => Value::Null,
    }
}

/// Changes a setting the agent offers (model, mode, effort) in a chat session (blocking: the agent answers). Returns the new state.
pub fn chat_set_config(pane_id: &str, option_id: &str, value: &str) -> Result<Value, String> {
    let session = chat::get(pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))?;
    session.set_config(option_id, value).map_err(|e| match e {
        crate::acp::error::AcpError::Busy => "BUSY: The agent is working. Change this when the turn ends.".to_string(),
        crate::acp::error::AcpError::BadOption(what) => format!("INVALID_ARGUMENT: the agent does not offer {what}"),
        other => format!("ACP_CONFIG_FAILED: {other}"),
    })?;
    // A model the person picks is the next chat's starting model (for an agent that has a default-model rule).
    chat::default_model::remember_pick(&session, option_id, value);
    Ok(session.state())
}

/// The person's Force yes switch for this chat. A fence still holds, and a question the risk rules do not call low risk still comes to the person.
pub fn chat_set_force_yes(pane_id: &str, on: bool) -> Result<Value, String> {
    let session = chat::get(pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))?;
    session.set_force_yes(on);
    Ok(session.state())
}

/// What a start needs from a machine with a pane table and nothing else: events go out through the host, the status into the event log.
pub fn live_deps(registry: &Arc<Mutex<PaneRegistry>>) -> StartDeps {
    StartDeps { registry: registry.clone(), host: Arc::new(LiveChatHost), env: Arc::new(crate::acp::config::RealHost), conversations: Some(crate::acp::conversations::global().clone()) }
}

/// The chat host of a running machine: the window events through [`crate::host`], the paired PCs' frames through the hooks, the event log for the status.
pub struct LiveChatHost;

impl chat::ChatHost for LiveChatHost {
    fn status_changed(&self, pane_id: &str, status: crate::pty::status::PaneStatus) {
        crate::event_log::append_system_event(crate::events::SystemEvent::PaneStatusChanged {
            pane_id: crate::events::PaneId(pane_id.to_string()),
            status: status.as_str().to_string(),
        });
        crate::host::emit("pty://status", json!({ "pane_id": pane_id, "status": status.as_str() }));
    }

    fn state_changed(&self, pane_id: &str, state: &Value) {
        // A paired PC sees the same new state (an `app` frame, `pclink::events`); a chat on another computer is this window's alone.
        if !chat::is_remote_pane(pane_id) {
            crate::hooks::get().push_sse(super::events::app_frame("acp-chat-state", &json!({ "paneId": pane_id, "state": state })));
        }
        crate::host::emit("acp-chat-state", json!({ "paneId": pane_id, "state": state }));
    }

    fn questions_changed(&self, _raised: Option<&crate::questions::Question>) {
        crate::questions::routes::publish_changed();
    }

    fn panes_changed(&self) {
        crate::host::emit("pty://panes-changed", Value::Null);
    }
}

// ----- The rights rules (one copy: the app and the host both come here) -----

/// What a choice on a permission card means in the agent's own words, from the chat that holds the card.
pub fn choice_kind_of(pane: Option<&str>, question_id: &str, choice_id: &str) -> Option<String> {
    chat::get(pane?)?.card_choice_kind(question_id, choice_id)
}

pub fn is_reject(kind: &str) -> bool {
    kind.starts_with("reject")
}

/// The one rule for tool permissions: below Full a PC may only DENY. An unknown choice (no card, no such option, free text) counts as a
/// yes, so it is refused: the rule fails closed.
pub fn approval_needs_full(is_permission: bool, full: bool, choice_kind: Option<&str>, has_text: bool) -> bool {
    is_permission && !full && (has_text || !choice_kind.is_some_and(is_reject))
}

/// A card a paired PC may answer: an agent's own question, or its permission to run a tool. Consent, usage-limit, budget,
/// issue, CI and helper-login cards are decisions for the person at this PC.
pub fn may_answer(q: &crate::questions::Question) -> bool {
    q.consent.is_none() && q.limit.is_none() && (q.kind.is_none() || q.kind.as_deref() == Some(crate::questions::ACP_KIND_PERMISSION))
}

/// Whether a message would run with no card at all: a mode that lets the agent act with no questions asked (the same words as the
/// press-and-hold rule), or kinds of action allowed without asking. For an Answer PC that is Full by another name.
pub fn message_needs_full(options: &[Value], auto_allowed: &[String]) -> bool {
    !auto_allowed.is_empty()
        || options.iter().any(|o| {
            o["category"].as_str() == Some("mode")
                && match (o["id"].as_str(), o["currentValue"].as_str()) {
                    (Some(id), Some(current)) => needs_hold(options, id, current),
                    _ => false,
                }
        })
}

const FULL_ACCESS: &str = r"(?i)full[\s_-]*access|bypass|yolo|dangerous|skip[\s_-]*permission|auto[\s_-]*approve|never[\s_-]*ask";

/// Whether picking `value` for the mode setting `option_id` lets the agent act with no questions asked (it then needs a press and hold).
pub fn needs_hold(options: &[Value], option_id: &str, value: &str) -> bool {
    let Some(option) = options.iter().find(|o| o["id"].as_str() == Some(option_id)) else { return false };
    if option["category"].as_str() != Some("mode") {
        return false;
    }
    let name = option["options"].as_array().and_then(|list| list.iter().find(|c| c["value"].as_str() == Some(value))).and_then(|c| c["name"].as_str()).unwrap_or("");
    let Ok(re) = regex::Regex::new(FULL_ACCESS) else { return false };
    re.is_match(value) || re.is_match(name)
}

/// The row for a missing `paneId` on a chat row.
pub fn pane_required() -> Reply {
    bad("INVALID_ARGUMENT", "paneId is required")
}

// ----- Agents and closing -----

/// The agents a chat can start for right now, as `(id, label)`: Chat is on, the agent has a chat way to run (its own or the person's
/// overlay), it is not switched off and its add-on is installed.
pub fn chat_agents() -> Vec<(String, String)> {
    if !crate::acp::chat_enabled() {
        return Vec::new();
    }
    let overlay = crate::acp::overlay::OverlayStore::in_app_data();
    let mut all = crate::acp::config::builtin_agents();
    all.extend(crate::acp::overlay::overlay_agents(&overlay));
    all.into_iter().filter(|cfg| !cfg.disabled && !crate::acp::install::is_missing(cfg, &crate::acp::config::RealHost)).map(|cfg| (cfg.id, cfg.label)).collect()
}

/// The agents a PC may start: a chat, a terminal, or both. With terminals hidden on this machine only agents that can chat are listed.
pub fn offered_agents(chat_agents: &[(String, String)], terminal_agents: &[(String, String)], terminals: bool) -> (Vec<Value>, usize) {
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

/// Closes one session (an agent that was started by mistake, or a move that did not finish): its chat stops and its pane goes.
pub fn close_session(env: &dyn ChatEnv, session: &str) -> Reply {
    if let Some(refused) = remote_refusal(session) {
        return refused;
    }
    let Some(registry) = env.registry() else { return not_ready() };
    if !registry.lock().panes.contains_key(session) {
        return unknown(session);
    }
    match crate::pty::registry::helper_cascade::kill_pane_and_helpers(&registry, session, Some("closed from another PC")) {
        Ok(()) => (200, json!({ "id": session, "closed": true })),
        Err(error) => (502, json!({ "error": error, "code": "CLOSE_FAILED" })),
    }
}

// ----- A machine with a project list and no windows (potato-host) -----

/// How a machine with a project list names its folders: an opaque id per folder, and the folder back from an id it handed out.
pub trait ProjectNames: Send + Sync {
    fn id(&self, path: &str) -> String;
    fn folder_of(&self, id: &str) -> Option<String>;
}

type AgentFinder = Arc<dyn Fn(&str) -> Option<crate::acp::config::AgentConfig> + Send + Sync>;

/// The chat rows of a machine that has a pane table, a project list and no windows: a screen-less host. A far screen sends chat ids
/// (a pane) for the rows of one chat and project ids for the rows that start one; [`ProjectChatEnv::folder_of_pane_or_project`] is the one
/// place that turns either into a folder, and an id it did not hand out is `None`, never a path from the far side.
pub struct ProjectChatEnv {
    registry: Arc<Mutex<PaneRegistry>>,
    projects: Arc<dyn ProjectNames>,
    watchers: std::sync::OnceLock<Arc<Watchers>>,
    agents: Option<AgentFinder>,
    deps: Option<StartDeps>,
}

/// The readers of this machine: no terminal panes to read (a chat is read from the session itself), no window to push to. A far PC reads
/// a chat by asking for its transcript from a revision.
struct NoTerminals;

impl crate::session_chat::Sink for NoTerminals {
    fn send(&self, _pane_id: &str, _items: Vec<crate::session_chat::ChatItem>, _reset: bool) {}
}

impl crate::session_chat::PaneLookup for NoTerminals {
    fn facts(&self, _pane_id: &str) -> Option<crate::session_chat::PaneFacts> {
        None
    }
}

/// A machine with no terminals: a conversation that was open in one has no pane to be found in, and none is started.
struct NoTerminalPanes;

impl crate::acp::handover::PaneHost for NoTerminalPanes {
    fn start(&self, _: &crate::acp::handover::TerminalStart) -> Result<String, String> {
        Err("This computer has no terminals yet.".into())
    }
    fn activity(&self, _: &str) -> crate::acp::handover::PaneActivity {
        crate::acp::handover::PaneActivity::Gone
    }
    fn stop(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

impl ProjectChatEnv {
    pub fn new(projects: Arc<dyn ProjectNames>) -> Self {
        Self { registry: Arc::new(Mutex::new(PaneRegistry::new())), projects, watchers: std::sync::OnceLock::new(), agents: None, deps: None }
    }

    /// Agents of this machine's own instead of the registered ones (a test starts the fake agent through the real rows with it).
    pub fn with_agents(mut self, agents: AgentFinder) -> Self {
        self.agents = Some(agents);
        self
    }

    /// Start dependencies of this machine's own (a test keeps its conversations in a folder of its own).
    pub fn with_start_deps(mut self, build: impl FnOnce(&Arc<Mutex<PaneRegistry>>) -> StartDeps) -> Self {
        self.deps = Some(build(&self.registry));
        self
    }

    pub fn pane_registry(&self) -> &Arc<Mutex<PaneRegistry>> {
        &self.registry
    }

    /// After a start: a chat pane for every conversation that was open when this machine stopped (nothing starts until one is read or
    /// written to). Returns how many came back.
    pub fn restore_chats(&self) -> usize {
        let Some(deps) = self.start_deps() else { return 0 };
        crate::acp::conversations::global().restore_lazily(&NoTerminalPanes);
        chat::restore_panes(&deps).len()
    }

    /// The folder a row names: a live chat's own folder, else a project this machine knows by id. Anything else (a closed or unknown id, a
    /// path, `..`) is `None`.
    pub fn folder_of_pane_or_project(&self, id: &str) -> Option<String> {
        let own = self.registry.lock().get(id).filter(|_| !chat::is_remote_pane(id)).map(|pane| pane.info.cwd.clone()).filter(|cwd| !cwd.trim().is_empty());
        own.or_else(|| self.projects.folder_of(id))
    }
}

impl ChatEnv for ProjectChatEnv {
    fn registry(&self) -> Option<Arc<Mutex<PaneRegistry>>> {
        Some(self.registry.clone())
    }
    fn watchers(&self) -> Option<Arc<Watchers>> {
        Some(self.watchers.get_or_init(|| Arc::new(Watchers::new(Arc::new(NoTerminals), Arc::new(NoTerminals)))).clone())
    }
    // A host has no per-pane "not for remote use" switch: a PC at some level reaches every chat, and the level rules decide what it may do.
    fn remote_ok(&self, pane: &str) -> bool {
        !chat::is_remote_pane(pane)
    }
    fn project_id(&self, path: &str) -> String {
        self.projects.id(path)
    }
    fn project_folder(&self, id: &str) -> Option<String> {
        self.projects.folder_of(id)
    }
    fn start_deps(&self) -> Option<StartDeps> {
        Some(self.deps.clone().unwrap_or_else(|| live_deps(&self.registry)))
    }
    fn find_agent(&self, agent: &str) -> Option<crate::acp::config::AgentConfig> {
        match &self.agents {
            Some(find) => find(agent),
            None => crate::acp::config::find_builtin(agent),
        }
    }
}

// ----- Lists the New agent page and the history read -----

/// `agents_list` as the far page reads it, without what only this machine's own screens need: a user-defined agent's `definition` and the
/// install hints can carry command lines and paths, and another PC (maybe another account's, at Watch) has no use for them.
pub fn agents_list() -> Value {
    let mut list = crate::agent_run_mode::decorate_listing(crate::tui::agent_types_listing());
    for row in list.get_mut("agents").and_then(Value::as_array_mut).into_iter().flatten() {
        for key in ["definition", "install_hint", "install_fallback"] {
            if row.get(key).is_some() {
                row[key] = Value::Null;
            }
        }
    }
    list
}

/// The closed chats of this machine, as a far PC may see them: the ones this machine left open to other PCs, each with its folder's name
/// in place of its path unless the asker is at Full.
pub fn closed_list(env: &dyn ChatEnv, full: bool) -> Value {
    let conversations = env.start_deps().and_then(|deps| deps.conversations).unwrap_or_else(|| crate::acp::conversations::global().clone());
    closed_rows(env, json!(conversations.closed_list()), full)
}

/// [`closed_list`] over a given list (the app gives its own conversations').
pub fn closed_rows(env: &dyn ChatEnv, list: Value, full: bool) -> Value {
    let rows = list.as_array().cloned().unwrap_or_default();
    Value::Array(
        rows.into_iter()
            .filter(|row| row["id"].as_str().is_some_and(|id| env.remote_ok(id)))
            .map(|mut row| {
                if !full {
                    if let Some(cwd) = row["cwd"].as_str() {
                        row["cwd"] = json!(cwd.rsplit(['/', '\\']).find(|part| !part.is_empty()).unwrap_or_default());
                    }
                }
                row
            })
            .collect(),
    )
}

// ----- The chat screen's call rows -----

/// The rows of the far call table that the chat screen of a far PC sends besides the feed itself (`session_chat_open` and its frames are
/// the app's own: they need a window to push to): Stop, "keep waiting", "take back", the warm-up, the chat's own switches, the message box
/// and "show earlier". Each runs the same inner function as the Tauri command of that name.
pub const CHAT_SCREEN_ROWS: &[&str] = &[
    "chat_earlier",
    "acp_chat_cancel",
    "pane_message_send",
    "pane_message_cancel",
    "pane_message_hold",
    "pane_message_edit",
    "pane_messages_list",
    "acp_chat_keep_waiting",
    "acp_chat_take_back",
    "acp_chat_set_auto_allow",
    "acp_chat_set_agent_answering",
    "acp_chat_warm",
];

fn flag(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    super::calls::arg(args, key)
}

fn text_of(args: &Value, key: &str) -> Option<String> {
    super::calls::text_arg(args, key)
}

/// The answer of a command that returns a value, or its `"CODE: sentence"` error.
fn done<T: serde::Serialize>(result: Result<T, String>) -> Reply {
    match result {
        Ok(value) => (200, serde_json::to_value(value).unwrap_or(Value::Null)),
        Err(error) => command_error(&error),
    }
}

/// A message of the outbox as it leaves this machine (its text redacted), or the refusal.
fn message(result: Result<crate::pane_outbox::OutboxMessage, String>, code: &str) -> Reply {
    match result {
        Ok(m) => (200, serde_json::to_value(crate::pane_outbox::redacted(&m)).unwrap_or(Value::Null)),
        Err(error) => (409, json!({ "code": code, "error": error })),
    }
}

/// The press-and-hold rule, before anything runs: turning ON a switch that lets the agent act without asking (Force yes, "don't ask
/// again", agents answering for the person) needs `hold: true` from the asker, unless it is the person's own PC (`_marked`).
/// `Some`: the refusal.
pub fn gate(cmd: &str, args: &Value) -> Option<Reply> {
    let on = match cmd {
        "acp_chat_set_auto_allow" => arg(args, "on").and_then(Value::as_bool),
        "acp_chat_set_agent_answering" => arg(args, "allowed").and_then(Value::as_bool),
        _ => return None,
    };
    match on {
        None => Some(bad("INVALID_ARGUMENT", if cmd == "acp_chat_set_auto_allow" { "kind and on are required" } else { "allowed is required" })),
        Some(true) if !(flag(args, "hold") || flag(args, "_marked")) => Some(needs_hold_reply()),
        Some(_) => None,
    }
}

/// Stops the turn of a chat session (`session/cancel`). True when a turn was running.
pub fn chat_cancel(pane_id: &str) -> Result<bool, String> {
    let session = chat::get(pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))?;
    session.cancel().map_err(|e| e.to_string())
}

/// "Take back": this machine drives the chat again. Returns the id of the device that was driving, or `None` when nobody else was.
pub fn chat_take_back(pane_id: &str) -> Result<Option<String>, String> {
    let live = chat::get(pane_id).ok_or_else(|| "This chat is not open any more.".to_string())?;
    Ok(live.take_back())
}

/// "Keep waiting": the agent was quiet, the person chose to wait. True when a turn was running.
pub fn chat_keep_waiting(pane_id: &str) -> Result<bool, String> {
    let session = chat::get(pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))?;
    Ok(session.keep_waiting())
}

/// The message box got the focus: start the chat's adapter if it sleeps. Starts nothing else.
pub fn chat_warm(pane_id: &str) {
    if let Some(session) = chat::get(pane_id) {
        session.warm();
    }
}

/// The person's switch: may agents answer this chat's permission questions (default: no, only you)?
pub fn chat_set_agent_answering(pane_id: &str, allowed: bool) -> Result<Value, String> {
    let session = chat::get(pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))?;
    session.set_agent_answering(allowed);
    Ok(session.state())
}

/// "Don't ask again in this chat" for one kind of tool call (`on`), or "Turn back on". In memory for this chat only.
pub fn chat_set_auto_allow(pane_id: &str, kind: &str, on: bool) -> Result<Value, String> {
    let session = chat::get(pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))?;
    session.set_auto_allow(kind, on)?;
    Ok(session.state())
}

/// One chat-screen row (`CHAT_SCREEN_ROWS`), or `None` for any other command. The press-and-hold rule and the arguments are checked here.
pub fn chat_screen_row(env: &dyn ChatEnv, node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    if !CHAT_SCREEN_ROWS.contains(&cmd) {
        return None;
    }
    if let Some(refused) = text_of(args, "paneId").and_then(|pane| remote_refusal(&pane)) {
        return Some(refused);
    }
    if let Some(refused) = gate(cmd, args) {
        return Some(refused);
    }
    let Some(pane) = text_of(args, "paneId") else { return Some(pane_required()) };
    let Some(registry) = env.registry() else { return Some(not_ready()) };
    Some(match cmd {
        "chat_earlier" => {
            let Some(before) = text_of(args, "before") else { return Some(bad("INVALID_ARGUMENT", "before is required")) };
            if registry.lock().get(&pane).is_none() {
                return Some(unknown(&pane));
            }
            let limit = arg(args, "limit").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(crate::session_chat::earlier::DEFAULT_PAGE);
            (200, crate::redact::json(crate::session_chat::earlier::for_pane(&pane, &before, limit, false)).into_inner())
        }
        "acp_chat_cancel" => done(chat_cancel(&pane)),
        "acp_chat_keep_waiting" => done(chat_keep_waiting(&pane)),
        "acp_chat_warm" => {
            chat_warm(&pane);
            (200, Value::Null)
        }
        "acp_chat_take_back" => {
            let reply = done(chat_take_back(&pane));
            if reply.0 == 200 {
                env.audit_call(node, &pane, "take back", false);
            }
            reply
        }
        "acp_chat_set_auto_allow" => {
            let (Some(kind), Some(on)) = (text_of(args, "kind"), arg(args, "on").and_then(Value::as_bool)) else {
                return Some(bad("INVALID_ARGUMENT", "kind and on are required"));
            };
            let reply = done(chat_set_auto_allow(&pane, &kind, on));
            if reply.0 == 200 {
                env.audit_call(node, &pane, "auto-allow", on && flag(args, "hold"));
            }
            reply
        }
        "acp_chat_set_agent_answering" => {
            let Some(allowed) = arg(args, "allowed").and_then(Value::as_bool) else { return Some(bad("INVALID_ARGUMENT", "allowed is required")) };
            let reply = done(chat_set_agent_answering(&pane, allowed));
            if reply.0 == 200 {
                env.audit_call(node, &pane, "agent answering", allowed && flag(args, "hold"));
            }
            reply
        }
        "pane_message_send" => {
            let text = arg(args, "text").and_then(Value::as_str).unwrap_or("");
            // Attachments are files already on THIS machine inside this chat's project: the asker's own paths mean nothing here. Only Full may
            // attach, and each is described from the disk by the machine (`ChatEnv::vouch_attachments`).
            let named: Vec<crate::attach::ChatAttachment> = match arg(args, "attachments") {
                None | Some(Value::Null) => Vec::new(),
                Some(list) => match serde_json::from_value(list.clone()) {
                    Ok(list) => list,
                    Err(_) => return Some(bad("INVALID_ARGUMENT", "attachments are not a list of files")),
                },
            };
            if text.trim().is_empty() && named.is_empty() {
                return Some(bad("INVALID_ARGUMENT", "text is required"));
            }
            let attachments = if named.is_empty() {
                named
            } else if !flag(args, "_full") {
                return Some((403, json!({ "error": "Attaching a file needs Full on this PC.", "code": "DEVICE_NOT_ALLOWED", "needs": "full" })));
            } else {
                match env.vouch_attachments(&pane, &named) {
                    Ok(list) => list,
                    Err(reply) => return Some(reply),
                }
            };
            let (status, body) = send_message(env, node, &pane, text, flag(args, "_full"), &attachments);
            (status, if status == 200 { body["message"].clone() } else { body })
        }
        "pane_message_cancel" | "pane_message_hold" | "pane_message_edit" => {
            let Some(id) = text_of(args, "messageId") else { return Some(bad("INVALID_ARGUMENT", "messageId is required")) };
            let outbox = crate::pane_outbox::global(&registry);
            match cmd {
                "pane_message_cancel" => message(outbox.cancel(&pane, &id), "MESSAGE_NOT_CANCELLABLE"),
                "pane_message_hold" => match arg(args, "hold").and_then(Value::as_bool) {
                    Some(hold) => message(outbox.hold(&pane, &id, hold), "MESSAGE_NOT_HELD"),
                    None => bad("INVALID_ARGUMENT", "hold is required"),
                },
                _ => match arg(args, "text").and_then(Value::as_str) {
                    Some(text) => message(outbox.edit(&pane, &id, text), "MESSAGE_NOT_EDITABLE"),
                    None => bad("INVALID_ARGUMENT", "text is required"),
                },
            }
        }
        _ => {
            // pane_messages_list
            let (status, body) = outbox_list(env, &pane);
            (status, if status == 200 { body["messages"].clone() } else { body })
        }
    })
}
