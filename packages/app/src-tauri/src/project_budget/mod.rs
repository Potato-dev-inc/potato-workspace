//! A budget for each project: how much a project may use in one day, next to the budgets of single agent runs
//! (`crate::budgets`). Off by default; a project with no limits is never held back.
//!
//! - Limits: turns a day, agent minutes a day, and optionally a share of the plan (percent) the agent's plan may
//!   have used. Each is optional.
//! - Counting: a turn counts when it starts, its minutes when it ends. The day is the local calendar day; at
//!   midnight the counters start again. Nothing is sent anywhere.
//! - When a limit is reached the NEXT turn of a chat in that project does not start (the chat says why and the
//!   banner offers "Raise" / "Wait until tomorrow"). A turn that is running always finishes.
//!
//! `store` keeps the limits and the day's counters in one small file; `gate` decides; this file is the live
//! entry points the chat and the commands call.

mod gate;
mod store;
#[cfg(test)]
mod tests;

pub use gate::{Reached, Status};
#[cfg(test)]
use gate::judge;
pub use store::{Limits, Store};

use once_cell::sync::Lazy;

pub const FILE_NAME: &str = "project-budgets.json";
pub const MAX_TURNS: u32 = 10_000;
pub const MAX_MINUTES: u32 = 24 * 60;

static STORE: Lazy<Store> = Lazy::new(|| {
    if cfg!(test) {
        Store::in_memory()
    } else {
        Store::at(&crate::app_paths::app_data_dir().join(FILE_NAME))
    }
});

/// A project as a key (same spelling rules as the project's pins and fences).
pub fn key_of(project: &str) -> String {
    crate::project_path::comparable_project_path(std::path::Path::new(project))
}

pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// The highest "used" percent of the plan windows of this agent's sign-ins, from the last usage reading. `None`
/// when nothing is known (nothing is read or fetched here).
pub fn plan_percent_of(agent_id: &str) -> Option<f64> {
    let snapshot = crate::usage::cached()?;
    snapshot
        .rows
        .iter()
        .filter(|row| row.agent_id == agent_id)
        .flat_map(|row| row.windows.iter().map(|w| w.used_percent))
        .fold(None, |best: Option<f64>, p| Some(best.map_or(p, |b| b.max(p))))
}

pub fn limits(project: &str) -> Limits {
    STORE.limits(&key_of(project))
}

pub fn set_limits(project: &str, limits: Limits) {
    STORE.set_limits(&key_of(project), limits.clamped());
}

/// Where the project stands today. `plan_percent` is the agent's plan use, when known.
pub fn status(project: &str, plan_percent: Option<f64>) -> Status {
    STORE.status(&key_of(project), &today(), plan_percent)
}

/// A turn starts in the project.
pub fn note_turn_started(project: &str) {
    STORE.add_turn(&key_of(project), &today());
}

/// A turn ended after `ms` milliseconds.
pub fn note_turn_ended(project: &str, ms: u64) {
    STORE.add_ms(&key_of(project), &today(), ms);
}

/// "Raise": gives the reached limits more room (see `raise_step`). Returns the new status.
pub fn raise(project: &str, plan_percent: Option<f64>) -> Status {
    let key = key_of(project);
    STORE.raise(&key, &today(), plan_percent);
    STORE.status(&key, &today(), plan_percent)
}

/// The plain sentence for a project that has used up its day (the chat line and the refused send), `None` while it
/// may start turns.
pub fn sentence(status: &Status) -> Option<String> {
    let reached = status.reached?;
    let what = match reached {
        Reached::Turns => format!("{} turns", status.limits.turns_per_day.unwrap_or(0)),
        Reached::Minutes => format!("{} minutes of agent time", status.limits.minutes_per_day.unwrap_or(0)),
        Reached::Plan => format!("{}% of the plan", status.limits.plan_percent.unwrap_or(0)),
    };
    Some(format!("Project budget reached: {what} for today. New turns in this project wait until tomorrow, unless you raise the limit."))
}
