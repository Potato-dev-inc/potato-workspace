//! Tauri commands of Over SSH (Devices phase 3). Desktop only: no bridge route and no MCP tool, so a phone or an agent
//! cannot start an ssh or pick a machine. The commands are thin; the rules live in `ssh::*`. They take parts, never a
//! command line, and answer with views that hold no password and no key contents (a key file is only a path).
//! The names and argument names match `packages/app/src/lib/ssh.ts`.

use super::AppState;
use crate::operations::OperationError;
use crate::pty::{registry_spawn_pane, SpawnPaneArgs};
use crate::ssh::check::{self, AgentProgram, Facts, BASE_PROGRAMS};
use crate::ssh::command::{terminal_argv, Remote};
use crate::ssh::model::{PartError, SshHost, SshState};
use crate::ssh::once::{self, SshLaunch};
use crate::ssh::run::{self, LiveRunner};
use crate::ssh::store::{Saved, Store};
use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

const SSH_BAD_PART: &str = "SSH_BAD_PART";
const SSH_NOT_FOUND: &str = "SSH_NOT_FOUND";
const SSH_START_FAILED: &str = "SSH_START_FAILED";

#[cfg(not(test))]
fn store() -> Store {
    Store::live()
}

#[cfg(test)]
fn store() -> Store {
    Store::at(&std::env::temp_dir().join("pm-ssh-commands-no-store"))
}

async fn off_ui<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> Result<T, OperationError> {
    tauri::async_runtime::spawn_blocking(job).await.map_err(|e| OperationError::new("INTERNAL", e.to_string(), false))
}

fn bad(e: PartError) -> OperationError {
    OperationError::new(SSH_BAD_PART, e.sentence(), false)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// One row of a check: a tool or an agent CLI, found or not.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProgramRow {
    /// `git`, `node`, or the agent id (`claude`).
    pub id: String,
    pub label: String,
    /// `tool` or `agent`.
    pub kind: &'static str,
    pub found: bool,
}

/// What a check answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckView {
    #[serde(flatten)]
    pub state: SshState,
    /// A plain sentence for the state.
    pub message: String,
    pub os: Option<String>,
    pub programs: Vec<ProgramRow>,
}

/// A saved machine. `key_file` is a path (shown so the person can see which key); it is never read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub id: String,
    pub name: String,
    pub user: String,
    pub host: String,
    pub port: u16,
    pub key_file: Option<String>,
    pub os: Option<String>,
    pub checked_at: Option<u64>,
    /// The agent CLIs the last check found, as `{ id, label }` (ids from our own list only).
    pub agents: Vec<AgentRef>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentRef {
    pub id: String,
    pub label: String,
}

/// Rows for a check: git and node, then each agent CLI, in a fixed order.
pub fn rows(found: &[String], agents: &[AgentProgram]) -> Vec<ProgramRow> {
    let has = |p: &str| found.iter().any(|f| f == p);
    let mut out: Vec<ProgramRow> = BASE_PROGRAMS
        .iter()
        .map(|p| ProgramRow { id: (*p).to_string(), label: (*p).to_string(), kind: "tool", found: has(p) })
        .collect();
    out.extend(agents.iter().map(|a| ProgramRow { id: a.id.clone(), label: a.label.clone(), kind: "agent", found: has(&a.program) }));
    out
}

pub fn check_view(result: &run::CheckResult, agents: &[AgentProgram]) -> CheckView {
    let ok = result.state == SshState::Ok;
    CheckView {
        state: result.state.clone(),
        message: result.state.sentence(),
        os: result.facts.os.clone(),
        programs: if ok { rows(&result.facts.found, agents) } else { Vec::new() },
    }
}

pub fn host_view(saved: &Saved, agents: &[AgentProgram]) -> HostView {
    HostView {
        id: saved.host.id.clone(),
        name: saved.host.name.clone(),
        user: saved.host.user.clone(),
        host: saved.host.host.clone(),
        port: saved.host.port,
        key_file: saved.host.key_file.clone(),
        os: saved.os.clone(),
        checked_at: saved.checked_at,
        agents: agents.iter().filter(|a| saved.found.contains(&a.program)).map(|a| AgentRef { id: a.id.clone(), label: a.label.clone() }).collect(),
    }
}

