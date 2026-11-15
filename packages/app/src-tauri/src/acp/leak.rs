//! Tool-server children an agent's shared server keeps after a chat ends.
//!
//! OpenCode (2.x) can run one long-lived `opencode serve --service` that every `opencode acp` talks to. The
//! tool servers of a session (our own `puppet-master-mcp`, the person's other ones) are started by that
//! server, so they are NOT under our adapter's process tree, and `session/close` answers `{}` without ending
//! them. Ending the adapter's tree (`job.rs`) therefore leaves them running.
//!
//! What this module does, and the only thing it ends:
//! * Every session of an agent that lists `shared_server_images` gets a marker, `pmacp.<app pid>.<random>`. It is
//!   passed to OUR tool server as one extra argument, `--pm-session=<marker>` (the server ignores it), so it shows
//!   in that process's command line. Nothing but this app writes it.
//! * When the session closes, and when the app starts, processes whose command line carries that marker AND whose
//!   parent chain leads to one of the agent's shared-server images are ended, by pid, never by name.
//! * The person's other tool servers (pencil and so on) carry no marker and are never touched. They can still
//!   outlive a session; that is the agent's own bug and is documented, not worked around.
//!
//! The matching ([`owned_by_marker`], [`stale_pids`]) is pure over a process list, so it is tested without
//! starting anything. Reading the list and ending a pid are the only operating-system parts.

use std::collections::{HashMap, HashSet};

/// The argument that carries the marker, `--pm-session=<marker>`.
pub const MARKER_FLAG: &str = "--pm-session=";
/// Every marker starts with this, then the pid of the app that made it, then a random part.
pub const MARKER_PREFIX: &str = "pmacp";
/// How far up the parent chain is followed (a cycle or a very deep chain proves nothing).
const MAX_CHAIN: usize = 16;

/// One process: what the matching needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    /// Lowercase image name (`opencode.exe`).
    pub image: String,
    /// The whole command line (empty when it could not be read).
    pub cmdline: String,
}

/// A new marker for a session of this app run.
pub fn new_marker() -> String {
    format!("{MARKER_PREFIX}.{}.{}", std::process::id(), uuid::Uuid::new_v4().simple())
}

/// The pid of the app run that made `marker`, or `None` when it is not one of ours.
pub fn marker_app_pid(marker: &str) -> Option<u32> {
    let mut parts = marker.split('.');
    if parts.next()? != MARKER_PREFIX {
        return None;
    }
    let pid = parts.next()?.parse().ok()?;
    let random = parts.next()?;
    (parts.next().is_none() && random.len() >= 16 && random.chars().all(|c| c.is_ascii_hexdigit())).then_some(pid)
}

/// The markers in a command line (each a whole `--pm-session=` argument).
fn markers_in(cmdline: &str) -> Vec<&str> {
    cmdline
        .split(MARKER_FLAG)
        .skip(1)
        .map(|rest| rest.split(|c: char| c.is_whitespace() || c == '"' || c == '\'').next().unwrap_or(""))
        .filter(|m| marker_app_pid(m).is_some())
        .collect()
}

fn stem(image: &str) -> String {
    let lower = image.to_ascii_lowercase();
    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
}

/// Does the parent chain of `pid` reach a process whose image is one of `images`? A parent that is not in
/// the list (it ended: Windows does not hand the child to anyone) ends the walk with `false`: nothing is proven.
fn chain_reaches(by_pid: &HashMap<u32, &Proc>, pid: u32, images: &[String]) -> bool {
    let mut seen = HashSet::new();
    let mut at = by_pid.get(&pid).map(|p| p.parent);
    for _ in 0..MAX_CHAIN {
        let Some(parent_pid) = at else { return false };
        if parent_pid == 0 || !seen.insert(parent_pid) {
            return false;
        }
        let Some(parent) = by_pid.get(&parent_pid) else { return false };
        if images.iter().any(|i| stem(i) == stem(&parent.image)) {
            return true;
        }
        at = Some(parent.parent);
    }
    false
}

/// The pids to end for one closed session: command line carries exactly `marker` and the parent chain leads to
/// one of `images`. Never the current process.
pub fn owned_by_marker(procs: &[Proc], marker: &str, images: &[String]) -> Vec<u32> {
    if marker_app_pid(marker).is_none() || images.is_empty() {
        return Vec::new();
    }
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    procs
        .iter()
        .filter(|p| p.pid != std::process::id())
        .filter(|p| markers_in(&p.cmdline).contains(&marker))
        .filter(|p| chain_reaches(&by_pid, p.pid, images))
        .map(|p| p.pid)
        .collect()
}

/// The pids to end at app start: our marker from an app run that is no longer there (`app_alive` says which pids
/// run), and the parent chain leads to one of `images`, or the parent is gone (the shared server ended first, the
/// child was left behind: the marker alone proves it is ours, and nothing else keeps it).
pub fn stale_pids(procs: &[Proc], images: &[String], app_alive: &dyn Fn(u32) -> bool) -> Vec<u32> {
    if images.is_empty() {
        return Vec::new();
    }
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    procs
        .iter()
        .filter(|p| p.pid != std::process::id())
        .filter(|p| {
            let markers = markers_in(&p.cmdline);
            !markers.is_empty() && markers.iter().all(|m| marker_app_pid(m).map_or(false, |app| app != std::process::id() && !app_alive(app)))
        })
        .filter(|p| chain_reaches(&by_pid, p.pid, images) || !by_pid.contains_key(&p.parent))
        .map(|p| p.pid)
        .collect()
}

