//! The PC link's own routes (`/pclink/...`): what one Potato Workspace may ask of another that it is paired with.
//!
//! This is NOT the phone's bridge. A phone has bearer tokens, four caps and a route table of its own (`mobile_pairing`); a
//! PC is a paired device with three plain levels. They share no route, no cap, no type: this file names none of the phone's.
//! What they share is only the app's internal services (the pane registry, the chat reader, the message outbox, the project
//! list), reached through [`Services`].
//!
//! The levels (what the person at the far PC allowed for THIS PC, read from its trust list at every request):
//!
//! | Level  | In words                                                                                      |
//! |--------|-----------------------------------------------------------------------------------------------|
//! | Watch  | Read live transcripts and lists. Type nothing.                                                |
//! | Answer | Watch, plus answer an agent's question, message a running agent, stop and continue it.        |
//! | Full   | Answer, plus work on this PC: start agents, use the terminal, change settings of an agent.    |
//!
//! Pairing grants nothing: with the switch off there is no level at all and every route is refused. Full is its own switch
//! and a PC can ask for it (`POST /pclink/full-request`): that puts a real card on the far PC's screen, and only the person
//! there can say yes. Rights are checked HERE, on the far side, for every request; the buttons on the asking side only hide.
//!
//! A pane that the person marked "not for remote use" on this PC (its own per-agent rule) refuses everything for a PC too, and
//! the rule can only SHUT a session for a PC. Its Watch / Answer / Full cap belongs to phones and is not applied to PCs.

use serde_json::{json, Value};

pub mod app_services;
pub mod asks;
pub mod browse;
pub mod calls;
pub mod calls_agents;
#[cfg(test)]
mod calls_agents_tests;
pub mod calls_chat;
pub mod calls_workflows;
pub mod calls_signin;
pub mod door;
pub mod events;
pub mod meta;
pub mod services;
pub mod sessions_rows;
pub mod terminal;

#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
mod calls_chat_tests;
#[cfg(test)]
mod calls_terminal_tests;
#[cfg(test)]
mod calls_workflows_tests;
#[cfg(test)]
mod sessions_rows_tests;

pub use asks::{Ask, Asks, Refusal};
pub use door::Door;
pub use services::Services;

/// How far a paired PC may go. Ordered: a higher level can do everything a lower one can.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    Watch,
    Answer,
    Full,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Watch => "watch",
            Level::Answer => "answer",
            Level::Full => "full",
        }
    }

    /// The level of a stored right (`p2p::trust`). `None`: the switch is off, so there is no level.
    pub fn of(level: Option<crate::p2p::trust::RemoteLevel>) -> Option<Level> {
        use crate::p2p::trust::RemoteLevel as R;
        level.map(|l| match l {
            R::Watch => Level::Watch,
            R::Answer => Level::Answer,
            R::Full => Level::Full,
        })
    }
}

/// The level a route needs, or `None` for a route that does not exist. The one table: nothing else decides.
pub fn need(method: &str, segs: &[&str]) -> Option<Level> {
    use Level::*;
    Some(match (method, segs) {
        ("GET", ["me"]) => Watch,
        ("GET", ["sessions"]) => Watch,
        ("GET", ["sessions", _, "transcript"]) => Watch,
        ("GET", ["sessions", _, "transcript", "earlier"]) => Watch,
        ("GET", ["sessions", _, "picture"]) => Watch,
        ("GET", ["projects"]) => Watch,
        ("GET", ["usage"]) => Watch,
        ("GET", ["agents"]) => Watch,
        ("GET", ["questions"]) => Watch,
        // Asking is not doing: any PC that is let in may ask the person for more.
        ("POST", ["full-request"]) => Watch,
        ("GET", ["sessions", _, "messages"]) => Answer,
        ("POST", ["sessions", _, "messages"]) => Answer,
        ("DELETE", ["sessions", _, "messages", _]) => Answer,
        ("POST", ["sessions", _, "interrupt"]) => Answer,
        ("POST", ["questions", _, "answer"]) => Answer,
        ("POST", ["sessions", _, "config"]) => Full,
        ("GET", ["agents", _, "models"]) => Full,
        ("GET", ["browse"]) => Full,
        ("POST", ["projects", "open"]) => Full,
        ("POST", ["agents", "start"]) => Full,
        ("POST", ["agents", "warm"]) => Full,
        ("DELETE", ["sessions", _]) => Full,
        ("POST", ["move-work"]) => Full,
        // The far call table (`calls.rs`): its own allowlist, one row per command.
        ("POST", ["call", cmd]) => return calls::need(cmd),
        _ => return None,
    })
}