/// Keeps only names that are ours (git, node, an agent's id or program): a value from the screen never widens the list.
/// Each agent comes back as its program name, which is what the store keeps.
pub fn sanitize_found(found: &[String], agents: &[AgentProgram]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in found {
        let name = if BASE_PROGRAMS.contains(&f.as_str()) {
            Some(f.clone())
        } else {
            agents.iter().find(|a| &a.program == f || &a.id == f).map(|a| a.program.clone())
        };
        if let Some(n) = name {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

fn runner() -> Result<LiveRunner, OperationError> {
    let exe = run::ssh_exe().ok_or_else(|| OperationError::new(SSH_NOT_FOUND, "SSH is not installed on this PC. Turn on the OpenSSH Client in Windows optional features.", false))?;
    Ok(LiveRunner { exe, pre: Vec::new() })
}

fn programs_of(agents: &[AgentProgram]) -> Vec<String> {
    agents.iter().map(|a| a.program.clone()).collect()
}

/// The saved machines.
#[tauri::command]
pub async fn ssh_hosts() -> Result<Vec<HostView>, OperationError> {
    off_ui(|| {
        let agents = check::agent_programs();
        store().list().iter().map(|s| host_view(s, &agents)).collect()
    })
    .await
}

/// A read-only check of a machine that is not saved yet (the Add form's Check button). Nothing is stored.
#[tauri::command]
pub async fn ssh_check(target: String, port: Option<u16>, key_file: Option<String>) -> Result<CheckView, OperationError> {
    off_ui(move || {
        let host = SshHost::parse("check", "check", &target, port, key_file.as_deref()).map_err(bad)?;
        let agents = check::agent_programs();
        let result = run::check(&runner()?, &host, &programs_of(&agents));
        Ok(check_view(&result, &agents))
    })
    .await?
}

/// Saves a machine. `found` and `os` are what a check showed (kept so New agent can list the agents without asking again).
#[tauri::command]
pub async fn ssh_add(name: String, target: String, port: Option<u16>, key_file: Option<String>, found: Option<Vec<String>>, os: Option<String>) -> Result<HostView, OperationError> {
    off_ui(move || {
        let id = Uuid::new_v4().to_string();
        let host = SshHost::parse(&id, &name, &target, port, key_file.as_deref()).map_err(bad)?;
        let agents = check::agent_programs();
        let found = sanitize_found(&found.unwrap_or_default(), &agents);
        let os = os.map(|o| crate::ssh::model::clean_line(&o, 24)).filter(|o| !o.is_empty());
        let checked_at = (!found.is_empty() || os.is_some()).then(now_secs);
        let saved = Saved { host, os, found, checked_at };
        store().add(saved.clone()).map_err(|m| OperationError::new(SSH_START_FAILED, m, false))?;
        Ok(host_view(&saved, &agents))
    })
    .await?
}

/// Checks a saved machine again and keeps what it found.
#[tauri::command]
pub async fn ssh_check_saved(id: String) -> Result<CheckView, OperationError> {
    off_ui(move || {
        let st = store();
        let saved = st.get(&id).ok_or_else(|| OperationError::new(SSH_NOT_FOUND, "That machine is not saved any more.", false))?;
        let agents = check::agent_programs();
        let result = run::check(&runner()?, &saved.host, &programs_of(&agents));
        if result.state == SshState::Ok {
            let facts: &Facts = &result.facts;
            let _ = st.set_check(&id, facts, now_secs());
        }
        Ok(check_view(&result, &agents))
    })
    .await?
}

#[tauri::command]
pub async fn ssh_remove(id: String) -> Result<bool, OperationError> {
    off_ui(move || store().remove(&id).map_err(|m| OperationError::new(SSH_START_FAILED, m, false))).await?
}

/// Opens a terminal pane on a saved machine: a local PTY that runs `ssh -t ...`. `agent` is `shell` or an agent id whose
/// CLI the machine has. The pane has no sign-in, hook or variable of this PC.
#[tauri::command]
pub async fn ssh_open(id: String, agent: String, folder: Option<String>, state: State<'_, AppState>, app: AppHandle) -> Result<String, OperationError> {
    let registry = state.registry.clone();
    off_ui(move || {
        let saved = store().get(&id).ok_or_else(|| OperationError::new(SSH_NOT_FOUND, "That machine is not saved any more.", false))?;
        let (remote, agent_type) = if agent == "shell" {
            (Remote::Shell, "bash".to_string())
        } else {
            let known = check::agent_programs();
            let found = known.iter().find(|a| a.id == agent).ok_or_else(|| OperationError::new(SSH_BAD_PART, PartError::Program.sentence(), false))?;
            (Remote::Program(found.program.clone()), found.id.clone())
        };
        let folder = folder.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
        let argv = terminal_argv(&saved.host, folder.as_deref(), &remote).map_err(bad)?;
        let exe = run::ssh_exe().ok_or_else(|| OperationError::new(SSH_NOT_FOUND, "SSH is not installed on this PC. Turn on the OpenSSH Client in Windows optional features.", false))?;
        let pane_id = Uuid::new_v4().to_string();
        once::request(&pane_id, SshLaunch { exe, argv, name: saved.host.name.clone(), folder });
        let args = SpawnPaneArgs {
            agent_type,
            cwd: None,
            cols: None,
            rows: None,
            extra_args: None,
            pane_id: Some(pane_id.clone()),
            read_only: false,
            account: None,
            guard_env: None,
        };
        // The registry emits `pty://panes-changed` when the pane starts, as it does for `spawn_pane`.
        registry_spawn_pane(&registry, &app, args).map_err(|m| OperationError::new(SSH_START_FAILED, m, true))?;
        Ok(pane_id)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agents() -> Vec<AgentProgram> {
        vec![
            AgentProgram { id: "claude".into(), label: "Claude".into(), program: "claude".into() },
            AgentProgram { id: "codex".into(), label: "Codex".into(), program: "codex".into() },
        ]
    }

    #[test]
    fn rows_list_tools_then_agents_found_or_not() {
        let r = rows(&["git".into(), "claude".into()], &agents());
        let ids: Vec<(&str, bool)> = r.iter().map(|x| (x.id.as_str(), x.found)).collect();
        assert_eq!(ids, vec![("git", true), ("node", false), ("claude", true), ("codex", false)]);
    }

    #[test]
    fn a_failed_check_lists_nothing_and_says_why() {
        let v = check_view(&run::CheckResult { state: SshState::WrongKey, facts: Facts::default() }, &agents());
        assert!(v.programs.is_empty());
        assert!(v.message.contains("Wrong key or password"));
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["state"], "wrong_key");
    }

    #[test]
    fn what_the_screen_sends_back_is_cut_to_our_own_names() {
        assert_eq!(sanitize_found(&["git".into(), "evil".into(), "claude".into(), "git".into(), "$(id)".into()], &agents()), vec!["git".to_string(), "claude".to_string()]);
    }

    #[test]
    fn a_saved_host_view_has_no_secret_fields() {
        let host = SshHost::parse("i1", "Build box", "dev@build.local", None, Some("C:/k/id")).unwrap();
        let v = host_view(&Saved { host, os: Some("Linux".into()), found: vec!["claude".into()], checked_at: Some(5) }, &agents());
        let json = serde_json::to_string(&v).unwrap().to_ascii_lowercase();
        assert!(!json.contains("password") && !json.contains("passphrase"));
        assert_eq!(v.agents, vec![AgentRef { id: "claude".into(), label: "Claude".into() }]);
        assert_eq!(v.key_file.as_deref(), Some("C:/k/id"));
    }
}
