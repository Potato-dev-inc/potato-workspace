//! How a turn ended, in plain words (P-28 "honest turn endings").
//!
//! Every turn of a chat ends with one grey line. This module decides which one: an `EndReason` from what the
//! session reported (`TurnSummary`) and what the mapper saw (files touched, any visible answer), and the sentence
//! for it. The sentence never holds a button: the chat view adds the buttons that belong to the reason
//! (`Retry`, `Sign in`, `Keep going with ...`), keyed by the notice kind `ending:<reason>`.
//!
//! Generic: the matching words below are about limits and sign-in in general, not about one agent. An agent's own
//! wording lives in its definition, and the agent's name only comes in as a label.
//!
//! Also here: `strip_leaked_markup`, which removes the control tokens some models leak into their text
//! (`<|im_end|>`, `[INST]`, a half-printed `<function_calls>` block, terminal escape codes).

use crate::acp::state::{StopKind, TurnSummary};

/// Why a turn ended. The snake-case name is the suffix of the notice kind (`ending:usage_limit`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// The agent answered and stopped.
    Done,
    /// The person pressed Stop.
    Stopped,
    /// The agent ran out of usage (a plan limit, a quota, rate limiting).
    UsageLimit,
    /// The agent went quiet and the turn was stopped.
    NoAnswer,
    /// The agent refused the request for want of a sign-in.
    SignedOut,
    /// The agent said `end_turn` with nothing visible: no text, no tool.
    Empty,
    /// The agent stopped at its length or step limit.
    CutShort,
    /// The agent declined to continue.
    Declined,
    /// Anything else that went wrong.
    Failed,
}

impl EndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EndReason::Done => "done",
            EndReason::Stopped => "stopped",
            EndReason::UsageLimit => "usage_limit",
            EndReason::NoAnswer => "no_answer",
            EndReason::SignedOut => "signed_out",
            EndReason::Empty => "empty",
            EndReason::CutShort => "cut_short",
            EndReason::Declined => "declined",
            EndReason::Failed => "failed",
        }
    }

    /// The notice kind that carries this ending in the chat.
    pub fn notice_kind(self) -> String {
        format!("{NOTICE_PREFIX}{}", self.as_str())
    }
}

/// Every ending notice kind starts with this; the chat view finds the line by it.
pub const NOTICE_PREFIX: &str = "ending:";

/// What the mapper knows about the turn besides the session's report.
#[derive(Debug, Clone, Copy, Default)]
pub struct TurnFacts<'a> {
    /// How many different files the turn changed.
    pub files: usize,
    /// The turn showed an answer or a tool call the person can see.
    pub visible: bool,
    pub duration_ms: Option<u64>,
    /// The agent's name for the person, if it said one.
    pub agent: Option<&'a str>,
    /// The quiet window in minutes (the "No answer for N min" number).
    pub quiet_minutes: u64,
    /// The chat is a key-based add-on: it has no sign-in of its own, so a failure is never "signed out" and the
    /// agent's own short message (redacted) is shown instead of a guess.
    pub own_cause: bool,
    /// The agent's words for a model that needs credit (or does not exist), from its definition.
    pub credit: Option<&'a crate::acp::config::DefaultModel>,
    /// The model in use when the turn ended, for that sentence.
    pub model: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ending {
    pub reason: EndReason,
    pub text: String,
}

