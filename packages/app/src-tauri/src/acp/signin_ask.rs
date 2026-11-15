//! "Sign in without a terminal": is the agent's sign-in screen asking the person something?
//!
//! The chat shows a two-step card ("1. Your browser opens. 2. Come back here."). The agent's own sign-in runs in a hidden
//! pane; its terminal stays folded under "Details" and opens by itself when the screen is asking a question (a menu, a
//! "paste the code" line, a yes/no), because then the browser alone is not enough. Generic: no agent is named here. A
//! wrong guess costs nothing: Details opens, or does not, and the person can open it by hand.

use once_cell::sync::Lazy;
use regex::Regex;

static ASKS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"(?i)\bpaste\b",
        r"(?i)\benter (the |your |a )?(code|key|token|url|email|password)\b",
        r"(?i)\b(select|choose|pick) (a|an|the|your|one|how|login|sign)",
        r"(?i)\(y/n\)|\[y/n\]|\(yes/no\)",
        r"(?i)\bpress (enter|return|any key)\b",
        r"(?i)\bdo you (want|trust)\b",
        r"(?i)\buse arrow keys\b|↑↓|\bto select\b",
        r"(?m)^\s*[❯›>]\s*\d+\.\s+\S",
        r"(?m)^\s*\d+\.\s+\S.*\n\s*\d+\.\s+\S",
        r"\?\s*$",
        r"(?i)code:\s*$|>\s*$",
    ]
    .into_iter()
    .map(|p| Regex::new(p).expect("valid sign-in prompt regex"))
    .collect()
});

/// How many of the last lines of the screen are looked at.
const TAIL_LINES: usize = 8;

/// Whether the end of `screen` (the text of the hidden pane) reads like a question for the person.
pub fn asks_the_person(screen: &str) -> bool {
    if crate::pty::status::looks_like_prompt(screen) {
        return true;
    }
    let clean = crate::pty::ansi::strip_ansi(screen);
    let tail: Vec<&str> = clean.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(TAIL_LINES)..].join("\n");
    ASKS.iter().any(|re| re.is_match(&tail))
}

#[cfg(test)]
#[path = "signin_ask_tests.rs"]
mod tests;
