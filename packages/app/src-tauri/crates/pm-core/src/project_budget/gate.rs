//! The decision: given limits and today's counters, may another turn start?

use super::store::{Entry, Limits};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reached {
    Turns,
    Minutes,
    Plan,
}

impl Reached {
    pub fn as_str(self) -> &'static str {
        match self {
            Reached::Turns => "turns",
            Reached::Minutes => "minutes",
            Reached::Plan => "plan",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub limits: Limits,
    pub used_turns: u32,
    pub used_minutes: u32,
    pub plan_percent: Option<f64>,
    /// The first limit that is used up; `None` while the project may start turns.
    pub reached: Option<Reached>,
}

/// Turns come first, then minutes, then the plan share.
pub fn judge(limits: &Limits, used_turns: u32, used_ms: u64, plan_percent: Option<f64>) -> Status {
    let used_minutes = (used_ms / 60_000) as u32;
    let reached = if limits.turns_per_day.is_some_and(|n| used_turns >= n) {
        Some(Reached::Turns)
    } else if limits.minutes_per_day.is_some_and(|n| used_ms >= u64::from(n) * 60_000) {
        Some(Reached::Minutes)
    } else if limits.plan_percent.zip(plan_percent).is_some_and(|(limit, used)| used >= f64::from(limit)) {
        Some(Reached::Plan)
    } else {
        None
    };
    Status { limits: limits.clone(), used_turns, used_minutes, plan_percent, reached }
}

pub fn status_of(entry: &Entry, today: &str, plan_percent: Option<f64>) -> Status {
    let (turns, ms) = entry.used_on(today);
    judge(&entry.limits, turns, ms, plan_percent)
}

/// The new limits after "Raise": every limit that is used up gets half again as much room (at least 5 turns, 30
/// minutes or 10 percentage points), so one press is enough for a few more turns and the person can press again.
pub fn raise_step(limits: &Limits, status: &Status, plan_percent: Option<f64>) -> Limits {
    let mut next = limits.clone();
    if let Some(n) = limits.turns_per_day.filter(|n| status.used_turns >= *n) {
        next.turns_per_day = Some((n + (n / 2).max(5)).min(super::MAX_TURNS));
    }
    if let Some(n) = limits.minutes_per_day.filter(|n| status.used_minutes >= *n) {
        next.minutes_per_day = Some((n + (n / 2).max(30)).min(super::MAX_MINUTES));
    }
    if let Some(n) = limits.plan_percent.filter(|n| plan_percent.is_some_and(|p| p >= f64::from(*n))) {
        next.plan_percent = Some((n + 10).min(100));
    }
    next
}