/// The ending of a turn the session reported.
pub fn ending_of(summary: &TurnSummary, facts: &TurnFacts) -> Ending {
    if let Some(text) = credit_text(summary, facts) {
        return Ending { reason: EndReason::Failed, text };
    }
    if summary.error.as_deref() == Some(crate::acp::session::SESSION_CLOSED) {
        return Ending { reason: EndReason::Failed, text: "The app closed while this was running.".to_string() };
    }
    let reason = reason_of(summary, facts);
    let text = match reason {
        EndReason::Done => done_line(facts),
        EndReason::Stopped => "You stopped it".to_string(),
        EndReason::UsageLimit => format!("{} hit its usage limit", facts.agent.filter(|a| !a.trim().is_empty()).unwrap_or("The agent")),
        EndReason::NoAnswer => format!("No answer for {} min", facts.quiet_minutes.max(1)),
        EndReason::SignedOut => "Probably signed out".to_string(),
        EndReason::Empty => "The turn ended with no answer".to_string(),
        EndReason::CutShort => match summary.stop {
            StopKind::MaxTurnRequests => "It stopped at its step limit".to_string(),
            _ => "It stopped at its length limit".to_string(),
        },
        EndReason::Declined => "The agent declined to continue".to_string(),
        EndReason::Failed => format!("Something went wrong: {}", plain_cause(summary.error.as_deref(), facts.own_cause)),
    };
    Ending { reason, text }
}

/// The ending of a turn that was closed without a report from the session (the adapter went away, the chat was
/// closed). `cause` is the plain sentence the mapper already had.
pub fn ending_without_report(cause: &str, facts: &TurnFacts) -> Ending {
    Ending { reason: EndReason::Failed, text: format!("Something went wrong: {}", plain_cause(Some(cause), facts.own_cause)) }
}

/// The one sentence for an agent that quit with exit code 0 in the middle of a turn: what it last said on its error
/// output, in its own words, and one thing to do. `None` when it said nothing.
pub fn quit_with_words(stderr_tail: &[String]) -> Option<String> {
    let line = stderr_tail.iter().rev().map(|l| strip_leaked_markup(l)).map(|l| l.trim().to_string()).find(|l| !l.is_empty())?;
    let mut said = line.as_str();
    for prefix in ["error:", "fatal:", "error", "fatal"] {
        if said.len() > prefix.len() && said.is_char_boundary(prefix.len()) && said[..prefix.len()].eq_ignore_ascii_case(prefix) {
            said = said[prefix.len()..].trim_start_matches([':', ' ']);
            break;
        }
    }
    // A trailing "(...)" is a code or a tag, not part of the message.
    let said = match said.rfind(" (") {
        Some(i) if said.ends_with(')') => &said[..i],
        _ => said,
    };
    let said = plain_cause(Some(said), false);
    let todo = if says_signed_out(&said) { "Sign in, then try again." } else { "Try again." };
    Some(format!("The agent stopped. It said: \"{said}\". {todo}"))
}

/// The sentence for a failure the agent's definition calls "needs credit" (a billing error, an unknown model).
fn credit_text(summary: &TurnSummary, facts: &TurnFacts) -> Option<String> {
    let rule = facts.credit?;
    if summary.stop != StopKind::Failed || rule.credit_message.trim().is_empty() {
        return None;
    }
    let error = summary.error.as_deref()?.to_lowercase();
    if !rule.credit_patterns.iter().any(|p| !p.trim().is_empty() && error.contains(&p.to_lowercase())) {
        return None;
    }
    let model = facts.model.map(str::trim).filter(|m| !m.is_empty()).unwrap_or("in use");
    Some(rule.credit_message.replace("{model}", model))
}

fn reason_of(summary: &TurnSummary, facts: &TurnFacts) -> EndReason {
    match summary.stop {
        StopKind::Cancelled => EndReason::Stopped,
        StopKind::Hung => EndReason::NoAnswer,
        StopKind::Refusal => EndReason::Declined,
        StopKind::MaxTokens | StopKind::MaxTurnRequests => EndReason::CutShort,
        StopKind::EndTurn => {
            // The silent failure check: the agent says it is done but nothing came out.
            if (summary.empty || !facts.visible) && !summary.cancel_requested {
                EndReason::Empty
            } else {
                EndReason::Done
            }
        }
        StopKind::Failed => {
            let text = summary.error.as_deref().unwrap_or("");
            if facts.own_cause {
                // No sign-in exists for this chat: the code -32000 is only "the request failed", so the real message shows.
                EndReason::Failed
            } else if says_usage_limit(text) {
                EndReason::UsageLimit
            } else if summary.error_code == Some(-32000) || says_signed_out(text) {
                EndReason::SignedOut
            } else {
                EndReason::Failed
            }
        }
    }
}

