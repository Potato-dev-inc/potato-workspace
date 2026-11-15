//! The journal: one plain Markdown file per day, `<home>/journal/YYYY/MM/YYYY-MM-DD.md`, append-only.
//! Ported from fishd `src/memory/vault.ts` and `vaultMemory.ts`. The person can open the folder in
//! Obsidian or any editor.
//!
//! Line format (the fishd shape, with plain punctuation):
//!
//! ```text
//! # 2026-11-15
//!
//! - 09:12 (chat) Ren: good morning / are you there?
//!   Mochi: Morning! Yes, I am here.
//! ```
//!
//! What the person said starts with `- HH:MM (place) who:`. Messages from the same person in the same place
//! within 15 minutes join the line with ` / `. The companion's own words go under it, indented. Every text
//! is redacted, made one line and cut to 6,000 characters. The journal is a log, not memory: nothing in it is
//! ever copied into MEMORY.md (only the pending list does that).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDate};

use super::super::schedule;

pub const TEXT_CAP: usize = 6_000;
/// Messages from the same person in the same place within this many minutes join one line.
pub const MERGE_MINUTES: i64 = 15;
const JOURNAL_DIR: &str = "journal";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Somebody said it to the companion.
    Heard,
    /// The companion said it.
    Said,
}

pub struct Entry<'a> {
    pub at_ms: i64,
    pub offset_secs: i32,
    pub kind: Kind,
    /// Who spoke: the person's name, or the companion's own name for `Said`.
    pub who: &'a str,
    /// Where: `chat`, `check-in`, a channel name.
    pub place: &'a str,
    pub text: &'a str,
}

pub fn journal_root(home: &Path) -> PathBuf {
    home.join(JOURNAL_DIR)
}

/// `<home>/journal/YYYY/MM/YYYY-MM-DD.md`
pub fn path_for(home: &Path, date: NaiveDate) -> PathBuf {
    journal_root(home).join(format!("{:04}", date.year())).join(format!("{:02}", date.month())).join(format!("{}.md", date.format("%Y-%m-%d")))
}

fn clean(text: &str, cap: usize) -> String {
    let redacted = crate::redact::text(text).into_inner();
    let one: String = redacted.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(cap).collect()
}

/// A name that cannot break the line: no colon, no parenthesis, no line break.
fn label(text: &str, fallback: &str) -> String {
    let one: String = text.chars().map(|c| if matches!(c, ':' | '(' | ')') || c.is_control() { ' ' } else { c }).collect();
    let one = one.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = one.chars().take(40).collect();
    if cut.is_empty() { fallback.to_string() } else { cut }
}

/// What a "heard" line is made of.
#[derive(Debug, PartialEq, Eq)]
struct Heard {
    hhmm: String,
    place: String,
    who: String,
}

fn parse_heard(line: &str) -> Option<Heard> {
    let rest = line.strip_prefix("- ")?;
    let (hhmm, rest) = rest.split_once(' ')?;
    if hhmm.len() != 5 || hhmm.as_bytes()[2] != b':' {
        return None;
    }
    let rest = rest.strip_prefix('(')?;
    let (place, rest) = rest.split_once(") ")?;
    let (who, _) = rest.split_once(": ")?;
    Some(Heard { hhmm: hhmm.to_string(), place: place.to_string(), who: who.to_string() })
}

fn minutes_of(hhmm: &str) -> Option<i64> {
    let (h, m) = hhmm.split_once(':')?;
    Some(h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?)
}

