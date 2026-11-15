//! "Leaving my desk": one switch that hands the day to the phone, and "I'm back" that ends all of it.
//!
//! While it is on:
//! - **The phone may use the agents** (only when the person set it on the PC): an agent a phone could only watch
//!   or answer in (its pane rule) counts as "everything" for the phone, the same effect as pressing "Allow for 15
//!   minutes" on every agent, for the chosen time. Nothing else widens: a phone still needs its own ability
//!   (`Caps`), an agent that is switched off for phones stays off, and the bridge's sign-in is unchanged.
//!   A switch a phone flips itself (`By::Phone`) does not lift anything: only the person at the PC may
//!   widen what the phone can do ("Ask the PC for control" stays the way for that).
//! - **"Needs you" reaches the phone** whatever the bell levels, quiet hours or snooze say (`wants_push`).
//! - **Agents keep running.** Nothing here touches them.
//! - **Screen control is locked** when asked (`screen_locked`): agents cannot use the browser on this PC.
//!
//! The state is kept in `desk-away.json` next to the pairing file, with its end time, so it ends on time even
//! when the app was closed in between. "Until I'm back" has no end time: only "I'm back" (or the phone) ends it.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How long the day is handed over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Length {
    UntilBack,
    OneHour,
    FourHours,
    /// Until 06:00 in the morning (this PC's clock).
    Tonight,
}

impl Length {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.trim() {
            "until_back" => Ok(Length::UntilBack),
            "one_hour" => Ok(Length::OneHour),
            "four_hours" => Ok(Length::FourHours),
            "tonight" => Ok(Length::Tonight),
            other => Err(format!("unknown length {other:?}")),
        }
    }
}

/// Who flipped the switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum By {
    Pc,
    Phone,
}

/// One running "away".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Away {
    pub started_ms: u64,
    /// `None`: until the person says they are back.
    pub until_ms: Option<u64>,
    pub length: Length,
    pub by: By,
    /// Agents may not use the browser on this PC meanwhile.
    pub lock_screen: bool,
    /// Phone name that flipped it, when `by` is `Phone`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

impl Away {
    fn running(&self, now: u64) -> bool {
        self.until_ms.map_or(true, |until| until > now)
    }
}

/// The time "tonight" ends: the next 06:00 after `now_ms`, from the PC's clock.
pub fn tonight_end(now_ms: u64) -> u64 {
    use chrono::{Duration, Local, TimeZone};
    let now = Local.timestamp_millis_opt(now_ms as i64).single().unwrap_or_else(Local::now);
    let six = |date: chrono::NaiveDate| date.and_hms_opt(6, 0, 0).and_then(|t| Local.from_local_datetime(&t).earliest());
    let today = six(now.date_naive()).filter(|t| *t > now);
    let at = today.or_else(|| six(now.date_naive() + Duration::days(1))).unwrap_or(now + Duration::hours(10));
    at.timestamp_millis().max(0) as u64
}

