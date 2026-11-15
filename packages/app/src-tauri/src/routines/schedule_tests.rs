//! Schedule maths with a clock the test controls. 2026-11-16 is a Monday.

use super::schedule::*;

const MIN: u64 = 60_000;
const HOUR: u64 = 60 * MIN;
const DAY: u64 = 24 * HOUR;
/// 2026-11-16 00:00 UTC (a Monday).
const MON: u64 = 1_794_787_200_000 - 1_794_787_200_000 % DAY;

fn mon_utc() -> u64 {
    // 20,408 days after 1970-01-01 is 2025-12-?; compute from the weekday instead of trusting a literal.
    let mut day = MON;
    while weekday(day, 0) != 1 {
        day += DAY;
    }
    day
}

#[test]
fn weekdays_count_from_monday() {
    let m = mon_utc();
    assert_eq!(weekday(m, 0), 1);
    assert_eq!(weekday(m + DAY, 0), 2);
    assert_eq!(weekday(m + 6 * DAY, 0), 7);
    assert_eq!(weekday(m + 7 * DAY, 0), 1);
    // 1970-01-01 was a Thursday.
    assert_eq!(weekday(0, 0), 4);
}

#[test]
fn the_local_clock_decides_the_day_and_the_hour() {
    let m = mon_utc();
    // 23:30 UTC on Monday is 07:30 Tuesday at UTC+8.
    assert_eq!(weekday(m + 23 * HOUR + 30 * MIN, 8 * 60), 2);
    assert_eq!(hhmm(m + 23 * HOUR + 30 * MIN, 8 * 60), "07:30");
    assert_eq!(hhmm(m, -5 * 60), "19:00");
}

#[test]
fn due_inside_the_window_runs_once() {
    let m = mon_utc();
    let nine = m + 9 * HOUR;
    let got = latest_due(&[], "09:00", nine - MIN, nine + 30_000, 0);
    assert_eq!(got, Some(nine));
    // The same moment is not due again once it was run for.
    assert_eq!(latest_due(&[], "09:00", nine, nine + 10 * MIN, 0), None);
}

#[test]
fn nothing_is_due_before_the_time() {
    let m = mon_utc();
    assert_eq!(latest_due(&[], "09:00", m, m + 8 * HOUR + 59 * MIN, 0), None);
}

#[test]
fn weekdays_only_skips_the_weekend() {
    let m = mon_utc();
    let weekdays = [1, 2, 3, 4, 5];
    // Saturday 10:00: the last due 09:00 weekday was Friday's.
    let sat = m + 5 * DAY + 10 * HOUR;
    let got = latest_due(&weekdays, "09:00", m, sat, 0).unwrap();
    assert_eq!(got, m + 4 * DAY + 9 * HOUR);
    // Looking only at the weekend there is nothing due.
    assert_eq!(latest_due(&weekdays, "09:00", m + 4 * DAY + 9 * HOUR, sat + DAY, 0), None);
}

#[test]
fn many_missed_mornings_give_one_answer_the_latest() {
    let m = mon_utc();
    // The computer was off from Monday evening to Thursday 12:00.
    let after = m + 9 * HOUR;
    let now = m + 3 * DAY + 12 * HOUR;
    assert_eq!(latest_due(&[], "09:00", after, now, 0), Some(m + 3 * DAY + 9 * HOUR));
}

#[test]
fn the_offset_moves_the_due_time() {
    let m = mon_utc();
    // 09:00 at UTC+8 is 01:00 UTC.
    let got = latest_due(&[], "09:00", m - HOUR, m + 2 * HOUR, 8 * 60);
    assert_eq!(got, Some(m + HOUR));
}

#[test]
fn next_after_finds_the_next_weekday() {
    let m = mon_utc();
    let fri_noon = m + 4 * DAY + 12 * HOUR;
    let next = next_after(&[1, 2, 3, 4, 5], "09:00", fri_noon, 0).unwrap();
    assert_eq!(next, m + 7 * DAY + 9 * HOUR); // the next Monday
    assert_eq!(next_after(&[], "09:00", m + 8 * HOUR, 0), Some(m + 9 * HOUR));
}

#[test]
fn a_bad_time_is_never_due() {
    assert_eq!(latest_due(&[], "9am", 0, u64::MAX / 4, 0), None);
    assert_eq!(next_after(&[], "25:00", 0, 0), None);
}
