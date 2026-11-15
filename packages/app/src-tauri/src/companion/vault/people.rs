//! People: one Markdown note per person the companion knows, `<home>/people/<slug>.md`. Ported from fishd
//! `src/persona/people.ts` and `vaultMemory.ts` (`person`, `setPerson`).
//!
//! ```text
//! ---
//! name: "Ren"
//! closeness: 50
//! warmth: 50
//! grudge_until: ""
//! impression: "likes short answers"
//! ---
//! # Ren
//!
//! ## Habits
//! ## Ongoing
//! ## Shared jokes
//! ## Notes
//! ```
//!
//! A new or changed note goes through the pending list: the companion writes `- person: Ren: likes tea` in
//! `memory/pending.md`, and only the person's Keep (`memory::decide`) calls `add_note`. The display name is
//! data, never trusted: it is cut, stripped of control characters and quotes, and the file name is a slug.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub const NAME_CAP: usize = 40;
pub const NOTE_CAP: usize = 300;
pub const MAX_NOTES: usize = 30;
const DIR: &str = "people";

#[derive(Clone, Debug, PartialEq)]
pub struct Person {
    pub name: String,
    pub closeness: u8,
    pub warmth: u8,
    pub grudge_until: String,
    pub impression: String,
    pub habits: Vec<String>,
    pub ongoing: Vec<String>,
    pub jokes: Vec<String>,
    pub notes: Vec<String>,
}

impl Person {
    pub fn new(name: &str) -> Person {
        Person {
            name: clean_name(name),
            closeness: 50,
            warmth: 50,
            grudge_until: String::new(),
            impression: String::new(),
            habits: Vec::new(),
            ongoing: Vec::new(),
            jokes: Vec::new(),
            notes: Vec::new(),
        }
    }
}

pub fn people_dir(home: &Path) -> PathBuf {
    home.join(DIR)
}

/// A name that is safe as data: no control characters, no quotes, one line, at most `NAME_CAP` characters.
pub fn clean_name(name: &str) -> String {
    let one: String = name.chars().map(|c| if c.is_control() || c == '"' || c == '\\' { ' ' } else { c }).collect();
    one.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(NAME_CAP).collect()
}

/// The file name of a person: lower-case ASCII letters and digits with dashes; a name with none gets a
/// short hash, so two non-Latin names do not share a file.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in clean_name(name).chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let base: String = out.trim_matches('-').chars().take(24).collect();
    let non_latin = clean_name(name).chars().any(|c| !c.is_ascii());
    if base.is_empty() || non_latin {
        let hash: String = Sha256::digest(clean_name(name).to_lowercase().as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect();
        return if base.is_empty() { format!("p-{hash}") } else { format!("{}-{hash}", base.trim_end_matches('-')) };
    }
    base
}

pub fn path_for(home: &Path, name: &str) -> PathBuf {
    people_dir(home).join(format!("{}.md", slug(name)))
}

fn field(front: &str, key: &str) -> String {
    for line in front.lines() {
        if let Some(rest) = line.strip_prefix(key).and_then(|r| r.strip_prefix(':')) {
            let v = rest.trim();
            return match v.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
                Some(inner) => inner.replace("\\\"", "\"").replace("\\\\", "\\"),
                None => v.to_string(),
            };
        }
    }
    String::new()
}

fn level(front: &str, key: &str) -> u8 {
    field(front, key).parse::<f64>().ok().filter(|n| n.is_finite()).map_or(50, |n| n.round().clamp(0.0, 100.0) as u8)
}

fn section(body: &str, heading: &str) -> Vec<String> {
    let mut on = false;
    let mut out = Vec::new();
    for line in body.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            on = h.trim().eq_ignore_ascii_case(heading);
        } else if on {
            if let Some(item) = line.trim().strip_prefix("- ") {
                if !item.trim().is_empty() {
                    out.push(item.trim().to_string());
                }
            }
        }
    }
    out
}

/// Reads a person file. Anything that is not our shape is `None`.
pub fn parse(text: &str) -> Option<Person> {
    let text = text.replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n")?;
    let (front, body) = rest.split_once("\n---")?;
    let name = clean_name(&field(front, "name"));
    if name.is_empty() {
        return None;
    }
    Some(Person {
        name,
        closeness: level(front, "closeness"),
        warmth: level(front, "warmth"),
        grudge_until: field(front, "grudge_until"),
        impression: field(front, "impression").chars().take(NOTE_CAP).collect(),
        habits: section(body, "Habits"),
        ongoing: section(body, "Ongoing"),
        jokes: section(body, "Shared jokes"),
        notes: section(body, "Notes"),
    })
}

