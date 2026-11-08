//! JSON-in / JSON-out front for the pack installer, shared by the Tauri commands and the tests.

use serde_json::{json, Value};
#[cfg(test)]
use std::path::PathBuf;

use super::custom;
use super::plan::{self, AgentSpec, Options};
use crate::mcp_install::declarative::HostLaunch;

/// Everything the actions depend on, so tests can point them at temp folders.
pub struct Env {
    pub agents: Vec<AgentSpec>,
    pub options: Options,
}

impl Env {
    /// The live app: the real agent registry, the real home folder and app data folder.
    pub fn live() -> Result<Self, String> {
        Ok(Self {
            agents: live_specs(),
            options: Options {
                home: crate::project_path::home_dir().ok_or_else(|| "could not resolve the home folder".to_string())?,
                state_dir: crate::app_paths::app_data_dir(),
                launch: HostLaunch::current(),
            },
        })
    }

    #[cfg(test)]
    pub fn new(agents: Vec<AgentSpec>, home: PathBuf, state_dir: PathBuf, launch: HostLaunch) -> Self {
        Self { agents, options: Options { home, state_dir, launch } }
    }
}

/// Every non-shell agent with what its profile declares.
pub fn live_specs() -> Vec<AgentSpec> {
    crate::tui::descriptors()
        .into_iter()
        .filter(|d| !crate::tui::is_shell(d.id))
        .map(|d| {
            let profile = crate::tui::profile_for(d.id);
            AgentSpec { id: d.id.to_string(), label: d.label.clone(), installed: d.installed, mcp: profile.mcp_host(), skills: profile.skills_host() }
        })
        .collect()
}

/// `preview`, `apply`, `undo`.
pub fn call(env: &Env, action: &str) -> Result<Value, String> {
    match action {
        "preview" | "apply" => {
            let hosts = custom::load(&env.options.state_dir);
            let mut agents = env.agents.clone();
            custom::merge(&mut agents, &hosts);
            let report = plan::run(&agents, &env.options, action == "apply")?;
            let mut v = serde_json::to_value(report).map_err(|e| e.to_string())?;
            v["custom"] = serde_json::to_value(&hosts).map_err(|e| e.to_string())?;
            Ok(v)
        }
        "undo" => {
            let report = plan::undo(&env.options)?;
            let mut v = serde_json::to_value(report).map_err(|e| e.to_string())?;
            v["recorded"] = json!(plan::recorded(&env.options.state_dir));
            Ok(v)
        }
        other => Err(format!("unknown agent pack action {other}")),
    }
}

pub fn call_live(action: &str) -> Result<Value, String> {
    call(&Env::live()?, action)
}

/// Read the settings file the user picked and say what would be added where. Writes nothing.
pub fn inspect(env: &Env, path: &str) -> Result<Value, String> {
    let found = custom::inspect(path, &env.options.home, &env.options.launch)?;
    serde_json::to_value(found).map_err(|e| e.to_string())
}

/// Keep the user's choice for a registered agent (`agent_id`) or an agent called `name`.
pub fn save_custom(env: &Env, agent_id: Option<&str>, name: &str, path: &str, skills_dir: Option<&str>) -> Result<Value, String> {
    let agent = match agent_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => {
            let spec = env.agents.iter().find(|a| a.id == id).ok_or_else(|| "Potato Workspace doesn't know this agent.".to_string())?;
            Some((spec.id.as_str(), spec.label.as_str()))
        }
        None => None,
    };
    let host = custom::save(&env.options.state_dir, &env.options.home, &env.options.launch, agent, name, path, skills_dir)?;
    serde_json::to_value(host).map_err(|e| e.to_string())
}

/// Stop using the saved settings file for `id`. Anything already written stays until Undo.
pub fn forget_custom(env: &Env, id: &str) -> Result<Value, String> {
    let removed = custom::forget(&env.options.state_dir, id)?;
    Ok(json!({ "removed": removed }))
}
