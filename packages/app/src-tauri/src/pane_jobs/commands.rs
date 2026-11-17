//! Background tasks, the command part: every command that runs for a chat, from three sources joined by process id.
//!
//! 1. The process scan (`jobs_for_panes`): long-lived processes below an agent, with their ports. A command run for more
//!    than three seconds, or one that listens on a port, shows. A shorter one never makes a row (no flicker).
//! 2. The chat's own tool calls (`chat_commands`): the words the agent used, when a command started and how it ended. They
//!    name a row the scan found, add a row the scan cannot see (no process id: shown, not stoppable), and fill the
//!    finished list.
//! 3. Terminals the app hosts for an agent (`agent_terminals`): always listed, with their output.
//!
//! Every row is keyed by the pane of the agent that ran it (its "owner"). The screen shows a chat the rows of its own
//! agent and of every agent below it, each marked "by <name>" (`lib/pane-jobs.ts`, `rail/commandOwners.ts`).

use super::chat_commands::{calls_of, ChatCall};
use super::select::Job;
use super::{jobs_for_panes, now_ms, PaneRef};
use crate::agent_terminals::{self as terminals, State};
use serde::Serialize;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};

/// A command shorter than this never makes a row.
pub const MIN_ROW_MS: u64 = 3_000;
/// How many finished commands one owner lists.
pub const FINISHED_PER_OWNER: usize = 20;
/// A process belongs to a chat call when it started while the call was open: not before it (less this slack), and not after
/// it ended (plus this slack). The call is "seen" when the agent asks to run it, and a command waits for the person's yes
/// first, so the process can start long after the call did.
const MATCH_SLACK_MS: u64 = 2_000;
/// How many of a chat's last items are read for its commands.
const ITEMS_READ: usize = 400;

/// One running command. The `Job` fields (`pid`, `parentPid`, `name`, `command`, `startedAtMs`, `ports`) are the same as ever.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgJob {
    #[serde(flatten)]
    pub job: Job,
    /// `process`: found in the process tree. `terminal`: started with `start_terminal`. `chat`: seen in the chat only.
    pub source: &'static str,
    /// `test`, `build`, `dev`, `install`, `other`: the app turns it into a plain name.
    pub kind: &'static str,
    /// The name the agent gave (`start_terminal`'s `name`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// Stop can end it (it has a process id the app may stop, or it is a terminal).
    pub stoppable: bool,
}

/// One command that is over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    /// Stable per command: `terminal:<id>` or `call:<id>`.
    pub id: String,
    pub name: String,
    pub command: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    /// `done`, `failed` or `stopped`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// The person stopped it from the app, or its chat closed (an agent stopping its own command is "stopped" too).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_by: Option<String>,
}

fn short(text: &str) -> String {
    super::select::short_command(text, "command")
}

/// Joins process rows with chat calls: the nearest start within the window names the row.
///
/// `asking`: the chat waits for an answer to a question (the person's yes to run something). A call with no process yet is then
/// most likely the one that waits, and has not started: it shows no row until its process runs.
///
/// `seen`: calls that had a process row before. When that process is gone (stopped, or finished) and the call's result has not
/// come yet, the call shows no row of its own (it would only flicker as one nobody can stop).
pub fn join_process_rows(owner_calls: &[ChatCall], jobs: Vec<Job>, now: u64, asking: bool, seen: &HashSet<String>) -> Vec<BgJob> {
    let mut used: Vec<bool> = vec![false; owner_calls.len()];
    let mut rows: Vec<BgJob> = Vec::new();
    let mut jobs = jobs;
    jobs.sort_by_key(|j| (j.started_at_ms, j.pid));
    for job in jobs {
        // In order of start: the earliest call that still has no process and was open when this process started is its call
        // (processes start in the order their calls did).
        let nearest = owner_calls
            .iter()
            .enumerate()
            .filter(|(i, c)| !used[*i] && c.started_ms.saturating_sub(MATCH_SLACK_MS) <= job.started_at_ms && c.ended_ms.is_none_or(|ended| job.started_at_ms <= ended + MATCH_SLACK_MS))
            .min_by_key(|(_, c)| c.started_ms)
            .map(|(i, _)| i);
        let mut job = job;
        let mut call_id = None;
        if let Some(i) = nearest {
            used[i] = true;
            // The agent's own words are the command a person recognises (the process says `cmd /c ...`).
            job.command = short(&owner_calls[i].command);
            call_id = Some(owner_calls[i].call_id.clone());
        }
        let kind = terminals::kind_of(&job.command);
        rows.push(BgJob { job, source: "process", kind, title: None, terminal_id: None, call_id, stoppable: true });
    }
    // A running command the scan did not catch: show it once it has run long enough.
    for (i, call) in owner_calls.iter().enumerate() {
        if asking || used[i] || !call.is_running() || call.ran_ms(now) < MIN_ROW_MS || seen.contains(&call.call_id) {
            continue;
        }
        let command = short(&call.command);
        rows.push(BgJob {
            job: Job { pid: 0, parent_pid: 0, name: terminals::program_of(&call.command), command: command.clone(), started_at_ms: call.started_ms, ports: Vec::new() },
            source: "chat",
            kind: terminals::kind_of(&command),
            title: None,
            terminal_id: None,
            call_id: Some(call.call_id.clone()),
            stoppable: false,
        });
    }
    rows
}

