//! The Allow card for an agent's background command (`start_terminal`).
//!
//! * The first command an agent starts in a chat asks the person: Allow once, Allow for this chat, No.
//!   After "Allow for this chat" later starts in that chat do not ask.
//! * A minion uses the chat it belongs to: its parent's grant counts, and with no grant the card names the minion
//!   and its parent ("A minion of Claude 1 wants to run a command ...").
//! * A dangerous command (`helper_answers::needs_person`: delete, push, curl, outside the project ...) asks EVERY
//!   time. "Allow for this chat" is not offered on its card and never covers it.
//! * Answers come through the same card list the Inbox and the phone already show (`consent`).

use super::consent::{Action, Ask};
use super::gate;
use crate::operations::OperationError;
use std::path::Path;

/// Everything the card and the grant need to know about one start.
pub struct Request<'a> {
    /// The MCP connection that asked.
    pub session: &'a str,
    /// The pane of the agent that asked.
    pub caller: &'a str,
    /// The chat whose grant counts: the caller, or for a minion the chat it belongs to.
    pub chat: &'a str,
    /// Who asks, in a sentence: "Claude 1", or "A minion of Claude 1".
    pub requester: String,
    /// What the card calls the command: its name, else the program.
    pub target: String,
    /// The command line, secrets masked.
    pub command: &'a str,
    /// The folder the agent works in (the danger check looks for paths outside it).
    pub project: &'a Path,
}

/// Why the command is dangerous, in plain words, or `None` when it is an ordinary one.
pub fn danger(command: &str, project: &Path) -> Option<String> {
    crate::acp::chat::helper_answers::needs_person(command, "execute", "allow_once", project)
}

fn key_of(command: &str, target: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (command, target).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// `Ok` when the command may start now. `CONSENT_PENDING` while the person has not answered, `CONSENT_DENIED` after a no.
pub fn check(request: &Request<'_>, now: u64) -> Result<(), OperationError> {
    let risk = danger(request.command, request.project);
    let shown: String = request.command.chars().take(300).collect();
    let mut headline = format!("Command: {shown}");
    if let Some(why) = &risk {
        headline = format!("{headline}. This one asks every time: {why}");
    }
    let ask = Ask {
        session: request.session.to_string(),
        subject: request.chat.to_string(),
        pane_id: Some(request.caller.to_string()),
        action: Action::BackgroundCommand,
        prompt_key: key_of(request.command, &request.target),
        requester: request.requester.clone(),
        target: request.target.clone(),
        risk: risk.as_ref().map(|_| "medium".to_string()),
        risk_headline: Some(headline),
    };
    gate::run(ask, now).map(|_| ())
}

/// A chat ended: "Allow for this chat" ends with it.
pub fn forget_chat(chat: &str) {
    super::consent::forget_chat(chat);
}
