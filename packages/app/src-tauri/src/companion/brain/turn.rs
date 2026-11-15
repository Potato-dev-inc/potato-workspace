//! One reply of the small brain: take a call from today's allowance, ask, clean the answer, cut it.

use std::time::Duration;

use super::assemble::{assemble, Request};
use super::budget::DailyCalls;
use super::{Brain, BrainError};

/// Discord allows 2,000 characters in a message. Stay well under.
pub const MAX_CHARS: usize = 1_800;
pub const MAX_TOKENS: u32 = 400;
pub const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnError {
    /// Today's calls are used up. Nothing was asked.
    Capped,
    /// The brain could not answer.
    Brain(BrainError),
    /// The answer had no text left after cleaning.
    Empty,
}

/// Stops the text from pinging anybody if it ever reached a place that parses mentions. (The request also says
/// `allowed_mentions.parse = []`, so this is a second wall.)
fn defang(text: &str) -> String {
    text.replace("@everyone", "@\u{200b}everyone").replace("@here", "@\u{200b}here")
}

/// The text of a reply, cleaned: secrets and paths masked, hidden characters gone, cut to `MAX_CHARS`.
pub fn clean_reply(raw: &str) -> String {
    let cleaned = crate::channels::render::clean_multiline(raw, MAX_CHARS).into_inner();
    defang(cleaned.trim())
}

pub fn run(brain: &dyn Brain, calls: &DailyCalls, request: &Request<'_>, now_ms: i64) -> Result<String, TurnError> {
    if !calls.take(now_ms) {
        return Err(TurnError::Capped);
    }
    let raw = brain.complete(&assemble(request), MAX_TOKENS, TIMEOUT).map_err(|e| if e == BrainError::Capped { TurnError::Capped } else { TurnError::Brain(e) })?;
    let text = clean_reply(&raw);
    if text.trim().is_empty() {
        return Err(TurnError::Empty);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::brain::assemble::{Line, Persona, Why};
    use crate::companion::brain::stub::StubBrain;

    fn persona() -> Persona {
        Persona { name: "Mochi".into(), soul: "Be kind.".into(), ..Default::default() }
    }

    fn ask<'a>(persona: &'a Persona, window: &'a [Line]) -> Request<'a> {
        Request { persona, window, why: Why::Called, memory: None }
    }

    #[test]
    fn a_reply_is_cleaned_cut_and_defanged() {
        let p = persona();
        let window = vec![Line { author: "Sam".into(), text: "hi".into(), is_self: false }];
        let brain = StubBrain::says(&format!("Hello @everyone and @here! key sk-ant-api03-abcdefghijklmnop {}", "x".repeat(3000)));
        let calls = DailyCalls::open(None, 10, 0);
        let text = run(&brain, &calls, &ask(&p, &window), 1_000).unwrap();
        assert!(text.chars().count() <= MAX_CHARS);
        assert!(!text.contains("@everyone") && !text.contains("@here"));
        assert!(!text.contains("sk-ant-api03"), "{text}");
        assert_eq!(calls.used(1_000), 1);
    }

    #[test]
    fn the_cap_stops_it_before_the_brain_is_asked() {
        let p = persona();
        let window = vec![Line { author: "Sam".into(), text: "hi".into(), is_self: false }];
        let brain = StubBrain::says("hello");
        let calls = DailyCalls::open(None, 1, 0);
        assert!(run(&brain, &calls, &ask(&p, &window), 1_000).is_ok());
        assert_eq!(run(&brain, &calls, &ask(&p, &window), 2_000), Err(TurnError::Capped));
        assert_eq!(brain.calls(), 1);
    }

    #[test]
    fn an_empty_or_failed_answer_is_an_error_not_a_message() {
        let p = persona();
        let window = vec![Line { author: "Sam".into(), text: "hi".into(), is_self: false }];
        let calls = DailyCalls::open(None, 10, 0);
        assert_eq!(run(&StubBrain::says("   \n "), &calls, &ask(&p, &window), 1), Err(TurnError::Empty));
        assert_eq!(run(&StubBrain::fails(BrainError::Timeout), &calls, &ask(&p, &window), 2), Err(TurnError::Brain(BrainError::Timeout)));
        assert_eq!(run(&StubBrain::fails(BrainError::NoKey), &calls, &ask(&p, &window), 3), Err(TurnError::Brain(BrainError::NoKey)));
    }
}
