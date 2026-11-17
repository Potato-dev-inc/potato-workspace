//! "Background jobs": the long-lived child processes any agent left running inside a pane (a dev
//! server, a watcher, a test runner, a background shell), with a short command, how long they have
//! run, the port they listen on, and a way to stop one. Agent-agnostic: it reads the pane's process
//! tree, never an agent's name (a profile may declare its own helper processes, `TuiProfile::
//! helper_processes`).
//!
//! Cost model: nothing runs until the UI asks (every 3 s while the card or the count chip is on
//! screen). One Toolhelp snapshot serves every pane; the OS is asked about start time and command
//! line only for processes below a pane's agent, and for the listening-port table only when one
//! of them is old enough to count. No watcher thread, no child process.
//!
//! Stopping is by pid and re-checked at the moment of the stop: the pid must be below that pane's
//! process now and must have the start time the job was listed with, so a reused pid is refused
//! (`select::authorize_stop`). Never by image name, never by port.

mod chat_commands;
mod commands;
mod select;
mod sys;

#[cfg(test)]
mod tests;

pub use commands::{background_all, finished_all, BgJob, Finished};
pub use select::Job;

use crate::pty::agent_proc::{agent_pid_in, snapshot, ProcEntry};
use select::{authorize_stop, descendant_pids, select as select_jobs, Row};
use std::collections::HashMap;

/// What the module needs to know about a pane.
#[derive(Debug, Clone)]
pub struct PaneRef {
    pub id: String,
    pub agent_type: String,
    /// The pane's own process (`PaneInfo::pid`).
    pub pid: u32,
    /// A chat pane (ACP): its adapter process as it is now. Everything the agent runs sits below the agent process the
    /// adapter started, so those processes (its direct children) play the part of "the agent" for the jobs below them.
    pub chat_pid: Option<u32>,
}

/// The jobs of every pane that has any, from one process snapshot.
pub fn jobs_for_panes(panes: &[PaneRef]) -> HashMap<String, Vec<Job>> {
    let Some(procs) = snapshot() else { return HashMap::new() };
    let mut ports: Option<HashMap<u32, Vec<u16>>> = None;
    let now = sys::now_unix_ms();
    let mut out = HashMap::new();
    for pane in panes.iter().filter(|p| p.pid != 0 || p.chat_pid.is_some()) {
        let profile = crate::tui::profile_for(&pane.agent_type);
        let mut jobs: Vec<Job> = Vec::new();
        // The agent processes whose tree is scanned, each with its own start (what it started at launch is its plumbing).
        let agents: Vec<(Vec<u32>, Option<(u32, Option<u64>)>)> = match pane.chat_pid {
            Some(adapter) => procs
                .iter()
                .filter(|p| p.parent == adapter && p.pid != adapter)
                .map(|p| (vec![p.pid], Some((p.pid, sys::details(p.pid).started_ms))))
                .collect(),
            None => {
                let agent = agent_pid_in(&pane.id, pane.pid, &procs);
                let mut seeds = vec![pane.pid];
                seeds.extend(agent);
                vec![(seeds, agent.map(|pid| (pid, sys::details(pid).started_ms)))]
            }
        };
        for (seeds, agent_start) in agents {
            let below = descendant_pids(&procs, &seeds);
            if below.is_empty() {
                continue;
            }
            let rows: Vec<Row> = below
                .iter()
                .filter_map(|pid| procs.iter().find(|p| p.pid == *pid))
                .map(|p| row_of(p, sys::details(p.pid)))
                .collect();
            let ports = ports.get_or_insert_with(sys::listening_ports);
            jobs.extend(select_jobs(&rows, ports, agent_start, profile.helper_processes(), now));
        }
        if !jobs.is_empty() {
            jobs.sort_by_key(|j| (j.started_at_ms, j.pid));
            out.insert(pane.id.clone(), jobs);
        }
    }
    out
}

/// The TCP ports `pid` and everything under it listen on right now, ascending.
pub fn ports_below(pid: u32) -> Vec<u16> {
    if pid == 0 {
        return Vec::new();
    }
    let Some(procs) = snapshot() else { return Vec::new() };
    let mut family = descendant_pids(&procs, &[pid]);
    family.push(pid);
    let table = sys::listening_ports();
    let mut found: Vec<u16> = family.iter().flat_map(|p| table.get(p).into_iter().flatten().copied()).collect();
    found.sort_unstable();
    found.dedup();
    found
}

pub(crate) fn now_ms() -> u64 {
    sys::now_unix_ms()
}

fn row_of(entry: &ProcEntry, details: sys::Details) -> Row {
    // Redact first, then shorten: a cut must not leave half a secret behind.
    let command = crate::redact::text(&details.command).into_inner();
    Row { pid: entry.pid, parent: entry.parent, image: entry.image.clone(), started_ms: details.started_ms, command }
}

/// Stop the job `pid` of `pane` and everything under it, after checking that it is still below
/// that pane's process and still the process the person saw: `started_at_ms` is the start time
/// the job was listed with (`Job::started_at_ms`), and a pid the system gave to a new process
/// since has another one.
pub fn stop_job(pane: &PaneRef, pid: u32, started_at_ms: u64) -> Result<(), String> {
    let procs = snapshot().ok_or("Jobs cannot be listed on this system.")?;
    let (root, agent) = match pane.chat_pid {
        Some(adapter) => (adapter, None),
        None => (pane.pid, agent_pid_in(&pane.id, pane.pid, &procs)),
    };
    let started_now = sys::details(pid).started_ms;
    authorize_stop(&procs, root, agent, pid, started_at_ms, started_now).map_err(|why| why.message().to_string())?;
    crate::pty::proc_tree::kill_process_tree(pid);
    Ok(())
}

/// The pids below `pid` in a process table (not `pid` itself).
#[cfg(test)]
pub(crate) fn descendants_of(procs: &[ProcEntry], pid: u32) -> Vec<u32> {
    descendant_pids(procs, &[pid])
}
