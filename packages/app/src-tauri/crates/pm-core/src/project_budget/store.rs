//! The limits of each project and the counters of the day, in one small file.

use super::gate::{raise_step, status_of, Status};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// What a project may use in a day. `None` = no limit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(default)]
    pub turns_per_day: Option<u32>,
    #[serde(default)]
    pub minutes_per_day: Option<u32>,
    /// The agent's plan may have used this much (1-100) before new turns wait.
    #[serde(default)]
    pub plan_percent: Option<u32>,
}

impl Limits {
    pub fn any(&self) -> bool {
        self.turns_per_day.is_some() || self.minutes_per_day.is_some() || self.plan_percent.is_some()
    }

    /// 0 or nothing means no limit; numbers are kept inside sensible bounds.
    pub fn clamped(&self) -> Limits {
        let keep = |v: Option<u32>, max: u32| v.filter(|n| *n > 0).map(|n| n.min(max));
        Limits {
            turns_per_day: keep(self.turns_per_day, super::MAX_TURNS),
            minutes_per_day: keep(self.minutes_per_day, super::MAX_MINUTES),
            plan_percent: keep(self.plan_percent, 100),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    #[serde(default)]
    pub limits: Limits,
    /// The local day the counters below belong to (`YYYY-MM-DD`).
    #[serde(default)]
    pub day: String,
    #[serde(default)]
    pub turns: u32,
    #[serde(default)]
    pub ms: u64,
}

impl Entry {
    /// Turns and busy milliseconds on `today` (zero when the counters are from another day).
    pub fn used_on(&self, today: &str) -> (u32, u64) {
        if self.day == today {
            (self.turns, self.ms)
        } else {
            (0, 0)
        }
    }

    fn roll(&mut self, today: &str) {
        if self.day != today {
            self.day = today.to_string();
            self.turns = 0;
            self.ms = 0;
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    projects: BTreeMap<String, Entry>,
}

pub struct Store {
    path: Option<PathBuf>,
    data: Mutex<Data>,
}

impl Store {
    pub fn in_memory() -> Self {
        Self { path: None, data: Mutex::new(Data::default()) }
    }

    pub fn at(path: &Path) -> Self {
        let data = std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
        Self { path: Some(path.to_path_buf()), data: Mutex::new(data) }
    }

    fn save(&self, data: &Data) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match serde_json::to_vec_pretty(data) {
            Ok(bytes) => {
                if let Err(error) = std::fs::write(path, bytes) {
                    tracing::debug!(%error, "project budgets not saved");
                }
            }
            Err(error) => tracing::debug!(%error, "project budgets not saved"),
        }
    }

    pub fn limits(&self, key: &str) -> Limits {
        self.data.lock().projects.get(key).map(|e| e.limits.clone()).unwrap_or_default()
    }

    pub fn set_limits(&self, key: &str, limits: Limits) {
        let mut data = self.data.lock();
        let entry = data.projects.entry(key.to_string()).or_default();
        entry.limits = limits;
        // A project with nothing set is not kept.
        if !entry.limits.any() {
            data.projects.remove(key);
        }
        self.save(&data);
    }

    pub fn status(&self, key: &str, today: &str, plan_percent: Option<f64>) -> Status {
        let data = self.data.lock();
        match data.projects.get(key) {
            Some(entry) => status_of(entry, today, plan_percent),
            None => status_of(&Entry::default(), today, plan_percent),
        }
    }

    /// Nothing is counted for a project nobody limited: no file, no growth.
    pub fn add_turn(&self, key: &str, today: &str) {
        let mut data = self.data.lock();
        let Some(entry) = data.projects.get_mut(key) else { return };
        entry.roll(today);
        entry.turns = entry.turns.saturating_add(1);
        self.save(&data);
    }

    pub fn add_ms(&self, key: &str, today: &str, ms: u64) {
        let mut data = self.data.lock();
        let Some(entry) = data.projects.get_mut(key) else { return };
        entry.roll(today);
        entry.ms = entry.ms.saturating_add(ms);
        self.save(&data);
    }

    pub fn raise(&self, key: &str, today: &str, plan_percent: Option<f64>) {
        let mut data = self.data.lock();
        let Some(entry) = data.projects.get_mut(key) else { return };
        let status = status_of(entry, today, plan_percent);
        entry.limits = raise_step(&entry.limits, &status, plan_percent);
        self.save(&data);
    }
}