/// Who is asking, as the far side knows it.
pub struct Caller<'a> {
    /// The asking PC's node id in hex.
    pub node: &'a str,
    /// The person's name for it.
    pub name: &'a str,
    /// What this PC lets it do now. `None`: nothing (the switch is off).
    pub level: Option<Level>,
    /// The person's own PC: it carries the account marker (`AGENTS_REMOTE_ACCOUNT`). The person there is the person here, so the press
    /// and hold that guards "let the agent act without asking" is not asked of it. Read from the trust list at every request.
    pub marked: bool,
    pub now_ms: u64,
}

fn reply(status: u16, value: Value) -> (u16, Value) {
    (status, value)
}

pub(crate) fn refusal(have: Option<Level>, needs: Level) -> (u16, Value) {
    reply(
        403,
        json!({
            "error": "not_allowed",
            "code": "DEVICE_NOT_ALLOWED",
            "needs": needs.as_str(),
            "have": have.map(Level::as_str),
            "hint": "This PC does not let that PC do this. Change it in Settings > Devices.",
        }),
    )
}

fn bad(code: &str, message: &str) -> (u16, Value) {
    reply(400, json!({ "error": message, "code": code }))
}

fn text(body: &Value, key: &str) -> Option<String> {
    body.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// `a=1&b=2` to the value of `key` (percent-decoded).
fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').filter_map(|pair| pair.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| decode(v))
}

