//! Hidden runs: helpers that ran with no pane (a headless run), listed in the Inbox so a person can see
//! that they ran, what they were asked and how they ended. A visible helper is a pane in the sidebar and
//! needs no entry. `quick_ask` is hidden by design and never listed.
//!
//! The list lives in memory (a hidden run cannot outlive the app) and holds only where to look: the run's
//! project and handle. What a row shows (status, times) is read from the run itself each time, so it is
//! never stale. The person can dismiss a row; a running one comes back only if it is noted again.

use crate::operations::{self, OperationSnapshot, OperationStatus};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// How many hidden runs the list keeps (oldest leave first).
const KEEP: usize = 30;
/// A task longer than this is cut for the row.
const TASK_CHARS: usize = 140;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Noted {
    project: String,
    handle: String,
    agent_type: String,
    task: String,
    started_at_ms: u64,
}

static FEED: Mutex<Vec<Noted>> = Mutex::new(Vec::new());

/// One row of the Inbox list.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HiddenRunView {
    pub handle: String,
    pub agent_type: String,
    pub task: String,
    pub project: String,
    /// `running` | `needs_input` | `done` | `failed` | `cancelled`
    pub status: String,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
}

fn one_line(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= TASK_CHARS {
        return line;
    }
    let cut: String = line.chars().take(TASK_CHARS).collect();
    format!("{cut}…")
}

fn handle_of(snapshot: &OperationSnapshot) -> String {
    if snapshot.agent_run_id.is_empty() { snapshot.operation_id.clone() } else { snapshot.agent_run_id.clone() }
}

/// Lists a run that started with no pane. A second turn of the same handle only refreshes the row.
pub fn note_started(snapshot: &OperationSnapshot, app: Option<&AppHandle>) {
    let entry = Noted {
        project: snapshot.project_path.clone(),
        handle: handle_of(snapshot),
        agent_type: snapshot.agent_type.clone(),
        task: one_line(&snapshot.task),
        started_at_ms: snapshot.created_at_ms,
    };
    {
        let mut feed = FEED.lock();
        feed.retain(|known| known.handle != entry.handle);
        feed.push(entry);
        let extra = feed.len().saturating_sub(KEEP);
        feed.drain(..extra);
    }
    changed(app);
}

/// Takes a row off the list (the person dismissed it).
pub fn dismiss(handle: &str, app: Option<&AppHandle>) -> bool {
    let removed = {
        let mut feed = FEED.lock();
        let before = feed.len();
        feed.retain(|known| known.handle != handle);
        feed.len() != before
    };
    if removed {
        changed(app);
    }
    removed
}

fn changed(app: Option<&AppHandle>) {
    if let Some(app) = app {
        let _ = app.emit("hidden-runs://changed", ());
    }
}

fn status_word(status: OperationStatus) -> &'static str {
    match status {
        OperationStatus::Queued | OperationStatus::Starting | OperationStatus::Running | OperationStatus::Cancelling => "running",
        OperationStatus::WaitingInput => "needs_input",
        OperationStatus::Completed => "done",
        OperationStatus::Failed => "failed",
        OperationStatus::Cancelled => "cancelled",
    }
}

/// The listed runs, newest first, each with its status read from the run now.
pub fn list() -> Vec<HiddenRunView> {
    let feed: Vec<Noted> = FEED.lock().clone();
    let mut rows: Vec<HiddenRunView> = feed
        .into_iter()
        .map(|noted| {
            let latest = operations::latest_agent_run(&noted.project, &noted.handle).ok();
            let (status, finished) = match &latest {
                Some(run) => (
                    status_word(run.status).to_string(),
                    run.status.terminal().then_some(run.updated_at_ms),
                ),
                None => ("failed".to_string(), None),
            };
            HiddenRunView {
                handle: noted.handle,
                agent_type: noted.agent_type,
                task: noted.task,
                project: noted.project,
                status,
                started_at_ms: noted.started_at_ms,
                finished_at_ms: finished,
            }
        })
        .collect();
    rows.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
    rows
}

#[cfg(test)]
mod tests;
