//! Time of day maths for schedules. Pure: the clock and the offset from UTC come in as numbers, so the tests
//! drive it with a clock they control. A "day" here is a day on this computer's clock (`offset_min` east of UTC).

use super::model::parse_hhmm;

const DAY_MS: i64 = 86_400_000;
const MIN_MS: i64 = 60_000;
/// How far back or forward a search looks (a week and a day: every weekday pattern repeats inside it).
const SEARCH_DAYS: i64 = 8;

/// The local day number (days since 1970-01-01 on the local clock).
fn local_day(ms: i64, offset_min: i32) -> i64 {
    (ms + i64::from(offset_min) * MIN_MS).div_euclid(DAY_MS)
}

/// 1 (Monday) to 7 (Sunday). 1970-01-01 was a Thursday.
pub fn weekday_of_day(day: i64) -> u8 {
    ((day + 3).rem_euclid(7) + 1) as u8
}

/// 1 (Monday) to 7 (Sunday) for a moment.
#[cfg(test)]
pub fn weekday(ms: u64, offset_min: i32) -> u8 {
    weekday_of_day(local_day(ms as i64, offset_min))
}

fn at(day: i64, minutes: u32, offset_min: i32) -> i64 {
    day * DAY_MS + i64::from(minutes) * MIN_MS - i64::from(offset_min) * MIN_MS
}

fn on_day(days: &[u8], day: i64) -> bool {
    days.is_empty() || days.contains(&weekday_of_day(day))
}

/// The latest time the schedule was due in `(after_ms, upto_ms]`, or `None`. One answer even when many were
/// missed: a routine that was due five mornings in a row while the computer was off runs once.
pub fn latest_due(days: &[u8], time: &str, after_ms: u64, upto_ms: u64, offset_min: i32) -> Option<u64> {
    let minutes = parse_hhmm(time)?;
    let top = local_day(upto_ms as i64, offset_min);
    for day in (top - SEARCH_DAYS..=top).rev() {
        let due = at(day, minutes, offset_min);
        if due <= after_ms as i64 {
            return None;
        }
        if due <= upto_ms as i64 && on_day(days, day) {
            return Some(due as u64);
        }
    }
    None
}

/// The first time the schedule is due after `from_ms`, for "Next run".
pub fn next_after(days: &[u8], time: &str, from_ms: u64, offset_min: i32) -> Option<u64> {
    let minutes = parse_hhmm(time)?;
    let first = local_day(from_ms as i64, offset_min);
    for day in first..=first + SEARCH_DAYS {
        let due = at(day, minutes, offset_min);
        if due > from_ms as i64 && on_day(days, day) {
            return Some(due as u64);
        }
    }
    None
}

/// "09:00" on the local clock for a UTC moment.
#[cfg(test)]
pub fn hhmm(ms: u64, offset_min: i32) -> String {
    let minutes = (ms as i64 + i64::from(offset_min) * MIN_MS).rem_euclid(DAY_MS) / MIN_MS;
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}