/// `args` plus the marker argument, for the entry of OUR tool server in a `mcpServers` list. Other entries
/// (the person's own servers) are left exactly as they are.
pub fn mark_own_server(servers: Vec<serde_json::Value>, own_name: &str, marker: &str) -> Vec<serde_json::Value> {
    servers
        .into_iter()
        .map(|mut server| {
            if server.get("name").and_then(|n| n.as_str()) == Some(own_name) {
                if let Some(obj) = server.as_object_mut() {
                    let args = obj.entry("args").or_insert_with(|| serde_json::json!([]));
                    if let Some(list) = args.as_array_mut() {
                        list.push(serde_json::Value::String(format!("{MARKER_FLAG}{marker}")));
                    }
                }
            }
            server
        })
        .collect()
}

// ---- operating system ------------------------------------------------------------------------------------

/// Every process with its command line (kept only for the ones that carry a marker), or `None` when the list
/// cannot be read.
pub fn list_processes() -> Option<Vec<Proc>> {
    #[cfg(windows)]
    {
        let mut procs: Vec<Proc> = crate::pty::agent_proc::snapshot()?
            .into_iter()
            .map(|e| Proc { pid: e.pid, parent: e.parent, image: e.image, cmdline: String::new() })
            .collect();
        // Command lines only for the processes that carry a marker: the filter runs inside the query.
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"CommandLine like '%{MARKER_FLAG}{MARKER_PREFIX}.%'\" | ForEach-Object {{ \"$($_.ProcessId)`t$($_.CommandLine)\" }}"
        );
        let out = crate::proc_util::hidden_command("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let lines: HashMap<u32, &str> = text
            .lines()
            .filter_map(|l| l.split_once('\t'))
            .filter_map(|(pid, cl)| Some((pid.trim().parse().ok()?, cl)))
            .collect();
        for p in &mut procs {
            if let Some(cl) = lines.get(&p.pid) {
                p.cmdline = (*cl).to_string();
            }
        }
        Some(procs)
    }
    #[cfg(not(windows))]
    {
        let out = crate::proc_util::hidden_command("ps").args(["-axo", "pid=,ppid=,comm=,args="]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        Some(
            text.lines()
                .filter_map(|line| {
                    let mut it = line.split_whitespace();
                    let pid = it.next()?.parse().ok()?;
                    let parent = it.next()?.parse().ok()?;
                    let image = it.next()?.rsplit('/').next()?.to_ascii_lowercase();
                    Some(Proc { pid, parent, image, cmdline: it.collect::<Vec<_>>().join(" ") })
                })
                .collect(),
        )
    }
}

/// Whether a process with this pid is running (true when that cannot be told: nothing is then ended).
fn pid_alive(pid: u32) -> bool {
    match list_processes_light() {
        Some(set) => set.contains(&pid),
        None => true,
    }
}

fn list_processes_light() -> Option<HashSet<u32>> {
    #[cfg(windows)]
    {
        Some(crate::pty::agent_proc::snapshot()?.into_iter().map(|e| e.pid).collect())
    }
    #[cfg(not(windows))]
    {
        let out = crate::proc_util::hidden_command("ps").args(["-axo", "pid="]).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).split_whitespace().filter_map(|v| v.parse().ok()).collect())
    }
}

/// Ends each pid and what it started (by pid; never by name). Returns how many were asked to end.
fn end(pids: &[u32]) -> usize {
    for pid in pids {
        crate::pty::proc_tree::kill_process_tree(*pid);
    }
    pids.len()
}

/// A closed session's tool servers. Best effort; logs only pids.
pub fn sweep_session(marker: &str, images: &[String]) -> usize {
    let Some(procs) = list_processes() else { return 0 };
    let pids = owned_by_marker(&procs, marker, images);
    if !pids.is_empty() {
        tracing::info!(?pids, "acp: ending tool servers a closed session left in its agent's shared server");
    }
    end(&pids)
}

/// Every session of this app run (a quit): the same proof, any marker made by this process.
pub fn sweep_this_run(images: &[String]) -> usize {
    let Some(procs) = list_processes() else { return 0 };
    let me = std::process::id();
    let markers: HashSet<&str> = procs.iter().flat_map(|p| markers_in(&p.cmdline)).filter(|m| marker_app_pid(m) == Some(me)).collect();
    let pids: HashSet<u32> = markers.into_iter().flat_map(|m| owned_by_marker(&procs, m, images)).collect();
    let pids: Vec<u32> = pids.into_iter().collect();
    end(&pids)
}

/// At app start: tool servers an earlier run of this app left behind.
pub fn sweep_stale(images: &[String]) -> usize {
    let Some(procs) = list_processes() else { return 0 };
    let pids = stale_pids(&procs, images, &pid_alive);
    if !pids.is_empty() {
        tracing::info!(?pids, "acp: ending tool servers an earlier run left behind");
    }
    end(&pids)
}

/// The shared-server images of every built-in agent that lists some.
pub fn all_shared_images() -> Vec<String> {
    let mut images: Vec<String> = super::config::builtin_agents().into_iter().flat_map(|a| a.shared_server_images).collect();
    images.sort();
    images.dedup();
    images
}

#[cfg(test)]
#[path = "leak_tests.rs"]
mod tests;
