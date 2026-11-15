//! Self: the slow inner life that is not mood. Ported (reduced) from fishd `src/persona/self.ts`.
//!
//! Boredom and longing rise while nobody talks to the companion; a message from the person lowers
//! them. A small battery drains in busy rooms. The companion may keep a plan, an unsaid sentence and
//! up to eight small marks. "Sleeping" is not stored here: it is `Runtime::sleeping`, the one flag the
//! keeper already owns, and it is passed in.

use serde::{Deserialize, Serialize};

#[allow(dead_code)] // `apply` (the `::state` line of the bot brain, P3) uses these
pub const MAX_MARKS: usize = 8;
#[allow(dead_code)]
const NOTE_CAP: usize = 40;
#[allow(dead_code)]
const PENDING_CAP: usize = 120;
#[allow(dead_code)]
const TOPIC_CAP: usize = 80;
const MIN_MS: f64 = 60_000.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub at_ms: i64,
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub at_ms: i64,
    pub topic: String,
    pub why: String,
    pub deferred: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SelfState {
    /// 0..=100, rises when nobody talks.
    pub boredom: f64,
    /// 0..=100, keeps growing while the person is away; only partly drains when it reaches out.
    pub longing: f64,
    /// 0..=100 social battery.
    pub battery: f64,
    pub last_seen_ms: Option<i64>,
    pub last_tick_ms: Option<i64>,
    pub woke_ms: Option<i64>,
    pub plan: Option<Plan>,
    /// Something it wanted to say and did not.
    pub pending: Option<String>,
    /// Newest last, at most `MAX_MARKS`.
    pub marks: Vec<Mark>,
}

impl Default for SelfState {
    fn default() -> Self {
        SelfState { boredom: 20.0, longing: 0.0, battery: 80.0, last_seen_ms: None, last_tick_ms: None, woke_ms: None, plan: None, pending: None, marks: Vec::new() }
    }
}

fn clamp(n: f64) -> f64 {
    n.clamp(0.0, 100.0)
}

/// Advances the slow metabolism. `last_tick_ms` makes it safe to call from anywhere: the same minute is
/// never counted twice and a machine that was off for a day catches up once.
pub fn tick(s: &SelfState, now_ms: i64, sleeping: bool) -> SelfState {
    let Some(last) = s.last_tick_ms else {
        return SelfState { last_tick_ms: Some(now_ms), ..s.clone() };
    };
    let minutes = ((now_ms - last) as f64 / MIN_MS).max(0.0);
    if minutes == 0.0 {
        return s.clone();
    }
    let near = s.last_seen_ms.is_some_and(|seen| now_ms - seen < 5 * 60_000);
    let (boredom_rate, longing_rate) = if sleeping { (0.1, 0.08) } else { (0.35, 0.18) };
    let refill = if sleeping { 0.3 } else { 0.15 };
    SelfState {
        boredom: clamp(s.boredom + if near { 0.0 } else { minutes * boredom_rate }),
        longing: clamp(s.longing + if near { 0.0 } else { minutes * longing_rate }),
        battery: if near { s.battery } else { clamp(s.battery + minutes.min(10.0) * refill) },
        last_tick_ms: Some(now_ms),
        ..s.clone()
    }
}

/// A message from the person: boredom and longing drop a lot, and a sleeping companion wakes.
pub fn touch(s: &SelfState, now_ms: i64, was_sleeping: bool) -> SelfState {
    SelfState {
        last_seen_ms: Some(now_ms),
        last_tick_ms: Some(now_ms),
        woke_ms: if was_sleeping { Some(now_ms) } else { s.woke_ms },
        boredom: clamp(s.boredom - 25.0),
        longing: clamp(s.longing - 45.0),
        ..s.clone()
    }
}

/// It reaches out itself: the pressure drops, but not to zero.
pub fn reach_out(s: &SelfState, now_ms: i64) -> SelfState {
    SelfState { longing: clamp(s.longing - 15.0), last_tick_ms: Some(now_ms), ..s.clone() }
}

