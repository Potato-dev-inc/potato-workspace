//! A small brain for places the companion's agent pane cannot be (P3 of the fishd port; decision D1).
//!
//! The companion normally lives in an agent pane the person already pays for. A Discord room cannot be handed to
//! that pane: the pane has tools, and every line in a room is typed by strangers. So a Discord reply comes from
//! this small brain instead: ONE call to the person's own AI service (their Custom AI address, model and key),
//! with the persona and the room in the prompt, and NO tools of any kind.
//!
//! - `assemble`: the persona, the house rules and the room (as marked data) become the messages.
//! - `turn`: one reply: count the call, ask, clean the text, cut it.
//! - `openai`: the OpenAI-style `/chat/completions` call, with timeouts and fixed-word errors.
//! - `budget`: today's number of calls and the daily cap, kept in a small file.
//! - `tools`: the policy: there are none.
//! - `stub` (tests): a brain that answers from a list and remembers what it was asked.

pub mod assemble;
pub mod budget;
pub mod openai;
#[cfg(test)]
pub mod stub;
pub mod tools;
pub mod turn;

use std::time::Duration;

pub use super::social::llm::CompleteError as BrainError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    System,
    User,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatMsg {
    pub role: Role,
    pub content: String,
}

/// Something that answers a conversation with text.
pub trait Brain: Send + Sync {
    fn complete(&self, messages: &[ChatMsg], max_tokens: u32, timeout: Duration) -> Result<String, BrainError>;
}
