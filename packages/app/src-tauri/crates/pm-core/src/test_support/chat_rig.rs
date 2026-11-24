//! A chat's test parts shared by the engine's, the app's and the host's tests: a fake-agent config, a conversation store and the start
//! dependencies, all in one folder. No pane table, no window: `QuietHost` ignores every event.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::acp::chat::{QuietHost, StartDeps};
use crate::acp::config::{AgentConfig, HostEnv};
use crate::acp::conversations::{AgentSource, Conversations};
use crate::acp::fake_agent;
use crate::acp::record::RecordStore;
use crate::acp::supervisor::{Supervisor, SupervisorConfig};
use crate::pty::PaneRegistry;

/// A machine whose adapters and homes live under `root` and which finds no program by name.
pub struct Env {
    pub root: PathBuf,
}

impl HostEnv for Env {
    fn var(&self, name: &str) -> Option<std::ffi::OsString> {
        std::env::var_os(name)
    }
    fn which(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn adapters_dir(&self) -> PathBuf {
        self.root.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.root.join("homes")
    }
}

pub struct Agents(pub BTreeMap<String, Arc<AgentConfig>>);

impl AgentSource for Agents {
    fn config(&self, agent: &str) -> Option<Arc<AgentConfig>> {
        self.0.get(agent).cloned()
    }
}

/// The agent table with one agent, `fake`, configured by `opts` (`fake_agent::agent_config`).
pub fn agents(opts: &str, dir: &Path) -> Arc<Agents> {
    let mut cfg = fake_agent::agent_config(opts, &dir.join("agent-sessions"));
    cfg.resume_command = vec!["resume".into(), "{session}".into()];
    // `read_only=plan` (its own read-only mode only), `read_only=ask` (asks before every tool), `read_only=plan_ask` (both): the fake's `[acp.read_only]`.
    if let Some(kind) = opts.split(';').find_map(|pair| pair.trim().strip_prefix("read_only=")) {
        let mode = if kind.starts_with("plan") { "plan" } else { "" };
        cfg.read_only = Some(crate::acp::config::ReadOnlyChat { mode: mode.into(), mode_option: if mode.is_empty() { String::new() } else { "mode".into() }, asks_before_tools: kind.ends_with("ask") });
    }
    Arc::new(Agents(BTreeMap::from([("fake".to_string(), Arc::new(cfg))])))
}

pub fn conversations_in(dir: &Path, opts: &str) -> Conversations {
    let env: Arc<dyn HostEnv> = Arc::new(Env { root: dir.to_path_buf() });
    Conversations::new(RecordStore::at(dir.join("conversations.json")), Arc::new(Supervisor::new(SupervisorConfig::default())), env, agents(opts, dir))
}

pub fn deps_for(dir: &Path, conversations: &Conversations) -> StartDeps {
    StartDeps { registry: Arc::new(Mutex::new(PaneRegistry::new())), host: Arc::new(QuietHost), env: Arc::new(Env { root: dir.to_path_buf() }), conversations: Some(conversations.clone()) }
}