/// When `length` ends if it starts at `now`.
pub fn ends_at(length: Length, now: u64, tonight: u64) -> Option<u64> {
    match length {
        Length::UntilBack => None,
        Length::OneHour => Some(now + 60 * 60 * 1000),
        Length::FourHours => Some(now + 4 * 60 * 60 * 1000),
        Length::Tonight => Some(tonight),
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Desk {
    #[serde(default)]
    away: Option<Away>,
}

impl Desk {
    /// Start (or replace) the away. A running one is replaced, never stacked.
    pub fn start(&mut self, length: Length, lock_screen: bool, by: By, device_name: Option<String>, now: u64) -> Away {
        let away = Away { started_ms: now, until_ms: ends_at(length, now, tonight_end(now)), length, by, lock_screen, device_name };
        self.away = Some(away.clone());
        away
    }

    /// The away that is running at `now`.
    pub fn active(&self, now: u64) -> Option<&Away> {
        self.away.as_ref().filter(|a| a.running(now))
    }

    /// "I'm back". `true` when something was running.
    pub fn back(&mut self) -> bool {
        self.away.take().is_some()
    }

    /// Drop an away whose time is over. `true` when one was dropped.
    pub fn settle(&mut self, now: u64) -> bool {
        if self.away.as_ref().is_some_and(|a| !a.running(now)) {
            self.away = None;
            return true;
        }
        false
    }

    fn load(path: &Path) -> Self {
        std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("write {}: {e}", path.display()))
    }
}

static DESK: once_cell::sync::Lazy<RwLock<Desk>> = once_cell::sync::Lazy::new(Default::default);
static DESK_PATH: once_cell::sync::OnceCell<PathBuf> = once_cell::sync::OnceCell::new();

/// Load the state that sits next to the pairing file (called when the bridge starts).
pub fn init(pairing_file: &Path) {
    let path = pairing_file.with_file_name("desk-away.json");
    if DESK_PATH.set(path.clone()).is_ok() {
        let mut desk = DESK.write();
        // Something started before the file was known stays (a test may); otherwise the file decides.
        if desk.away.is_none() {
            *desk = Desk::load(&path);
        }
        desk.settle(super::control_ask::now_ms());
    }
}

fn persist(desk: &Desk) {
    if let Some(path) = DESK_PATH.get() {
        if let Err(error) = desk.save(path) {
            tracing::warn!(%error, "could not save the away state");
        }
    }
}

/// Switch it on. A write that fails still leaves it on in memory (the person asked for it).
pub fn start(length: Length, lock_screen: bool, by: By, device_name: Option<String>) -> Away {
    let mut desk = DESK.write();
    let away = desk.start(length, lock_screen, by, device_name, super::control_ask::now_ms());
    persist(&desk);
    away
}

/// "I'm back": everything ends at once. A failed write still ends it in memory (the safe side).
pub fn back() -> bool {
    let mut desk = DESK.write();
    let was = desk.back();
    persist(&desk);
    was
}

/// The running away at `now` (an away whose time is over is gone).
pub fn current_at(now: u64) -> Option<Away> {
    if DESK.read().away.as_ref().is_some_and(|a| !a.running(now)) {
        let mut desk = DESK.write();
        if desk.settle(now) {
            persist(&desk);
        }
    }
    DESK.read().active(now).cloned()
}

/// Whether the person set the away on the PC and it runs now: a phone's pane rules are lifted to "everything".
pub fn lifts_levels(now: u64) -> bool {
    current_at(now).is_some_and(|a| a.by == By::Pc)
}

/// Whether "needs you" must reach the phone whatever the bell levels say.
pub fn wants_push(now: u64) -> bool {
    current_at(now).is_some()
}

/// Whether agents are locked out of the PC's screen-control features (the browser).
pub fn screen_locked() -> bool {
    current_at(super::control_ask::now_ms()).is_some_and(|a| a.lock_screen)
}

/// The event the PC's screen and the phone's refresh on when the switch changes.
pub const AWAY_EVENT: &str = "desk://away";

/// What the PC's status bar and the phone show: `{ away, length, started_ms, until_ms, by, lock_screen,
/// device_name, phones }`. `phones` is how many phones are paired (they are the ones that get control).
pub fn status_json(now: u64) -> serde_json::Value {
    let phones = super::pairing_store().map(|store| store.lock().list_devices().len()).unwrap_or(0);
    match current_at(now) {
        Some(a) => serde_json::json!({
            "away": true,
            "length": a.length,
            "started_ms": a.started_ms,
            "until_ms": a.until_ms,
            "by": a.by,
            "lock_screen": a.lock_screen,
            "device_name": a.device_name,
            "phones": phones,
        }),
        None => serde_json::json!({ "away": false, "lock_screen": false, "phones": phones }),
    }
}

#[cfg(test)]
#[path = "desk_away_tests.rs"]
mod tests;
