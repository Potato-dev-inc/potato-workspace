//! Force yes: may the app answer "allow once" to this permission question for the person?
//!
//! The answer is yes only when every one of these holds, otherwise the question goes to the person as usual:
//! * the agent offered an "allow once" option (never "allow always" is chosen);
//! * the tool is of a kind that reads, searches, fetches, thinks, edits a project file or runs a command (deleting,
//!   moving and any kind the agent did not name always ask);
//! * nothing in the question looks like a password, a key, a token or a login (`looks_secret`);
//! * the risk rules (`prompt_risk`) call it Low: a command must be a known low-risk one, a file must be inside the
//!   project and not a file that holds secrets.
//!
//! Pure functions: no store, no chat. The chat (`acp::chat::rules`) feeds them what the agent asked.

use crate::prompt_risk::{assess, RiskInput, RiskLevel};
use std::path::PathBuf;

/// What the agent asked.
#[derive(Debug, Clone, Default)]
pub struct Ask<'a> {
    pub kind: Option<&'a str>,
    pub title: Option<&'a str>,
    pub paths: &'a [String],
    pub command: Option<&'a str>,
    /// The folder the agent works in and the project: a path outside both is not "inside the project".
    pub roots: &'a [PathBuf],
}

/// The options the agent offered, as (option id, kind).
pub type Offered<'a> = &'a [(&'a str, &'a str)];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Answer with this option id.
    Allow { option_id: String },
    /// Leave the question to the person; the words say why (for tests and logs).
    Ask(Why),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    NoAllowOnce,
    KindAlwaysAsks,
    LooksSecret,
    Risky(RiskLevel),
    NothingToJudge,
}

/// Words that mark a question about a password, a key or a login. Checked on the title, the command and the paths.
const SECRET_WORDS: &[&str] = &[
    "password", "passwd", "passphrase", "credential", "secret", "token", "api key", "api_key", "apikey", "private key", "id_rsa", "id_ed25519",
    ".pem", ".pfx", ".env", "keychain", "otp", "2fa", "sign in", "sign-in", "login", "log in", "sudo", "authenticat",
];

/// Whether the question looks like one about a secret. Cautious on purpose: a false alarm only means the person is asked.
pub fn looks_secret(ask: &Ask) -> bool {
    let mut text = String::new();
    for part in ask.title.iter().copied().chain(ask.command).chain(ask.paths.iter().map(String::as_str)) {
        text.push_str(&part.to_lowercase());
        text.push('\n');
    }
    SECRET_WORDS.iter().any(|word| text.contains(word))
}

fn level_of(ask: &Ask, kind: &str) -> RiskLevel {
    let workspace = ask.roots.first().map(|p| p.to_string_lossy().into_owned());
    let workspace = workspace.as_deref();
    match kind {
        "execute" => match ask.command.map(str::trim).filter(|c| !c.is_empty()) {
            Some(command) => assess(&RiskInput { kind: "command_approval", command: Some(command), workspace, ..Default::default() }, &[]).level,
            None => RiskLevel::High,
        },
        _ => ask
            .paths
            .iter()
            .map(|path| {
                // A path in any root counts as inside (a copy of the project, or the project).
                let judged = ask.roots.iter().map(|root| assess(&RiskInput { kind: "file_edit", path: Some(path), workspace: Some(root.to_string_lossy().as_ref()), ..Default::default() }, &[]).level).min();
                judged.unwrap_or(RiskLevel::Medium)
            })
            .max()
            .unwrap_or(RiskLevel::Low),
    }
}

pub fn decide(ask: &Ask, offered: Offered) -> Verdict {
    let Some((option_id, _)) = offered.iter().find(|(_, kind)| *kind == "allow_once") else { return Verdict::Ask(Why::NoAllowOnce) };
    let kind = ask.kind.unwrap_or("");
    if !matches!(kind, "read" | "search" | "fetch" | "think" | "edit" | "execute") {
        return Verdict::Ask(Why::KindAlwaysAsks);
    }
    if looks_secret(ask) {
        return Verdict::Ask(Why::LooksSecret);
    }
    // An edit with no file named, or a command with no text, cannot be judged.
    if (kind == "edit" && ask.paths.is_empty()) || (kind == "execute" && ask.command.is_none_or(|c| c.trim().is_empty())) {
        return Verdict::Ask(Why::NothingToJudge);
    }
    let level = level_of(ask, kind);
    if level != RiskLevel::Low {
        return Verdict::Ask(Why::Risky(level));
    }
    Verdict::Allow { option_id: (*option_id).to_string() }
}