fn quote(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The file text of a person.
pub fn render(p: &Person) -> String {
    let list = |title: &str, items: &[String]| {
        let mut s = format!("## {title}\n");
        for item in items {
            s.push_str(&format!("- {item}\n"));
        }
        s.push('\n');
        s
    };
    format!(
        "---\nname: {}\ncloseness: {}\nwarmth: {}\ngrudge_until: {}\nimpression: {}\n---\n# {}\n\n{}{}{}{}",
        quote(&p.name),
        p.closeness,
        p.warmth,
        quote(&p.grudge_until),
        quote(&p.impression),
        p.name,
        list("Habits", &p.habits),
        list("Ongoing", &p.ongoing),
        list("Shared jokes", &p.jokes),
        list("Notes", &p.notes)
    )
}

pub fn read(home: &Path, name: &str) -> Option<Person> {
    parse(&fs::read_to_string(path_for(home, name)).ok()?)
}

/// Everyone the companion knows: name and closeness, closest first.
pub fn list(home: &Path) -> Vec<(String, u8)> {
    let mut out: Vec<(String, u8)> = fs::read_dir(people_dir(home))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| parse(&fs::read_to_string(e.path()).ok()?))
        .map(|p| (p.name, p.closeness))
        .collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

/// A pending line's text, `Name: note`, split into the two parts. Both must have something in them.
pub fn split_pending(text: &str) -> Option<(String, String)> {
    let (name, note) = text.split_once(':')?;
    let name = clean_name(name);
    let note: String = note.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(NOTE_CAP).collect();
    (!name.is_empty() && !note.is_empty()).then_some((name, note))
}

/// Adds a note to the person (the file is made when it is new). The same note twice is kept once. Only the
/// newest `MAX_NOTES` stay. Returns the path relative to the home folder.
pub fn add_note(home: &Path, name: &str, note: &str) -> std::io::Result<String> {
    let mut person = read(home, name).unwrap_or_else(|| Person::new(name));
    let note: String = note.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(NOTE_CAP).collect();
    if !note.is_empty() && !person.notes.iter().any(|n| n == &note) {
        person.notes.push(note);
        let over = person.notes.len().saturating_sub(MAX_NOTES);
        person.notes.drain(..over);
    }
    fs::create_dir_all(people_dir(home))?;
    let path = path_for(home, name);
    let tmp = PathBuf::from(format!("{}.pm-tmp", path.display()));
    fs::write(&tmp, render(&person))?;
    fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(format!("{DIR}/{}.md", slug(name)))
}

#[allow(dead_code)]
fn warmth_band(n: u8) -> &'static str {
    match n {
        80..=100 => "very warm",
        60..=79 => "warm",
        40..=59 => "normal",
        20..=39 => "a little cold",
        _ => "angry",
    }
}

