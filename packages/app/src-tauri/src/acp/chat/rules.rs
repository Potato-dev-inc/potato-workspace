//! Force yes, Fences and Pins as a chat lives them (`crate::agent_rules` holds the rules and the saved settings).
//!
//! * Every permission question that has no card yet goes through [`AcpChat::rule_for`]: a write inside a fence is
//!   answered "no" for the person; with Force yes on, a question the risk rules call low risk is answered "allow once".
//!   Anything else gets its card as before. The chat keeps one quiet line for each answer the app gave.
//! * The first message of a chat carries the fences and the pinned notes ([`AcpChat::wire_text`]).
//! * A new chat starts with the pins of its project and the Force yes of its agent ([`apply_at_start`]).
//!
//! Nothing here names an agent: what differs between agents is the options they offer, and the question's own words.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde_json::json;

use super::AcpChat;
use crate::acp::session::AnswerSource;
use crate::acp::state::PermissionWait;
use crate::agent_rules::{self, fence, force_yes};

/// Per chat: the Force yes switch, whether the rules were said to the agent, and the line to show for each ask the app
/// answered (by ask number, until the session reports the ask closed).
#[derive(Default)]
pub(super) struct ChatRules {
    force_yes: AtomicBool,
    told: AtomicBool,
    /// The project a chat in a copy belongs to, until the copy is saved with the conversation.
    project_hint: Mutex<Option<String>>,
    answered: Mutex<BTreeMap<u64, String>>,
}

/// What the rules decided for one question.
pub(super) enum Ruled {
    /// Already decided (the answer is on its way): leave it alone.
    Already,
    /// Answered "no": with the agent's own reject option, or (none offered) "cancelled".
    Deny { ask_id: u64, option_id: Option<String> },
    /// Answered "allow once".
    Allow { ask_id: u64, option_id: String },
}

impl AcpChat {
    /// Whether Force yes is on for this chat.
    pub fn force_yes(&self) -> bool {
        self.rules.force_yes.load(Ordering::SeqCst)
    }

    /// The person's switch (a Tauri command of the app's own window; no bridge route or MCP tool reaches it). It counts
    /// for questions that come after it: a card that is already open stays the person's to answer.
    pub fn set_force_yes(&self, on: bool) {
        if self.rules.force_yes.swap(on, Ordering::SeqCst) == on {
            return;
        }
        crate::audit::record(
            crate::audit::Kind::AgentRules,
            crate::audit::Who::Desktop,
            if on { "You turned Force yes on in a chat session" } else { "You turned Force yes off in a chat session" },
            json!({ "event": if on { "force_yes_on" } else { "force_yes_off" }, "pane_id": self.pane_id, "agent": self.agent_id }),
        );
        self.host.state_changed(&self.pane_id, &self.state());
    }

    /// The project this chat belongs to: the original folder of a copy, else the folder the agent works in.
    pub fn project(&self) -> String {
        if let Some(hint) = self.rules.project_hint.lock().clone() {
            return hint;
        }
        let copy = self.conversations.as_ref().and_then(|c| c.copy_of(&self.pane_id));
        match copy {
            Some(link) => link.origin,
            None => self.session.cwd().to_string_lossy().into_owned(),
        }
    }

    pub(crate) fn set_project_hint(&self, project: Option<&std::path::Path>) {
        *self.rules.project_hint.lock() = project.map(|p| p.to_string_lossy().into_owned());
    }

