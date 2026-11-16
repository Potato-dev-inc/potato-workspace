//! Standby helpers: helpers the person makes themselves ("Reviewer · Codex · gpt-5" in this project), started ahead of time
//! and waiting with no tokens spent. The next task that fits one (from the person, from an agent's `run_agent`, from a
//! routine or a chain) takes it instead of starting a new helper. After the task it goes back to waiting, or stays closed
//! until it is needed, as its setting says.
//!
//! This file is the list and its limits (saved in `standby-helpers.json` in the app data folder) and the view the screens
//! read. The sessions themselves are slots of the warm chat pool (`acp::warm`, `warm/helpers.rs`): one slot per helper.
//! Standbys need Chat (ACP): an agent that only runs in a terminal cannot be one yet, and the view says so.

use super::config::MAX_PRELOAD_TOTAL;
use crate::acp::warm::{AgentProbe, HelperMeta, HelperState, HelperStatus, HelperWant, Policy};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Most standby helpers the person may have.
pub const MAX_HELPERS: usize = MAX_PRELOAD_TOTAL;
pub const DEFAULT_MAX: usize = 4;
pub const DEFAULT_IDLE_MINUTES: u64 = 30;
const NAME_MAX: usize = 40;

/// What a helper does when its task is over.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AfterTask {
    /// Starts again and waits for the next task.
    #[default]
    Wait,
    /// Stays closed (no memory used) until a task asks for it or the person presses Start.
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StandbyHelper {
    pub id: String,
    pub name: String,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    pub project: String,
    #[serde(default)]
    pub after_task: AfterTask,
    /// The pane id of the agent this helper is shown under. The project owns the helper; `home` only says where it sits.
    /// Old files have none.
    #[serde(default)]
    pub home: Option<String>,
    /// "Remove from the agent": the helper is no longer a standby of any agent. It keeps running as a free warm agent that
    /// any agent's task of its type may use, until the person makes it a standby again or closes it.
    #[serde(default)]
    pub warm: bool,
}

/// What the person typed in the form.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NewHelper {
    pub name: String,
    pub agent: String,
    pub model: Option<String>,
    pub project: String,
    pub after_task: AfterTask,
    pub home: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HelperSettings {
    /// Most standbys at once.
    pub max: usize,
    /// A standby nobody used for this long is closed to free memory (it starts again when a task asks).
    pub idle_minutes: u64,
    /// The person chose `idle_minutes`. Until then it follows this PC's RAM (`acp::memory::default_idle_secs`).
    pub idle_explicit: bool,
}

