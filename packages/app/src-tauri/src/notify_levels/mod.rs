//! Notification levels: how loud each agent is, quiet hours, and the 30-minute snooze. The choices live on this
//! computer (one small json file) and ONE filter, `decide`, sits in front of every alert that leaves
//! (`push::dispatch`: phone, Telegram, Discord).
//!
//! Rules (same as `src/lib/notify-levels.ts`):
//! - A high-risk approval or a consent card ALWAYS notifies. Level, quiet hours and snooze do not stop it.
//! - Then the agent's level, then quiet hours, then the snooze on this card.
//! - A filtered alert is only not SENT. The Inbox count comes from the attention list and never changes.
//! Nothing here names an agent: the caller passes the key it looked up from the pane registry.

use crate::push::triggers::Kind;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[cfg(test)]
mod tests;

/// How long a snoozed card stays quiet.
pub const SNOOZE_MS: u64 = 30 * 60_000;
const MAX_SNOOZES: usize = 256;
const MAX_BELLS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BellLevel {
    #[default]
    Everything,
    Needs,
    Finished,
    Silent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct QuietHours {
    pub enabled: bool,
    /// Minutes after midnight, 0 to 1439.
    pub start: u32,
    pub end: u32,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self { enabled: false, start: 22 * 60, end: 7 * 60 }
    }
}

impl QuietHours {
    /// Inside the window? It may cross midnight (22:00 to 07:00). Equal start and end is never quiet.
    pub fn contains(&self, minute: u32) -> bool {
        if !self.enabled || self.start == self.end {
            return false;
        }
        if self.start < self.end {
            minute >= self.start && minute < self.end
        } else {
            minute >= self.start || minute < self.end
        }
    }

    fn clamped(self) -> Self {
        Self { enabled: self.enabled, start: self.start.min(1439), end: self.end.min(1439) }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    /// One level per bell key (an agent id, or `helper:<id>`). Missing = the default for that kind of agent.
    pub bells: BTreeMap<String, BellLevel>,
    pub quiet: QuietHours,
    /// Card or pane key -> the time (ms) its snooze ends.
    pub snoozes: BTreeMap<String, u64>,
    /// The old browser-storage choices were moved here (once).
    pub imported: bool,
}

/// What the filter needs to know about one alert.
#[derive(Debug, Clone)]
pub struct Alert<'a> {
    pub kind: Kind,
    pub high_risk: bool,
    /// The bell key of the agent it came from; `None` for a card that belongs to no agent.
    pub bell_key: Option<&'a str>,
    /// A helper starts at "Only when it needs me".
    pub is_helper: bool,
    /// Every key a snooze may have been set on (card id, pane id, queue key).
    pub snooze_keys: &'a [&'a str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Risky,
    Level,
    QuietHours,
    Snoozed,
    Shown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub notify: bool,
    pub reason: Reason,
}

impl Prefs {
    /// The level for a bell key: the saved choice, else the default (a helper is quieter).
    pub fn level_for(&self, key: Option<&str>, is_helper: bool) -> BellLevel {
        key.and_then(|k| self.bells.get(k).copied()).unwrap_or(if is_helper { BellLevel::Needs } else { BellLevel::Everything })
    }

    pub fn snoozed(&self, keys: &[&str], now_ms: u64) -> bool {
        keys.iter().any(|k| self.snoozes.get(*k).is_some_and(|until| *until > now_ms))
    }
}

/// Does this level want this kind of alert? A failed run is both something to look at and a finished run.
pub fn level_wants(level: BellLevel, kind: Kind) -> bool {
    let needs = matches!(
        kind,
        Kind::WaitingInput | Kind::Error | Kind::Question | Kind::TrustGate | Kind::Consent | Kind::Budget | Kind::Limit | Kind::RunFailed
    );
    let finished = matches!(kind, Kind::RunFinished | Kind::RunFailed);
    match level {
        BellLevel::Everything => true,
        BellLevel::Needs => needs,
        BellLevel::Finished => finished,
        BellLevel::Silent => false,
    }
}

