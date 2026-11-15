//! The memory vault of a companion (P2 of the fishd port): plain Markdown files in its home folder that the
//! person can open in Obsidian or any editor.
//!
//! - `journal`: `journal/YYYY/MM/YYYY-MM-DD.md`, append-only, what was said
//! - `diary`: `diary/YYYY-MM-DD.md`, a short first-person entry per day
//! - `people`: `people/<name>.md`, a note per person (new notes go through the pending list)
//! - `checkpoint`: `sessions/<scope>/cp-NNN.md`, never overwritten, for a brain that holds its own chat
//!
//! The journal is a log, not memory: the only way something becomes a memory is still `memory/pending.md`.
//! Nothing here runs unless the Labs switch `companion_vault_enabled` is on.

pub mod checkpoint;
pub mod diary;
pub mod journal;
pub mod people;

use std::fs;
use std::path::Path;

use super::model::{DiaryView, JournalDay, JournalView, PersonView};
use super::persona;

/// The folders the vault uses, made when it is first on for a companion.
pub fn ensure_dirs(home: &Path) -> std::io::Result<()> {
    for dir in ["journal", "diary", "people"] {
        fs::create_dir_all(home.join(dir))?;
    }
    persona::ensure_files(home)
}

/// The folders (relative to a home) that belong to the vault: a home that moves takes them along.
pub const FOLDERS: [&str; 5] = ["journal", "diary", "people", "persona", "sessions"];

/// What `companion_journal` shows: the newest `days` days of the journal, the newest diary, who the companion
/// knows and which persona files exist.
pub fn view(home: &Path, days: usize) -> JournalView {
    let shown: Vec<JournalDay> = journal::list_days(home)
        .into_iter()
        .take(days)
        .map(|d| JournalDay { date: d.format("%Y-%m-%d").to_string(), lines: journal::read_day(home, d) })
        .filter(|d| !d.lines.is_empty())
        .collect();
    let persona_files = ["SOUL.md", persona::RULES_REL, persona::NOTES_REL]
        .into_iter()
        .filter(|rel| fs::metadata(home.join(rel)).is_ok_and(|m| m.len() > 0))
        .map(str::to_string)
        .collect();
    JournalView {
        days: shown,
        diary: diary::latest(home).map(|(date, text)| DiaryView { date: date.format("%Y-%m-%d").to_string(), text }),
        people: people::list(home).into_iter().map(|(name, closeness)| PersonView { name, closeness }).collect(),
        persona_files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_view_of_an_empty_home_is_empty_and_makes_nothing() {
        let h = std::env::temp_dir().join(format!("pm-vault-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&h).unwrap();
        let v = view(&h, 2);
        assert!(v.days.is_empty() && v.diary.is_none() && v.people.is_empty() && v.persona_files.is_empty());
        assert!(fs::read_dir(&h).unwrap().next().is_none(), "looking creates nothing");
    }

    #[test]
    fn ensure_dirs_makes_the_folders_and_the_two_persona_files() {
        let h = std::env::temp_dir().join(format!("pm-vault-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&h).unwrap();
        ensure_dirs(&h).unwrap();
        for dir in ["journal", "diary", "people", "persona"] {
            assert!(h.join(dir).is_dir(), "{dir}");
        }
        assert!(h.join(persona::RULES_REL).is_file() && h.join(persona::NOTES_REL).is_file());
        assert!(!h.join("sessions").exists(), "sessions is made by the first checkpoint");
    }
}
