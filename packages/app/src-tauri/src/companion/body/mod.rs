//! Body state of a companion (P2 of the fishd port): how it feels and what it carries between turns.
//!
//! - `mood`: mood, energy and hunger from the clock (pure `tick`)
//! - `selfstate`: boredom, longing, battery, plan, unsaid sentence, marks (max 8)
//! - `drives`: data-only rules with a threshold that wakes, resets or halves
//! - `presence`: the app's last heartbeat and how long it was away
//! - `pace`: how fast and how long a person usually writes
//! - `tip`: the one short block that goes to the companion
//!
//! Program state lives in the app data folder (`<root>/companions/<id>/state/`), next to `runtime.json`,
//! never in the person's home folder. Everything here is pure except `BodyState::open` and `save`, and
//! nothing runs unless the Labs switch `companion_vault_enabled` is on.

pub mod drives;
pub mod mood;
pub mod pace;
pub mod presence;
pub mod selfstate;
pub mod tip;

use std::path::{Path, PathBuf};

use chrono::{FixedOffset, TimeZone, Timelike, Utc};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::model::{BodyDriveView, BodyView, CompanionResult};
use super::store;

/// The local hour of an instant with its fraction (14.5 = 14:30).
pub fn local_hour(ms: i64, offset_secs: i32) -> f64 {
    let zone = FixedOffset::east_opt(offset_secs).unwrap_or_else(|| FixedOffset::east_opt(0).expect("zero offset"));
    let at = Utc.timestamp_millis_opt(ms).single().unwrap_or_default().with_timezone(&zone);
    f64::from(at.hour()) + f64::from(at.minute()) / 60.0 + f64::from(at.second()) / 3600.0
}

/// `<root>/companions/<id>/state`.
pub fn state_dir(root: &Path, id: &str) -> CompanionResult<PathBuf> {
    Ok(store::companion_dir(root, id)?.join("state"))
}

/// Everything the body keeps, in memory.
#[derive(Clone, Debug)]
pub struct BodyState {
    pub mood: mood::MoodState,
    pub me: selfstate::SelfState,
    pub drives: drives::DriveState,
    pub rules: Vec<drives::Rule>,
    pub pace: pace::PaceState,
    pub presence: presence::Presence,
    /// Set once, when this run started after a gap; the brief says it once.
    pub offline: Option<presence::Offline>,
    /// The last pace hint (a guess about the person's last message), kept for the tip.
    pub pace_hint: String,
}

const MOOD_FILE: &str = "mood.json";
const SELF_FILE: &str = "self.json";
const DRIVES_FILE: &str = "drives-state.json";
const RULES_FILE: &str = "drives-rules.json";
const PRESENCE_FILE: &str = "presence.json";
const PACE_FILE: &str = "pace.json";