/// The finished commands of one chat: calls that ran at least [`MIN_ROW_MS`], newest first.
pub fn finished_of_calls(calls: &[ChatCall]) -> Vec<Finished> {
    calls
        .iter()
        .filter(|c| !c.is_running())
        .filter_map(|c| {
            let ended = c.ended_ms?;
            if ended.saturating_sub(c.started_ms) < MIN_ROW_MS {
                return None;
            }
            let command = short(&c.command);
            Some(Finished {
                id: format!("call:{}", c.call_id),
                name: terminals::program_of(&c.command),
                kind: terminals::kind_of(&command),
                command,
                title: None,
                started_at_ms: c.started_ms,
                ended_at_ms: ended,
                state: if c.cut_short { "stopped" } else if c.ok == Some(true) { "done" } else { "failed" },
                exit_code: None,
                terminal_id: None,
                stopped_by: None,
            })
        })
        .collect()
}

/// Calls that had a process row at some look (most recent 400).
static SEEN: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

fn chat_calls(pane: &str) -> Vec<ChatCall> {
    crate::acp::chat::get(pane).map(|chat| calls_of(&chat.recent_items(ITEMS_READ))).unwrap_or_default()
}

/// Every running command, per owner pane.
pub fn background_all(panes: &[PaneRef]) -> HashMap<String, Vec<BgJob>> {
    let now = now_ms();
    let scanned = jobs_for_panes(panes);
    let mut out: HashMap<String, Vec<BgJob>> = HashMap::new();
    let mut scanned = scanned;
    for pane in panes {
        let jobs = scanned.remove(&pane.id).unwrap_or_default();
        let calls = if pane.chat_pid.is_some() || crate::acp::chat::get(&pane.id).is_some() { chat_calls(&pane.id) } else { Vec::new() };
        // Only calls that can still be running or that just ended take part in naming.
        let asking = crate::acp::chat::get(&pane.id).is_some_and(|chat| !chat.session().pending_permissions().is_empty());
        let rows = {
            let mut seen = SEEN.lock();
            let rows = join_process_rows(&calls, jobs, now, asking, &seen);
            seen.extend(rows.iter().filter(|r| r.source == "process").filter_map(|r| r.call_id.clone()));
            if seen.len() > 400 {
                seen.clear();
            }
            rows
        };
        if !rows.is_empty() {
            out.insert(pane.id.clone(), rows);
        }
    }
    for row in terminals::rows().into_iter().filter(|r| r.state == State::Running) {
        let ports = crate::pane_jobs::ports_below(row.pid);
        let name = if row.name.is_empty() { terminals::program_of(&row.command) } else { row.name.clone() };
        out.entry(row.owner.clone()).or_default().push(BgJob {
            kind: terminals::kind_of(&row.command),
            job: Job { pid: row.pid, parent_pid: 0, name, command: short(&row.command), started_at_ms: row.started_ms, ports },
            source: "terminal",
            title: (!row.name.is_empty()).then(|| row.name.clone()),
            terminal_id: Some(row.id),
            call_id: None,
            stoppable: true,
        });
    }
    for list in out.values_mut() {
        list.sort_by_key(|r| (r.job.started_at_ms, r.job.pid));
    }
    out
}

