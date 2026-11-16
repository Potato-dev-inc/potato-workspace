//! A helper's questions go to the agent that started it. When a helper (a chat an agent started) stops on a permission
//! question, the agent is told through the tools it already waits on (`run_agent`'s wait, `wait_agents`: status
//! `waiting_input` with `prompt`), never by a typed message, and may answer with `answer_prompt`.
//!
//! The setting `helper_answers_enabled` (Settings > Agents, on by default) lets it answer the safe ones: "allow this once"
//! and any "no". Everything broad or risky stays with the person: "always allow", deleting, pushing, forcing, and a path
//! outside the project folder. The person's own per-chat switch (`AcpChat::set_agent_answering`) still answers everything.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;

/// The key in the public settings.
pub const KEY: &str = "helper_answers_enabled";

static ON: AtomicBool = AtomicBool::new(true);

/// Called with the effective public settings whenever they change and once at startup. Absent means on.
pub fn apply_settings(public: &Value) {
    ON.store(public.get(KEY).and_then(Value::as_bool).unwrap_or(true), Ordering::SeqCst);
}

pub fn enabled() -> bool {
    #[cfg(test)]
    if let Some(on) = TEST_ON.with(|slot| slot.get()) {
        return on;
    }
    ON.load(Ordering::SeqCst)
}

#[cfg(test)]
thread_local! {
    /// A test sets the switch for its own thread only, so tests never see each other's.
    static TEST_ON: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Puts the switch at `on` on this thread until the guard is dropped (tests only).
#[cfg(test)]
pub struct TestSwitch(Option<bool>);

#[cfg(test)]
impl Drop for TestSwitch {
    fn drop(&mut self) {
        TEST_ON.with(|slot| slot.set(self.0));
    }
}

#[cfg(test)]
pub fn test_switch(on: bool) -> TestSwitch {
    TestSwitch(TEST_ON.with(|slot| slot.replace(Some(on))))
}

/// Words in a tool call's title that always send the question to the person.
const RISKY_WORDS: &[&str] = &[
    "delete", "remove", "rm ", "rm -", "rmdir", "del ", "erase", "wipe", "format ", "truncate", "drop ", "push", "force", "reset --hard", "clean -f",
    "sudo", "chmod", "chown", "kill", "taskkill", "shutdown", "registry", "credential", "password", "token", "secret", "curl ", "wget ", "| sh", "| bash", "iex ",
    "npm publish", "cargo publish", "release", "deploy", "merge",
];

/// Tool kinds the app names that are never answered by an agent.
const RISKY_KINDS: &[&str] = &["delete", "move", "fetch"];

/// Why an agent may not answer this question with this option (`None`: it may). `option_kind` is the option's kind
/// (`allow_once`, `allow_always`, `reject_once`, `reject_always`).
pub fn needs_person(title: &str, tool_kind: &str, option_kind: &str, project: &Path) -> Option<String> {
    if option_kind.starts_with("reject") {
        return None;
    }
    if option_kind != "allow_once" {
        return Some("it would allow this kind of action from now on, which only the person decides".into());
    }
    if RISKY_KINDS.iter().any(|k| tool_kind.eq_ignore_ascii_case(k)) {
        return Some(format!("it is a {tool_kind} action"));
    }
    let lower = title.to_lowercase();
    if let Some(word) = RISKY_WORDS.iter().find(|w| lower.contains(*w)) {
        return Some(format!("the request mentions \"{}\"", word.trim()));
    }
    outside_project(title, project).map(|path| format!("it reaches {path}, outside the project"))
}

/// Where a minion's permission ask goes (Two types mode, `started_as = "minion"`; plan 2.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MinionAsk {
    /// An ordinary ask: only the agent that started the minion sees it (no card for the person, no push, no Inbox line).
    Agent,
    /// A risky ask (the reason is for the card): a card for the person, docked in the parent's chat.
    Person(String),
    /// The switch is off: the ask is refused, and the minion is told no. The person is not asked.
    Refuse,
}

/// How a minion's ask is routed. `switch_on` is `enabled()`. The classification is `needs_person` for the plain
/// "allow once" option: the same words as the helper rule, so a risky ask is risky in both modes.
pub fn minion_route(title: &str, tool_kind: &str, project: &Path, switch_on: bool) -> MinionAsk {
    if !switch_on {
        return MinionAsk::Refuse;
    }
    match needs_person(title, tool_kind, "allow_once", project) {
        None => MinionAsk::Agent,
        Some(why) => MinionAsk::Person(why),
    }
}

/// How long a minion's ordinary ask may wait for its agent before the app wakes the agent with a note.
pub const WAKE_AFTER_MS: u64 = 60_000;
/// While the agent is in the middle of a turn that can take the line, the note waits this long.
pub const WAKE_BUSY_AFTER_MS: u64 = 180_000;

/// The one app-written note that wakes the agent of a minion whose ask nobody answered.
pub fn wake_note(minion: &str, handle: &str) -> String {
    format!(
        "[Potato Workspace] Your minion {minion} is waiting for an answer. Read its question with wait_agents or inspect_agent (handle {handle}), then answer it with answer_prompt. The person is not asked about this one."
    )
}

/// What the minion's agent is told when the switch is off and an ask is refused.
pub const REFUSED_NOTE: &str = "the setting that lets agents answer their minions' questions is off, so the minion was told no";

/// A path written in the title that is not inside `project`.
fn outside_project(title: &str, project: &Path) -> Option<String> {
    let root = norm(&project.to_string_lossy());
    for raw in title.split_whitespace() {
        let word = raw.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']'));
        let bytes = word.as_bytes();
        let drive = bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/');
        let unix = word.starts_with('/') && word.len() > 1;
        let up = word.contains("../") || word.contains("..\\");
        if up {
            return Some(word.to_string());
        }
        if (drive || unix || word.starts_with("~/")) && !within(&norm(word), &root) {
            return Some(word.to_string());
        }
    }
    None
}

fn norm(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn within(path: &str, root: &str) -> bool {
    !root.is_empty() && (path == root || path.starts_with(&format!("{root}/")))
}

#[cfg(test)]
#[path = "helper_answers_tests.rs"]
mod tests;
