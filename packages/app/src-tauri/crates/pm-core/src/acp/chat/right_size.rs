//! "Right-size the agent": after a turn, a quiet line may say the model looked too big or too small for the task.
//!
//! Heuristic only, all local, no model call:
//! - A SMALL task on a big model: a short message, at most one file changed, a quick finish. Suggest a cheaper
//!   model the agent offers.
//! - A cheap model that FAILED or hit its step limit: suggest a stronger one the agent offers.
//!
//! The model's weight is read from the words of its name ("mini", "flash", "pro", "max"...), never from the agent's
//! name, and only models the agent really offers (its `configOptions`) are suggested. At most one suggestion per
//! chat per day; the Settings switch `right_size_suggest` turns it off.

use super::ending::EndReason;
use parking_lot::Mutex;
use serde::Serialize;
use std::time::Instant;

/// The Settings key (on unless `false`).
pub const SETTING: &str = "right_size_suggest";

/// A message at most this long (characters) is a short one.
pub const SHORT_PROMPT_CHARS: usize = 240;
/// A turn that finished within this long is a quick one.
pub const QUICK_MS: u64 = 60_000;
/// At most this many files changed.
pub const FEW_FILES: usize = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Cheap,
    Mid,
    Strong,
}

const CHEAP: &[&str] = &["haiku", "mini", "flash", "lite", "nano", "small", "instant"];
const MID: &[&str] = &["sonnet", "medium"];
const STRONG: &[&str] = &["opus", "pro", "max", "ultra", "large"];

/// How heavy a model is, from the words of its name or id. `None` when the name says nothing.
pub fn tier_of(text: &str) -> Option<Tier> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let has = |list: &[&str]| words.iter().any(|w| list.contains(w));
    // The lightest word wins ("opus-mini" would be odd, but a "pro mini" is a mini).
    if has(CHEAP) {
        Some(Tier::Cheap)
    } else if has(STRONG) {
        Some(Tier::Strong)
    } else if has(MID) {
        Some(Tier::Mid)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The task looked small: a cheaper model would do.
    Smaller,
    /// The cheap model failed or ran out of steps: try a stronger one.
    Stronger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub kind: Kind,
    /// The model in use, as the agent names it.
    pub from_name: String,
    /// What to switch to: the value the agent's model setting takes, and its name.
    pub to_value: String,
    pub to_name: String,
}

/// What the turn looked like.
#[derive(Debug, Clone, Copy)]
pub struct Facts {
    pub prompt_chars: usize,
    pub files: usize,
    pub duration_ms: u64,
    pub reason: EndReason,
}

impl Facts {
    pub fn looked_small(&self) -> bool {
        self.reason == EndReason::Done && self.prompt_chars > 0 && self.prompt_chars <= SHORT_PROMPT_CHARS && self.files <= FEW_FILES && self.duration_ms <= QUICK_MS
    }

    pub fn went_wrong(&self) -> bool {
        matches!(self.reason, EndReason::Failed | EndReason::Empty | EndReason::CutShort | EndReason::NoAnswer)
    }
}

/// `current` is the model in use (value, name); `choices` are the models the agent offers (value, name).
pub fn suggest(facts: &Facts, current: (&str, &str), choices: &[(String, String)]) -> Option<Suggestion> {
    let tier = tier_of(current.1).or_else(|| tier_of(current.0))?;
    let tier_choice = |wanted: &dyn Fn(Tier) -> bool| {
        choices
            .iter()
            .filter(|(value, _)| value != current.0)
            .filter_map(|(value, name)| tier_of(name).or_else(|| tier_of(value)).map(|t| (t, value, name)))
            .filter(|(t, _, _)| wanted(*t))
            .min_by_key(|(t, _, _)| *t)
    };
    let (kind, picked) = if tier == Tier::Strong && facts.looked_small() {
        (Kind::Smaller, tier_choice(&|t| t == Tier::Cheap))
    } else if tier == Tier::Cheap && facts.went_wrong() {
        (Kind::Stronger, tier_choice(&|t| t > Tier::Cheap))
    } else {
        return None;
    };
    let (_, value, name) = picked?;
    Some(Suggestion { kind, from_name: current.1.to_string(), to_value: value.clone(), to_name: name.clone() })
}

#[derive(Default)]
struct Inner {
    began: Option<Instant>,
    replied: bool,
    prompt_chars: usize,
    /// The local day a suggestion was last made in this chat.
    shown_day: String,
    pending: Option<Suggestion>,
}

/// One chat's note of its latest turn and of the suggestion that waits.
#[derive(Default)]
pub struct Slot {
    inner: Mutex<Inner>,
}

impl Slot {
    /// A turn begins with a message of `chars` characters. Any suggestion from before is gone.
    pub fn started(&self, chars: usize) {
        let mut inner = self.inner.lock();
        inner.began = Some(Instant::now());
        inner.replied = false;
        inner.prompt_chars = chars;
        inner.pending = None;
    }

    /// The first sign of an answer in this turn: how long it took since the message went out. `None` for every later
    /// sign and when no turn began here (the Speed report in Settings reads this back from the log).
    pub fn first_reply(&self) -> Option<u64> {
        let mut inner = self.inner.lock();
        if inner.replied {
            return None;
        }
        let began = inner.began?;
        inner.replied = true;
        Some(began.elapsed().as_millis() as u64)
    }