/// The last finished commands, per owner pane (newest first).
pub fn finished_all(panes: &[PaneRef]) -> HashMap<String, Vec<Finished>> {
    let mut out: HashMap<String, Vec<Finished>> = HashMap::new();
    for pane in panes {
        if crate::acp::chat::get(&pane.id).is_none() {
            continue;
        }
        let done = finished_of_calls(&chat_calls(&pane.id));
        if !done.is_empty() {
            out.insert(pane.id.clone(), done);
        }
    }
    for row in terminals::rows().into_iter().filter(|r| r.state != State::Running) {
        let command = short(&row.command);
        let ended = row.ended_ms.unwrap_or(row.started_ms);
        out.entry(row.owner.clone()).or_default().push(Finished {
            id: format!("terminal:{}", row.id),
            name: if row.name.is_empty() { terminals::program_of(&row.command) } else { row.name.clone() },
            kind: terminals::kind_of(&command),
            command,
            title: (!row.name.is_empty()).then(|| row.name.clone()),
            started_at_ms: row.started_ms,
            ended_at_ms: ended,
            state: match (row.state, row.exit_code) {
                (State::Stopped, _) => "stopped",
                (_, Some(0)) | (_, None) => "done",
                _ => "failed",
            },
            exit_code: row.exit_code,
            terminal_id: Some(row.id),
            stopped_by: row.stopped_by,
        });
    }
    for list in out.values_mut() {
        list.sort_by_key(|f| std::cmp::Reverse(f.ended_at_ms));
        list.truncate(FINISHED_PER_OWNER);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(pid: u32, started: u64, command: &str) -> Job {
        Job { pid, parent_pid: 1, name: "node".into(), command: command.into(), started_at_ms: started, ports: vec![] }
    }

    fn call(id: &str, started: u64, ended: Option<u64>, ok: Option<bool>, command: &str) -> ChatCall {
        ChatCall { call_id: id.into(), command: command.into(), started_ms: started, ended_ms: ended, ok, cut_short: false }
    }

    #[test]
    fn a_process_started_with_a_call_takes_its_words_and_is_listed_once() {
        let calls = [call("a", 100_000, None, None, "npm test")];
        let rows = join_process_rows(&calls, vec![job(7, 101_000, "cmd /c something odd")], 120_000, false, &HashSet::new());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].job.command, "npm test");
        assert_eq!(rows[0].kind, "test");
        assert_eq!(rows[0].call_id.as_deref(), Some("a"));
        assert!(rows[0].stoppable);
    }

    #[test]
    fn a_call_whose_process_is_gone_but_whose_result_has_not_come_shows_no_row() {
        let calls = [call("a", 100_000, None, None, "npm test")];
        let seen: HashSet<String> = ["a".to_string()].into();
        assert!(join_process_rows(&calls, vec![], 130_000, false, &seen).is_empty());
    }

    #[test]
    fn a_call_that_waits_for_the_persons_yes_shows_no_row_until_its_process_runs() {
        let calls = [call("a", 100_000, None, None, "npm test")];
        assert!(join_process_rows(&calls, vec![], 130_000, true, &HashSet::new()).is_empty(), "asking: it has not started");
        assert_eq!(join_process_rows(&calls, vec![], 130_000, false, &HashSet::new()).len(), 1, "not asking: it runs, the scan just cannot see it");
        // Once its process runs, the row is the process's, asking or not.
        assert_eq!(join_process_rows(&calls, vec![job(7, 125_000, "bash")], 130_000, true, &HashSet::new()).len(), 1);
    }

    #[test]
    fn a_process_that_starts_long_after_its_call_was_seen_still_belongs_to_it_while_the_call_is_open() {
        // The agent asked at 100 s; the person said yes, and the shell started at 146 s.
        let calls = [call("a", 100_000, None, None, "npm test")];
        let rows = join_process_rows(&calls, vec![job(7, 146_000, "bash")], 160_000, false, &HashSet::new());
        assert_eq!(rows.len(), 1, "one row, not a process row and a chat row for the same command");
        assert_eq!(rows[0].job.command, "npm test");
        assert_eq!(rows[0].source, "process");
        // A process that began before the call, or after it ended, is not its.
        let ended = [call("b", 100_000, Some(110_000), Some(true), "ls")];
        assert_eq!(join_process_rows(&ended, vec![job(8, 90_000, "x"), job(9, 120_000, "y")], 130_000, false, &HashSet::new()).iter().filter(|r| r.call_id.is_some()).count(), 0);
    }

    #[test]
    fn a_running_call_the_scan_missed_shows_after_three_seconds_and_is_not_stoppable() {
        let calls = [call("a", 100_000, None, None, "npm run build")];
        assert!(join_process_rows(&calls, vec![], 102_000, false, &HashSet::new()).is_empty(), "a two second command shows no row");
        let rows = join_process_rows(&calls, vec![], 103_500, false, &HashSet::new());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "chat");
        assert!(!rows[0].stoppable && rows[0].job.pid == 0);
        assert_eq!(rows[0].kind, "build");
    }

    #[test]
    fn two_commands_started_together_are_paired_one_to_one() {
        let calls = [call("a", 100_000, None, None, "npm test"), call("b", 100_500, None, None, "npm run dev")];
        let rows = join_process_rows(&calls, vec![job(1, 100_400, "x"), job(2, 100_900, "y")], 120_000, false, &HashSet::new());
        let by_pid: HashMap<u32, String> = rows.iter().map(|r| (r.job.pid, r.job.command.clone())).collect();
        assert_eq!(by_pid[&1], "npm test");
        assert_eq!(by_pid[&2], "npm run dev");
    }

    #[test]
    fn a_one_second_command_is_not_finished_work_to_list_but_a_long_one_is() {
        let calls = [call("a", 100_000, Some(101_000), Some(true), "ls"), call("b", 100_000, Some(112_000), Some(false), "npm test"), call("c", 100_000, Some(108_000), Some(true), "npm run build")];
        let done = finished_of_calls(&calls);
        assert_eq!(done.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["call:b", "call:c"]);
        assert_eq!(done[0].state, "failed");
        assert_eq!(done[1].state, "done");
    }
}