/// The one decision for one alert. Pure: the time comes in as arguments.
pub fn decide(prefs: &Prefs, alert: &Alert<'_>, minute_of_day: u32, now_ms: u64) -> Decision {
    // These two never come through this filter: a companion reply has its own switch, the morning push is one line.
    if matches!(alert.kind, Kind::CompanionReply | Kind::NightShift) {
        return Decision { notify: true, reason: Reason::Shown };
    }
    if alert.high_risk || alert.kind == Kind::Consent {
        return Decision { notify: true, reason: Reason::Risky };
    }
    if !level_wants(prefs.level_for(alert.bell_key, alert.is_helper), alert.kind) {
        return Decision { notify: false, reason: Reason::Level };
    }
    if prefs.quiet.contains(minute_of_day) {
        return Decision { notify: false, reason: Reason::QuietHours };
    }
    if prefs.snoozed(alert.snooze_keys, now_ms) {
        return Decision { notify: false, reason: Reason::Snoozed };
    }
    Decision { notify: true, reason: Reason::Shown }
}

/// The choices on disk, behind a lock.
pub struct Store {
    path: PathBuf,
    prefs: Mutex<Option<Prefs>>,
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self { path, prefs: Mutex::new(None) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Prefs) -> T) -> T {
        let mut guard = self.prefs.lock();
        let prefs = guard.get_or_insert_with(|| std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default());
        f(prefs)
    }

    fn save(&self, prefs: &Prefs) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(prefs) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    fn change(&self, f: impl FnOnce(&mut Prefs)) -> Prefs {
        self.with(|p| {
            f(p);
            p.imported = true;
            self.save(p);
            p.clone()
        })
    }

    pub fn get(&self) -> Prefs {
        self.with(|p| p.clone())
    }

    pub fn set_bell(&self, key: &str, level: BellLevel) -> Prefs {
        let key = key.trim();
        if key.is_empty() || key.len() > 120 {
            return self.get();
        }
        self.change(|p| {
            if p.bells.len() < MAX_BELLS || p.bells.contains_key(key) {
                p.bells.insert(key.to_string(), level);
            }
        })
    }

    pub fn set_quiet(&self, quiet: QuietHours) -> Prefs {
        self.change(|p| p.quiet = quiet.clamped())
    }

    /// Snooze these keys for `SNOOZE_MS` from `now_ms`. Returns the end time with the new choices.
    pub fn snooze(&self, keys: &[String], now_ms: u64) -> (u64, Prefs) {
        let until = now_ms + SNOOZE_MS;
        let prefs = self.change(|p| {
            p.snoozes.retain(|_, end| *end > now_ms);
            for key in keys.iter().map(|k| k.trim()).filter(|k| !k.is_empty() && k.len() <= 200) {
                if p.snoozes.len() < MAX_SNOOZES || p.snoozes.contains_key(key) {
                    p.snoozes.insert(key.to_string(), until);
                }
            }
        });
        (until, prefs)
    }

    /// Take over the old browser-storage choices, once. Does nothing after the first save or import.
    pub fn import_once(&self, bells: BTreeMap<String, BellLevel>, quiet: QuietHours) -> Prefs {
        if self.get().imported {
            return self.get();
        }
        self.change(|p| {
            p.bells.extend(bells.into_iter().take(MAX_BELLS));
            p.quiet = quiet.clamped();
        })
    }
}

static STORE: once_cell::sync::Lazy<Store> = once_cell::sync::Lazy::new(|| Store::new(crate::app_paths::app_data_dir().join("notify-levels.json")));

pub fn store() -> &'static Store {
    &STORE
}

/// Local minutes after midnight.
pub fn local_minute_of_day() -> u32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

/// The filter on the real choices and the real clock. `true` = send it.
pub fn allows(alert: &Alert<'_>, now_ms: u64) -> bool {
    let decision = decide(&store().get(), alert, local_minute_of_day(), now_ms);
    if !decision.notify {
        tracing::debug!(reason = ?decision.reason, kind = ?alert.kind, "alert held back by the notification levels");
    }
    decision.notify
}
