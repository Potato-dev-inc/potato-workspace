//! Background tasks the person put in the sidebar ("Show in sidebar", or a drag from the Background tasks rows).
//!
//! A task is a minion (an agent's small worker) or a command an agent left running. Putting one in the sidebar does not
//! change who owns it: it still stops with its agent, and its questions still go where they went. This module keeps only
//! WHERE each one is shown, so the desktop and the phone read one list:
//!
//! - `under: Some(pane)` the row is nested under that agent's row; `None`: it sits on its own at the top level.
//! - The list order is the order of the rows among their siblings.
//!
//! Saved in `task-sidebar.json` in the app data folder (not in the browser's storage, so the phone sees the same rows).
//! A task id is stable for the task's life: `minion:<pane_id>`, `terminal:<terminal_id>`, `job:<pane_id>:<pid>:<started_ms>`.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Most rows kept; the oldest go first.
pub const MAX_ROWS: usize = 60;
const NAME_MAX: usize = 120;
const COMMAND_MAX: usize = 400;

/// One task shown in the sidebar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    pub task_id: String,
    /// `minion` or `command`.
    pub kind: String,
    /// The agent that owns the task (its pane id). Never changes when the row moves; a hand-over changes it.
    pub owner: String,
    /// The agent row it is nested under. `None`: on its own.
    #[serde(default)]
    pub under: Option<String>,
    /// The shown name, kept so a finished command can still be drawn.
    pub name: String,
    /// A command's full line (a tooltip only).
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Store {
    pub rows: Vec<Placement>,
}

fn clean(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

/// A task id this module accepts.
pub fn valid_task_id(id: &str) -> bool {
    id.len() <= 200 && ["minion:", "terminal:", "job:"].iter().any(|p| id.strip_prefix(p).is_some_and(|rest| !rest.trim().is_empty()))
}

impl Store {
    /// Puts a task in the sidebar (or moves it when it is there already). It goes last among its siblings.
    pub fn show(&mut self, mut row: Placement) -> Result<(), String> {
        if !valid_task_id(&row.task_id) || !matches!(row.kind.as_str(), "minion" | "command") {
            return Err("That task cannot be shown in the sidebar.".into());
        }
        row.name = clean(&row.name, NAME_MAX);
        row.command = row.command.as_deref().map(|c| clean(c, COMMAND_MAX)).filter(|c| !c.is_empty());
        if row.under.as_deref().is_some_and(str::is_empty) {
            row.under = None;
        }
        if let Some(at) = self.rows.iter().position(|r| r.task_id == row.task_id) {
            self.rows[at] = row;
        } else {
            self.rows.push(row);
        }
        while self.rows.len() > MAX_ROWS {
            self.rows.remove(0);
        }
        Ok(())
    }

    /// Nests the row under `under`, or (`None`) sets it on its own. False when the task is not in the sidebar.
    pub fn place(&mut self, task_id: &str, under: Option<&str>) -> bool {
        let Some(row) = self.rows.iter_mut().find(|r| r.task_id == task_id) else { return false };
        row.under = under.filter(|u| !u.is_empty()).map(str::to_string);
        true
    }

    /// Puts the rows in a new order: `order` lists task ids; ones not listed keep their relative place at the end.
    pub fn reorder(&mut self, order: &[String]) {
        let mut next: Vec<Placement> = Vec::with_capacity(self.rows.len());
        for id in order {
            if let Some(at) = self.rows.iter().position(|r| &r.task_id == id) {
                next.push(self.rows.remove(at));
            }
        }
        next.append(&mut self.rows);
        self.rows = next;
    }

    /// "Back to Background tasks": the row goes, the task keeps running. True when there was one.
    pub fn remove(&mut self, task_id: &str) -> bool {
        let before = self.rows.len();
        self.rows.retain(|r| r.task_id != task_id);
        self.rows.len() != before
    }

    /// A hand-over moved a task to another agent: its owner changes, and it is nested under the new owner when it was
    /// nested under the old one. A task shown on its own stays on its own.
    pub fn hand_to(&mut self, task_id: &str, new_owner: &str) -> bool {
        let Some(row) = self.rows.iter_mut().find(|r| r.task_id == task_id) else { return false };
        let nested_under_owner = row.under.as_deref() == Some(row.owner.as_str());
        row.owner = new_owner.to_string();
        if nested_under_owner {
            row.under = Some(new_owner.to_string());
        }
        true
    }

    /// Drops the rows of agents that are gone (`live` says whether a pane is still open): a row nested under a closed
    /// agent is set on its own, a row whose OWNER is closed goes (the task stopped with its agent).
    pub fn prune(&mut self, live: impl Fn(&str) -> bool) -> bool {
        let before = self.clone();
        self.rows.retain(|r| live(&r.owner));
        for row in &mut self.rows {
            if row.under.as_deref().is_some_and(|u| !live(u)) {
                row.under = None;
            }
        }
        *self != before
    }
}

/// The list on disk.
pub struct File {
    path: PathBuf,
    store: Mutex<Store>,
}

impl File {
    pub fn at(path: PathBuf) -> Self {
        let store = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Store>(&t).ok()).unwrap_or_default();
        Self { path, store: Mutex::new(store) }
    }

    pub fn snapshot(&self) -> Store {
        self.store.lock().clone()
    }

    /// Changes the list and saves it. Nothing changes when `change` refuses or the file cannot be written.
    pub fn edit<T>(&self, change: impl FnOnce(&mut Store) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.store.lock();
        let mut next = guard.clone();
        let out = change(&mut next)?;
        if next != *guard {
            save(&self.path, &next)?;
            *guard = next;
        }
        Ok(out)
    }
}

fn save(path: &Path, store: &Store) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

static FILE: Lazy<File> = Lazy::new(|| File::at(crate::app_paths::app_data_dir().join("task-sidebar.json")));

/// The app's list.
pub fn file() -> &'static File {
    &FILE
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