fn decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One request: `target` is the path with its query (`/pclink/sessions?x=1`). Returns the HTTP status and the JSON body.
pub fn handle(who: &Caller<'_>, svc: &dyn Services, asks: &Asks, method: &str, target: &str, body: &[u8]) -> (u16, Value) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let raw: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let Some(("pclink", segs)) = raw.split_first().map(|(a, b)| (*a, b)) else {
        return reply(404, json!({ "error": "not found", "code": "UNKNOWN_ROUTE" }));
    };
    let Some(needs) = need(method, segs) else {
        return reply(404, json!({ "error": "not found", "code": "UNKNOWN_ROUTE" }));
    };
    let Some(level) = who.level else {
        return reply(403, json!({ "error": "not_allowed", "code": "REMOTE_OFF", "hint": "That device does not let this PC in. Turn it on there: Settings > Devices." }));
    };
    if level < needs {
        return refusal(Some(level), needs);
    }
    // One session's own rule on the far PC can only lower the level for that session (or shut it).
    if let ["sessions", id, ..] = segs {
        match svc.ceiling(id) {
            None => return reply(403, json!({ "error": "This agent is switched off for other PCs on its own PC.", "code": "AGENT_LOCKED" })),
            Some(cap) if level.min(cap) < needs => return refusal(Some(level.min(cap)), needs),
            Some(_) => {}
        }
    }
    let mut json_body: Value = if body.is_empty() { json!({}) } else { match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return bad("INVALID_ARGUMENT", "the body is not JSON"),
    } };
    // What this side knows about the asker travels to a call row in two keys of its own, always overwritten (the asker cannot send them).
    if let (["call", _], Some(args)) = (segs, json_body.as_object_mut()) {
        args.insert("_marked".into(), json!(who.marked));
        args.insert("_full".into(), json!(level >= Level::Full));
    }
    // A call that names a chat pane meets that pane's own rule on this PC, like the `sessions/<id>` routes.
    if let ["call", cmd] = segs {
        if calls::names_pane(cmd) {
            match calls::text_arg(&json_body, "paneId") {
                None => return bad("INVALID_ARGUMENT", "paneId is required"),
                Some(id) => match svc.ceiling(&id) {
                    None => return reply(403, json!({ "error": "This agent is switched off for other PCs on its own PC.", "code": "AGENT_LOCKED" })),
                    Some(cap) if level.min(cap) < needs => return refusal(Some(level.min(cap)), needs),
                    Some(_) => {}
                },
            }
        }
    }
    match (method, segs) {
        ("GET", ["me"]) => reply(200, json!({ "level": level.as_str(), "name": svc.name(), "asked": asks.pending_for(who.node, who.now_ms) })),
        ("GET", ["sessions"]) => svc.sessions(),
        ("GET", ["sessions", id, "transcript"]) => svc.transcript(id, query_param(query, "since").and_then(|v| v.parse::<u64>().ok())),
        ("GET", ["sessions", id, "transcript", "earlier"]) => match query_param(query, "before").filter(|v| !v.is_empty()) {
            Some(before) => svc.transcript_earlier(id, &before, query_param(query, "limit").and_then(|v| v.parse::<usize>().ok())),
            None => bad("INVALID_ARGUMENT", "before is required"),
        },
        ("GET", ["sessions", id, "picture"]) => match query_param(query, "path").filter(|v| !v.is_empty()) {
            Some(path) => svc.picture(id, &path),
            None => bad("INVALID_ARGUMENT", "path is required"),
        },
        ("GET", ["projects"]) => svc.projects(),
        ("GET", ["usage"]) => svc.usage(),
        ("GET", ["browse"]) => svc.browse(query_param(query, "root").filter(|v| !v.is_empty()).as_deref(), &query_param(query, "sub").unwrap_or_default()),
        ("POST", ["projects", "open"]) => match text(&json_body, "root") {
            Some(root) => svc.open_folder(&root, json_body.get("sub").and_then(Value::as_str).unwrap_or("")),
            None => bad("INVALID_ARGUMENT", "root is required"),
        },
        ("GET", ["agents"]) => svc.agents(),
        ("GET", ["questions"]) => svc.questions(level >= Level::Full),
        ("GET", ["sessions", id, "messages"]) => svc.outbox(id),
        ("POST", ["sessions", id, "messages"]) => match text(&json_body, "text") {
            Some(message) => svc.send(who.node, id, &message, level >= Level::Full),
            None => bad("INVALID_ARGUMENT", "text is required"),
        },
        ("DELETE", ["sessions", id, "messages", message]) => svc.cancel_message(id, message),
        ("POST", ["sessions", id, "interrupt"]) => svc.interrupt(id),
        ("POST", ["questions", id, "answer"]) => svc.answer_question(id, &json_body, level >= Level::Full),
        ("POST", ["sessions", id, "config"]) => match (text(&json_body, "option_id"), text(&json_body, "value")) {
            (Some(option), Some(value)) => svc.set_config(who.node, id, &option, &value, who.marked || json_body.get("hold").and_then(Value::as_bool).unwrap_or(false)),
            _ => bad("INVALID_ARGUMENT", "option_id and value are required"),
        },
        ("GET", ["agents", agent, "models"]) => svc.models(agent),
        ("POST", ["agents", "start"]) => match (text(&json_body, "agent"), text(&json_body, "project")) {
            (Some(agent), Some(project)) => svc.start(who.node, &agent, &project, text(&json_body, "lane").as_deref().unwrap_or("chat"), &json_body),
            _ => bad("INVALID_ARGUMENT", "agent and project are required"),
        },
        ("POST", ["agents", "warm"]) => match (text(&json_body, "agent"), text(&json_body, "project")) {
            (Some(agent), Some(project)) => svc.warm(&agent, &project),
            _ => bad("INVALID_ARGUMENT", "agent and project are required"),
        },
        ("DELETE", ["sessions", id]) => svc.close(who.node, id),
        ("POST", ["move-work"]) => match (text(&json_body, "project"), text(&json_body, "branch"), text(&json_body, "bundle_b64")) {
            (Some(project), Some(branch), Some(bundle)) => svc.move_work(&project, &branch, &bundle),
            _ => bad("INVALID_ARGUMENT", "project, branch and bundle_b64 are required"),
        },
        ("POST", ["call", cmd]) => svc.call(who.node, cmd, &json_body),
        ("POST", ["full-request"]) => full_request(who, svc, asks, level),
        _ => reply(404, json!({ "error": "not found", "code": "UNKNOWN_ROUTE" })),
    }
}

/// "Ask <PC> to allow agents": a real card on the far PC. Nothing is granted by asking.
fn full_request(who: &Caller<'_>, svc: &dyn Services, asks: &Asks, level: Level) -> (u16, Value) {
    if level == Level::Full {
        return reply(409, json!({ "error": "This PC can already work there.", "code": "ALREADY_FULL" }));
    }
    match asks.request(who.node, who.name, who.now_ms) {
        Ok(ask) => {
            svc.notify_full_request(&ask);
            reply(202, json!({ "asked": true, "id": ask.id }))
        }
        Err(Refusal::Pending) => reply(202, json!({ "asked": true, "already": true })),
        Err(Refusal::TooSoon { retry_after_ms }) => reply(429, json!({ "error": "That PC was asked a moment ago.", "code": "TOO_SOON", "retry_after_ms": retry_after_ms })),
        Err(Refusal::Busy) => reply(429, json!({ "error": "That PC has too many questions waiting.", "code": "BUSY" })),
    }
}

