//! Mood: how the companion feels, from time and rest. Ported from fishd `src/persona/mood.ts`.
//!
//! Energy and hunger move with the clock (`tick`), the mood is derived from them with a little
//! hysteresis (`derive`), and a short override (`apply_patch`) lets the companion or the app set a
//! mood for a while. Every function is pure: the caller passes the time.
//!
//! Not ported on purpose: the tease/praise word lists (they are Chinese phrases tied to the fish) and
//! the affect/chronotype hooks of the mind roadmap.

use serde::{Deserialize, Serialize};

use super::local_hour;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mood {
    Sleepy,
    Hungry,
    #[default]
    Genki,
    Tsundere,
}

impl Mood {
    pub const ALL: [Mood; 4] = [Mood::Sleepy, Mood::Hungry, Mood::Genki, Mood::Tsundere];

    pub fn word(self) -> &'static str {
        match self {
            Mood::Sleepy => "sleepy",
            Mood::Hungry => "hungry",
            Mood::Genki => "genki",
            Mood::Tsundere => "tsundere",
        }
    }
}

/// How long a patch holds a mood by the wall clock.
#[allow(dead_code)] // used by `apply_patch`, which the bot brain (P3) calls
pub const OVERRIDE_MS: i64 = 20 * 60_000;
const HOUR_MS: f64 = 3_600_000.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct MoodState {
    pub mood: Mood,
    /// 1..=3
    pub intensity: u8,
    /// 0..=100
    pub energy: f64,
    /// 0..=100
    pub hunger: f64,
    pub last_tick_ms: i64,
    pub last_change_ms: i64,
    /// A patch holds the mood until this time (epoch ms).
    pub override_until_ms: Option<i64>,
}

impl Default for MoodState {
    fn default() -> Self {
        MoodState::new(0)
    }
}

