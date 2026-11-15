//! What this PC already has: the toolbelt's servers, the MCP servers in each agent's own config, and the
//! skills in each agent's skills folder. Read from the places the app already knows (`agent_pack`'s
//! per-agent `skills_host`, the toolbelt's `mcp_host`); nothing here matches an agent's name.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use super::export;
use super::model::{item_id, ShelfItem};
use crate::agent_pack::plan::AgentSpec;
use crate::agent_pack::MARKER_PREFIX;
use crate::toolbelt::edit;
use crate::toolbelt::import;
use crate::toolbelt::store::{self, Scope, ToolServer};
use crate::toolbelt::sync::{groups, AgentRef, HostSpec, SyncOptions};
use crate::toolbelt::KEY_PREFIX;

/// Everything the shelf reads and writes, so tests can point it at temp folders.
pub struct Env {
    pub store_path: PathBuf,
    /// Every agent and what it declares (where it keeps tools and skills).
    pub agents: Vec<AgentSpec>,
    pub home: PathBuf,
}

impl Env {
    pub fn live() -> Result<Self, String> {
        let state_dir = crate::app_paths::app_data_dir();
        let mut agents = crate::agent_pack::service::live_specs();
        let custom = crate::agent_pack::custom::load(&state_dir);
        crate::agent_pack::custom::merge(&mut agents, &custom);
        Ok(Self {
            store_path: store::default_path(),
            agents,
            home: crate::project_path::home_dir().ok_or_else(|| "Potato Workspace could not find your home folder.".to_string())?,
        })
    }

    /// The agents that keep tools in a config file the toolbelt can write.
    pub fn hosts(&self) -> Vec<HostSpec> {
        self.agents
            .iter()
            .filter_map(|a| a.mcp.clone().map(|table| HostSpec { agent_id: a.id.clone(), label: a.label.clone(), installed: a.installed, table }))
            .collect()
    }

    pub fn sync_options(&self) -> SyncOptions {
        SyncOptions { home: self.home.clone(), project: None, pm_launch: None }
    }
}

/// One thing this PC has.
#[derive(Debug, Clone)]
pub struct LocalItem {
    pub id: String,
    /// The shareable definition, or why it cannot be shared.
    pub item: Result<ShelfItem, String>,
    /// The name as the person knows it (also for an item that cannot be shared).
    pub name: String,
    pub kind: &'static str,
    pub agents: Vec<AgentRef>,
    /// Where it was found: `toolbelt`, `agent` (an agent's own config) or `skills`.
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Target {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub tools: bool,
    pub skills: bool,
}

pub fn targets(env: &Env) -> Vec<Target> {
    env.agents.iter().map(|a| Target { id: a.id.clone(), label: a.label.clone(), installed: a.installed, tools: a.mcp.is_some(), skills: a.skills.is_some() }).collect()
}

/// Agents whose config has the key `pm-toolbelt-<id>`.
fn agents_with_key(env: &Env, key: &str) -> Vec<AgentRef> {
    let hosts = env.hosts();
    let opts = env.sync_options();
    let mut out: Vec<AgentRef> = Vec::new();
    for g in groups(&hosts, &opts) {
        if g.scope != Scope::Global {
            continue;
        }
        let Ok(path) = &g.path else { continue };
        let Ok(text) = fs::read_to_string(path) else { continue };
        let Ok(segs) = crate::mcp_install::declarative::key_segments(&g.table.key_path) else { continue };
        let (parent, _) = segs.split_at(segs.len() - 1);
        let Ok(members) = edit::members(g.table.format, &text, parent) else { continue };
        if members.iter().any(|(k, _)| k == key) {
            for a in g.agents {
                if !out.contains(&a) {
                    out.push(a);
                }
            }
        }
    }
    out
}

fn push_item(out: &mut Vec<LocalItem>, name: String, kind: &'static str, source: &'static str, item: Result<ShelfItem, String>, agents: Vec<AgentRef>) {
    let id = match &item {
        Ok(i) => item_id(i),
        Err(_) => format!("local-{kind}-{}", super::model::slug(&name)),
    };
    if let Some(found) = out.iter_mut().find(|l| l.id == id && l.item.is_ok()) {
        for a in agents {
            if !found.agents.contains(&a) {
                found.agents.push(a);
            }
        }
        return;
    }
    out.push(LocalItem { id, item, name, kind, agents, source });
}

fn first_line_value(text: &str, key: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(v) = line.strip_prefix(key).and_then(|r| r.strip_prefix(':')) {
            let v = v.trim().trim_matches(['"', '\'']);
            return (!v.is_empty()).then(|| v.to_string());
        }
    }
    None
}

fn count_other_files(dir: &Path) -> u32 {
    fn walk(dir: &Path, depth: u32, top: bool) -> u32 {
        let Ok(rd) = fs::read_dir(dir) else { return 0 };
        rd.flatten()
            .map(|e| {
                let p = e.path();
                if p.is_dir() {
                    if depth < 4 { walk(&p, depth + 1, false) } else { 0 }
                } else if top && p.file_name().is_some_and(|n| n == "SKILL.md") {
                    0
                } else {
                    1
                }
            })
            .sum()
    }
    walk(dir, 0, true)
}

/// Skills in one folder: `<dir>/<skill>/SKILL.md`. The Potato Workspace pack's own skills are not offered.
fn scan_skills(env: &Env, out: &mut Vec<LocalItem>) {
    let mut seen_dirs: Vec<(PathBuf, Vec<AgentRef>)> = Vec::new();
    for a in &env.agents {
        let Some(h) = &a.skills else { continue };
        let Ok(dir) = crate::mcp_install::declarative::resolve_config_path(&h.dir, &env.home, None) else { continue };
        let agent = AgentRef { id: a.id.clone(), label: a.label.clone() };
        match seen_dirs.iter_mut().find(|(d, _)| *d == dir) {
            Some((_, agents)) => agents.push(agent),
            None => seen_dirs.push((dir, vec![agent])),
        }
    }
    for (dir, agents) in seen_dirs {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut folders: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        folders.sort();
        for folder in folders {
            let file = folder.join("SKILL.md");
            let Ok(meta) = fs::metadata(&file) else { continue };
            if meta.len() > 1_000_000 {
                continue;
            }
            let Ok(text) = fs::read_to_string(&file) else { continue };
            if text.contains(MARKER_PREFIX) {
                continue;
            }
            let folder_name = folder.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let name = first_line_value(&text, "name").unwrap_or_else(|| folder_name.clone());
            let about = first_line_value(&text, "description").unwrap_or_default();
            let item = export::skill_item(&name, &about, &text, count_other_files(&folder), &env.home);
            push_item(out, name, "skill", "skills", item, agents.clone());
        }
    }
}

/// Everything this PC has that can go on the shelf (or be listed as "cannot be shared").
pub fn scan(env: &Env) -> Vec<LocalItem> {
    let mut out: Vec<LocalItem> = Vec::new();
    let servers: Vec<ToolServer> = store::load_servers(&env.store_path).unwrap_or_default();
    for s in &servers {
        let agents = agents_with_key(env, &format!("{KEY_PREFIX}{}", s.id));
        push_item(&mut out, s.name.clone(), "tool", "toolbelt", export::tool_item(s, &env.home), agents);
    }
    let hosts = env.hosts();
    for (_reference, agents, server, _already) in import::scan(&hosts, &env.sync_options(), &servers) {
        push_item(&mut out, server.name.clone(), "tool", "agent", export::tool_item(&server, &env.home), agents);
    }
    scan_skills(env, &mut out);
    out
}