impl Default for HelperSettings {
    fn default() -> Self {
        Self { max: DEFAULT_MAX, idle_minutes: DEFAULT_IDLE_MINUTES, idle_explicit: false }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HelperStore {
    pub settings: HelperSettings,
    pub helpers: Vec<StandbyHelper>,
}

fn tidy_home(home: Option<String>) -> Option<String> {
    home.map(|h| h.trim().to_string()).filter(|h| !h.is_empty())
}

fn tidy(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl HelperStore {
    /// Pulls a hand-edited file into range.
    pub fn clamped(self) -> Self {
        self.clamped_for(crate::acp::memory::pc_total_phys())
    }

    /// `clamped` for a PC with this much RAM. A saved idle time that is neither today's default nor this PC's tier counts as the person's choice;
    /// otherwise the RAM tier applies (5 minutes under 16 GB, 10 minutes to 32 GB).
    pub fn clamped_for(mut self, total_phys: Option<u64>) -> Self {
        self.settings.max = self.settings.max.clamp(1, MAX_HELPERS);
        self.settings.idle_minutes = self.settings.idle_minutes.clamp(1, 24 * 60);
        let tier_minutes = crate::acp::memory::idle_tier_secs(total_phys).map(|secs| secs / 60);
        if self.settings.idle_minutes != DEFAULT_IDLE_MINUTES && Some(self.settings.idle_minutes) != tier_minutes {
            self.settings.idle_explicit = true;
        }
        if !self.settings.idle_explicit {
            self.settings.idle_minutes = (crate::acp::memory::default_idle_secs(total_phys, DEFAULT_IDLE_MINUTES * 60) / 60).clamp(1, 24 * 60);
        }
        let mut seen = std::collections::BTreeSet::new();
        self.helpers.retain(|h| !h.id.trim().is_empty() && !h.agent.trim().is_empty() && !h.project.trim().is_empty() && seen.insert(h.id.clone()));
        for helper in &mut self.helpers {
            helper.agent = helper.agent.trim().to_ascii_lowercase();
            helper.name = tidy(&helper.name).chars().take(NAME_MAX).collect();
            helper.model = helper.model.take().map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
        }
        self.helpers.truncate(MAX_HELPERS);
        self
    }

    /// Adds a helper. The folder and the agent are checked by the caller (they need the machine).
    pub fn add(&mut self, input: NewHelper, id: String) -> Result<StandbyHelper, String> {
        if self.helpers.len() >= self.settings.max {
            return Err(format!("You already have {} standbys, the most allowed. Remove one first, or raise the limit.", self.helpers.len()));
        }
        let name: String = tidy(&input.name).chars().take(NAME_MAX).collect();
        if name.is_empty() {
            return Err("Give the standby a name, like Reviewer.".into());
        }
        let agent = input.agent.trim().to_ascii_lowercase();
        if agent.is_empty() {
            return Err("Pick an agent.".into());
        }
        let project = input.project.trim().to_string();
        if project.is_empty() {
            return Err("Pick a project folder.".into());
        }
        let helper = StandbyHelper { id, name, agent, model: input.model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()), project, after_task: input.after_task, home: tidy_home(input.home), warm: false };
        self.helpers.push(helper.clone());
        Ok(helper)
    }

    /// Moves a helper under another agent (`None`: under none; the screens pick the most recent agent of the project).
    pub fn set_home(&mut self, id: &str, home: Option<String>) -> Result<(), String> {
        let helper = self.helpers.iter_mut().find(|h| h.id == id).ok_or("That standby is gone.")?;
        helper.home = tidy_home(home);
        // Under an agent again: a standby, not a free warm agent.
        if helper.home.is_some() {
            helper.warm = false;
        }
        Ok(())
    }

    /// "Remove from the agent": the helper stays (and keeps running) but belongs to no agent.
    pub fn detach(&mut self, id: &str) -> Result<(), String> {
        let helper = self.helpers.iter_mut().find(|h| h.id == id).ok_or("That standby is gone.")?;
        helper.home = None;
        helper.warm = true;
        Ok(())
    }

    /// Renames a helper or changes what it does after a task.
    pub fn update(&mut self, id: &str, name: Option<&str>, model: Option<Option<&str>>, after_task: Option<AfterTask>) -> Result<(), String> {
        let helper = self.helpers.iter_mut().find(|h| h.id == id).ok_or("That standby is gone.")?;
        if let Some(name) = name {
            let name: String = tidy(name).chars().take(NAME_MAX).collect();
            if name.is_empty() {
                return Err("Give the standby a name, like Reviewer.".into());
            }
            helper.name = name;
        }
        if let Some(model) = model {
            helper.model = model.map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
        }
        if let Some(after_task) = after_task {
            helper.after_task = after_task;
        }
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.helpers.len();
        self.helpers.retain(|h| h.id != id);
        self.helpers.len() != before
    }

    /// The limits. A limit below the number of standbys is refused: nothing is removed on the person's behalf.
    pub fn set_settings(&mut self, max: usize, idle_minutes: u64) -> Result<(), String> {
        let max = max.clamp(1, MAX_HELPERS);
        if max < self.helpers.len() {
            return Err(format!("You have {} standbys. Remove some before the limit goes below that.", self.helpers.len()));
        }
        let idle_minutes = idle_minutes.clamp(1, 24 * 60);
        let idle_explicit = self.settings.idle_explicit || idle_minutes != self.settings.idle_minutes;
        self.settings = HelperSettings { max, idle_minutes, idle_explicit };
        Ok(())
    }
}

/// The list on disk.
pub struct HelperFile {
    path: PathBuf,
    store: Mutex<HelperStore>,
}

impl HelperFile {
    pub fn at(path: PathBuf) -> Self {
        let store = std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str::<HelperStore>(&text).ok()).unwrap_or_default().clamped();
        Self { path, store: Mutex::new(store) }
    }

    pub fn snapshot(&self) -> HelperStore {
        self.store.lock().clone()
    }

    /// Changes the list and saves it. Nothing changes when `change` refuses or the file cannot be written.
    pub fn edit<T>(&self, change: impl FnOnce(&mut HelperStore) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.store.lock();
        let mut next = guard.clone();
        let out = change(&mut next)?;
        let next = next.clamped();
        save(&self.path, &next)?;
        *guard = next;
        Ok(out)
    }
}

fn save(path: &Path, store: &HelperStore) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

static FILE: Lazy<HelperFile> = Lazy::new(|| HelperFile::at(crate::app_paths::app_data_dir().join("standby-helpers.json")));

/// The app's list.
pub fn file() -> &'static HelperFile {
    &FILE
}

// ---- the policy -------------------------------------------------------------------------------------------------------

