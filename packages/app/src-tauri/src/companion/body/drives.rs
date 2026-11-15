//! Drives: numbers the companion carries between turns (missing someone, hunger, wanting a pat). Ported
//! from fishd `src/persona/stats.ts`.
//!
//! A drive is DATA: a rule with a name, a start value, a gain per hour, an optional gain per message from
//! the person, a maximum and a threshold. When it reaches the threshold it does one of three things:
//! `wake` (wait to be handled), `reset` (back to zero) or `halve`. Nothing here is ever run as code. The
//! rules are edited by the person (`state/drives-rules.json`); the companion never changes them.
//!
//! A wake is only a candidate for a check-in: the service sends it through the same gates as a scheduled
//! check-in (the 2 h rule and the daily cap).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::local_hour;

pub const MAX_RULES: usize = 12;
pub const MAX_NAME_CHARS: usize = 20;
pub const MAX_GAIN_ABS: f64 = 200.0;
pub const MAX_VALUE_LIMIT: f64 = 1000.0;
pub const MAX_ELAPSED_HOURS: f64 = 48.0;
const HOUR_MS: i64 = 3_600_000;
/// Quiet window: local 01:00 up to (not including) 06:00.
const QUIET_START: f64 = 1.0;
const QUIET_END: f64 = 6.0;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnThreshold {
    Wake,
    Reset,
    Halve,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub name: String,
    pub start_value: f64,
    pub gain_per_hour: f64,
    #[serde(default)]
    pub gain_on_user_message: Option<f64>,
    pub max: f64,
    pub threshold: f64,
    pub on_threshold: OnThreshold,
    #[serde(default)]
    pub record_peak: bool,
    /// 0..=1, applied to the gain per hour during the quiet window.
    #[serde(default)]
    pub quiet_hours_gain: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Peak {
    pub value: f64,
    pub at_ms: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct DriveState {
    pub values: BTreeMap<String, f64>,
    pub peaks: BTreeMap<String, Peak>,
    pub last_tick_ms: i64,
    pub pending_wake: Vec<String>,
}

/// Why a rule was refused, one plain line per rule.
pub type RuleErrors = Vec<String>;

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

fn name_ok(name: &str) -> bool {
    let n = name.chars().count();
    (1..=MAX_NAME_CHARS).contains(&n) && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == ' ' || c == '-')
}

/// Checks untrusted rule data. A bad rule is dropped with an error; this never panics.
pub fn parse_rules(raw: &Value) -> (Vec<Rule>, RuleErrors) {
    let mut rules: Vec<Rule> = Vec::new();
    let mut errors = Vec::new();
    let list = match raw {
        Value::Array(list) => list.clone(),
        Value::Object(o) => match o.get("rules") {
            Some(Value::Array(list)) => list.clone(),
            _ => {
                errors.push("rules must be a list".to_string());
                return (rules, errors);
            }
        },
        _ => {
            errors.push("rules must be a list".to_string());
            return (rules, errors);
        }
    };
    for (i, entry) in list.iter().enumerate() {
        let where_ = format!("rule {i}");
        let Some(e) = entry.as_object() else {
            errors.push(format!("{where_}: not an object"));
            continue;
        };
        if rules.len() >= MAX_RULES {
            errors.push(format!("{where_}: over the limit of {MAX_RULES} rules, dropped"));
            continue;
        }
        let name = e.get("name").and_then(Value::as_str).unwrap_or("");
        if !name_ok(name) {
            errors.push(format!("{where_}: the name must be 1-{MAX_NAME_CHARS} letters, digits, space, _ or -"));
            continue;
        }
        if rules.iter().any(|r| r.name == name) {
            errors.push(format!("{where_}: duplicate name \"{name}\", dropped"));
            continue;
        }
        let Some(max) = e.get("max").and_then(finite).filter(|m| *m > 0.0 && *m <= MAX_VALUE_LIMIT) else {
            errors.push(format!("{where_} ({name}): max must be above 0 and at most {MAX_VALUE_LIMIT}"));
            continue;
        };
        let Some(threshold) = e.get("threshold").and_then(finite).filter(|t| *t > 0.0 && *t <= max) else {
            errors.push(format!("{where_} ({name}): threshold must be above 0 and at most max"));
            continue;
        };
        let (Some(start), Some(gain)) = (e.get("startValue").and_then(finite), e.get("gainPerHour").and_then(finite)) else {
            errors.push(format!("{where_} ({name}): startValue and gainPerHour must be numbers"));
            continue;
        };
        let on_threshold = match e.get("onThreshold").and_then(Value::as_str) {
            Some("wake") => OnThreshold::Wake,
            Some("reset") => OnThreshold::Reset,
            Some("halve") => OnThreshold::Halve,
            _ => {
                errors.push(format!("{where_} ({name}): onThreshold must be wake, reset or halve"));
                continue;
            }
        };
        let gain_on_user_message = match e.get("gainOnUserMessage") {
            None | Some(Value::Null) => None,
            Some(v) => match finite(v) {
                Some(n) => Some(n.clamp(-MAX_GAIN_ABS, MAX_GAIN_ABS)),
                None => {
                    errors.push(format!("{where_} ({name}): gainOnUserMessage must be a number"));
                    continue;
                }
            },
        };
        let quiet_hours_gain = match e.get("quietHoursGain") {
            None | Some(Value::Null) => None,
            Some(v) => match finite(v).filter(|q| (0.0..=1.0).contains(q)) {
                Some(q) => Some(q),
                None => {
                    errors.push(format!("{where_} ({name}): quietHoursGain must be between 0 and 1"));
                    continue;
                }
            },
        };
        rules.push(Rule {
            name: name.to_string(),
            start_value: start.clamp(0.0, max),
            gain_per_hour: gain.clamp(-MAX_GAIN_ABS, MAX_GAIN_ABS),
            gain_on_user_message,
            max,
            threshold,
            on_threshold,
            record_peak: e.get("recordPeak").and_then(Value::as_bool).unwrap_or(false),
            quiet_hours_gain,
        });
    }
    (rules, errors)
}

/// The rules a companion starts with.
pub fn default_rules() -> Vec<Rule> {
    vec![
        Rule {
            name: "Missing you".into(),
            start_value: 0.0,
            gain_per_hour: 4.0,
            gain_on_user_message: Some(-10.0),
            max: 80.0,
            threshold: 70.0,
            on_threshold: OnThreshold::Wake,
            record_peak: true,
            quiet_hours_gain: Some(0.5),
        },
        Rule {
            name: "Hunger".into(),
            start_value: 10.0,
            gain_per_hour: 3.0,
            gain_on_user_message: None,
            max: 50.0,
            threshold: 40.0,
            on_threshold: OnThreshold::Reset,
            record_peak: false,
            quiet_hours_gain: Some(0.3),
        },
        Rule {
            name: "Wants a pat".into(),
            start_value: 0.0,
            gain_per_hour: 2.0,
            gain_on_user_message: Some(8.0),
            max: 60.0,
            threshold: 50.0,
            on_threshold: OnThreshold::Halve,
            record_peak: true,
            quiet_hours_gain: None,
        },
    ]
}

/// A state with every drive at its start value.
pub fn fresh_state(rules: &[Rule], now_ms: i64) -> DriveState {
    DriveState {
        values: rules.iter().map(|r| (r.name.clone(), r.start_value)).collect(),
        peaks: BTreeMap::new(),
        last_tick_ms: now_ms,
        pending_wake: Vec::new(),
    }
}

/// Splits `[start, end)` into hours inside and outside the local quiet window.
fn split_hours(start_ms: i64, end_ms: i64, offset: i32) -> (f64, f64) {
    let (mut normal, mut quiet) = (0.0, 0.0);
    let mut t = start_ms;
    while t < end_ms {
        let hour = local_hour(t, offset);
        // The next whole local hour after `t`.
        let into_hour_ms = ((hour.fract()) * HOUR_MS as f64) as i64;
        let next = (t - into_hour_ms + HOUR_MS).max(t + 1);
        let seg_end = next.min(end_ms);
        let hours = (seg_end - t) as f64 / HOUR_MS as f64;
        if (QUIET_START..QUIET_END).contains(&hour) {
            quiet += hours;
        } else {
            normal += hours;
        }
        t = seg_end;
    }
    (normal, quiet)
}

/// Advances every rule to `now_ms`. Elapsed time is capped at 48 hours so a long absence does not fill
/// every drive in one jump. `woke` lists the drives that crossed their threshold on this tick; a drive
/// already waiting is not reported again until it is acknowledged.
pub fn tick(state: &DriveState, rules: &[Rule], now_ms: i64, offset: i32, user_messages: u32) -> (DriveState, Vec<String>) {
    let start = state.last_tick_ms.min(now_ms);
    let end = now_ms.min(start + (MAX_ELAPSED_HOURS as i64) * HOUR_MS);
    let (normal, quiet) = split_hours(start, end, offset);

    let mut values = BTreeMap::new();
    let mut peaks = state.peaks.clone();
    let mut pending: Vec<String> = state.pending_wake.iter().filter(|n| rules.iter().any(|r| &r.name == *n)).cloned().collect();
    let mut woke = Vec::new();
    for rule in rules {
        let prev = state.values.get(&rule.name).copied().unwrap_or(rule.start_value);
        let mut v = prev + rule.gain_per_hour * (normal + quiet * rule.quiet_hours_gain.unwrap_or(1.0))
            + rule.gain_on_user_message.unwrap_or(0.0) * f64::from(user_messages);
        v = v.clamp(0.0, rule.max);
        if rule.record_peak && peaks.get(&rule.name).is_none_or(|p| v > p.value) {
            peaks.insert(rule.name.clone(), Peak { value: v, at_ms: now_ms });
        }
        if v >= rule.threshold {
            match rule.on_threshold {
                OnThreshold::Wake => {
                    if !pending.contains(&rule.name) {
                        pending.push(rule.name.clone());
                        woke.push(rule.name.clone());
                    }
                }
                OnThreshold::Reset => {
                    v = 0.0;
                    woke.push(rule.name.clone());
                }
                OnThreshold::Halve => {
                    v /= 2.0;
                    woke.push(rule.name.clone());
                }
            }
        }
        values.insert(rule.name.clone(), v);
    }
    (DriveState { values, peaks, last_tick_ms: now_ms, pending_wake: pending }, woke)
}

/// The person said something: only the per-message gain applies and no time passes.
pub fn note_message(state: &DriveState, rules: &[Rule], offset: i32) -> (DriveState, Vec<String>) {
    tick(state, rules, state.last_tick_ms, offset, 1)
}

/// The companion handled the named wakes. A `wake` drive that stays above its threshold would fire again
/// at the next tick, so handling it halves it (the app's own choice: fishd leaves it where it was).
pub fn acknowledge(state: &DriveState, names: &[String], rules: &[Rule]) -> DriveState {
    let mut next = state.clone();
    next.pending_wake.retain(|n| !names.contains(n));
    for rule in rules.iter().filter(|r| names.contains(&r.name) && state.pending_wake.contains(&r.name)) {
        if let Some(v) = next.values.get_mut(&rule.name) {
            match rule.on_threshold {
                OnThreshold::Reset => *v = 0.0,
                OnThreshold::Halve | OnThreshold::Wake => *v /= 2.0,
            }
        }
    }
    next
}

/// One compact line: `Missing you 62/80; Hunger 12/50`.
pub fn render(state: &DriveState, rules: &[Rule]) -> String {
    rules
        .iter()
        .map(|r| format!("{} {}/{}", r.name, state.values.get(&r.name).copied().unwrap_or(r.start_value).round(), r.max))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn at(h: u32) -> i64 {
        chrono::Utc.with_ymd_and_hms(2026, 11, 15, h, 0, 0).unwrap().timestamp_millis()
    }

    fn rule(name: &str, gain: f64, threshold: f64, on: OnThreshold) -> Rule {
        Rule {
            name: name.into(),
            start_value: 0.0,
            gain_per_hour: gain,
            gain_on_user_message: None,
            max: 100.0,
            threshold,
            on_threshold: on,
            record_peak: false,
            quiet_hours_gain: None,
        }
    }

    #[test]
    fn a_drive_grows_by_the_hour_and_stops_at_its_max() {
        let rules = vec![rule("a", 10.0, 90.0, OnThreshold::Wake)];
        let s = fresh_state(&rules, at(8));
        let (s, woke) = tick(&s, &rules, at(11), 0, 0);
        assert_eq!(s.values["a"], 30.0);
        assert!(woke.is_empty());
        let (s, _) = tick(&s, &rules, at(23), 0, 0);
        assert_eq!(s.values["a"], 100.0, "capped at max");
    }

    #[test]
    fn crossing_the_threshold_wakes_once_until_it_is_handled() {
        let rules = vec![rule("a", 10.0, 50.0, OnThreshold::Wake)];
        let s = fresh_state(&rules, at(8));
        let (s, woke) = tick(&s, &rules, at(14), 0, 0);
        assert_eq!(woke, vec!["a".to_string()]);
        assert_eq!(s.pending_wake, vec!["a".to_string()]);
        let (s, woke) = tick(&s, &rules, at(15), 0, 0);
        assert!(woke.is_empty(), "already waiting: not reported again");
        assert_eq!(s.pending_wake.len(), 1);
        let s = acknowledge(&s, &["a".to_string()], &rules);
        assert!(s.pending_wake.is_empty());
        assert!(s.values["a"] < 50.0, "handling it takes the edge off: {}", s.values["a"]);
    }

    #[test]
    fn reset_and_halve_act_on_the_value_at_once() {
        let rules = vec![rule("r", 10.0, 50.0, OnThreshold::Reset), rule("h", 10.0, 50.0, OnThreshold::Halve)];
        let (s, woke) = tick(&fresh_state(&rules, at(8)), &rules, at(14), 0, 0);
        assert_eq!(s.values["r"], 0.0);
        assert_eq!(s.values["h"], 30.0);
        assert_eq!(woke.len(), 2);
        assert!(s.pending_wake.is_empty(), "only wake waits");
    }

    #[test]
    fn the_quiet_window_slows_the_gain() {
        let mut r = rule("q", 10.0, 90.0, OnThreshold::Wake);
        r.quiet_hours_gain = Some(0.5);
        let rules = vec![r];
        // 00:00 to 06:00 is 1 normal hour (00-01) and 5 quiet hours (01-06): 10 + 25.
        let (s, _) = tick(&fresh_state(&rules, at(0)), &rules, at(6), 0, 0);
        assert!((s.values["q"] - 35.0).abs() < 0.001, "{}", s.values["q"]);
    }

    #[test]
    fn a_message_can_lower_or_raise_a_drive_without_time_passing() {
        let mut r = rule("m", 0.0, 90.0, OnThreshold::Wake);
        r.start_value = 50.0;
        r.gain_on_user_message = Some(-10.0);
        let rules = vec![r];
        let s = fresh_state(&rules, at(8));
        let (s, _) = note_message(&s, &rules, 0);
        assert_eq!(s.values["m"], 40.0);
        assert_eq!(s.last_tick_ms, at(8), "the clock did not move");
    }

    #[test]
    fn a_long_absence_is_capped_at_two_days() {
        let rules = vec![rule("a", 1.0, 1000.0, OnThreshold::Wake)];
        let mut rules = rules;
        rules[0].max = 1000.0;
        let (s, _) = tick(&fresh_state(&rules, at(8)), &rules, at(8) + 30 * 24 * HOUR_MS, 0, 0);
        assert!((s.values["a"] - 48.0).abs() < 0.001, "{}", s.values["a"]);
    }

    #[test]
    fn peaks_are_recorded_only_when_asked() {
        let mut r = rule("p", 10.0, 90.0, OnThreshold::Wake);
        r.record_peak = true;
        let rules = vec![r, rule("n", 10.0, 90.0, OnThreshold::Wake)];
        let (s, _) = tick(&fresh_state(&rules, at(8)), &rules, at(11), 0, 0);
        assert_eq!(s.peaks["p"].value, 30.0);
        assert!(!s.peaks.contains_key("n"));
    }

    #[test]
    fn rules_from_a_file_are_checked_not_trusted() {
        let (rules, errors) = parse_rules(&json!({ "rules": [
            { "name": "ok", "startValue": 0, "gainPerHour": 2, "max": 50, "threshold": 40, "onThreshold": "wake" },
            { "name": "bad name!", "startValue": 0, "gainPerHour": 2, "max": 50, "threshold": 40, "onThreshold": "wake" },
            { "name": "over", "startValue": 0, "gainPerHour": 2, "max": 50, "threshold": 90, "onThreshold": "wake" },
            { "name": "how", "startValue": 0, "gainPerHour": 2, "max": 50, "threshold": 40, "onThreshold": "run" },
            { "name": "ok", "startValue": 0, "gainPerHour": 2, "max": 50, "threshold": 40, "onThreshold": "reset" },
            "junk"
        ]}));
        assert_eq!(rules.len(), 1);
        assert_eq!(errors.len(), 5, "{errors:?}");
        assert!(parse_rules(&json!(7)).0.is_empty());
    }

    #[test]
    fn at_most_twelve_rules_are_kept_and_gains_are_clamped() {
        let many: Vec<Value> = (0..15)
            .map(|i| json!({ "name": format!("d{i}"), "startValue": 500, "gainPerHour": 9999, "max": 100, "threshold": 50, "onThreshold": "wake" }))
            .collect();
        let (rules, errors) = parse_rules(&Value::Array(many));
        assert_eq!(rules.len(), MAX_RULES);
        assert_eq!(errors.len(), 3);
        assert_eq!(rules[0].gain_per_hour, MAX_GAIN_ABS);
        assert_eq!(rules[0].start_value, 100.0);
    }

    #[test]
    fn the_default_rules_pass_their_own_checks() {
        let json = serde_json::to_value(default_rules()).unwrap();
        let (rules, errors) = parse_rules(&json);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(rules, default_rules());
    }

    #[test]
    fn render_is_one_short_line() {
        let rules = default_rules();
        let line = render(&fresh_state(&rules, 0), &rules);
        assert_eq!(line, "Missing you 0/80; Hunger 10/50; Wants a pat 0/60");
    }
}