/// The part of a person note that goes into a prompt: two or three things, never the whole file.
#[allow(dead_code)] // the bot brain (P3) puts it in its tip
pub fn brief_line(p: &Person, now_ms: i64) -> String {
    let mut bits: Vec<String> = Vec::new();
    let tail = |v: &[String], n: usize| v[v.len().saturating_sub(n)..].join("; ");
    if !p.habits.is_empty() {
        bits.push(format!("habits: {}", tail(&p.habits, 2)));
    }
    if !p.ongoing.is_empty() {
        bits.push(format!("open things: {}", tail(&p.ongoing, 2)));
    }
    if let Some(joke) = p.jokes.last() {
        bits.push(format!("you laughed about \"{joke}\""));
    }
    let grudge = chrono::DateTime::parse_from_rfc3339(&p.grudge_until).ok().map(|d| d.timestamp_millis());
    if grudge.is_some_and(|g| g > now_ms) {
        bits.push("you are still a little upset with them".to_string());
    } else {
        bits.push(format!("you feel {} toward them", warmth_band(p.warmth)));
    }
    format!("About {}: {}.", p.name, bits.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        let d = std::env::temp_dir().join(format!("pm-people-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_note_makes_the_file_and_it_reads_back() {
        let h = home();
        let rel = add_note(&h, "Ren", "likes short answers").unwrap();
        assert_eq!(rel, "people/ren.md");
        let p = read(&h, "Ren").unwrap();
        assert_eq!((p.name.as_str(), p.closeness, p.warmth), ("Ren", 50, 50));
        assert_eq!(p.notes, vec!["likes short answers".to_string()]);
        let raw = fs::read_to_string(h.join(&rel)).unwrap();
        assert!(raw.starts_with("---\nname: \"Ren\"\n") && raw.contains("## Notes\n- likes short answers\n"), "{raw}");
    }

    #[test]
    fn the_same_note_twice_is_kept_once_and_only_thirty_stay() {
        let h = home();
        add_note(&h, "Ren", "a").unwrap();
        add_note(&h, "Ren", "a").unwrap();
        assert_eq!(read(&h, "Ren").unwrap().notes.len(), 1);
        for i in 0..40 {
            add_note(&h, "Ren", &format!("n{i}")).unwrap();
        }
        let notes = read(&h, "Ren").unwrap().notes;
        assert_eq!(notes.len(), MAX_NOTES);
        assert_eq!(notes.last().unwrap(), "n39");
    }

    #[test]
    fn a_person_file_the_person_edited_keeps_its_other_fields() {
        let h = home();
        add_note(&h, "Ren", "first").unwrap();
        let mut p = read(&h, "Ren").unwrap();
        p.closeness = 80;
        p.impression = "kind, \"quiet\"".into();
        p.habits.push("tea at four".into());
        fs::write(path_for(&h, "Ren"), render(&p)).unwrap();
        add_note(&h, "Ren", "second").unwrap();
        let again = read(&h, "Ren").unwrap();
        assert_eq!((again.closeness, again.impression.as_str()), (80, "kind, \"quiet\""));
        assert_eq!(again.habits, vec!["tea at four".to_string()]);
        assert_eq!(again.notes.len(), 2);
    }

    #[test]
    fn names_are_data_not_paths() {
        assert_eq!(slug("Ren"), "ren");
        assert_eq!(slug("Mr. Sam  Lee"), "mr-sam-lee");
        let s = slug("../../etc/passwd");
        assert!(!s.contains('/') && !s.contains('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "{s}");
        assert_ne!(slug("小明"), slug("小華"), "two non-Latin names are two files");
        assert!(slug("小明").starts_with("p-"));
        let evil = clean_name("Ren\"\n---\nname: Boss");
        assert!(!evil.contains('\n') && !evil.contains('"'), "{evil}");
        assert_eq!(clean_name(&"x".repeat(100)).chars().count(), NAME_CAP);
    }

    #[test]
    fn a_name_with_a_quote_cannot_break_the_front_matter() {
        let h = home();
        add_note(&h, "Ren\"; closeness: 100", "hi").unwrap();
        let list = list(&h);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].1, 50, "the closeness line in the name did not count");
    }

    #[test]
    fn a_pending_text_splits_into_a_name_and_a_note() {
        assert_eq!(split_pending("Ren: likes tea"), Some(("Ren".into(), "likes tea".into())));
        assert_eq!(split_pending("Ren: a: b"), Some(("Ren".into(), "a: b".into())));
        assert_eq!(split_pending("no colon"), None);
        assert_eq!(split_pending(": no name"), None);
        assert_eq!(split_pending("Ren:   "), None);
    }

    #[test]
    fn the_list_is_closest_first_and_skips_files_that_are_not_ours() {
        let h = home();
        add_note(&h, "Ann", "x").unwrap();
        add_note(&h, "Ben", "x").unwrap();
        let mut ben = read(&h, "Ben").unwrap();
        ben.closeness = 90;
        fs::write(path_for(&h, "Ben"), render(&ben)).unwrap();
        fs::write(people_dir(&h).join("junk.md"), "just text").unwrap();
        assert_eq!(list(&h), vec![("Ben".to_string(), 90), ("Ann".to_string(), 50)]);
    }

    #[test]
    fn the_brief_line_is_short_and_uses_a_grudge_while_it_lasts() {
        let mut p = Person::new("Ren");
        p.habits = vec!["tea".into(), "walks".into(), "late nights".into()];
        p.jokes = vec!["the sock".into()];
        let line = brief_line(&p, 0);
        assert!(line.starts_with("About Ren: habits: walks; late nights"), "{line}");
        assert!(line.contains("you feel normal toward them"), "{line}");
        p.grudge_until = "2999-01-01T00:00:00Z".into();
        assert!(brief_line(&p, 0).contains("still a little upset"));
    }
}