/// One message in a room where `speakers` different people talked in the last ten minutes.
#[allow(dead_code)] // the bot brain (P3) drains it in a busy room
pub fn drain_battery(s: &SelfState, speakers: u32) -> SelfState {
    let amount = match speakers {
        0 | 1 => 0.1,
        2 => 0.5,
        3 => 1.2,
        _ => 2.0,
    };
    SelfState { battery: clamp(s.battery - amount), ..s.clone() }
}

#[derive(Clone, Debug, Default, PartialEq)]
#[allow(dead_code)] // the bot brain (P3) fills it from the `::state` line
pub struct SelfPatch {
    pub boredom: Option<f64>,
    pub longing: Option<f64>,
    pub pending: Option<Option<String>>,
    pub mark: Option<String>,
    pub clear_marks: bool,
    pub plan_minutes: Option<f64>,
    pub plan_topic: Option<String>,
    pub plan_why: Option<String>,
    pub clear_plan: bool,
    pub plan_defer_minutes: Option<f64>,
}

#[allow(dead_code)]
fn one_line(text: &str, cap: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(cap).collect()
}

/// Applies what the companion decided about itself. Returns the new state and plain log lines.
#[allow(dead_code)] // the bot brain (P3) applies what the model decided about itself
pub fn apply(s: &SelfState, patch: &SelfPatch, now_ms: i64) -> (SelfState, Vec<String>) {
    let mut next = s.clone();
    let mut log = Vec::new();
    if let Some(b) = patch.boredom.filter(|v| v.is_finite()) {
        next.boredom = clamp(b);
        log.push(format!("boredom={}", next.boredom.round()));
    }
    if let Some(l) = patch.longing.filter(|v| v.is_finite()) {
        next.longing = clamp(l);
        log.push(format!("longing={}", next.longing.round()));
    }
    if let Some(pending) = &patch.pending {
        let text = pending.as_deref().map(|t| one_line(t, PENDING_CAP)).unwrap_or_default();
        if text.is_empty() {
            next.pending = None;
            log.push("let go of an unsaid sentence".to_string());
        } else {
            log.push(format!("keeping in mind: {text}"));
            next.pending = Some(text);
        }
    }
    if patch.clear_marks {
        next.marks.clear();
        log.push("wiped the marks".to_string());
    }
    if let Some(mark) = &patch.mark {
        let note = one_line(mark, NOTE_CAP);
        if !note.is_empty() {
            next.marks.push(Mark { at_ms: now_ms, note: note.clone() });
            let over = next.marks.len().saturating_sub(MAX_MARKS);
            next.marks.drain(..over);
            log.push(format!("left a mark: {note}"));
        }
    }
    if patch.clear_plan {
        next.plan = None;
        log.push("dropped the plan".to_string());
    } else if let (Some(minutes), Some(plan)) = (patch.plan_defer_minutes.filter(|m| m.is_finite()), next.plan.as_mut()) {
        let minutes = minutes.clamp(1.0, 2880.0);
        plan.at_ms = now_ms + (minutes * MIN_MS) as i64;
        plan.deferred += 1;
        log.push(format!("pushed the plan back {} min", minutes.round()));
    } else if let Some(minutes) = patch.plan_minutes.filter(|m| m.is_finite() && *m > 0.0) {
        let topic = one_line(patch.plan_topic.as_deref().unwrap_or(""), TOPIC_CAP);
        if !topic.is_empty() {
            let minutes = minutes.clamp(1.0, 2880.0);
            next.plan = Some(Plan {
                at_ms: now_ms + (minutes * MIN_MS) as i64,
                topic: topic.clone(),
                why: one_line(patch.plan_why.as_deref().unwrap_or(""), TOPIC_CAP),
                deferred: 0,
            });
            log.push(format!("plans to talk about \"{topic}\" in {} min", minutes.round()));
        }
    }
    (next, log)
}

