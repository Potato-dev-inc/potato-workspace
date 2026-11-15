//! Presence: was the app away, and for how long? Ported from fishd `src/persona/presence.ts`.
//!
//! `state/presence.json` holds the last time the app was seen alive. At a start the gap since then
//! (3 minutes or more) is the time the companion "was away", which goes into the brief once.

use serde::{Deserialize, Serialize};

use super::super::schedule;

/// A gap shorter than this is not worth mentioning.
pub const MIN_GAP_MINUTES: i64 = 3;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Presence {
    pub running: bool,
    pub started_ms: i64,
    pub last_alive_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offline {
    pub from_ms: i64,
    pub to_ms: i64,
    pub minutes: i64,
    /// The last run said goodbye (it was closed the normal way).
    pub clean: bool,
}

/// Called once when the app starts. Returns the gap since the previous run was last seen and the new
/// presence (this run, alive).
pub fn mark_start(prev: Option<&Presence>, now_ms: i64) -> (Presence, Option<Offline>) {
    let offline = prev.filter(|p| p.last_alive_ms > 0).and_then(|p| {
        let minutes = (now_ms - p.last_alive_ms) / 60_000;
        (minutes >= MIN_GAP_MINUTES).then_some(Offline { from_ms: p.last_alive_ms, to_ms: now_ms, minutes, clean: !p.running })
    });
    (Presence { running: true, started_ms: now_ms, last_alive_ms: now_ms }, offline)
}

/// A cheap heartbeat. Keeps the start time of this run.
pub fn mark_alive(prev: &Presence, now_ms: i64) -> Presence {
    Presence { running: true, started_ms: if prev.started_ms == 0 { now_ms } else { prev.started_ms }, last_alive_ms: now_ms }
}

/// A normal shutdown.
#[allow(dead_code)] // a clean shutdown hook is not wired yet; the gap text then says "stopped suddenly"
pub fn mark_stop(prev: &Presence, now_ms: i64) -> Presence {
    Presence { running: false, last_alive_ms: now_ms, ..prev.clone() }
}

fn duration_text(minutes: i64) -> String {
    if minutes > 120 {
        format!("{:.1} hours", minutes as f64 / 60.0)
    } else {
        format!("{minutes} minutes")
    }
}

/// One sentence about an absence, for the brief. Empty when there was none.
pub fn render(offline: Option<&Offline>, now_ms: i64, offset: i32) -> String {
    let Some(o) = offline else { return String::new() };
    let clock = |ms: i64| {
        if schedule::today_key(ms, offset) == schedule::today_key(now_ms, offset) {
            schedule::clock_text(ms, offset)
        } else {
            schedule::day_clock_text(ms, offset)
        }
    };
    let how = if o.clean { "the app was closed normally" } else { "it looks like the app stopped suddenly" };
    format!(
        "You were away from {} to {} (about {}): {how}. You saw no messages in that time.",
        clock(o.from_ms),
        clock(o.to_ms),
        duration_text(o.minutes)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    #[test]
    fn a_first_start_has_no_gap_and_is_marked_alive() {
        let (p, gap) = mark_start(None, 10 * MIN);
        assert!(gap.is_none());
        assert!(p.running);
        assert_eq!(p.started_ms, 10 * MIN);
    }

    #[test]
    fn a_short_gap_is_not_worth_saying() {
        let prev = Presence { running: true, started_ms: 1, last_alive_ms: 100 * MIN };
        assert!(mark_start(Some(&prev), 102 * MIN).1.is_none());
    }

    #[test]
    fn a_long_gap_says_how_long_and_whether_it_ended_cleanly() {
        let sudden = Presence { running: true, started_ms: 1, last_alive_ms: 100 * MIN };
        let gap = mark_start(Some(&sudden), 250 * MIN).1.unwrap();
        assert_eq!((gap.minutes, gap.clean), (150, false));
        let stopped = mark_stop(&sudden, 100 * MIN);
        assert!(mark_start(Some(&stopped), 250 * MIN).1.unwrap().clean);
    }

    #[test]
    fn the_heartbeat_keeps_the_start_time() {
        let p = Presence { running: true, started_ms: 5, last_alive_ms: 5 };
        let next = mark_alive(&p, 99);
        assert_eq!((next.started_ms, next.last_alive_ms), (5, 99));
        assert_eq!(mark_alive(&Presence::default(), 7).started_ms, 7);
    }

    #[test]
    fn the_sentence_is_plain_and_empty_without_a_gap() {
        assert_eq!(render(None, 0, 0), "");
        let gap = Offline { from_ms: 0, to_ms: 150 * MIN, minutes: 150, clean: false };
        let line = render(Some(&gap), 150 * MIN, 0);
        assert!(line.contains("about 2.5 hours") && line.contains("stopped suddenly"), "{line}");
        let short = Offline { minutes: 45, ..gap };
        assert!(render(Some(&short), 150 * MIN, 0).contains("45 minutes"));
    }
}
