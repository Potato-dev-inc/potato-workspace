//! Tauri commands for the Background card (`pane_jobs`): the commands agents left running (in panes, in chats, and
//! the terminals the app hosts for them), the finished ones, a way to stop one, and a terminal's output.

use super::*;
use crate::pane_jobs::{BgJob, Finished, Job, PaneRef};
use std::collections::HashMap;

fn pane_refs(state: &State<'_, AppState>, only: Option<&str>) -> Vec<PaneRef> {
    let listed: Vec<_> = state
        .registry
        .lock()
        .list()
        .into_iter()
        .filter(|p| only.is_none_or(|id| p.id == id))
        .map(|p| PaneRef { id: p.id, agent_type: p.agent_type, pid: p.pid, chat_pid: None })
        .collect();
    // A chat's adapter is asked for outside the registry lock (the chat has its own).
    listed.into_iter().map(|mut pane| {
        pane.chat_pid = crate::acp::chat::get(&pane.id).map(|_| crate::pty::pane_parent::chat_live_pid(&pane.id).unwrap_or(0)).filter(|pid| *pid != 0);
        pane
    }).collect()
}

/// The long-lived processes under one pane's agent (empty when there are none).
#[tauri::command(async)]
pub fn pane_jobs(state: State<'_, AppState>, pane_id: String) -> Vec<Job> {
    crate::pane_jobs::jobs_for_panes(&pane_refs(&state, Some(&pane_id))).remove(&pane_id).unwrap_or_default()
}

/// The commands of every pane that has any, keyed by the pane of the agent that ran them: processes in its tree,
/// commands its chat ran, and terminals it started.
#[tauri::command(async)]
pub fn pane_jobs_all(state: State<'_, AppState>) -> HashMap<String, Vec<BgJob>> {
    crate::pane_jobs::background_all(&pane_refs(&state, None))
}

/// The last finished commands per owner pane (newest first).
#[tauri::command(async)]
pub fn pane_jobs_finished(state: State<'_, AppState>) -> HashMap<String, Vec<Finished>> {
    crate::pane_jobs::finished_all(&pane_refs(&state, None))
}

/// Stop one job (and its tree). Refused unless `pid` is below that pane's process right now and started at
/// `started_at_ms` (the start time the card listed it with), so a reused process id is never stopped.
#[tauri::command(async)]
pub fn pane_job_stop(state: State<'_, AppState>, pane_id: String, pid: u32, started_at_ms: u64) -> Result<(), String> {
    let pane = pane_refs(&state, Some(&pane_id)).pop().ok_or("That pane is not open any more.")?;
    crate::pane_jobs::stop_job(&pane, pid, started_at_ms)
}

/// Stop a terminal an agent started (the whole tree). The agent finds out when it reads the terminal.
#[tauri::command(async)]
pub fn agent_terminal_stop(terminal_id: String) -> Result<(), String> {
    if crate::agent_terminals::manager().stop(&terminal_id, "the person") {
        Ok(())
    } else {
        Err("That command has already ended.".to_string())
    }
}

/// A terminal's last lines for the output view (read only). `after_cursor` asks for what came after a cursor from
/// the last call.
#[tauri::command(async)]
pub fn agent_terminal_output(terminal_id: String, after_cursor: Option<u64>) -> Result<serde_json::Value, String> {
    let term = crate::agent_terminals::manager().get(&terminal_id).ok_or("That terminal is not kept any more.")?;
    Ok(match after_cursor {
        Some(after) => crate::agent_terminals::read_view(&term, after, 500),
        None => {
            let tail = term.tail(crate::agent_terminals::DEFAULT_READ_LINES);
            let mut view = crate::agent_terminals::read_view(&term, tail.next_cursor, 1);
            view["lines"] = serde_json::json!(tail.lines);
            view["next_cursor"] = serde_json::json!(tail.next_cursor);
            view
        }
    })
}
