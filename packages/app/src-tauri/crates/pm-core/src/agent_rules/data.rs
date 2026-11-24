//! What is saved: which agents have Force yes, the fences of each project and the pins.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const FILE: &str = "agent_rules.json";
/// A project keeps at most this many fences, a note at most this many characters: a runaway value cannot grow the file.
pub const MAX_FENCES: usize = 100;
pub const MAX_NOTES_CHARS: usize = 1000;
const MAX_WORD_CHARS: usize = 120;

/// Starting settings. A field left out is "not pinned" (the agent's own choice).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Pin {
    pub model: Option<String>,
    pub mode: Option<String>,
    /// Start new agents with Force yes on. `None`: not pinned.
    pub force_yes: Option<bool>,
    pub notes: Option<String>,
}

impl Pin {
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.mode.is_none() && self.force_yes.is_none() && self.notes.is_none()
    }

    /// Cuts every word to its limit and drops blanks.
    pub fn cleaned(mut self) -> Pin {
        let clean = |value: Option<String>, max: usize| value.map(|v| v.trim().chars().take(max).collect::<String>()).filter(|v| !v.is_empty());
        self.model = clean(self.model, MAX_WORD_CHARS);
        self.mode = clean(self.mode, MAX_WORD_CHARS);
        self.notes = clean(self.notes, MAX_NOTES_CHARS);
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Data {
    /// Agents (ids) that start their chats with Force yes on.
    pub force_yes_agents: BTreeSet<String>,
    /// Project key -> fences (paths inside the project, `/` separated).
    pub fences: BTreeMap<String, Vec<String>>,
    pub pin_global: Pin,
    pub pin_projects: BTreeMap<String, Pin>,
}

/// What a new agent starts with, after the project's pin is laid over the global one.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Effective {
    pub model: Option<String>,
    pub mode: Option<String>,
    pub force_yes: bool,
    /// Where Force yes came from: `"pin"`, `"agent"` or `None` (off).
    pub force_yes_source: Option<&'static str>,
    pub notes: Option<String>,
    /// The project's fences (inherited by every new agent of the project).
    pub fences: Vec<String>,
}

/// A project as a key: slashes forward, no trailing slash, lower case (Windows paths do not care about case).
pub fn project_key(path: &str) -> String {
    let mut text = path.trim().replace('\\', "/");
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string();
    }
    while text.len() > 1 && text.ends_with('/') {
        text.pop();
    }
    text.to_lowercase()
}

pub struct RulesStore {
    path: Option<PathBuf>,
    data: Mutex<Data>,
}

impl RulesStore {
    /// A store that lives in memory only (tests, and the app under `cargo test`).
    pub fn in_memory() -> Self {
        Self { path: None, data: Mutex::new(Data::default()) }
    }

    pub fn at(path: &Path) -> Self {
        let data = std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
        Self { path: Some(path.to_path_buf()), data: Mutex::new(data) }
    }

    pub(super) fn open_default() -> Self {
        if cfg!(any(test, feature = "test-util")) {
            Self::in_memory()
        } else {
            Self::at(&crate::app_paths::app_data_dir().join(FILE))
        }
    }

    pub fn snapshot(&self) -> Data {
        self.data.lock().clone()
    }

    fn change<T>(&self, edit: impl FnOnce(&mut Data) -> T) -> Result<T, String> {
        let mut data = self.data.lock();
        let out = edit(&mut data);
        if let Some(path) = &self.path {
            let text = serde_json::to_vec_pretty(&*data).map_err(|e| e.to_string())?;
            crate::write_atomic::write_atomic(path, &text).map_err(|e| format!("could not save: {e}"))?;
        }
        Ok(out)
    }

    // ---- Force yes, per agent ----------------------------------------------------------------------

    pub fn force_yes_for_agent(&self, agent: &str) -> bool {
        self.data.lock().force_yes_agents.contains(&agent.to_lowercase())
    }

    pub fn set_force_yes_for_agent(&self, agent: &str, on: bool) -> Result<bool, String> {
        let agent = agent.trim().to_lowercase();
        if agent.is_empty() || agent.len() > MAX_WORD_CHARS {
            return Err("INVALID_ARGUMENT: name an agent".into());
        }
        self.change(|d| if on { d.force_yes_agents.insert(agent) } else { d.force_yes_agents.remove(&agent) })
    }