/// Adds the helpers to the warm chat pool's policy: one wanted slot for each helper whose agent would run as a chat and
/// whose folder exists. They count against the pool's cap on top of the plain warm sessions.
pub fn extend_policy(policy: &mut Policy, store: &HelperStore, probe: &dyn AgentProbe) {
    policy.helper_idle_ms = store.settings.idle_minutes as i64 * 60_000;
    for helper in store.helpers.iter().take(store.settings.max) {
        let folder = Path::new(&helper.project);
        if !folder.is_dir() || !probe.runs_as_chat(&helper.agent) {
            continue;
        }
        let meta = HelperMeta { id: helper.id.clone(), name: helper.name.clone(), model: helper.model.clone(), close_after_use: helper.after_task == AfterTask::Close, home: helper.home.clone() };
        policy.helpers.push(HelperWant::new(meta, &helper.agent, folder, None));
        policy.cap += 1;
    }
}

// ---- the view -----------------------------------------------------------------------------------------------------------

pub use crate::acp::warm::{HelperUser, SkipReason};

/// A standby as the screens read it. The top bar chips and the Settings list use this one shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HelperEntry {
    pub id: String,
    pub name: String,
    pub agent: String,
    pub model: Option<String>,
    pub project: String,
    pub after_task: AfterTask,
    /// The agent (pane id) it is shown under; `None`: the screens choose.
    pub home: Option<String>,
    /// Who has it while `busy`: `agent` (an agent's task) or `person` (the person is using it).
    pub used_by: Option<HelperUser>,
    /// Always false: an agent never takes a standby away from the person any more (a seat with a turn running in it is
    /// never taken). Kept so older screens read the same shape.
    pub taken_over: bool,
    /// `ready`, `busy`, `starting`, `asleep` or `problem`.
    pub state: HelperState,
    /// Why it is a problem: `needs_chat`, `folder_missing`, `did_not_start`, `needs_sign_in`.
    pub note: Option<String>,
    /// The chat doing the task, while `busy`.
    pub pane_id: Option<String>,
    /// The chat the person has open on it, while `ready` or `busy` by `person` (opening it does not take it from the pool).
    pub open_pane: Option<String>,
    /// Always `None` (see `taken_over`).
    pub person_pane: Option<String>,
    /// A free warm agent (it was removed from its agent and keeps running).
    pub warm: bool,
    /// While `starting`: where the start is (`starting program`, `connecting`, `opening session`, `setting model`).
    pub stage: Option<String>,
    /// How long the start has been at that stage, in milliseconds.
    pub stage_ms: Option<i64>,
    /// How many times an agent's task used it today (the person's local day; starts again at local midnight).
    pub used_today: u32,
    /// The last reason an agent's task passed it by: `different_model`, `other_project`, `busy` or `you_were_using_it`.
    pub skip_reason: Option<SkipReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HelpersView {
    pub helpers: Vec<HelperEntry>,
    pub max: usize,
    pub idle_minutes: u64,
}

/// The list joined with what the pool says about each slot.
pub fn build_view(store: &HelperStore, statuses: &BTreeMap<String, HelperStatus>, runs_as_chat: impl Fn(&str) -> bool, folder_ok: impl Fn(&str) -> bool) -> HelpersView {
    let helpers = store
        .helpers
        .iter()
        .map(|h| {
            let status = if !runs_as_chat(&h.agent) {
                HelperStatus { state: HelperState::Problem, note: Some("needs_chat".to_string()), ..Default::default() }
            } else if !folder_ok(&h.project) {
                HelperStatus { state: HelperState::Problem, note: Some("folder_missing".to_string()), ..Default::default() }
            } else {
                statuses.get(&h.id).cloned().unwrap_or_default()
            };
            HelperEntry {
                id: h.id.clone(),
                name: h.name.clone(),
                agent: h.agent.clone(),
                model: h.model.clone(),
                project: h.project.clone(),
                after_task: h.after_task,
                home: h.home.clone(),
                used_by: status.used_by,
                taken_over: false,
                state: status.state,
                note: status.note,
                pane_id: status.pane_id,
                open_pane: status.open_pane,
                person_pane: None,
                warm: h.warm,
                stage: status.stage,
                stage_ms: status.stage_since_ms.map(|since| (crate::event_log::now_ms() - since).max(0)),
                used_today: status.used_today,
                skip_reason: status.skip_reason,
            }
        })
        .collect();
    HelpersView { helpers, max: store.settings.max, idle_minutes: store.settings.idle_minutes }
}

/// The view the app shows now.
pub fn view() -> HelpersView {
    let statuses = crate::acp::warm::pool().map(|pool| pool.helper_statuses()).unwrap_or_default();
    build_view(&file().snapshot(), &statuses, |agent| crate::acp::warm::LiveProbe.runs_as_chat(agent), |p| Path::new(p).is_dir())
}

#[cfg(test)]
#[path = "helpers_tests.rs"]
mod tests;
