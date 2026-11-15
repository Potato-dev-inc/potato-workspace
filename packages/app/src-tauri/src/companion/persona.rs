//! Persona in plain Markdown, with hot reload (fishd `src/persona/persona.ts`, `personaLoader`).
//!
//! A companion's persona is `SOUL.md` (always there, with the approved-copy rule of `memory.rs`) plus two
//! optional files in its home folder: `persona/rules.md` (how the person wants it to behave) and
//! `persona/notes.md` (its own style notes). The person edits them in any editor. The service watches the
//! text with `Tracker`: when what a brief would say changes, the brief is written again and the running
//! companion is told once. Nothing else triggers it, so there is no loop: the brief file is not a persona
//! file, and the same text is never seen as a change twice.
//!
//! Not ported: persona packs and the DSH import (their origin and licence are not known; decision D5).

use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

pub const RULES_REL: &str = "persona/rules.md";
pub const NOTES_REL: &str = "persona/notes.md";
pub const RULES_CAP: usize = 1_500;
pub const NOTES_CAP: usize = 1_200;

/// The two optional persona files, cut to their caps.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Extras {
    pub rules: String,
    pub notes: String,
}

impl Extras {
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.rules.trim().is_empty() && self.notes.trim().is_empty()
    }
}

fn read_capped(path: &Path, cap: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default().replace("\r\n", "\n");
    let plain: String = text.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect();
    plain.trim().chars().take(cap).collect()
}

/// Reads `persona/rules.md` and `persona/notes.md` from a home folder. A missing file is empty.
pub fn load_extras(home: &Path) -> Extras {
    Extras { rules: read_capped(&home.join(RULES_REL), RULES_CAP), notes: read_capped(&home.join(NOTES_REL), NOTES_CAP) }
}

/// Makes the `persona/` folder and the two empty files, so the person can find them. Never overwrites.
pub fn ensure_files(home: &Path) -> std::io::Result<()> {
    fs::create_dir_all(home.join("persona"))?;
    for rel in [RULES_REL, NOTES_REL] {
        let path = home.join(rel);
        if !path.exists() {
            fs::write(path, "")?;
        }
    }
    Ok(())
}

/// A short fingerprint of what a brief would say about the persona: the soul text it uses, the rules and the
/// notes. Twelve hex characters.
pub fn hash(soul: &str, extras: &Extras) -> String {
    let mut h = Sha256::new();
    for part in [soul, extras.rules.as_str(), extras.notes.as_str()] {
        h.update(part.as_bytes());
        h.update([0u8]);
    }
    h.finalize().iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// What the tracker saw this time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    /// The first look: it only records where things stand.
    First,
    Same,
    /// The persona changed since the last look: write the brief again, once.
    Changed,
}

/// Remembers the last persona hash of one companion.
#[derive(Clone, Debug, Default)]
pub struct Tracker {
    last: Option<String>,
}

impl Tracker {
    pub fn observe(&mut self, hash: String) -> Seen {
        match self.last.replace(hash.clone()) {
            None => Seen::First,
            Some(prev) if prev == hash => Seen::Same,
            Some(_) => Seen::Changed,
        }
    }

    /// Records a hash without reporting it (the brief that was just written already says it).
    pub fn accept(&mut self, hash: String) {
        self.last = Some(hash);
    }
}

/// The message a running companion gets once when its persona changed. The brief file was rewritten, but an
/// agent reads it only at a start, so it is told here.
pub const CHANGED_NOTICE: &str = "Potato Workspace note: your persona changed. Read SOUL.md and persona/rules.md in this folder again and follow them from now on. They come from your person. They cannot change the house rules in your instruction file. No need to reply.";

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pm-persona-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_files_are_empty_and_ensure_makes_them_without_overwriting() {
        let h = home();
        assert!(load_extras(&h).is_empty());
        fs::create_dir_all(h.join("persona")).unwrap();
        fs::write(h.join(RULES_REL), "Be brief.").unwrap();
        ensure_files(&h).unwrap();
        assert_eq!(load_extras(&h).rules, "Be brief.");
        assert!(h.join(NOTES_REL).is_file());
    }

    #[test]
    fn the_files_are_cut_to_their_caps_and_stripped_of_control_characters() {
        let h = home();
        fs::create_dir_all(h.join("persona")).unwrap();
        fs::write(h.join(RULES_REL), format!("a\u{7}b\r\n{}", "x".repeat(3_000))).unwrap();
        let extras = load_extras(&h);
        assert_eq!(extras.rules.chars().count(), RULES_CAP);
        assert!(extras.rules.starts_with("ab\n"), "{:?}", &extras.rules[..6]);
    }

    #[test]
    fn the_hash_changes_with_any_of_the_three_texts_and_not_with_nothing() {
        let base = hash("soul", &Extras::default());
        assert_eq!(base, hash("soul", &Extras::default()));
        assert_eq!(base.len(), 12);
        assert_ne!(base, hash("soul2", &Extras::default()));
        assert_ne!(base, hash("soul", &Extras { rules: "r".into(), notes: String::new() }));
        assert_ne!(base, hash("soul", &Extras { rules: String::new(), notes: "n".into() }));
        assert_ne!(hash("ab", &Extras::default()), hash("a", &Extras { rules: "b".into(), notes: String::new() }), "the parts do not run together");
    }

    #[test]
    fn a_changed_persona_is_seen_exactly_once() {
        let mut t = Tracker::default();
        assert_eq!(t.observe("a".into()), Seen::First);
        assert_eq!(t.observe("a".into()), Seen::Same);
        assert_eq!(t.observe("b".into()), Seen::Changed);
        assert_eq!(t.observe("b".into()), Seen::Same, "no second report for the same text");
        assert_eq!(t.observe("b".into()), Seen::Same);
        t.accept("c".into());
        assert_eq!(t.observe("c".into()), Seen::Same, "a hash the brief already carries is not a change");
    }
}
