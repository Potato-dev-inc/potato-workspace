//! The Today page's backend: a whole-day line of save points across every chat and project, and a
//! way to go back to one of them. The files are already captured at every turn edge by
//! `checkpoints/`; this module adds the day journal (an index), the read-only views and one write
//! (go back), and checks that every request names a folder that is on the line.
//! See `docs/features/time-machine.md`.

pub mod http;
pub mod journal;
#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::checkpoints::day::{self, NowDiff};
use crate::checkpoints::{CheckpointError, FileChange, RestoreReport, Runtime};
pub use journal::{Journal, Row, Who};

/// Why a Today call was refused.
#[derive(Debug, Clone)]
pub enum TimelineError {
    /// The folder is not in any journal row of the last 14 days. Nothing may name another folder.
    NotOnLine,
    BadDate,
    Checkpoint(CheckpointError),
}

impl From<CheckpointError> for TimelineError {
    fn from(e: CheckpointError) -> Self {
        Self::Checkpoint(e)
    }
}

impl std::fmt::Display for TimelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotOnLine => f.write_str("That folder is not on today's line."),
            Self::BadDate => f.write_str("That is not a date."),
            Self::Checkpoint(e) => e.fmt(f),
        }
    }
}

/// A row as the page gets it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowView {
    #[serde(flatten)]
    pub row: Row,
    /// The save point is gone (cleaned up, or the folder is): it is drawn faded.
    pub gone: bool,
    /// A mission or "What broke it" step: hidden unless the page shows helpers' steps.
    pub helper: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    pub project: String,
    pub name: String,
    pub folder_gone: bool,
    /// Oldest first.
    pub rows: Vec<RowView>,
    pub last_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayView {
    pub date: String,
    pub today: String,
    pub now_ms: u64,
    /// Newest activity first.
    pub lanes: Vec<Lane>,
    /// The days (newest first, up to 14 back) that have a journal file.
    pub dates: Vec<String>,
}

/// The last part of a folder path, for the lane label.
pub fn folder_name(project: &str) -> String {
    let key = project.trim().replace('\\', "/");
    key.trim_end_matches('/').rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or(project).to_string()
}

fn journal_of(rt: &Runtime) -> Journal {
    rt.journal().unwrap_or_else(Journal::live)
}

/// One day of the line. The only git work is one cheap listing of refs per folder with activity.
pub fn day_view(rt: &Runtime, date: &str) -> Result<DayView, TimelineError> {
    if !journal::valid_date(date) {
        return Err(TimelineError::BadDate);
    }
    let journal = journal_of(rt);
    let now_ms = rt.now_ms();
    let today = journal::date_of(now_ms);
    let rows = journal.read_day(date);
    let mut by_project: Vec<(String, Vec<Row>)> = Vec::new();
    for row in rows {
        let key = journal::folder_key(&row.project);
        match by_project.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(row),
            None => by_project.push((key, vec![row])),
        }
    }
    let mut lanes: Vec<Lane> = by_project
        .into_iter()
        .map(|(_, rows)| {
            let project = rows[0].project.clone();
            let folder_gone = !Path::new(&project).is_dir();
            let alive: HashSet<(String, String)> = if folder_gone { HashSet::new() } else { day::existing_points(Path::new(&project)).unwrap_or_default() };
            let last_ms = rows.iter().map(|r| r.at_ms).max().unwrap_or(0);
            let rows = rows
                .into_iter()
                .map(|row| {
                    let gone = folder_gone || !alive.contains(&(row.key.clone(), row.id.clone()));
                    let helper = row.is_helper();
                    RowView { row, gone, helper }
                })
                .collect();
            Lane { name: folder_name(&project), project, folder_gone, rows, last_ms }
        })
        .collect();
    lanes.sort_by(|a, b| b.last_ms.cmp(&a.last_ms));
    Ok(DayView { date: date.to_string(), dates: journal.recent_dates(&today), today, now_ms, lanes })
}

/// The folder's own spelling when it is on the line, else `NotOnLine`.
fn on_line(rt: &Runtime, project: &str) -> Result<String, TimelineError> {
    let today = journal::date_of(rt.now_ms());
    journal_of(rt).known_spelling(project, &today).ok_or(TimelineError::NotOnLine)
}

pub fn point_diff(rt: &Runtime, project: &str, key: &str, id: &str) -> Result<Vec<FileChange>, TimelineError> {
    let project = on_line(rt, project)?;
    Ok(day::point_diff(Path::new(&project), key, id)?)
}

pub fn now_diff(rt: &Runtime, project: &str, key: &str, id: &str) -> Result<NowDiff, TimelineError> {
    let project = on_line(rt, project)?;
    Ok(day::now_diff(Path::new(&project), key, id, &rt.day_limits())?)
}

/// A file's patch: `side` `"turn"` (what the turn did) or `"now"` (what going back would do).
pub fn file_patch(rt: &Runtime, project: &str, key: &str, id: &str, path: &str, side: &str) -> Result<(String, bool), TimelineError> {
    let project = on_line(rt, project)?;
    let project = Path::new(&project);
    Ok(if side == "now" { day::now_patch(project, key, id, path, &rt.day_limits())? } else { day::point_patch(project, key, id, path)? })
}

/// Put one folder back to a point. Refused while any chat in the folder works.
pub fn go_back(rt: &Runtime, project: &str, key: &str, id: &str) -> Result<RestoreReport, TimelineError> {
    let project = on_line(rt, project)?;
    Ok(rt.go_back(Path::new(&project), key, id)?)
}

/// A mission or "What broke it" save point is on the line too (as a helper's own step). Best effort.
pub fn note_helper_point(project: &Path, key: &str, c: &crate::checkpoints::Checkpoint) {
    // Tests of other modules take mission and What-broke-it points: they must not write the real journal.
    if cfg!(test) {
        return;
    }
    let row = Row::from_checkpoint(&project.to_string_lossy(), key, c, &Who::default());
    if let Err(e) = Journal::live().append(&row) {
        tracing::warn!(error = %e, "day journal row not written");
    }
}
