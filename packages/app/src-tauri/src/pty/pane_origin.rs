//! Who started a helper pane and what for: the calling host's name (from the MCP `initialize` -> `clientInfo.name`, as the
//! connection's own claim, only ever a label) and the first line of the task. Shown on the pane header as
//! "Started by Claude Code". Display-only, kept in memory for the life of the app, never used to decide anything.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const MAX_TASK_CHARS: usize = 140;
const MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct PaneOrigin {
    /// "Claude Code": the calling host, in plain words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The first line of the task, secrets removed, cut short.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

fn store() -> &'static Mutex<HashMap<String, PaneOrigin>> {
    static STORE: OnceLock<Mutex<HashMap<String, PaneOrigin>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The origin of a pane started by the MCP session `session` with `task`. Nothing is kept when neither part is known.
pub fn note(pane_id: &str, session: Option<&str>, task: &str) {
    let host = session.and_then(crate::mcp_sessions::session_client_name).map(|name| host_label(&name)).filter(|h| !h.is_empty());
    note_parts(pane_id, host, first_line(task));
}

pub(crate) fn note_parts(pane_id: &str, host: Option<String>, task: Option<String>) {
    if host.is_none() && task.is_none() {
        return;
    }
    let Ok(mut all) = store().lock() else { return };
    if all.len() >= MAX_ENTRIES && !all.contains_key(pane_id) {
        all.clear();
    }
    all.insert(pane_id.to_string(), PaneOrigin { host, task });
}

pub fn get(pane_id: &str) -> Option<PaneOrigin> {
    store().lock().ok()?.get(pane_id).cloned()
}

pub fn forget(pane_id: &str) {
    if let Ok(mut all) = store().lock() {
        all.remove(pane_id);
    }
}

/// The first non-empty line of a task, secrets removed, at most 140 characters.
pub(crate) fn first_line(task: &str) -> Option<String> {
    let clean = crate::redact::text(task).into_inner();
    let line = clean.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut text: String = line.chars().take(MAX_TASK_CHARS).collect();
    if line.chars().count() > MAX_TASK_CHARS {
        text.push('\u{2026}');
    }
    Some(text)
}

/// "claude-code" -> "Claude Code"; "codex-mcp-client" -> "Codex". The word `mcp` and a trailing `client` say nothing to a person.
pub(crate) fn host_label(client_name: &str) -> String {
    let words: Vec<String> = client_name
        .split(|c: char| matches!(c, '-' | '_' | ' ' | '.'))
        .filter(|w| !w.is_empty())
        .filter(|w| !w.eq_ignore_ascii_case("mcp"))
        .map(|w| {
            let mut chars = w.chars();
            chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
        })
        .collect();
    let mut words = words;
    if words.len() > 1 && words.last().is_some_and(|w| w.eq_ignore_ascii_case("client")) {
        words.pop();
    }
    words.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names_read_as_plain_words() {
        assert_eq!(host_label("claude-code"), "Claude Code");
        assert_eq!(host_label("codex-mcp-client"), "Codex");
        assert_eq!(host_label("cursor-vscode"), "Cursor Vscode");
        assert_eq!(host_label("Claude Code"), "Claude Code");
        assert_eq!(host_label("---"), "");
    }

    #[test]
    fn the_task_line_is_the_first_real_line_and_is_cut_short() {
        assert_eq!(first_line("\n\n  Fix the login bug  \nmore detail below").as_deref(), Some("Fix the login bug"));
        assert_eq!(first_line("   \n  "), None);
        let long = "x".repeat(300);
        let line = first_line(&long).unwrap();
        assert_eq!(line.chars().count(), MAX_TASK_CHARS + 1);
        assert!(line.ends_with('\u{2026}'));
    }

    #[test]
    fn a_noted_pane_is_read_back_and_a_pane_with_nothing_known_keeps_nothing() {
        note_parts("origin-test-1", Some("Claude Code".into()), Some("Review the diff".into()));
        let origin = get("origin-test-1").unwrap();
        assert_eq!((origin.host.as_deref(), origin.task.as_deref()), (Some("Claude Code"), Some("Review the diff")));
        note_parts("origin-test-2", None, None);
        assert_eq!(get("origin-test-2"), None);
        forget("origin-test-1");
        assert_eq!(get("origin-test-1"), None);
    }

    #[test]
    fn a_session_that_named_its_host_gives_a_started_by_label() {
        crate::mcp_sessions::note_session_client("sess-origin-1", "claude-code");
        note("origin-test-3", Some("sess-origin-1"), "Write the tests\nfor the parser");
        let origin = get("origin-test-3").unwrap();
        assert_eq!(origin.host.as_deref(), Some("Claude Code"));
        assert_eq!(origin.task.as_deref(), Some("Write the tests"));
        forget("origin-test-3");
    }
}
