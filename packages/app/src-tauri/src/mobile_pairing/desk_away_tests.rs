use super::*;
use crate::mobile_pairing::pane_rules::{lifted_if, Level, PaneRule};

const HOUR: u64 = 60 * 60 * 1000;

#[test]
fn each_length_ends_when_it_should() {
    let now = 1_000_000;
    assert_eq!(ends_at(Length::OneHour, now, 0), Some(now + HOUR));
    assert_eq!(ends_at(Length::FourHours, now, 0), Some(now + 4 * HOUR));
    assert_eq!(ends_at(Length::Tonight, now, 777), Some(777));
    assert_eq!(ends_at(Length::UntilBack, now, 777), None, "until I'm back has no end time");
    assert_eq!(Length::parse("one_hour"), Ok(Length::OneHour));
    assert!(Length::parse("forever").is_err());
}

#[test]
fn tonight_ends_at_the_next_six_in_the_morning() {
    let now = chrono::Local::now().timestamp_millis() as u64;
    let end = tonight_end(now);
    assert!(end > now && end - now <= 24 * HOUR, "within a day");
    use chrono::{Local, TimeZone, Timelike};
    let at = Local.timestamp_millis_opt(end as i64).single().unwrap();
    assert_eq!((at.hour(), at.minute()), (6, 0));
}

#[test]
fn the_switch_is_on_until_its_time_is_over() {
    let mut desk = Desk::default();
    assert!(desk.active(0).is_none());
    let away = desk.start(Length::OneHour, true, By::Pc, None, 1_000);
    assert_eq!(away.until_ms, Some(1_000 + HOUR));
    assert!(desk.active(1_000 + HOUR - 1).is_some());
    assert!(desk.active(1_000 + HOUR).is_none(), "it ends on the dot, even before anything tidies up");
    assert!(desk.settle(1_000 + HOUR), "the ended one is dropped");
    assert!(!desk.settle(1_000 + HOUR), "nothing more to drop");
}

#[test]
fn until_i_am_back_stays_on_for_days_and_im_back_ends_it() {
    let mut desk = Desk::default();
    desk.start(Length::UntilBack, false, By::Pc, None, 5);
    assert!(desk.active(5 + 30 * 24 * HOUR).is_some());
    assert!(!desk.settle(5 + 30 * 24 * HOUR), "no end time: nothing to settle");
    assert!(desk.back(), "I'm back ends it");
    assert!(desk.active(6).is_none());
    assert!(!desk.back(), "pressing it again changes nothing");
}

#[test]
fn starting_again_replaces_the_running_one() {
    let mut desk = Desk::default();
    desk.start(Length::FourHours, true, By::Pc, None, 0);
    let second = desk.start(Length::OneHour, false, By::Pc, None, 10);
    let now = desk.active(11).unwrap();
    assert_eq!((now.length, now.lock_screen, now.until_ms), (Length::OneHour, false, second.until_ms));
}

#[test]
fn it_is_kept_on_disk_with_its_end_time_and_loads_back() {
    let dir = std::env::temp_dir().join(format!("pm-desk-away-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("desk-away.json");
    let mut desk = Desk::default();
    desk.start(Length::OneHour, true, By::Phone, Some("Mia's phone".into()), 2_000);
    desk.save(&path).unwrap();
    let loaded = Desk::load(&path);
    assert_eq!(loaded.active(2_001), desk.active(2_001), "same away after a restart");
    // The app was closed past the end: it is over when it opens again.
    assert!(loaded.active(2_000 + HOUR + 1).is_none());
    // A broken file is no away at all (the safe side).
    std::fs::write(&path, "{ not json").unwrap();
    assert!(Desk::load(&path).active(0).is_none());
}

#[test]
fn a_pc_switch_raises_watch_and_answer_agents_but_never_switches_one_on() {
    let watch = PaneRule { remote: true, level: Level::Watch };
    let answer = PaneRule { remote: true, level: Level::Answer };
    let off = PaneRule { remote: false, level: Level::Watch };
    assert_eq!(lifted_if(watch, true), PaneRule::default());
    assert_eq!(lifted_if(answer, true), PaneRule::default());
    assert_eq!(lifted_if(off, true), off, "an agent the person keeps to the PC stays locked");
    // Not away (or set on the phone): nothing changes.
    assert_eq!(lifted_if(watch, false), watch);
    assert_eq!(lifted_if(answer, false), answer);
}

#[test]
fn the_phones_own_switch_lifts_nothing_but_turns_push_on_and_can_lock_the_screen() {
    use crate::mobile_pairing::pane_rules;
    // A phone-started away, so this test cannot change another test's pane rules (only a PC-started one lifts).
    let pane = "desk-away-watch-1";
    pane_rules::set(pane, PaneRule { remote: true, level: Level::Watch }).unwrap();
    let before = status_json(now_for_test());
    assert_eq!(before["away"], false);
    start(Length::OneHour, true, By::Phone, Some("Mia's phone".into()));
    let on = status_json(now_for_test());
    assert_eq!((on["away"].clone(), on["by"].clone(), on["lock_screen"].clone()), (true.into(), "phone".into(), true.into()));
    assert!(wants_push(now_for_test()));
    assert!(screen_locked());
    assert!(!lifts_levels(now_for_test()), "a phone cannot raise what the PC kept to itself");
    assert!(pane_rules::refuses(pane, crate::mobile_pairing::Cap::Type), "the watch-only agent is still watch-only");
    assert!(back());
    assert!(!wants_push(now_for_test()) && !screen_locked());
    assert_eq!(status_json(now_for_test())["away"], false);
    pane_rules::set(pane, PaneRule::default()).unwrap();
}

fn now_for_test() -> u64 {
    crate::mobile_pairing::control_ask::now_ms()
}