/// Reads a JSON state file. A missing or damaged file is the default (the file is left as it is).
fn read_json<T: DeserializeOwned + Default>(dir: &Path, name: &str) -> T {
    store::read_optional(&dir.join(name))
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(dir: &Path, name: &str, value: &T) -> CompanionResult<()> {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    store::write_private_text(&dir.join(name), &format!("{text}\n"))
}

impl BodyState {
    /// Loads the state from `dir` (missing files start fresh) and marks this run as alive. The person's
    /// own rules file wins when it has at least one good rule; a damaged one falls back to the defaults.
    pub fn open(dir: &Path, now_ms: i64) -> BodyState {
        let mut mood: mood::MoodState = store::read_optional(&dir.join(MOOD_FILE))
            .ok()
            .flatten()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| mood::MoodState::new(now_ms));
        if mood.last_tick_ms <= 0 {
            mood.last_tick_ms = now_ms;
        }
        let rules = store::read_optional(&dir.join(RULES_FILE))
            .ok()
            .flatten()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .map(|v| drives::parse_rules(&v).0)
            .filter(|r| !r.is_empty())
            .unwrap_or_else(drives::default_rules);
        let mut drive_state: drives::DriveState = read_json(dir, DRIVES_FILE);
        if drive_state.last_tick_ms <= 0 {
            drive_state = drives::fresh_state(&rules, now_ms);
        }
        for rule in &rules {
            drive_state.values.entry(rule.name.clone()).or_insert(rule.start_value);
        }
        let prev: Option<presence::Presence> = store::read_optional(&dir.join(PRESENCE_FILE)).ok().flatten().and_then(|t| serde_json::from_str(&t).ok());
        let (presence, offline) = presence::mark_start(prev.as_ref(), now_ms);
        BodyState {
            mood,
            me: read_json(dir, SELF_FILE),
            drives: drive_state,
            rules,
            pace: read_json(dir, PACE_FILE),
            presence,
            offline,
            pace_hint: String::new(),
        }
    }

    /// Writes the state files (not the rules: those are the person's).
    pub fn save(&self, dir: &Path) -> CompanionResult<()> {
        write_json(dir, MOOD_FILE, &self.mood)?;
        write_json(dir, SELF_FILE, &self.me)?;
        write_json(dir, DRIVES_FILE, &self.drives)?;
        write_json(dir, PACE_FILE, &self.pace)?;
        write_json(dir, PRESENCE_FILE, &self.presence)
    }

    /// One slow step: mood, self and drives move with the clock. Returns the drives that just woke.
    pub fn tick(&mut self, now_ms: i64, offset: i32, sleeping: bool) -> Vec<String> {
        let physics = if sleeping { mood::SLEEPING_PHYSICS } else { mood::DEFAULT_PHYSICS };
        self.mood = mood::tick(&self.mood, now_ms, offset, &physics);
        self.me = selfstate::tick(&self.me, now_ms, sleeping);
        let (next, woke) = drives::tick(&self.drives, &self.rules, now_ms, offset, 0);
        self.drives = next;
        self.presence = presence::mark_alive(&self.presence, now_ms);
        woke
    }

    /// The person said something (`length` characters, answered after `latency_ms`).
    pub fn heard_person(&mut self, now_ms: i64, offset: i32, was_sleeping: bool, latency_ms: Option<i64>, length: u32) {
        self.mood = mood::on_message(&self.mood, &mood::DEFAULT_PHYSICS);
        self.me = selfstate::touch(&self.me, now_ms, was_sleeping);
        self.drives = drives::note_message(&self.drives, &self.rules, offset).0;
        let point = pace::PacePoint { at_ms: now_ms, latency_ms: latency_ms.unwrap_or(0).max(0), length };
        let hour = local_hour(now_ms, offset) as u32;
        self.pace_hint = pace::hint(&self.pace, "person", &point, hour);
        self.pace = pace::add(&self.pace, "person", point);
    }

    /// The companion handled these drive wakes by reaching out.
    pub fn reached_out(&mut self, names: &[String], now_ms: i64) {
        self.drives = drives::acknowledge(&self.drives, names, &self.rules);
        self.me = selfstate::reach_out(&self.me, now_ms);
    }

    /// What the card shows. Whole numbers only.
    pub fn view(&self, sleeping: bool) -> BodyView {
        let whole = |v: f64| v.round().clamp(0.0, 100.0) as u8;
        BodyView {
            mood: self.mood.mood.word().to_string(),
            intensity: self.mood.intensity.clamp(1, 3),
            energy: whole(self.mood.energy),
            hunger: whole(self.mood.hunger),
            boredom: whole(self.me.boredom),
            longing: whole(self.me.longing),
            battery: whole(self.me.battery),
            drives: self
                .rules
                .iter()
                .map(|r| BodyDriveView {
                    name: r.name.clone(),
                    value: self.drives.values.get(&r.name).copied().unwrap_or(r.start_value).round().max(0.0) as u32,
                    max: r.max.round() as u32,
                    threshold: r.threshold.round() as u32,
                    waiting: self.drives.pending_wake.contains(&r.name),
                })
                .collect(),
            away_minutes: self.offline.as_ref().map(|o| o.minutes.max(0) as u32),
            sleeping,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("pm-body-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_fresh_body_has_defaults_and_writes_nothing_until_saved() {
        let d = dir();
        let body = BodyState::open(&d, 1_000);
        assert_eq!(body.rules, drives::default_rules());
        assert!(body.offline.is_none());
        assert!(std::fs::read_dir(&d).unwrap().next().is_none(), "open() does not write");
    }

    #[test]
    fn mood_and_drives_survive_a_restart() {
        let d = dir();
        let mut body = BodyState::open(&d, 1_000);
        body.mood.mood = mood::Mood::Sleepy;
        body.mood.override_until_ms = Some(i64::MAX);
        body.drives.values.insert("Missing you".into(), 33.0);
        body.save(&d).unwrap();
        let again = BodyState::open(&d, 1_000 + 10 * 60_000);
        assert_eq!(again.mood.mood, mood::Mood::Sleepy);
        assert_eq!(again.drives.values["Missing you"], 33.0);
        assert_eq!(again.offline.as_ref().map(|o| o.minutes), Some(10), "the gap between two runs");
    }

    #[test]
    fn a_damaged_file_falls_back_to_the_default_and_a_bad_rules_file_to_the_default_rules() {
        let d = dir();
        std::fs::write(d.join("mood.json"), "{ not json").unwrap();
        std::fs::write(d.join("drives-rules.json"), "{\"rules\": [ {\"name\": \"!!\"} ]}").unwrap();
        let body = BodyState::open(&d, 5);
        assert_eq!(body.mood.mood, mood::Mood::Genki);
        assert_eq!(body.rules, drives::default_rules());
    }

    #[test]
    fn the_persons_own_rules_are_used() {
        let d = dir();
        std::fs::write(
            d.join("drives-rules.json"),
            r#"{"rules":[{"name":"Curious","startValue":5,"gainPerHour":2,"max":40,"threshold":30,"onThreshold":"wake"}]}"#,
        )
        .unwrap();
        let body = BodyState::open(&d, 5);
        assert_eq!(body.rules.len(), 1);
        assert_eq!(body.drives.values["Curious"], 5.0);
    }

    #[test]
    fn a_person_message_lifts_energy_lowers_longing_and_trains_the_pace() {
        let d = dir();
        let mut body = BodyState::open(&d, 0);
        body.me.longing = 60.0;
        let energy = body.mood.energy;
        body.heard_person(60_000, 0, false, Some(5_000), 30);
        assert!(body.mood.energy > energy);
        assert!(body.me.longing < 60.0);
        assert_eq!(body.pace.people["person"].len(), 1);
    }

    #[test]
    fn the_view_is_whole_numbers_and_lists_the_drives() {
        let body = BodyState::open(&dir(), 0);
        let view = body.view(false);
        assert_eq!(view.mood, "genki");
        assert_eq!(view.drives.len(), 3);
        assert_eq!(view.drives[0].name, "Missing you");
        assert!(view.away_minutes.is_none());
    }

    #[test]
    fn local_hour_follows_the_offset() {
        assert_eq!(local_hour(0, 0), 0.0);
        assert_eq!(local_hour(0, 3600 * 8), 8.0);
        assert_eq!(local_hour(30 * 60_000, 0), 0.5);
    }
}