    /// The folders a path of this chat may be relative to or sit under: where the agent works, then the project.
    fn rule_roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![self.session.cwd().to_path_buf()];
        let project = PathBuf::from(self.project());
        if !roots.contains(&project) {
            roots.push(project);
        }
        roots
    }

    /// The fences of this chat's project (read from the saved settings each time, so a change counts at once).
    pub fn fences(&self) -> Vec<String> {
        agent_rules::store().fences(&self.project())
    }

    /// Takes the starting Force yes of the agent and the project (a pin, or the agent's own switch).
    pub(crate) fn init_rules(&self) {
        let effective = agent_rules::store().effective(&self.agent_id, Some(&self.project()));
        self.rules.force_yes.store(effective.force_yes, Ordering::SeqCst);
    }

    /// What goes to the agent for `text`: the first message of the chat gets the rules in front of it, once.
    pub(super) fn wire_text(&self, text: &str) -> String {
        let effective = agent_rules::store().effective(&self.agent_id, Some(&self.project()));
        let Some(preamble) = agent_rules::notes::preamble(&effective.fences, effective.notes.as_deref()) else { return text.to_string() };
        if self.rules.told.swap(true, Ordering::SeqCst) {
            return text.to_string();
        }
        format!("{preamble}{text}")
    }

    /// The first message did not go: the rules go again with the next one.
    pub(super) fn rules_not_told(&self) {
        self.rules.told.store(false, Ordering::SeqCst);
    }

    /// The line the chat shows for an ask the app answered by a rule, once.
    pub(super) fn take_rule_line(&self, ask_id: u64) -> Option<String> {
        self.rules.answered.lock().remove(&ask_id)
    }

    /// Decides one new question: a fence says no, Force yes says yes, anything else is left to the person (`None`).
    pub(super) fn rule_for(&self, wait: &PermissionWait, kind: Option<&str>, title: Option<&str>, mapped_paths: &[String]) -> Option<Ruled> {
        if self.rules.answered.lock().contains_key(&wait.ask_id) {
            return Some(Ruled::Already);
        }
        let force = self.force_yes();
        let fences = self.fences();
        if !force && fences.is_empty() {
            return None;
        }
        let mut paths = wait.paths.clone();
        for path in mapped_paths {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        let roots = self.rule_roots();
        let option_of = |kinds: &[&str]| kinds.iter().find_map(|k| wait.options.iter().find(|o| o.kind == *k)).map(|o| o.id.clone());
        let what: String = title.map(str::trim).filter(|t| !t.is_empty()).or(kind).unwrap_or("a tool").chars().take(160).collect();
        // A fence first: it holds whatever Force yes says.
        if matches!(kind, Some("edit" | "delete" | "move")) {
            if let Some((path, fence)) = paths.iter().find_map(|p| fence::covering(&fences, &roots, p).map(|f| (p.as_str(), f))) {
                let shown: String = path.chars().take(120).collect();
                let line = format!("Blocked by a fence: {shown} is fenced ({fence}). The agent was told no.");
                self.rules.answered.lock().insert(wait.ask_id, line);
                crate::audit::record(
                    crate::audit::Kind::AgentRules,
                    crate::audit::Who::Desktop,
                    "A fence refused an agent's change in a chat session",
                    json!({ "event": "fence_denied", "pane_id": self.pane_id, "agent": self.agent_id, "kind": kind, "fence": fence }),
                );
                return Some(Ruled::Deny { ask_id: wait.ask_id, option_id: option_of(&["reject_once", "reject_always"]) });
            }
        }
        if !force {
            return None;
        }
        // A command that names a fenced path may touch it: the person decides.
        if kind == Some("execute") && wait.command.as_deref().is_some_and(|c| fence::mentioned_in(&fences, c).is_some()) {
            return None;
        }
        let ask = force_yes::Ask { kind, title, paths: &paths, command: wait.command.as_deref(), roots: &roots };
        let offered: Vec<(&str, &str)> = wait.options.iter().map(|o| (o.id.as_str(), o.kind.as_str())).collect();
        match force_yes::decide(&ask, &offered) {
            force_yes::Verdict::Allow { option_id } => {
                self.rules.answered.lock().insert(wait.ask_id, format!("Auto-allowed: {what}"));
                let mut detail = json!({ "event": "auto_allowed", "pane_id": self.pane_id, "agent": self.agent_id, "kind": kind });
                if let Some(command) = wait.command.as_deref() {
                    // The program and a short hash, never the text (the audit log keeps no command text).
                    detail["command"] = crate::audit::command_fingerprint(command);
                }
                crate::audit::record(crate::audit::Kind::AgentRules, crate::audit::Who::Desktop, "Force yes allowed an agent's request in a chat session", detail);
                Some(Ruled::Allow { ask_id: wait.ask_id, option_id })
            }
            force_yes::Verdict::Ask(_) => None,
        }
    }

    /// Sends the answer a rule chose. A failed send forgets the line, so the next look decides again.
    pub(super) fn send_ruled(&self, ruled: Ruled) {
        let (ask_id, sent) = match ruled {
            Ruled::Already => return,
            Ruled::Allow { ask_id, option_id } => (ask_id, self.session.answer_permission(ask_id, &option_id, AnswerSource::Person)),
            Ruled::Deny { ask_id, option_id: Some(option_id) } => (ask_id, self.session.answer_permission(ask_id, &option_id, AnswerSource::Person)),
            Ruled::Deny { ask_id, option_id: None } => (ask_id, self.session.cancel_permission(ask_id)),
        };
        if sent.is_err() {
            self.rules.answered.lock().remove(&ask_id);
        }
    }
}

/// Right after a chat started: the pinned model and mode of its project (best effort: an agent that does not offer
/// them keeps its own), and the starting Force yes. `model_asked`: the caller named a model, which always wins.
pub fn apply_at_start(chat: &AcpChat, model_asked: bool) {
    chat.init_rules();
    let effective = agent_rules::store().effective(chat.agent_id(), Some(&chat.project()));
    if !model_asked {
        if let Some(model) = effective.model.as_deref() {
            if let Err(error) = chat.set_config("model", model) {
                chat.set_choice_warnings(vec![format!("The pinned model {model} could not be set: {error}")]);
            }
        }
    }
    if let Some(mode) = effective.mode.as_deref() {
        let _ = chat.set_config("mode", mode);
    }
}