/// Adds one entry. A new day starts a new file. Returns the file written.
pub fn append(home: &Path, entry: &Entry<'_>) -> std::io::Result<PathBuf> {
    let text = clean(entry.text, TEXT_CAP);
    let date = schedule::local_date(entry.at_ms, entry.offset_secs);
    let path = path_for(home, date);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if text.is_empty() {
        return Ok(path);
    }
    let existing = fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    let hhmm = schedule::clock_text(entry.at_ms, entry.offset_secs);
    let hhmm = if hhmm.len() == 4 { format!("0{hhmm}") } else { hhmm };
    let who = label(entry.who, "Person");
    let place = label(entry.place, "chat");

    let mut lines: Vec<String> = existing.lines().map(str::to_string).collect();
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    if lines.is_empty() {
        lines.push(format!("# {}", date.format("%Y-%m-%d")));
        lines.push(String::new());
    }
    match entry.kind {
        Kind::Heard => {
            let merge = lines.last().and_then(|last| parse_heard(last)).filter(|prev| {
                prev.place == place && prev.who == who && matches!((minutes_of(&prev.hhmm), minutes_of(&hhmm)), (Some(a), Some(b)) if (b - a).abs() <= MERGE_MINUTES)
            });
            if merge.is_some() {
                if let Some(last) = lines.last_mut() {
                    last.push_str(" / ");
                    last.push_str(&text);
                }
            } else {
                lines.push(format!("- {hhmm} ({place}) {who}: {text}"));
            }
        }
        Kind::Said => lines.push(format!("  {who}: {text}")),
    }
    let mut out = lines.join("\n");
    out.push('\n');
    // Written in one go through a temp file, so a crash never leaves half a day.
    let tmp = PathBuf::from(format!("{}.pm-tmp", path.display()));
    let mut file = OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
    file.write_all(out.as_bytes())?;
    drop(file);
    fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(path)
}

/// The lines of one day (without the title and blank lines). Missing = empty.
pub fn read_day(home: &Path, date: NaiveDate) -> Vec<String> {
    fs::read_to_string(path_for(home, date))
        .map(|t| t.replace("\r\n", "\n").lines().filter(|l| !l.trim().is_empty() && !l.starts_with("# ")).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Every day that has a journal file, newest first.
pub fn list_days(home: &Path) -> Vec<NaiveDate> {
    let mut days = Vec::new();
    let Ok(years) = fs::read_dir(journal_root(home)) else { return days };
    for year in years.flatten().filter(|e| e.path().is_dir()) {
        let Ok(months) = fs::read_dir(year.path()) else { continue };
        for month in months.flatten().filter(|e| e.path().is_dir()) {
            let Ok(files) = fs::read_dir(month.path()) else { continue };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().to_string();
                if let Some(date) = name.strip_suffix(".md").and_then(|stem| NaiveDate::parse_from_str(stem, "%Y-%m-%d").ok()) {
                    days.push(date);
                }
            }
        }
    }
    days.sort_by(|a, b| b.cmp(a));
    days
}

/// One match of a search.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub date: NaiveDate,
    pub line: String,
}