    /// The turn ended: how long it took and how long the message was.
    pub fn ended(&self) -> (u64, usize) {
        let mut inner = self.inner.lock();
        let ms = inner.began.take().map(|b| b.elapsed().as_millis() as u64).unwrap_or(0);
        (ms, inner.prompt_chars)
    }

    /// Keeps `suggestion` for the banner unless one was already made today. Returns whether it was kept.
    pub fn offer(&self, suggestion: Suggestion, today: &str) -> bool {
        let mut inner = self.inner.lock();
        if inner.shown_day == today {
            return false;
        }
        inner.shown_day = today.to_string();
        inner.pending = Some(suggestion);
        true
    }

    pub fn pending(&self) -> Option<Suggestion> {
        self.inner.lock().pending.clone()
    }

    pub fn dismiss(&self) {
        self.inner.lock().pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Vec<(String, String)> {
        vec![("opus".into(), "Opus".into()), ("sonnet".into(), "Sonnet".into()), ("haiku".into(), "Haiku".into())]
    }

    fn small() -> Facts {
        Facts { prompt_chars: 40, files: 0, duration_ms: 8_000, reason: EndReason::Done }
    }

    #[test]
    fn a_small_task_on_a_big_model_suggests_the_cheap_one() {
        let s = suggest(&small(), ("opus", "Opus"), &models()).expect("a suggestion");
        assert_eq!((s.kind, s.to_value.as_str(), s.to_name.as_str()), (Kind::Smaller, "haiku", "Haiku"));
    }

    #[test]
    fn a_big_task_or_a_slow_one_or_many_files_is_left_alone() {
        let big = Facts { prompt_chars: 900, ..small() };
        let slow = Facts { duration_ms: 300_000, ..small() };
        let wide = Facts { files: 4, ..small() };
        for facts in [big, slow, wide] {
            assert!(suggest(&facts, ("opus", "Opus"), &models()).is_none(), "{facts:?}");
        }
    }

    #[test]
    fn a_cheap_model_that_failed_or_ran_out_of_steps_suggests_the_next_one_up() {
        for reason in [EndReason::Failed, EndReason::CutShort, EndReason::Empty] {
            let facts = Facts { reason, ..small() };
            let s = suggest(&facts, ("haiku", "Haiku"), &models()).expect("a suggestion");
            assert_eq!((s.kind, s.to_value.as_str()), (Kind::Stronger, "sonnet"), "the middle one first");
        }
        let only_big = vec![("opus".to_string(), "Opus".to_string()), ("haiku".to_string(), "Haiku".to_string())];
        let s = suggest(&Facts { reason: EndReason::Failed, ..small() }, ("haiku", "Haiku"), &only_big).unwrap();
        assert_eq!(s.to_value, "opus");
    }

    #[test]
    fn a_cheap_model_that_did_well_and_a_stopped_turn_get_nothing() {
        assert!(suggest(&small(), ("haiku", "Haiku"), &models()).is_none());
        let stopped = Facts { reason: EndReason::Stopped, ..small() };
        assert!(suggest(&stopped, ("haiku", "Haiku"), &models()).is_none());
        assert!(suggest(&stopped, ("opus", "Opus"), &models()).is_none());
    }

    #[test]
    fn nothing_is_suggested_that_the_agent_does_not_offer_or_cannot_be_told_apart() {
        let only_big = vec![("opus".to_string(), "Opus".to_string())];
        assert!(suggest(&small(), ("opus", "Opus"), &only_big).is_none());
        assert!(suggest(&small(), ("default", "Default"), &models()).is_none());
    }

    #[test]
    fn the_weight_comes_from_the_words_of_the_name() {
        assert_eq!(tier_of("gpt-5-codex-mini"), Some(Tier::Cheap));
        assert_eq!(tier_of("gemini-2.5-pro"), Some(Tier::Strong));
        assert_eq!(tier_of("claude-sonnet-5"), Some(Tier::Mid));
        assert_eq!(tier_of("promise-engine"), None, "whole words only");
    }

    #[test]
    fn the_first_reply_is_timed_once_per_turn() {
        let slot = Slot::default();
        assert_eq!(slot.first_reply(), None, "no turn began");
        slot.started(5);
        assert!(slot.first_reply().is_some());
        assert_eq!(slot.first_reply(), None, "only the first sign counts");
        slot.started(5);
        assert!(slot.first_reply().is_some(), "the next turn is timed again");
    }

    #[test]
    fn one_suggestion_per_chat_per_day_and_a_new_turn_clears_it() {
        let slot = Slot::default();
        let s = suggest(&small(), ("opus", "Opus"), &models()).unwrap();
        assert!(slot.offer(s.clone(), "2026-11-15"));
        assert_eq!(slot.pending(), Some(s.clone()));
        assert!(!slot.offer(s.clone(), "2026-11-15"), "not twice in a day");
        slot.started(10);
        assert!(slot.pending().is_none(), "the next turn takes the line away");
        assert!(slot.offer(s, "2026-11-16"), "the next day it may speak again");
    }
}
