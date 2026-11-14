//! The outbox over a chat session (ACP): the same queue and the same worker, with the chat session standing in
//! for the terminal. A message waits while a turn runs ("The agent is working. Sends when the turn ends.") and goes
//! in as a prompt when the session is ready; when the agent takes text while it works the message is steered into
//! the running turn instead (`steer`). Nothing here types into anything.

use super::host::{Attempt, Look, Pulse};
use crate::attach::ChatAttachment;
use crate::acp::chat::{AcpChat, Readiness as ChatReadiness, SendError};
use crate::agent_runs::readiness::Readiness;
use crate::tui::ComposerState;

/// One look at a chat session: ready (idle), or busy. `None`: the chat was closed.
pub fn look(chat: &AcpChat) -> Option<Look> {
    let (readiness, idle) = match chat.readiness() {
        ChatReadiness::Ready => (Readiness::Ready, true),
        ChatReadiness::Busy => (Readiness::Busy, false),
        ChatReadiness::Gone => return None,
    };
    Some(Look { readiness, composer: ComposerState::Empty, idle, waiting: false })
}

/// What the chat shows now: the agent-side items so far, and whether it is starting or waking up.
pub fn pulse(chat: &AcpChat) -> Pulse {
    use crate::session_chat::ChatItem;
    let replies = chat.items().iter().filter(|item| !matches!(item, ChatItem::User { .. })).count();
    let waking = matches!(chat.session().snapshot().phase, crate::acp::state::Phase::Starting | crate::acp::state::Phase::Resuming);
    Pulse { replies, waking }
}

/// Sends the message as a prompt.
pub fn type_message(chat: &AcpChat, text: &str) -> Attempt {
    type_message_with(chat, text, &[])
}

/// Sends the message with its files and pictures as prompt blocks.
pub fn type_message_with(chat: &AcpChat, text: &str, attachments: &[ChatAttachment]) -> Attempt {
    match chat.send_quiet(text, attachments) {
        Ok(_) => Attempt::Sent,
        Err(SendError::Busy) => Attempt::NotTyped,
        Err(SendError::Gone) => Attempt::Gone,
        Err(SendError::Refused(why)) => Attempt::Failed(why),
    }
}

#[cfg(test)]
mod tests {
    // The behaviour with a real session (a fake agent) is tested in `acp/chat/tests.rs`.
    use super::*;

    #[test]
    fn a_closed_chat_has_no_look() {
        let _ = look as fn(&AcpChat) -> Option<Look>;
        let _ = type_message as fn(&AcpChat, &str) -> Attempt;
    }
}