#[allow(dead_code)] // the bot brain (P3) asks whether a plan is due
pub fn plan_due(s: &SelfState, now_ms: i64) -> bool {
    s.plan.as_ref().is_some_and(|p| p.at_ms <= now_ms)
}

/// Woke up less than `minutes` ago and is awake now.
pub fn groggy(s: &SelfState, now_ms: i64, sleeping: bool, minutes: i64) -> bool {
    !sleeping && s.woke_ms.is_some_and(|w| (0..minutes * 60_000).contains(&(now_ms - w)))
}

fn longing_band(v: f64) -> &'static str {
    if v >= 80.0 {
        "misses your person a lot"
    } else if v >= 50.0 {
        "misses your person"
    } else if v >= 20.0 {
        "misses your person a little"
    } else {
        ""
    }
}

fn ago(ms: i64) -> String {
    let mins = (ms / 60_000).max(0);
    if mins < 60 {
        format!("{mins} min ago")
    } else {
        format!("{} h ago", (mins as f64 / 60.0).round())
    }
}

/// One compact line for the prompt tail. Empty when there is nothing to say.
pub fn render(s: &SelfState, now_ms: i64, sleeping: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    if sleeping {
        parts.push("you are asleep".to_string());
    }
    if groggy(s, now_ms, sleeping, 20) {
        parts.push("you just woke up, a bit groggy: keep it short".to_string());
    }
    if s.boredom >= 60.0 {
        parts.push("a bit bored".to_string());
    } else if s.boredom <= 10.0 {
        parts.push("feeling lively".to_string());
    }
    if s.battery < 25.0 {
        parts.push("social battery is low".to_string());
    }
    let miss = longing_band(s.longing);
    if !miss.is_empty() {
        parts.push(miss.to_string());
    }
    if let Some(plan) = &s.plan {
        let minutes = (plan.at_ms - now_ms) as f64 / MIN_MS;
        let held = if plan.deferred > 0 { " (already held back once)" } else { "" };
        if minutes > 0.0 {
            parts.push(format!("you plan to bring up \"{}\" in {} min{held}", plan.topic, minutes.round()));
        } else {
            parts.push(format!("you wanted to bring up \"{}\"{held}", plan.topic));
        }
    }
    if let Some(pending) = &s.pending {
        parts.push(format!("an unsaid sentence: {pending}"));
    }
    if let Some(mark) = s.marks.last() {
        parts.push(format!("you left a mark {}: \"{}\"", ago(now_ms - mark.at_ms), mark.note));
    }
    if let Some(seen) = s.last_seen_ms {
        let hours = (now_ms - seen) as f64 / 3_600_000.0;
        if hours >= 1.0 {
            parts.push(format!("you last talked {} h ago", hours.round()));
        }
    }
    parts.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    #[test]
    fn silence_raises_boredom_and_longing_and_a_message_lowers_them() {
        let s = SelfState { last_tick_ms: Some(0), last_seen_ms: Some(-3_600_000), ..Default::default() };
        let later = tick(&s, 60 * MIN, false);
        assert!((later.boredom - (20.0 + 21.0)).abs() < 0.01, "{}", later.boredom);
        assert!((later.longing - 10.8).abs() < 0.01, "{}", later.longing);
        let heard = touch(&later, 61 * MIN, false);
        assert!(heard.boredom < later.boredom && heard.longing < later.longing);
        assert_eq!(heard.last_seen_ms, Some(61 * MIN));
    }

    #[test]
    fn no_time_is_counted_twice_and_a_first_tick_only_starts_the_clock() {
        let fresh = SelfState::default();
        let started = tick(&fresh, 5 * MIN, false);
        assert_eq!(started.boredom, fresh.boredom);
        assert_eq!(started.last_tick_ms, Some(5 * MIN));
        assert_eq!(tick(&started, 5 * MIN, false), started);
    }

    #[test]
    fn near_a_recent_message_nothing_grows() {
        let s = SelfState { last_tick_ms: Some(0), last_seen_ms: Some(0), ..Default::default() };
        assert_eq!(tick(&s, 3 * MIN, false).boredom, 20.0);
    }

    #[test]
    fn sleep_slows_the_growth() {
        let s = SelfState { last_tick_ms: Some(0), ..Default::default() };
        assert!(tick(&s, 60 * MIN, true).boredom < tick(&s, 60 * MIN, false).boredom);
    }

    #[test]
    fn marks_stop_at_eight_and_the_newest_stays() {
        let mut s = SelfState::default();
        for i in 0..11 {
            s = apply(&s, &SelfPatch { mark: Some(format!("mark {i}")), ..Default::default() }, i * MIN).0;
        }
        assert_eq!(s.marks.len(), MAX_MARKS);
        assert_eq!(s.marks.first().unwrap().note, "mark 3");
        assert_eq!(s.marks.last().unwrap().note, "mark 10");
    }

    #[test]
    fn long_text_is_cut_and_blank_text_is_ignored() {
        let (s, _) = apply(&SelfState::default(), &SelfPatch { mark: Some("x".repeat(200)), ..Default::default() }, 0);
        assert_eq!(s.marks[0].note.chars().count(), 40);
        let (s, log) = apply(&s, &SelfPatch { mark: Some("   ".into()), ..Default::default() }, 1);
        assert_eq!(s.marks.len(), 1);
        assert!(log.is_empty());
    }

    #[test]
    fn a_plan_can_be_made_deferred_and_dropped() {
        let (s, _) = apply(&SelfState::default(), &SelfPatch { plan_minutes: Some(30.0), plan_topic: Some("the trip".into()), ..Default::default() }, 0);
        assert!(!plan_due(&s, 29 * MIN) && plan_due(&s, 30 * MIN));
        let (s, _) = apply(&s, &SelfPatch { plan_defer_minutes: Some(10.0), ..Default::default() }, 30 * MIN);
        assert_eq!(s.plan.as_ref().unwrap().deferred, 1);
        assert!(!plan_due(&s, 39 * MIN));
        let (s, _) = apply(&s, &SelfPatch { clear_plan: true, ..Default::default() }, 31 * MIN);
        assert!(s.plan.is_none());
        let (none, _) = apply(&SelfState::default(), &SelfPatch { plan_minutes: Some(30.0), ..Default::default() }, 0);
        assert!(none.plan.is_none(), "a plan needs a topic");
    }

    #[test]
    fn the_battery_drains_more_in_a_busy_room_and_refills_when_quiet() {
        let s = SelfState::default();
        assert!(drain_battery(&s, 4).battery < drain_battery(&s, 2).battery);
        let low = SelfState { battery: 10.0, last_tick_ms: Some(0), ..Default::default() };
        assert!(tick(&low, 20 * MIN, false).battery > 10.0);
    }

    #[test]
    fn render_is_one_plain_line_and_empty_when_quiet() {
        let calm = SelfState { boredom: 30.0, ..Default::default() };
        assert_eq!(render(&calm, 0, false), "");
        let s = SelfState { boredom: 70.0, longing: 85.0, pending: Some("ask about the exam".into()), ..Default::default() };
        let line = render(&s, 0, false);
        assert!(line.contains("bored") && line.contains("misses your person a lot") && line.contains("ask about the exam"), "{line}");
    }

    #[test]
    fn a_companion_woken_by_a_message_is_groggy_for_twenty_minutes() {
        let s = touch(&SelfState::default(), 100 * MIN, true);
        assert!(groggy(&s, 110 * MIN, false, 20));
        assert!(!groggy(&s, 130 * MIN, false, 20));
        assert!(!groggy(&s, 110 * MIN, true, 20));
    }
}
