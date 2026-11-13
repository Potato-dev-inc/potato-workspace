//! One capability table per agent, built from its shipped definition, what it said in the free check and what
//! was seen in real turns. A value is only ever set with a source and a proof; unknown stays unknown.
//! The UI command and the MCP resolver both read `caps_json`.

// Callers land with the add-agent ladder (record_handshake) and the live-turn wiring (record_seen).
#![allow(dead_code)]

mod build;
mod facts;
pub mod drift;
pub mod live;
mod store;
pub mod types;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod added_agent_tests;

pub use build::build;
pub use types::*;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;

/// What the agent's definition and the app's own tables say. Pure data: `build` takes it as given.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DefFacts {
    pub agent_id: String,
    pub label: String,
    /// A shipped, reviewed file (bundled or Store definition, or a code profile). Not a file the ladder wrote.
    pub shipped: bool,
    pub has_acp: bool,
    pub has_headless: bool,
    pub resumable_headless: bool,
    pub read_only_mapped: bool,
    pub definition_models: Vec<String>,
    pub reviewed_adapter: bool,
}

/// What the free check learned from the agent's own replies to `initialize` and `session/new`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct HandshakeFacts {
    pub at: String,
    pub program_version: Option<String>,
    pub init_ok: bool,
    pub protocol_version: Option<u64>,
    pub load_session: bool,
    pub resume: bool,
    pub image_prompts: bool,
    pub session_new_ok: bool,
    pub models: Vec<String>,
    pub models_total: u32,
    /// Set only for level l5.
    pub no_chat_reason: Option<String>,
    /// Added for terminal use on purpose: the chat was never checked, so it stays unknown (not No).
    pub terminal_only: bool,
    /// Set by a drift check (`drift.rs`): the program changed version and the chat stopped answering.
    pub drifted: bool,
}

/// Something observed in a real turn the person started.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SeenFact {
    ToolCall { at: String },
    EditDone { at: String, asked: bool },
    ShellDone { at: String, asked: bool },
    StopWorked { at: String, ms: u64 },
    StopIgnored { at: String },
    Usage { at: String },
}

/// The table of one agent. Never errors: a missing or broken store reads as empty.
pub fn for_agent(agent_id: &str) -> AgentCaps {
    for_agent_in(&store::default_dir(), agent_id)
}

/// Every registered agent, sorted by id.
pub fn all() -> Vec<AgentCaps> {
    let mut ids = crate::tui::registered_agent_ids();
    ids.sort();
    ids.dedup();
    ids.iter().map(|id| for_agent(id)).collect()
}

/// `for_agent` with the store folder named (tests).
pub fn for_agent_in(dir: &Path, agent_id: &str) -> AgentCaps {
    let file = store::load(dir, agent_id);
    build(&facts::def_facts(agent_id), file.handshake.as_ref(), &file.seen)
}

/// Called by the add-agent save step.
pub fn record_handshake(agent_id: &str, hs: &HandshakeFacts) -> Result<(), String> {
    record_handshake_in(&store::default_dir(), agent_id, hs)?;
    notify(agent_id);
    Ok(())
}

pub fn record_handshake_in(dir: &Path, agent_id: &str, hs: &HandshakeFacts) -> Result<(), String> {
    // A new add is a new program: whatever was seen under this id before does not belong to it.
    store::update(dir, agent_id, |f| {
        f.handshake = Some(hs.clone());
        f.seen.clear();
    })
}

/// The agent was removed: its entry goes with it. The remove paths call this (`commands/add_agent.rs` does for an
/// add that is taken back; the lead wires `agent_store::add::remove` and `tui::declarative::service::remove_global`).
pub fn forget(agent_id: &str) {
    forget_in(&store::default_dir(), agent_id);
    notify(agent_id);
}

pub fn forget_in(dir: &Path, agent_id: &str) {
    store::remove(dir, agent_id);
}

/// Called when a real turn shows something (see the open seams in the spec).
pub fn record_seen(agent_id: &str, fact: SeenFact) -> Result<(), String> {
    record_seen_in(&store::default_dir(), agent_id, fact)?;
    notify(agent_id);
    Ok(())
}

pub fn record_seen_in(dir: &Path, agent_id: &str, fact: SeenFact) -> Result<(), String> {
    // The newest fact per (kind, asked) is kept, so a busy turn can never push a recorded No out of the log.
    store::update(dir, agent_id, |f| {
        let key = seen_key(&fact);
        f.seen.retain(|old| seen_key(old) != key);
        f.seen.push(fact);
        let extra = f.seen.len().saturating_sub(store::SEEN_MAX);
        f.seen.drain(..extra);
    })
}

/// What makes two facts "the same fact": the kind, and for edits and commands whether it was asked.
fn seen_key(fact: &SeenFact) -> (u8, bool) {
    match fact {
        SeenFact::ToolCall { .. } => (0, false),
        SeenFact::EditDone { asked, .. } => (1, *asked),
        SeenFact::ShellDone { asked, .. } => (2, *asked),
        SeenFact::StopWorked { .. } => (3, false),
        SeenFact::StopIgnored { .. } => (4, false),
        SeenFact::Usage { .. } => (5, false),
    }
}

/// The one serializer. MCP and Tauri both call it.
pub fn caps_json(agent_id: &str) -> serde_json::Value {
    caps_to_json(&for_agent(agent_id))
}

pub fn caps_to_json(caps: &AgentCaps) -> serde_json::Value {
    serde_json::to_value(caps).unwrap_or(serde_json::Value::Null)
}

/// The chips of one agent for `list_agents`: the level and each line as `yes`, `no` or `unknown`. The same table the
/// Add an agent screen draws from, so a helper and the window never say different things.
pub fn chips_json(agent_id: &str) -> serde_json::Value {
    let caps = for_agent(agent_id);
    let word = |c: &Cap| match c.value {
        Tri::Yes => "yes",
        Tri::No => "no",
        Tri::Unknown => "unknown",
    };
    let mut out = serde_json::Map::new();
    out.insert("level".into(), serde_json::to_value(caps.level).unwrap_or_default());
    for (name, cap) in [
        ("chat", &caps.chat),
        ("resume", &caps.resume),
        ("shows_steps", &caps.shows_steps),
        ("edits_files", &caps.edits_files),
        ("asks_before_edit", &caps.asks_before_edit),
        ("asks_before_shell", &caps.asks_before_shell),
        ("model_pick", &caps.model_pick),
        ("stop", &caps.stop),
        ("images", &caps.images),
        ("usage", &caps.usage),
        ("read_only", &caps.read_only),
    ] {
        out.insert(name.into(), word(cap).into());
    }
    serde_json::Value::Object(out)
}

type Notifier = Box<dyn Fn(&str) + Send + Sync>;
static NOTIFIER: OnceLock<Notifier> = OnceLock::new();

/// Who to tell when an agent's table changed (the window event `agent-caps://changed`). First call wins.
pub fn set_notifier(f: impl Fn(&str) + Send + Sync + 'static) {
    let _ = NOTIFIER.set(Box::new(f));
}

fn notify(agent_id: &str) {
    if let Some(f) = NOTIFIER.get() {
        f(agent_id);
    }
}
