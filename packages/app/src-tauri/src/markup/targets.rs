//! The "send to" list of the mark-up bar: the agents that are running, in plain words. Used by the app's bar (the
//! `markup_targets` command) and by the bar in the agent browser (`live.rs`). Names come from the agent registry; nothing
//! here looks at an agent's name. No pane id is ever shown: it is only the key a click sends with.

use crate::point::target::{self, TargetFacts};
use crate::pty::PaneInfo;
use serde::Serialize;

/// One running agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// The key a click sends with (never drawn).
    pub id: String,
    /// The agent's id, for its brand icon.
    pub agent_id: String,
    /// The agent's name ("Claude").
    pub name: String,
    /// What it works on (the chat's title); empty when it only repeats the name.
    pub task: String,
    /// The last folder of its project.
    pub project: String,
    /// `working`, `waiting`, `idle` or `stopped`.
    pub status: &'static str,
    /// False when it cannot take a message now; `reason` says why.
    pub ok: bool,
    pub reason: Option<String>,
}

/// The last folder name of a path ("D:\\work\\shop" -> "shop").
pub fn project_name(cwd: &str) -> String {
    cwd.trim().trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

pub fn status_word(status: &str) -> &'static str {
    match status {
        "running" => "working",
        "waiting_input" => "waiting",
        "error" => "stopped",
        _ => "idle",
    }
}

/// The pane whose project folder keeps the picture of a window nobody owns: the first agent that can take a message,
/// else the first one in the list. None only when no agent is running.
pub fn keeper(list: &[target::Target]) -> Option<String> {
    list.iter().find(|t| t.can_send).or_else(|| list.first()).map(|t| t.pane_id.clone())
}

/// The rows (the page's own agent first, then the same folder, then the newest) and the one to preselect.
pub fn rows(facts: &[TargetFacts], infos: &[PaneInfo], owner: Option<&str>) -> (Vec<Row>, Option<String>) {
    let (list, default) = target::targets(facts, owner, None);
    let rows = list
        .into_iter()
        .map(|t| {
            let info = infos.iter().find(|p| p.id == t.pane_id);
            let task = if t.title.trim().is_empty() || t.title == t.agent_label { String::new() } else { t.title.clone() };
            Row {
                agent_id: info.map(|p| p.agent_type.clone()).unwrap_or_default(),
                project: info.map(|p| project_name(&p.cwd)).unwrap_or_default(),
                status: info.map(|p| status_word(&p.status)).unwrap_or("idle"),
                id: t.pane_id,
                name: t.agent_label,
                task,
                ok: t.can_send,
                reason: t.reason,
            }
        })
        .collect();
    (rows, default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, can_send: bool) -> target::Target {
        target::Target { pane_id: id.to_string(), agent_label: "A".to_string(), title: String::new(), same_folder: false, can_send, chat: true, reason: None }
    }

    #[test]
    fn a_window_nobody_owns_still_keeps_its_picture_with_the_first_agent_that_can_take_it() {
        // `target::targets` itself names no default here (no opener, no folder): the picture used to be lost.
        assert_eq!(keeper(&[row("p1", false), row("p2", true), row("p3", true)]).as_deref(), Some("p2"));
        assert_eq!(keeper(&[row("p1", false)]).as_deref(), Some("p1"));
        assert_eq!(keeper(&[]), None);
    }

    #[test]
    fn project_is_the_last_folder() {
        assert_eq!(project_name("D:\\work\\shop\\"), "shop");
        assert_eq!(project_name("/home/a/site"), "site");
        assert_eq!(project_name(""), "");
    }

    #[test]
    fn status_words_are_plain() {
        assert_eq!(status_word("running"), "working");
        assert_eq!(status_word("waiting_input"), "waiting");
        assert_eq!(status_word("idle"), "idle");
        assert_eq!(status_word("error"), "stopped");
    }
}