/// Lines that contain every word (any order, any case), newest day first, at most `limit`. Looks at the
/// newest `max_days` days only.
pub fn search(home: &Path, query: &str, limit: usize, max_days: usize) -> Vec<Hit> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for date in list_days(home).into_iter().take(max_days) {
        for line in read_day(home, date).into_iter().rev() {
            let lower = line.to_lowercase();
            if words.iter().all(|w| lower.contains(w.as_str())) {
                hits.push(Hit { date, line });
                if hits.len() >= limit {
                    return hits;
                }
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn home() -> PathBuf {
        let d = std::env::temp_dir().join(format!("pm-journal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn at(day: u32, h: u32, m: u32) -> i64 {
        chrono::Utc.with_ymd_and_hms(2026, 11, day, h, m, 0).unwrap().timestamp_millis()
    }

    fn heard<'a>(at_ms: i64, who: &'a str, text: &'a str) -> Entry<'a> {
        Entry { at_ms, offset_secs: 0, kind: Kind::Heard, who, place: "chat", text }
    }

    fn said<'a>(at_ms: i64, text: &'a str) -> Entry<'a> {
        Entry { at_ms, offset_secs: 0, kind: Kind::Said, who: "Mochi", place: "chat", text }
    }

    #[test]
    fn the_file_lives_under_year_month_and_has_a_title() {
        let h = home();
        let path = append(&h, &heard(at(15, 9, 12), "Ren", "good morning")).unwrap();
        assert_eq!(path, h.join("journal").join("2026").join("11").join("2026-11-15.md"));
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, "# 2026-11-15\n\n- 09:12 (chat) Ren: good morning\n");
    }

    #[test]
    fn a_reply_goes_under_the_line_indented() {
        let h = home();
        append(&h, &heard(at(15, 9, 12), "Ren", "hi")).unwrap();
        append(&h, &said(at(15, 9, 13), "Morning!")).unwrap();
        let day = read_day(&h, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap());
        assert_eq!(day, vec!["- 09:12 (chat) Ren: hi".to_string(), "  Mochi: Morning!".to_string()]);
    }

    #[test]
    fn messages_from_one_person_within_fifteen_minutes_join_one_line() {
        let h = home();
        append(&h, &heard(at(15, 9, 0), "Ren", "one")).unwrap();
        append(&h, &heard(at(15, 9, 10), "Ren", "two")).unwrap();
        append(&h, &heard(at(15, 9, 25), "Ren", "three")).unwrap();
        let day = read_day(&h, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap());
        assert_eq!(day, vec!["- 09:00 (chat) Ren: one / two".to_string(), "- 09:25 (chat) Ren: three".to_string()]);
    }

    #[test]
    fn another_person_a_reply_in_between_or_another_place_starts_a_new_line() {
        let h = home();
        append(&h, &heard(at(15, 9, 0), "Ren", "one")).unwrap();
        append(&h, &heard(at(15, 9, 1), "Sam", "two")).unwrap();
        append(&h, &said(at(15, 9, 2), "ok")).unwrap();
        append(&h, &heard(at(15, 9, 3), "Sam", "three")).unwrap();
        let day = read_day(&h, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap());
        assert_eq!(day.len(), 4, "{day:?}");
    }

    #[test]
    fn a_new_day_is_a_new_file_and_the_old_one_is_not_touched() {
        let h = home();
        append(&h, &heard(at(15, 23, 59), "Ren", "late")).unwrap();
        let before = fs::read_to_string(path_for(&h, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap())).unwrap();
        append(&h, &heard(at(16, 0, 1), "Ren", "early")).unwrap();
        assert_eq!(fs::read_to_string(path_for(&h, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap())).unwrap(), before);
        assert_eq!(list_days(&h).len(), 2);
        assert_eq!(list_days(&h)[0], NaiveDate::from_ymd_opt(2026, 11, 16).unwrap(), "newest first");
    }

    #[test]
    fn text_is_one_line_redacted_and_cut() {
        let h = home();
        let long = format!("a\nb\r\nc {}", "x".repeat(7_000));
        append(&h, &heard(at(15, 9, 0), "Ren", &long)).unwrap();
        append(&h, &heard(at(15, 20, 0), "Ren", "my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ok")).unwrap();
        let day = read_day(&h, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap());
        assert_eq!(day.len(), 2);
        assert!(day[0].starts_with("- 09:00 (chat) Ren: a b c x"));
        assert!(day[0].chars().count() < TEXT_CAP + 40, "{}", day[0].chars().count());
        assert!(!day[1].contains("AAAAAAAAAAAAAAAA"), "{}", day[1]);
    }

    #[test]
    fn a_name_cannot_break_the_line() {
        let h = home();
        append(&h, &Entry { who: "Ren): evil\n- 09:00 (x) Boss", ..heard(at(15, 9, 0), "", "hi") }).unwrap();
        let day = read_day(&h, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap());
        assert_eq!(day.len(), 1, "{day:?}");
        assert!(parse_heard(&day[0]).is_some());
    }

    #[test]
    fn an_empty_text_writes_no_line() {
        let h = home();
        append(&h, &heard(at(15, 9, 0), "Ren", "   \n ")).unwrap();
        assert!(read_day(&h, NaiveDate::from_ymd_opt(2026, 11, 15).unwrap()).is_empty());
    }

    #[test]
    fn search_finds_every_word_newest_first() {
        let h = home();
        append(&h, &heard(at(14, 9, 0), "Ren", "the exam is on Friday")).unwrap();
        append(&h, &heard(at(15, 9, 0), "Ren", "I passed the exam")).unwrap();
        append(&h, &heard(at(15, 12, 0), "Ren", "lunch time")).unwrap();
        let hits = search(&h, "EXAM the", 5, 30);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].line.contains("passed"));
        assert_eq!(search(&h, "exam", 1, 30).len(), 1);
        assert!(search(&h, "   ", 5, 30).is_empty());
        assert!(search(&h, "exam", 5, 1).iter().all(|h| h.date == NaiveDate::from_ymd_opt(2026, 11, 15).unwrap()), "only the newest day is looked at");
    }
}