    /// Whether any pin (global or of a project) starts agents with Force yes on.
    pub fn any_pin_force_yes(&self) -> bool {
        let data = self.data.lock();
        data.pin_global.force_yes == Some(true) || data.pin_projects.values().any(|p| p.force_yes == Some(true))
    }

    // ---- Fences -------------------------------------------------------------------------------------

    pub fn fences(&self, project: &str) -> Vec<String> {
        self.data.lock().fences.get(&project_key(project)).cloned().unwrap_or_default()
    }

    /// Adds a fence given as a path inside `project` (absolute, or relative to it). Returns the stored form.
    pub fn add_fence(&self, project: &str, path: &str) -> Result<String, String> {
        let stored = super::fence::normalise(project, path)?;
        let key = project_key(project);
        self.change(|d| {
            let list = d.fences.entry(key).or_default();
            if list.iter().any(|f| f.eq_ignore_ascii_case(&stored)) {
                return Ok(stored);
            }
            if list.len() >= MAX_FENCES {
                return Err(format!("INVALID_ARGUMENT: a project keeps at most {MAX_FENCES} fences"));
            }
            list.push(stored.clone());
            list.sort();
            Ok(stored)
        })?
    }

    pub fn remove_fence(&self, project: &str, fence: &str) -> Result<bool, String> {
        let key = project_key(project);
        self.change(|d| {
            let Some(list) = d.fences.get_mut(&key) else { return false };
            let before = list.len();
            list.retain(|f| !f.eq_ignore_ascii_case(fence));
            let removed = list.len() != before;
            if list.is_empty() {
                d.fences.remove(&key);
            }
            removed
        })
    }

    // ---- Pins ---------------------------------------------------------------------------------------

    pub fn pin(&self, project: Option<&str>) -> Pin {
        let data = self.data.lock();
        match project {
            None => data.pin_global.clone(),
            Some(p) => data.pin_projects.get(&project_key(p)).cloned().unwrap_or_default(),
        }
    }

    /// Saves a pin: global for `None`, else for that project. An empty pin removes the project's entry.
    pub fn set_pin(&self, project: Option<&str>, pin: Pin) -> Result<Pin, String> {
        let pin = pin.cleaned();
        let saved = pin.clone();
        self.change(|d| match project {
            None => d.pin_global = pin,
            Some(p) if pin.is_empty() => {
                d.pin_projects.remove(&project_key(p));
            }
            Some(p) => {
                d.pin_projects.insert(project_key(p), pin);
            }
        })?;
        Ok(saved)
    }

    /// What a new agent `agent` in `project` starts with.
    pub fn effective(&self, agent: &str, project: Option<&str>) -> Effective {
        let data = self.data.lock();
        let global = &data.pin_global;
        let own = project.and_then(|p| data.pin_projects.get(&project_key(p)));
        let pick = |f: fn(&Pin) -> Option<String>| own.and_then(f).or_else(|| f(global));
        let notes = match (global.notes.as_deref(), own.and_then(|p| p.notes.as_deref())) {
            (Some(g), Some(p)) => Some(format!("{g}\n{p}")),
            (Some(n), None) | (None, Some(n)) => Some(n.to_string()),
            (None, None) => None,
        };
        let pinned_yes = own.and_then(|p| p.force_yes).or(global.force_yes);
        let agent_yes = data.force_yes_agents.contains(&agent.to_lowercase());
        // The per-agent switch wins when it is on; a pin that says "off" only leaves it off for agents without the switch.
        let (force_yes, force_yes_source) = match (agent_yes, pinned_yes) {
            (true, _) => (true, Some("agent")),
            (false, Some(true)) => (true, Some("pin")),
            _ => (false, None),
        };
        Effective {
            model: pick(|p| p.model.clone()),
            mode: pick(|p| p.mode.clone()),
            force_yes,
            force_yes_source,
            notes,
            fences: project.and_then(|p| data.fences.get(&project_key(p)).cloned()).unwrap_or_default(),
        }
    }
}