impl MoodState {
    pub fn new(now_ms: i64) -> Self {
        MoodState {
            mood: Mood::Genki,
            intensity: 2,
            energy: 62.0,
            hunger: 30.0,
            last_tick_ms: now_ms,
            last_change_ms: now_ms,
            override_until_ms: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Physics {
    pub sleep_start: f64,
    pub sleep_end: f64,
    pub energy_per_sleep_hour: f64,
    pub energy_per_awake_hour: f64,
    pub hunger_per_sleep_hour: f64,
    pub hunger_per_awake_hour: f64,
    pub energy_per_message: f64,
    /// A machine that was off for a month does not feel a month.
    pub max_gap_hours: f64,
}

pub const DEFAULT_PHYSICS: Physics = Physics {
    sleep_start: 1.0,
    sleep_end: 7.0,
    energy_per_sleep_hour: 1.6,
    energy_per_awake_hour: -2.4,
    hunger_per_sleep_hour: 1.5,
    hunger_per_awake_hour: 4.0,
    energy_per_message: 5.0,
    max_gap_hours: 72.0,
};

/// When the companion chose to sleep, every hour counts as rest.
pub const SLEEPING_PHYSICS: Physics = Physics { sleep_start: 0.0, sleep_end: 24.0, hunger_per_sleep_hour: 0.4, ..DEFAULT_PHYSICS };

fn clamp(n: f64) -> f64 {
    n.clamp(0.0, 100.0)
}

/// Hours of `hours` (from `from_ms`) that fall in the sleep window, sampled every 15 minutes.
fn sleep_hours(from_ms: i64, hours: f64, offset: i32, p: &Physics) -> f64 {
    let end = from_ms as f64 + hours * HOUR_MS;
    let step = 15.0 * 60_000.0;
    let (mut asleep, mut total, mut t) = (0.0, 0.0, from_ms as f64);
    while t < end {
        let h = local_hour(t as i64, offset);
        total += step;
        if h >= p.sleep_start && h < p.sleep_end {
            asleep += step;
        }
        t += step;
    }
    if total == 0.0 {
        0.0
    } else {
        asleep / total * hours
    }
}

/// Moves energy and hunger by the time that passed, then derives the mood again.
pub fn tick(s: &MoodState, now_ms: i64, offset: i32, physics: &Physics) -> MoodState {
    let raw = (now_ms - s.last_tick_ms) as f64 / HOUR_MS;
    if raw <= 0.0 {
        return s.clone();
    }
    let hours = raw.min(physics.max_gap_hours);
    let slept = sleep_hours(s.last_tick_ms, hours, offset, physics);
    let awake = hours - slept;
    let next = MoodState {
        energy: clamp(s.energy + slept * physics.energy_per_sleep_hour + awake * physics.energy_per_awake_hour),
        hunger: clamp(s.hunger + slept * physics.hunger_per_sleep_hour + awake * physics.hunger_per_awake_hour),
        last_tick_ms: now_ms,
        ..s.clone()
    };
    derive(&next, now_ms, offset)
}

fn scores(s: &MoodState, hour: f64) -> [f64; 4] {
    let sleepy = if s.energy < 35.0 { (35.0 - s.energy) / 35.0 * 2.2 } else { 0.0 }
        + if !(6.0..22.0).contains(&hour) { 1.1 } else { 0.0 }
        + if !(5.0..23.0).contains(&hour) { 0.5 } else { 0.0 };
    let hungry = if s.hunger > 45.0 { (s.hunger - 45.0) / 55.0 * 2.4 } else { 0.0 }
        + if (11.5..13.5).contains(&hour) { 0.9 } else { 0.0 }
        + if (17.5..19.5).contains(&hour) { 0.6 } else { 0.0 };
    let genki = if s.energy > 50.0 { (s.energy - 50.0) / 50.0 * 1.8 } else { 0.0 }
        + if (6.0..11.0).contains(&hour) { 0.7 } else { 0.0 }
        + if (18.0..22.0).contains(&hour) { 0.6 } else { 0.0 };
    // A low resting baseline: tsundere is a reaction (a patch), not a resting state.
    let tsundere = 0.2 - if !(25.0..=85.0).contains(&s.energy) { 1.2 } else { 0.0 } - if s.hunger > 80.0 { 0.6 } else { 0.0 };
    [sleepy, hungry, genki, tsundere]
}

fn index(m: Mood) -> usize {
    match m {
        Mood::Sleepy => 0,
        Mood::Hungry => 1,
        Mood::Genki => 2,
        Mood::Tsundere => 3,
    }
}

fn intensity_for(score: f64) -> u8 {
    if score >= 2.2 {
        3
    } else if score >= 1.4 {
        2
    } else {
        1
    }
}

pub fn override_active(s: &MoodState, now_ms: i64) -> bool {
    s.override_until_ms.is_some_and(|until| now_ms < until)
}

/// Derives the mood again unless a patch is still holding. A new mood needs a clear win (hysteresis).
pub fn derive(s: &MoodState, now_ms: i64, offset: i32) -> MoodState {
    if override_active(s, now_ms) {
        return s.clone();
    }
    let sc = scores(s, local_hour(now_ms, offset));
    let mut mood = s.mood;
    let mut best = sc[index(mood)];
    for m in Mood::ALL {
        if m != mood && sc[index(m)] > best + 0.25 {
            mood = m;
            best = sc[index(m)];
        }
    }
    let intensity = intensity_for(best);
    if mood == s.mood {
        return MoodState { intensity, ..s.clone() };
    }
    MoodState { mood, intensity, last_change_ms: now_ms, override_until_ms: None, ..s.clone() }
}

/// Each message from the person wakes the companion up a little.
pub fn on_message(s: &MoodState, physics: &Physics) -> MoodState {
    MoodState { energy: clamp(s.energy + physics.energy_per_message), ..s.clone() }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[allow(dead_code)] // the bot brain (P3) sets a mood with it
pub struct MoodPatch {
    pub hunger: Option<f64>,
    pub energy: Option<f64>,
    pub mood: Option<Mood>,
    pub intensity: Option<u8>,
}

/// Applies a patch. Numbers are clamped and non-finite ones ignored; a mood change holds like a nudge.
#[allow(dead_code)] // the bot brain (P3) sets a mood with it
pub fn apply_patch(s: &MoodState, patch: &MoodPatch, now_ms: i64, offset: i32) -> MoodState {
    let mut next = s.clone();
    if let Some(h) = patch.hunger.filter(|v| v.is_finite()) {
        next.hunger = clamp(h);
    }
    if let Some(e) = patch.energy.filter(|v| v.is_finite()) {
        next.energy = clamp(e);
    }
    let want_mood = patch.mood.unwrap_or(next.mood);
    let want_intensity = patch.intensity.filter(|i| (1..=3).contains(i)).unwrap_or(next.intensity);
    if want_mood != next.mood || want_intensity != next.intensity {
        next.mood = want_mood;
        next.intensity = want_intensity;
        next.last_change_ms = now_ms;
        next.override_until_ms = Some(now_ms + OVERRIDE_MS);
    }
    derive(&next, now_ms, offset)
}

fn time_band(hour: f64) -> &'static str {
    match hour {
        h if h < 5.0 => "late night",
        h if h < 7.0 => "early morning",
        h if h < 11.0 => "morning",
        h if h < 13.5 => "midday",
        h if h < 17.5 => "afternoon",
        h if h < 21.0 => "evening",
        _ => "night",
    }
}

fn effect(m: Mood) -> &'static str {
    match m {
        Mood::Sleepy => "replies get shorter, it rarely starts a new topic",
        Mood::Hungry => "a little empty inside, the talk drifts toward food",
        Mood::Genki => "quick and chatty, it starts topics",
        Mood::Tsundere => "teasing on the outside, caring on the inside",
    }
}

/// The mood as an effect, never as numbers: the agent needs the consequence, not "energy: 74".
pub fn render(s: &MoodState, now_ms: i64, offset: i32) -> String {
    let strength = match s.intensity {
        3 => " (strong)",
        1 => " (light)",
        _ => "",
    };
    format!("You feel {}: {}{strength}. It is {}.", s.mood.word(), effect(s.mood), time_band(local_hour(now_ms, offset)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> i64 {
        chrono::Utc.with_ymd_and_hms(2026, 11, 15, h, m, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn a_working_day_drains_energy_and_fills_hunger() {
        let s = MoodState { energy: 80.0, hunger: 10.0, ..MoodState::new(at(8, 0)) };
        let next = tick(&s, at(12, 0), 0, &DEFAULT_PHYSICS);
        assert!(next.energy < 80.0 - 9.0 && next.energy > 60.0, "energy {}", next.energy);
        assert!(next.hunger > 10.0 + 15.0, "hunger {}", next.hunger);
        assert_eq!(next.last_tick_ms, at(12, 0));
    }

    #[test]
    fn sleeping_hours_restore_energy() {
        let s = MoodState { energy: 20.0, hunger: 20.0, ..MoodState::new(at(1, 0)) };
        let next = tick(&s, at(7, 0), 0, &DEFAULT_PHYSICS);
        assert!(next.energy > 20.0 + 8.0, "energy {}", next.energy);
        let sleeping = tick(&s, at(7, 0), 0, &SLEEPING_PHYSICS);
        assert!(sleeping.hunger < next.hunger + 0.01, "chosen sleep is gentler on hunger");
    }

    #[test]
    fn a_gap_is_capped_and_time_going_backwards_changes_nothing() {
        let s = MoodState::new(at(8, 0));
        let far = tick(&s, at(8, 0) + 400 * 3_600_000, 0, &DEFAULT_PHYSICS);
        assert!((0.0..=100.0).contains(&far.energy) && (0.0..=100.0).contains(&far.hunger));
        assert_eq!(tick(&s, at(7, 0), 0, &DEFAULT_PHYSICS), s);
    }

    #[test]
    fn night_and_low_energy_make_it_sleepy_and_noon_hunger_makes_it_hungry() {
        let tired = MoodState { energy: 10.0, hunger: 30.0, mood: Mood::Genki, ..MoodState::new(at(23, 0)) };
        assert_eq!(derive(&tired, at(23, 30), 0).mood, Mood::Sleepy);
        let lunch = MoodState { energy: 45.0, hunger: 90.0, ..MoodState::new(at(12, 0)) };
        assert_eq!(derive(&lunch, at(12, 0), 0).mood, Mood::Hungry);
    }

    #[test]
    fn hysteresis_needs_a_clear_win_to_switch() {
        // Genki and hungry are nearly level: the current mood stays.
        let s = MoodState { mood: Mood::Genki, energy: 70.0, hunger: 62.0, ..MoodState::new(at(15, 0)) };
        assert_eq!(derive(&s, at(15, 0), 0).mood, Mood::Genki);
    }

    #[test]
    fn a_patch_holds_for_twenty_minutes_then_lets_go() {
        let s = MoodState { energy: 90.0, ..MoodState::new(at(9, 0)) };
        let p = apply_patch(&s, &MoodPatch { mood: Some(Mood::Sleepy), intensity: Some(3), ..Default::default() }, at(9, 0), 0);
        assert_eq!((p.mood, p.intensity), (Mood::Sleepy, 3));
        assert_eq!(derive(&p, at(9, 10), 0).mood, Mood::Sleepy, "still held");
        assert_ne!(derive(&p, at(9, 21), 0).mood, Mood::Sleepy, "released and derived again");
    }

    #[test]
    fn patch_numbers_are_clamped_and_junk_is_ignored() {
        let s = MoodState::new(at(9, 0));
        let p = apply_patch(&s, &MoodPatch { hunger: Some(900.0), energy: Some(f64::NAN), intensity: Some(9), ..Default::default() }, at(9, 0), 0);
        assert_eq!(p.hunger, 100.0);
        assert_eq!(p.energy, s.energy);
        assert!(p.override_until_ms.is_none(), "a bad intensity is not a mood change");
    }

    #[test]
    fn messages_add_energy_up_to_the_top() {
        let s = MoodState { energy: 98.0, ..MoodState::new(0) };
        assert_eq!(on_message(&s, &DEFAULT_PHYSICS).energy, 100.0);
    }

    #[test]
    fn render_names_the_effect_not_the_numbers() {
        let line = render(&MoodState { mood: Mood::Sleepy, intensity: 3, ..MoodState::new(0) }, at(23, 0), 0);
        assert!(line.contains("sleepy") && line.contains("(strong)") && line.contains("night"), "{line}");
        assert!(!line.chars().any(|c| c.is_ascii_digit()), "{line}");
    }

    #[test]
    fn the_state_survives_a_json_round_trip() {
        let s = MoodState { mood: Mood::Hungry, override_until_ms: Some(5), ..MoodState::new(7) };
        let back: MoodState = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        let partial: MoodState = serde_json::from_str("{\"mood\":\"sleepy\"}").unwrap();
        assert_eq!(partial.mood, Mood::Sleepy);
    }
}
