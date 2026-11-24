use super::*;

fn limits(turns: Option<u32>, minutes: Option<u32>, plan: Option<u32>) -> Limits {
    Limits { turns_per_day: turns, minutes_per_day: minutes, plan_percent: plan }
}

#[test]
fn a_project_with_no_limits_is_never_held_back() {
    let status = judge(&Limits::default(), 9_999, 99 * 3_600_000, Some(100.0));
    assert_eq!(status.reached, None);
    assert!(!status.limits.any());
}

#[test]
fn each_limit_stops_at_its_number_and_turns_come_first() {
    assert_eq!(judge(&limits(Some(3), None, None), 2, 0, None).reached, None);
    assert_eq!(judge(&limits(Some(3), None, None), 3, 0, None).reached, Some(Reached::Turns));
    assert_eq!(judge(&limits(None, Some(10), None), 0, 9 * 60_000 + 59_000, None).reached, None);
    assert_eq!(judge(&limits(None, Some(10), None), 0, 10 * 60_000, None).reached, Some(Reached::Minutes));
    assert_eq!(judge(&limits(None, None, Some(80)), 0, 0, Some(79.9)).reached, None);
    assert_eq!(judge(&limits(None, None, Some(80)), 0, 0, Some(80.0)).reached, Some(Reached::Plan));
    assert_eq!(judge(&limits(Some(1), Some(1), Some(1)), 5, 5 * 60_000, Some(50.0)).reached, Some(Reached::Turns));
}

#[test]
fn a_plan_share_with_no_reading_does_not_hold_anything_back() {
    assert_eq!(judge(&limits(None, None, Some(50)), 0, 0, None).reached, None);
}

#[test]
fn the_counters_start_again_on_a_new_day() {
    let store = Store::in_memory();
    store.set_limits("p", limits(Some(2), None, None));
    store.add_turn("p", "2026-11-15");
    store.add_turn("p", "2026-11-15");
    assert_eq!(store.status("p", "2026-11-15", None).reached, Some(Reached::Turns));
    let tomorrow = store.status("p", "2026-11-16", None);
    assert_eq!((tomorrow.used_turns, tomorrow.reached), (0, None), "wait until tomorrow works by itself");
    store.add_turn("p", "2026-11-16");
    assert_eq!(store.status("p", "2026-11-16", None).used_turns, 1);
}

#[test]
fn minutes_add_up_from_turn_lengths() {
    let store = Store::in_memory();
    store.set_limits("p", limits(None, Some(5), None));
    store.add_ms("p", "d", 3 * 60_000);
    assert_eq!(store.status("p", "d", None).reached, None);
    store.add_ms("p", "d", 2 * 60_000);
    let status = store.status("p", "d", None);
    assert_eq!((status.used_minutes, status.reached), (5, Some(Reached::Minutes)));
}

#[test]
fn nothing_is_counted_for_a_project_without_limits() {
    let store = Store::in_memory();
    store.add_turn("free", "d");
    store.add_ms("free", "d", 60_000);
    assert_eq!(store.status("free", "d", None).used_turns, 0);
    store.set_limits("free", limits(Some(5), None, None));
    assert_eq!(store.status("free", "d", None).used_turns, 0, "earlier turns were never counted");
}

#[test]
fn raise_gives_room_to_exactly_the_limits_that_ran_out() {
    let store = Store::in_memory();
    store.set_limits("p", limits(Some(4), Some(60), Some(70)));
    for _ in 0..4 {
        store.add_turn("p", "d");
    }
    store.raise("p", "d", Some(10.0));
    let after = store.status("p", "d", Some(10.0));
    assert_eq!(after.limits, limits(Some(9), Some(60), Some(70)), "4 + at least 5; time and plan were not used up");
    assert_eq!(after.reached, None);
    store.add_ms("p", "d", 60 * 60_000);
    store.raise("p", "d", Some(75.0));
    assert_eq!(store.limits("p"), limits(Some(9), Some(90), Some(80)));
}

#[test]
fn limits_are_kept_inside_bounds_and_zero_means_off() {
    let wild = limits(Some(0), Some(999_999), Some(500)).clamped();
    assert_eq!(wild, limits(None, Some(MAX_MINUTES), Some(100)));
    let store = Store::in_memory();
    store.set_limits("p", limits(Some(3), None, None));
    store.set_limits("p", Limits::default());
    assert_eq!(store.limits("p"), Limits::default());
}

#[test]
fn the_file_keeps_limits_and_the_day_between_runs() {
    let dir = std::env::temp_dir().join(format!("pm-project-budget-{}", uuid::Uuid::new_v4()));
    let path = dir.join(FILE_NAME);
    {
        let store = Store::at(&path);
        store.set_limits("p", limits(Some(7), None, None));
        store.add_turn("p", "2026-11-15");
    }
    let again = Store::at(&path);
    let status = again.status("p", "2026-11-15", None);
    assert_eq!((status.limits.turns_per_day, status.used_turns), (Some(7), 1));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_sentence_names_the_limit_in_plain_words() {
    let status = judge(&limits(Some(12), None, None), 12, 0, None);
    let text = sentence(&status).unwrap();
    assert!(text.contains("12 turns") && text.contains("tomorrow") && text.contains("raise"), "{text}");
    assert!(sentence(&judge(&limits(Some(12), None, None), 11, 0, None)).is_none());
}