fn done_line(facts: &TurnFacts) -> String {
    let mut parts = vec!["Done".to_string()];
    if facts.files > 0 {
        parts.push(if facts.files == 1 { "1 file".to_string() } else { format!("{} files", facts.files) });
    }
    if let Some(ms) = facts.duration_ms {
        parts.push(duration_words(ms));
    }
    parts.join(" · ")
}

/// "45 s", "2 min", "1 h 5 min". Under a second is "1 s".
pub fn duration_words(ms: u64) -> String {
    let secs = (ms / 1000).max(1);
    if secs < 60 {
        return format!("{secs} s");
    }
    let mins = (secs + 30) / 60;
    if mins < 60 {
        return format!("{mins} min");
    }
    let (h, m) = (mins / 60, mins % 60);
    if m == 0 {
        format!("{h} h")
    } else {
        format!("{h} h {m} min")
    }
}

fn says_usage_limit(text: &str) -> bool {
    let t = text.to_lowercase();
    ["usage limit", "rate limit", "quota", "limit reached", "reached your limit", "hit your limit", "out of credits", "insufficient credit", "too many requests", "resource_exhausted", "429"]
        .iter()
        .any(|needle| t.contains(needle))
}

fn says_signed_out(text: &str) -> bool {
    let t = text.to_lowercase();
    ["sign in", "sign-in", "signed in", "log in", "login", "logged in", "unauthorized", "unauthenticated", "authenticat", "invalid api key", "401", "credentials", "token expired", "expired token"]
        .iter()
        .any(|needle| t.contains(needle))
}

/// The cause of a failure as one short plain phrase: markup removed, one line, cut, no closing full stop. With
/// `own_cause` the text is redacted first (a key-like string is masked) and may be a little longer.
fn plain_cause(raw: Option<&str>, own_cause: bool) -> String {
    let mut clean = strip_leaked_markup(raw.unwrap_or(""));
    if own_cause {
        clean = crate::redact::text(&clean).into_inner();
    }
    let limit = if own_cause { 280 } else { 160 };
    let one_line = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let one_line = one_line.trim().trim_end_matches('.').trim().to_string();
    if one_line.is_empty() {
        return "the turn did not finish".to_string();
    }
    let mut chars = one_line.chars();
    let cut: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{}…", cut.trim_end())
    } else {
        cut
    }
}

// ---- leaked markup ------------------------------------------------------------------------------------------

/// Whole blocks a model sometimes prints instead of acting on them: opening tag, anything, closing tag. An open
/// tag with no closing tag removes the rest of the text.
const BLOCK_TAGS: &[&str] = &["function_calls", "tool_call", "tool_calls", "antml:function_calls", "thinking", "antml:thinking", "system-reminder", "tool_response", "function_results"];

/// Single tokens removed wherever they appear.
const LITERAL_TOKENS: &[&str] = &["[INST]", "[/INST]", "<<SYS>>", "<</SYS>>", "<s>", "</s>", "<bos>", "<eos>", "<pad>", "<unk>"];

