//! Pace: how fast and how long a person usually writes, so a sudden change reads as "they seem tired".
//! Ported from fishd `src/persona/reading.ts` (`paceAdd`, `paceHint`). Every hint is a guess and says so.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const MAX_POINTS: usize = 20;
pub const MAX_PEOPLE: usize = 50;
/// A hint needs this many earlier samples.
pub const MIN_SAMPLES: usize = 6;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PacePoint {
    pub at_ms: i64,
    /// How long the person took to answer (ms).
    pub latency_ms: i64,
    /// Characters written.
    pub length: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct PaceState {
    pub people: BTreeMap<String, Vec<PacePoint>>,
}

fn last_seen(points: &[PacePoint]) -> i64 {
    points.last().map_or(i64::MIN, |p| p.at_ms)
}

/// Adds a sample. The newest `MAX_POINTS` are kept; past `MAX_PEOPLE` the person seen longest ago goes.
/// An empty id is refused (nothing changes).
pub fn add(state: &PaceState, person: &str, point: PacePoint) -> PaceState {
    if person.trim().is_empty() {
        return state.clone();
    }
    let mut people = state.people.clone();
    let list = people.entry(person.to_string()).or_default();
    list.push(point);
    let over = list.len().saturating_sub(MAX_POINTS);
    list.drain(..over);
    while people.len() > MAX_PEOPLE {
        let Some(oldest) = people.iter().min_by_key(|(_, pts)| last_seen(pts)).map(|(k, _)| k.clone()) else { break };
        people.remove(&oldest);
    }
    PaceState { people }
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    }
}

/// One line about the latest message compared with this person's usual pace, or empty.
pub fn hint(state: &PaceState, person: &str, latest: &PacePoint, local_hour: u32) -> String {
    let Some(earlier) = state.people.get(person).filter(|e| e.len() >= MIN_SAMPLES) else { return String::new() };
    let med_len = median(&earlier.iter().map(|p| f64::from(p.length)).collect::<Vec<_>>());
    let med_lat = median(&earlier.iter().map(|p| p.latency_ms as f64).collect::<Vec<_>>());
    let shorter = f64::from(latest.length) < 0.4 * med_len;
    let slower = med_lat > 0.0 && latest.latency_ms as f64 > 3.0 * med_lat;
    if shorter || slower {
        let reason = if local_hour <= 5 { "it is late, they may be tired" } else { "they may be tired or busy" };
        return format!("Their last messages are shorter or slower than usual; my guess: {reason}. It does not mean they want to be left alone.");
    }
    let fast = med_lat > 0.0 && (latest.latency_ms as f64) < 0.5 * med_lat;
    if fast && f64::from(latest.length) > 2.0 * med_len {
        return "They are writing more than usual today; my guess: good mood or something to say.".to_string();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(at: i64, latency: i64, length: u32) -> PacePoint {
        PacePoint { at_ms: at, latency_ms: latency, length }
    }

    fn steady(n: usize) -> PaceState {
        (0..n).fold(PaceState::default(), |s, i| add(&s, "p", pt(i as i64, 10_000, 40)))
    }

    #[test]
    fn only_the_newest_twenty_samples_are_kept() {
        let s = steady(30);
        let list = &s.people["p"];
        assert_eq!(list.len(), MAX_POINTS);
        assert_eq!(list[0].at_ms, 10);
    }

    #[test]
    fn the_person_seen_longest_ago_is_dropped_past_fifty() {
        let mut s = PaceState::default();
        for i in 0..52 {
            s = add(&s, &format!("p{i}"), pt(i, 1, 1));
        }
        assert_eq!(s.people.len(), MAX_PEOPLE);
        assert!(!s.people.contains_key("p0") && !s.people.contains_key("p1"));
        assert!(s.people.contains_key("p51"));
    }

    #[test]
    fn an_empty_person_id_changes_nothing() {
        assert_eq!(add(&PaceState::default(), "  ", pt(0, 1, 1)), PaceState::default());
    }

    #[test]
    fn too_few_samples_give_no_hint() {
        assert_eq!(hint(&steady(5), "p", &pt(99, 90_000, 2), 14), "");
        assert_eq!(hint(&steady(8), "nobody", &pt(99, 90_000, 2), 14), "");
    }

    #[test]
    fn a_short_or_slow_message_reads_as_tired_and_says_it_is_a_guess() {
        let s = steady(8);
        let short = hint(&s, "p", &pt(99, 10_000, 5), 14);
        assert!(short.contains("my guess") && short.contains("tired or busy"), "{short}");
        let slow = hint(&s, "p", &pt(99, 60_000, 40), 3);
        assert!(slow.contains("it is late"), "{slow}");
    }

    #[test]
    fn a_fast_long_message_reads_as_good_mood_and_a_normal_one_says_nothing() {
        let s = steady(8);
        assert!(hint(&s, "p", &pt(99, 2_000, 120), 14).contains("good mood"));
        assert_eq!(hint(&s, "p", &pt(99, 10_000, 40), 14), "");
    }
}
