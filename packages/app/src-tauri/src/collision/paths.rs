//! Collision Alert: the same file written by two chats, wherever it lives (SPEC-n33 addition).
//!
//! The git watch (`engine`, `probe`) only sees a folder that belongs to a repo, and only a change that
//! is not committed. A file outside any repo (a note, a scratch file) was never seen, so two agents that
//! overwrote one file got no heads-up. This reads what the chats themselves report: a finished edit or
//! write tool call names the file. The same absolute path written by two panes within `PATH_WINDOW_MS`
//! is a `SameFile` finding for that pair. Pure: items in, findings out. Nothing is read from disk.

use std::collections::{BTreeMap, BTreeSet};

use super::alerts::Finding;
use super::model::{FileOverlap, How, Level, PaneFact, PaneRun, Relation, SideFacts};
use crate::session_chat::ChatItem;

/// Two writes of one file by two panes count when both are this recent.
pub const PATH_WINDOW_MS: u64 = 10 * 60_000;
/// How often the watch thread reads the chats for this.
pub const PATH_LOOK_MS: u64 = 5_000;

/// One write: the comparable path, its short name for the screen, and when the call was seen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Write {
    pub key: String,
    pub name: String,
    pub at_ms: u64,
}

fn is_absolute(path: &str) -> bool {
    path.starts_with('/') || path.starts_with("\\\\") || path.as_bytes().get(1) == Some(&b':')
}

/// The comparable form of a path: forward slashes, no trailing slash, relative paths joined to the pane's folder,
/// lower case where the file system ignores case. `None`: a relative path with no folder to join, or control characters.
pub fn key_of(path: &str, cwd: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() || path.chars().any(|c| c.is_control() || matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
        return None;
    }
    let joined = if is_absolute(path) {
        path.to_string()
    } else if cwd.trim().is_empty() {
        return None;
    } else {
        format!("{}/{}", cwd.trim_end_matches(['/', '\\']), path.trim_start_matches("./").trim_start_matches(".\\"))
    };
    let mut key = joined.replace('\\', "/");
    while key.len() > 1 && key.ends_with('/') {
        key.pop();
    }
    Some(if cfg!(windows) { key.to_lowercase() } else { key })
}

/// The finished writes among a chat's recent items.
pub fn writes_of(items: &[ChatItem], cwd: &str) -> Vec<Write> {
    let mut out = Vec::new();
    for item in items {
        let ChatItem::ToolCall { at, detail, .. } = item else { continue };
        if !detail.writes {
            continue;
        }
        let Some(at_ms) = crate::pane_jobs::chat_commands::parse_at(at) else { continue };
        for path in &detail.paths {
            if let Some(key) = key_of(path, cwd) {
                let name = path.trim().rsplit(['/', '\\']).next().unwrap_or_default().to_string();
                out.push(Write { key, name, at_ms });
            }
        }
    }
    out
}

/// One `SameFile` finding for each pair of panes that wrote one file within the window.
pub fn findings(panes: &[(PaneFact, Vec<Write>)], now: u64) -> Vec<Finding> {
    let recent = |w: &&Write| now.saturating_sub(w.at_ms) <= PATH_WINDOW_MS;
    let mut out = Vec::new();
    for (i, (a, wa)) in panes.iter().enumerate() {
        for (b, wb) in &panes[i + 1..] {
            if a.pane_id == b.pane_id {
                continue;
            }
            let mut shared: BTreeMap<&str, &str> = BTreeMap::new();
            for x in wa.iter().filter(recent) {
                if wb.iter().filter(recent).any(|y| y.key == x.key) {
                    shared.insert(x.key.as_str(), x.name.as_str());
                }
            }
            if shared.is_empty() {
                continue;
            }
            let side = |p: &PaneFact, w: &[Write]| SideFacts {
                pane_id: p.pane_id.clone(),
                working: p.run == PaneRun::Working,
                files: w.iter().filter(recent).map(|x| x.key.as_str()).collect::<BTreeSet<_>>().len() as u32,
                started_ms: p.created_ms,
            };
            out.push(Finding {
                relation: Relation::SameFolder,
                level: Level::SameFile,
                panes: [a.clone(), b.clone()],
                sides: [side(a, wa), side(b, wb)],
                files: shared.values().map(|name| FileOverlap { path: (*name).to_string(), how: How::Shared }).collect(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str) -> PaneFact {
        PaneFact { pane_id: id.into(), agent_id: "fake".into(), label: id.into(), cwd: "D:\\work".into(), run: PaneRun::Working, created_ms: 1 }
    }
    fn w(path: &str, at_ms: u64) -> Write {
        Write { key: key_of(path, "D:\\work").unwrap(), name: path.rsplit(['/', '\\']).next().unwrap().into(), at_ms }
    }

    #[test]
    fn the_same_file_by_two_panes_16_s_apart_is_a_finding_outside_any_repo() {
        let now = 1_000_000;
        let panes = vec![(pane("a"), vec![w("D:\\work\\shared.txt", now - 30_000)]), (pane("b"), vec![w("d:/work/shared.txt", now - 14_000)])];
        let found = findings(&panes, now);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].level, Level::SameFile);
        assert_eq!(found[0].files[0].path, "shared.txt");
    }

    #[test]
    fn an_old_write_a_different_file_or_one_pane_alone_is_nothing() {
        let now = 10_000_000;
        let old = vec![(pane("a"), vec![w("D:\\x\\f.txt", now - PATH_WINDOW_MS - 1)]), (pane("b"), vec![w("D:\\x\\f.txt", now)])];
        assert!(findings(&old, now).is_empty());
        let other = vec![(pane("a"), vec![w("D:\\x\\f.txt", now)]), (pane("b"), vec![w("D:\\x\\g.txt", now)])];
        assert!(findings(&other, now).is_empty());
        let alone = vec![(pane("a"), vec![w("D:\\x\\f.txt", now), w("D:\\x\\f.txt", now)])];
        assert!(findings(&alone, now).is_empty());
    }

    #[test]
    fn a_relative_path_joins_the_folder_of_its_pane() {
        assert_eq!(key_of("sub\\f.txt", "D:\\work\\"), key_of("D:/work/sub/f.txt", ""));
        assert_eq!(key_of("f.txt", ""), None);
        assert_eq!(key_of("a\u{202e}b.txt", "D:\\w"), None);
    }
}