/// Removes control tokens and terminal escape codes from text that is meant to be read. Plain text, markdown and
/// code stay as they are; text with none of these is returned unchanged.
pub fn strip_leaked_markup(text: &str) -> String {
    let suspicious = text.chars().any(|c| (c.is_control() && !matches!(c, '\n' | '\t' | '\r')) || c == '<' || c == '[');
    if !suspicious {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'scan: while let Some(c) = rest.chars().next() {
        // Terminal escape sequences: ESC [ ... final byte, ESC ] ... BEL/ST.
        if c == '\u{1b}' {
            let after = &rest[1..];
            if let Some(body) = after.strip_prefix('[') {
                let end = body.find(|ch: char| ('@'..='~').contains(&ch)).map(|i| i + 1).unwrap_or(body.len());
                rest = &body[end.min(body.len())..];
            } else if let Some(body) = after.strip_prefix(']') {
                let end = body.find(['\u{7}', '\u{1b}']).map(|i| i + 1).unwrap_or(body.len());
                rest = &body[end.min(body.len())..];
            } else {
                rest = after.char_indices().nth(1).map(|(i, _)| &after[i..]).unwrap_or("");
            }
            continue;
        }
        if c.is_control() && !matches!(c, '\n' | '\t' | '\r') {
            rest = &rest[c.len_utf8()..];
            continue;
        }
        if c == '<' || c == '[' {
            // <|...|> and <｜...｜> special tokens.
            for (open, close) in [("<|", "|>"), ("<\u{ff5c}", "\u{ff5c}>")] {
                if let Some(body) = rest.strip_prefix(open) {
                    if let Some(end) = body.find(close) {
                        if end <= 64 && !body[..end].contains('\n') {
                            rest = &body[end + close.len()..];
                            continue 'scan;
                        }
                    }
                }
            }
            for token in LITERAL_TOKENS {
                if let Some(after) = rest.strip_prefix(token) {
                    rest = after;
                    continue 'scan;
                }
            }
            for tag in BLOCK_TAGS {
                let open = format!("<{tag}");
                if let Some(after_open) = rest.strip_prefix(open.as_str()) {
                    if after_open.starts_with(['>', ' ', '\n']) {
                        let close = format!("</{tag}>");
                        match after_open.find(close.as_str()) {
                            Some(end) => rest = &after_open[end + close.len()..],
                            None => rest = "",
                        }
                        continue 'scan;
                    }
                }
            }
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    if out.len() == text.len() {
        // Nothing was cut: the text keeps its own spacing.
        return out;
    }
    // The cut-out blocks leave blank runs behind: no more than one empty line, and no blank edge.
    let mut tidy = String::with_capacity(out.len());
    let mut blank = 0;
    for line in out.split('\n') {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        tidy.push_str(line);
        tidy.push('\n');
    }
    tidy.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(stop: StopKind) -> TurnSummary {
        TurnSummary { turn: 1, stop, stop_reason: None, cancel_requested: false, empty: false, error: None, error_code: None }
    }

    fn facts() -> TurnFacts<'static> {
        TurnFacts { files: 0, visible: true, duration_ms: None, agent: Some("Fake A"), quiet_minutes: 5, own_cause: false, credit: None, model: None }
    }

    #[test]
    fn a_billing_error_names_the_model_and_what_to_do() {
        let rule = crate::acp::config::find_builtin("opencode").and_then(|c| c.default_model).expect("OpenCode has a default-model rule");
        let mut s = summary(StopKind::Failed);
        s.error_code = Some(-32000);
        s.error = Some("Insufficient balance. Top up at opencode.ai/console/x/billing".into());
        let e = ending_of(&s, &TurnFacts { credit: Some(&rule), model: Some("opencode/gemini-4-carbon"), ..facts() });
        assert_eq!(e.reason, EndReason::Failed, "not read as signed out");
        assert_eq!(e.text, "OpenCode's model opencode/gemini-4-carbon needs credit. Pick another model in the chat, or set Settings \u{203a} Orchestrator & Models \u{203a} OpenCode model.");
        s.error = Some("ProviderModelNotFoundError: model not found".into());
        assert!(ending_of(&s, &TurnFacts { credit: Some(&rule), model: None, ..facts() }).text.contains("model in use needs credit"));
        s.error = Some("connection reset".into());
        s.error_code = None;
        assert!(ending_of(&s, &TurnFacts { credit: Some(&rule), ..facts() }).text.starts_with("Something went wrong"));
    }

    #[test]
    fn done_says_files_and_time_when_known() {
        assert_eq!(ending_of(&summary(StopKind::EndTurn), &TurnFacts { files: 3, duration_ms: Some(120_000), ..facts() }).text, "Done · 3 files · 2 min");
        assert_eq!(ending_of(&summary(StopKind::EndTurn), &TurnFacts { files: 1, duration_ms: Some(45_000), ..facts() }).text, "Done · 1 file · 45 s");
        assert_eq!(ending_of(&summary(StopKind::EndTurn), &facts()).text, "Done");
        assert_eq!(ending_of(&summary(StopKind::EndTurn), &TurnFacts { duration_ms: Some(3_900_000), ..facts() }).text, "Done · 1 h 5 min");
    }

    #[test]
    fn every_stop_reason_maps_to_its_ending() {
        let cases = [
            (StopKind::EndTurn, EndReason::Done),
            (StopKind::Cancelled, EndReason::Stopped),
            (StopKind::Hung, EndReason::NoAnswer),
            (StopKind::Refusal, EndReason::Declined),
            (StopKind::MaxTokens, EndReason::CutShort),
            (StopKind::MaxTurnRequests, EndReason::CutShort),
            (StopKind::Failed, EndReason::Failed),
        ];
        for (stop, want) in cases {
            assert_eq!(ending_of(&summary(stop), &facts()).reason, want, "{stop:?}");
        }
    }

    #[test]
    fn the_person_stopping_it_reads_you_stopped_it() {
        let mut s = summary(StopKind::Cancelled);
        s.cancel_requested = true;
        assert_eq!(ending_of(&s, &facts()).text, "You stopped it");
    }

    #[test]
    fn a_usage_limit_names_the_agent_and_a_missing_label_falls_back() {
        let mut s = summary(StopKind::Failed);
        s.error = Some("Claude usage limit reached. Resets at 5pm.".into());
        let e = ending_of(&s, &facts());
        assert_eq!((e.reason, e.text.as_str()), (EndReason::UsageLimit, "Fake A hit its usage limit"));
        let e = ending_of(&s, &TurnFacts { agent: None, ..facts() });
        assert_eq!(e.text, "The agent hit its usage limit");
        s.error = Some("HTTP 429 too many requests".into());
        assert_eq!(ending_of(&s, &facts()).reason, EndReason::UsageLimit);
    }

    #[test]
    fn sign_in_errors_read_probably_signed_out() {
        let mut s = summary(StopKind::Failed);
        s.error_code = Some(-32000);
        s.error = Some("Authentication required".into());
        assert_eq!(ending_of(&s, &facts()), Ending { reason: EndReason::SignedOut, text: "Probably signed out".into() });
        let mut s = summary(StopKind::Failed);
        s.error = Some("401 Unauthorized".into());
        assert_eq!(ending_of(&s, &facts()).reason, EndReason::SignedOut);
    }

    #[test]
    fn a_limit_message_that_mentions_signing_in_is_still_a_limit() {
        let mut s = summary(StopKind::Failed);
        s.error = Some("You have hit your limit. Sign in with another account to continue.".into());
        assert_eq!(ending_of(&s, &facts()).reason, EndReason::UsageLimit);
    }

    #[test]
    fn end_turn_with_nothing_visible_is_a_silent_failure() {
        let mut s = summary(StopKind::EndTurn);
        s.empty = true;
        assert_eq!(ending_of(&s, &facts()), Ending { reason: EndReason::Empty, text: "The turn ended with no answer".into() });
        // The session saw thought chunks, but the person has nothing to read.
        let s = summary(StopKind::EndTurn);
        assert_eq!(ending_of(&s, &TurnFacts { visible: false, ..facts() }).reason, EndReason::Empty);
        // A stop the person asked for is not a silent failure.
        let mut s = summary(StopKind::EndTurn);
        s.empty = true;
        s.cancel_requested = true;
        assert_eq!(ending_of(&s, &facts()).reason, EndReason::Done);
    }

    #[test]
    fn something_went_wrong_gives_a_short_plain_cause() {
        let mut s = summary(StopKind::Failed);
        s.error = Some("  the pipe\n broke.  <|im_end|> ".into());
        assert_eq!(ending_of(&s, &facts()).text, "Something went wrong: the pipe broke");
        s.error = None;
        assert_eq!(ending_of(&s, &facts()).text, "Something went wrong: the turn did not finish");
        s.error = Some("x".repeat(400));
        let text = ending_of(&s, &facts()).text;
        assert!(text.chars().count() < 200 && text.ends_with('…'), "{text}");
    }

    #[test]
    fn no_answer_names_the_quiet_window() {
        assert_eq!(ending_of(&summary(StopKind::Hung), &facts()).text, "No answer for 5 min");
    }

    #[test]
    fn notice_kinds_carry_the_reason() {
        assert_eq!(EndReason::UsageLimit.notice_kind(), "ending:usage_limit");
        assert_eq!(EndReason::Done.notice_kind(), "ending:done");
    }

    // ---- markup strip: golden --------------------------------------------------------------------------------

    #[test]
    fn leaked_markup_is_stripped_golden() {
        let cases: &[(&str, &str)] = &[
            ("Hello<|im_end|>", "Hello"),
            ("<|im_start|>assistant\nHello", "assistant\nHello"),
            ("Done.<|endoftext|><|endoftext|>", "Done."),
            ("[INST] hi [/INST] hello", "hi  hello"),
            ("<s>Hello</s>", "Hello"),
            ("Result is 4.\n<function_calls>\n<invoke name=\"x\">\n</invoke>\n</function_calls>\nDone.", "Result is 4.\n\nDone."),
            ("Answer<thinking>secret plan</thinking> is 4", "Answer is 4"),
            ("Cut off <function_calls><invoke", "Cut off"),
            ("\u{1b}[31mred\u{1b}[0m text", "red text"),
            ("bell\u{7} and nul\u{0}", "bell and nul"),
            ("tab\tstays\nand lines", "tab\tstays\nand lines"),
        ];
        for (raw, want) in cases {
            assert_eq!(&strip_leaked_markup(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn ordinary_text_with_brackets_and_code_is_untouched() {
        let text = "Use `a < b` and arr[0] then <div class=\"x\">hi</div>\n\n\nTwo blank lines above.\n";
        assert_eq!(strip_leaked_markup(text), text);
        let md = "- [x] done\n- [ ] todo\n\n```rust\nlet v: Vec<u8> = vec![1];\n```";
        assert_eq!(strip_leaked_markup(md), md);
    }

    #[test]
    fn a_key_based_chat_never_reads_signed_out_and_shows_its_own_masked_message() {
        let mut s = summary(StopKind::Failed);
        s.error_code = Some(-32000);
        s.error = Some("model request failed: AuthenticationError: Missing Authentication header (401) key sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef01234567".into());
        let other = ending_of(&s, &facts());
        assert_eq!((other.reason, other.text.as_str()), (EndReason::SignedOut, "Probably signed out"), "other agents keep the guess");
        let own = ending_of(&s, &TurnFacts { own_cause: true, ..facts() });
        assert_eq!(own.reason, EndReason::Failed);
        assert!(own.text.starts_with("Something went wrong: model request failed: AuthenticationError: Missing Authentication header (401)"), "{}", own.text);
        assert!(!own.text.contains("0123456789abcdef0123456789abcdef"), "{}", own.text);
        // a rate limit also shows its own words, not "hit its usage limit"
        s.error = Some("model request failed: RateLimitError: 429 too many requests".into());
        assert!(ending_of(&s, &TurnFacts { own_cause: true, ..facts() }).text.contains("RateLimitError"));
        assert_eq!(ending_of(&s, &facts()).reason, EndReason::UsageLimit);
    }
}
