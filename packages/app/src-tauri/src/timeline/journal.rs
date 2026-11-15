//! The day journal: one small append-only file per day, `timeline/<YYYY-MM-DD>.jsonl`, with one row
//! for every save point that was really created. It is only an index of the Today page: the save
//! points themselves stay in each project's shadow store. Local only; never sent to the team relay.

use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{Datelike, Local, NaiveDate, TimeZone};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::checkpoints::Checkpoint;

/// Day files older than this many days are removed.
pub const KEEP_DAYS: i64 = 14;

/// One writer at a time, process-wide: two chats ending a turn together must not interleave a line.
static WRITER: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// One save point on the line.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Row {
    pub at_ms: u64,
    /// The folder the save point is of (the chat's folder when it was taken).
    pub project: String,
    /// The series (`refs/pm/<key>/<id>`): a chat's pane key, `day`, `mission-<id>` or `wb-<id>`.
    pub key: String,
    pub id: String,
    pub tree: String,
    pub kind: String,
    pub turn: u32,
    pub files: u32,
    pub added: u32,
    pub deleted: u32,
    /// Only for the icon. No code matches on it.
    pub agent_type: String,
    pub chat_id: String,
    pub chat_title: String,
    /// The start of the prompt.
    pub note: String,
    pub via_phone: bool,
}

/// Who took the save point, for the row.
#[derive(Debug, Clone, Default)]
pub struct Who {
    pub agent_type: String,
    pub chat_title: String,
    pub via_phone: bool,
}

impl Row {
    pub fn from_checkpoint(project: &str, key: &str, c: &Checkpoint, who: &Who) -> Row {
        Row {
            at_ms: c.at_ms,
            project: project.to_string(),
            key: key.to_string(),
            id: c.id.clone(),
            tree: c.tree.clone(),
            kind: c.kind.clone(),
            turn: c.turn,
            files: c.files,
            added: c.added,
            deleted: c.deleted,
            agent_type: who.agent_type.clone(),
            chat_id: key.to_string(),
            chat_title: who.chat_title.chars().take(80).collect(),
            note: c.note.chars().take(120).collect(),
            via_phone: who.via_phone,
        }
    }

    /// Mission and "What broke it" steps are helpers' own: the Today page hides them by default.
    pub fn is_helper(&self) -> bool {
        self.key.starts_with("mission-") || self.key.starts_with("wb-")
    }
}

/// `YYYY-MM-DD` in the computer's own time zone for a time in milliseconds.
pub fn date_of(ms: u64) -> String {
    match Local.timestamp_millis_opt(ms as i64).single() {
        Some(t) => format!("{:04}-{:02}-{:02}", t.year(), t.month(), t.day()),
        None => "1970-01-01".to_string(),
    }
}

/// A date string that is exactly `YYYY-MM-DD` and a real day. Nothing else may name a file.
pub fn valid_date(date: &str) -> bool {
    date.len() == 10 && NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
}

/// A folder spelled for comparing: forward slashes, no trailing slash, lower case on Windows paths.
pub fn folder_key(path: &str) -> String {
    let slashed = path.trim().replace('\\', "/");
    let trimmed = slashed.trim_end_matches('/');
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    let windows = trimmed.as_bytes().get(1) == Some(&b':') || trimmed.starts_with("//");
    if windows {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// The folder `child` is `parent` itself or sits inside it.
pub fn same_or_inside(child: &str, parent: &str) -> bool {
    let (c, p) = (folder_key(child), folder_key(parent));
    c == p || c.strip_prefix(&p).is_some_and(|rest| p.ends_with('/') || rest.starts_with('/'))
}

#[derive(Debug, Clone)]
pub struct Journal {
    dir: PathBuf,
}

impl Journal {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The journal in the app's data folder.
    pub fn live() -> Self {
        Self::new(crate::app_paths::app_data_dir().join("timeline"))
    }

    fn file(&self, date: &str) -> PathBuf {
        self.dir.join(format!("{date}.jsonl"))
    }

    /// Add one row to the day of its time. Errors are returned for the caller to ignore: a journal
    /// that cannot be written must never break a save point.
    pub fn append(&self, row: &Row) -> std::io::Result<()> {
        let mut line = serde_json::to_string(row).map_err(std::io::Error::other)?;
        line.push('\n');
        let _one_writer = WRITER.lock();
        std::fs::create_dir_all(&self.dir)?;
        let path = self.file(&date_of(row.at_ms));
        let is_new_day = !path.exists();
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(line.as_bytes())?;
        if is_new_day {
            self.cleanup(&date_of(row.at_ms));
        }
        Ok(())
    }

    /// Rows of one day, oldest first. A damaged line is skipped. An unknown or bad date: nothing.
    pub fn read_day(&self, date: &str) -> Vec<Row> {
        if !valid_date(date) {
            return Vec::new();
        }
        let Ok(bytes) = std::fs::read(self.file(date)) else { return Vec::new() };
        let mut rows: Vec<Row> = String::from_utf8_lossy(&bytes).lines().filter_map(|l| serde_json::from_str(l.trim()).ok()).collect();
        rows.sort_by_key(|r| r.at_ms);
        rows
    }

    /// Remove day files more than `KEEP_DAYS` before `today`. Returns how many went.
    pub fn cleanup(&self, today: &str) -> usize {
        let Ok(today) = NaiveDate::parse_from_str(today, "%Y-%m-%d") else { return 0 };
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return 0 };
        let mut removed = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(date) = name.strip_suffix(".jsonl").and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()) else { continue };
            if (today - date).num_days() > KEEP_DAYS && std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    /// The dates (newest first) of the last `KEEP_DAYS` days up to `today` that have a file.
    pub fn recent_dates(&self, today: &str) -> Vec<String> {
        let Ok(today) = NaiveDate::parse_from_str(today, "%Y-%m-%d") else { return Vec::new() };
        let mut dates: Vec<NaiveDate> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.strip_suffix(".jsonl").and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            })
            .filter(|d| (today - *d).num_days() <= KEEP_DAYS && *d <= today)
            .collect();
        dates.sort_by(|a, b| b.cmp(a));
        dates.into_iter().map(|d| d.format("%Y-%m-%d").to_string()).collect()
    }

    /// Whether `project` is a folder that appears in a row of the last `KEEP_DAYS` days. The only way
    /// a request may name a folder.
    pub fn knows_project(&self, project: &str, today: &str) -> bool {
        let want = folder_key(project);
        !want.is_empty() && self.recent_dates(today).iter().any(|date| self.read_day(date).iter().any(|r| folder_key(&r.project) == want))
    }

    /// The folder's own spelling (as journaled), when `project` is a known folder.
    pub fn known_spelling(&self, project: &str, today: &str) -> Option<String> {
        let want = folder_key(project);
        self.recent_dates(today)
            .iter()
            .flat_map(|date| self.read_day(date))
            .find(|r| folder_key(&r.project) == want)
            .map(|r| r.project)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}
