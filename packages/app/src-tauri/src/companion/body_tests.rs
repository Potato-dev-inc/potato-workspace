//! Body state on a fake host: drives that wake the companion as a check-in (never breaking the 2 h rule, the
//! daily cap or the night), a mood that follows the day, and state that survives a restart.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::keeper::{Pane, Status};
use super::model::MAX_SCHEDULED_SENDS_PER_DAY;
use super::store::{self, SentToday};
use super::test_host::{draft, start_ms, temp_dir, FakeHost};
use super::vault_tick::DRIVE_WAKE_GAP_MS;
use super::{schedule, Service};

const PANE: &str = "companion-mochi";
const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;

/// A fast drive: +60 per hour, wakes at 50, the person's own rules file.
const FAST_RULES: &str = r#"{"rules":[{"name":"Curious","startValue":0,"gainPerHour":60,"max":100,"threshold":50,"onThreshold":"wake"}]}"#;

fn vault_service(rules: Option<&str>) -> (Service, Arc<FakeHost>, PathBuf) {
    let root = temp_dir("pm-companion-body");
    let host = FakeHost::new(start_ms());
    host.vault.store(true, Ordering::SeqCst);
    if let Some(rules) = rules {
        let dir = root.join("companions").join("mochi").join("state");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("drives-rules.json"), rules).unwrap();
    }
    let service = Service::new(host.clone(), root.clone());
    service.create(draft("Mochi", &root.join("mochi"))).unwrap();
    (service, host, root)
}

fn boot(service: &Service, host: &FakeHost) {
    host.set_pane(PANE, Pane::Alive(Status::Idle));
    host.advance_ms(1_000);
    service.tick();
}

/// Ticks every 61 seconds for `ms` (the body moves once a minute).
fn run_for(service: &Service, host: &FakeHost, ms: i64) {
    let mut left = ms;
    while left > 0 {
        let step = left.min(61_000);
        host.advance_ms(step);
        service.tick();
        left -= step;
    }
}

fn drive_messages(host: &FakeHost) -> Vec<String> {
    host.sent.lock().iter().map(|(_, t)| t.clone()).filter(|t| t.starts_with("[Check-in: Drive]")).collect()
}

fn local_hour(host: &FakeHost) -> f64 {
    super::body::local_hour(host.now(), 0)
}

// ---- drives -------------------------------------------------------------------------------------

#[test]
fn a_drive_that_crosses_its_threshold_sends_one_check_in_and_the_two_hour_rule_holds() {
    let (service, host, root) = vault_service(Some(FAST_RULES));
    boot(&service, &host);
    assert!((7.0..=11.0).contains(&local_hour(&host)), "the test runs in the morning");

    run_for(&service, &host, 100 * MIN);
    let first = drive_messages(&host);
    assert_eq!(first.len(), 1, "{first:?}");
    assert!(first[0].contains("Curious building up") && first[0].contains("This is not a request"), "{}", first[0]);
    assert!(first[0].contains("How you feel right now"), "a check-in carries the tip");
    let sent_at = store::runtime_load(&root, "mochi").unwrap().last_drive_wake_ms.expect("remembered for the 2 h rule");

    // The drive builds up again within the hour, but the 2 h rule keeps it quiet.
    run_for(&service, &host, 60 * MIN);
    assert_eq!(drive_messages(&host).len(), 1, "still inside two hours of the first one");
    assert!(host.now() - sent_at < DRIVE_WAKE_GAP_MS);

    // Past two hours it may speak again.
    run_for(&service, &host, 25 * MIN);
    assert_eq!(drive_messages(&host).len(), 2);
    assert_eq!(store::feed_read(&root, "mochi").unwrap().iter().filter(|i| i.text == "Asked \"Drive\"").count(), 2);
}

#[test]
fn the_daily_cap_stops_a_drive_wake() {
    let (service, host, _root) = vault_service(Some(FAST_RULES));
    boot(&service, &host);
    {
        let mut inner = service.inner.lock();
        let slot = inner.slots.get_mut("mochi").unwrap();
        slot.runtime.sent_today = SentToday { date: schedule::today_key(host.now(), 0), count: MAX_SCHEDULED_SENDS_PER_DAY };
    }
    run_for(&service, &host, 3 * HOUR);
    assert!(drive_messages(&host).is_empty(), "the cap holds for a drive too");
}

#[test]
fn a_drive_does_not_wake_the_phone_at_night_and_speaks_when_the_night_is_over() {
    let (service, host, _root) = vault_service(Some(FAST_RULES));
    host.set_now(start_ms() + 18 * HOUR); // 02:00 the next day
    boot(&service, &host);
    run_for(&service, &host, 90 * MIN); // the drive is waiting, but it is night
    assert!(drive_messages(&host).is_empty(), "no message between 01:00 and 07:00");
    host.set_now(start_ms() + 24 * HOUR); // 08:00
    run_for(&service, &host, 3 * MIN);
    assert_eq!(drive_messages(&host).len(), 1);
}

#[test]
fn a_sleeping_companion_is_never_woken_by_a_drive() {
    let (service, host, _root) = vault_service(Some(FAST_RULES));
    boot(&service, &host);
    service.sleep("mochi").unwrap();
    host.remove_pane(PANE);
    run_for(&service, &host, 4 * HOUR);
    assert!(drive_messages(&host).is_empty());
    assert_eq!(host.spawn_count(), 1, "it did not start again");
}

// ---- mood and state --------------------------------------------------------------------------------

#[test]
fn a_long_day_makes_it_sleepy_in_the_evening() {
    let (service, host, _root) = vault_service(None);
    boot(&service, &host);
    host.set_now(start_ms() + 15 * HOUR); // 23:00
    service.tick();
    service.tick();
    host.advance_ms(61_000);
    service.tick();
    let body = service.view("mochi", false).unwrap().body.unwrap();
    assert_eq!(body.mood, "sleepy", "{body:?}");
    assert!(body.energy < 40);
}

#[test]
fn mood_and_drives_survive_a_restart_of_the_app() {
    let (service, host, root) = vault_service(None);
    boot(&service, &host);
    run_for(&service, &host, 30 * MIN);
    let before = service.view("mochi", false).unwrap().body.unwrap();
    let state: &Path = &root.join("companions/mochi/state");
    for file in ["mood.json", "self.json", "drives-state.json", "presence.json", "pace.json"] {
        assert!(state.join(file).is_file(), "{file}");
    }
    drop(service);

    let again = Service::new(host.clone(), root.clone());
    host.set_pane(PANE, Pane::Alive(Status::Idle));
    host.advance_ms(1_000);
    again.tick();
    let after = again.view("mochi", false).unwrap().body.unwrap();
    assert_eq!(after.mood, before.mood);
    assert!((i32::from(after.energy) - i32::from(before.energy)).abs() <= 1, "{before:?} vs {after:?}");
    assert_eq!(after.drives[0].name, before.drives[0].name);
    assert!(after.drives[0].value >= before.drives[0].value || after.drives[0].value == 0);
}

#[test]
fn a_gap_between_two_runs_is_told_once_in_the_view() {
    let (service, host, root) = vault_service(None);
    boot(&service, &host);
    run_for(&service, &host, 5 * MIN);
    drop(service);
    host.advance_ms(3 * HOUR);
    let again = Service::new(host.clone(), root.clone());
    host.set_pane(PANE, Pane::Alive(Status::Idle));
    host.advance_ms(1_000);
    again.tick();
    let body = again.view("mochi", false).unwrap().body.unwrap();
    assert!(body.away_minutes.is_some_and(|m| (170..=185).contains(&m)), "{body:?}");
}

#[test]
fn the_phone_copy_of_the_view_carries_no_folder_and_the_body_is_plain_numbers() {
    let (service, host, _root) = vault_service(None);
    boot(&service, &host);
    run_for(&service, &host, 2 * MIN);
    let phone = service.view("mochi", true).unwrap();
    let json = serde_json::to_string(&phone).unwrap();
    assert!(json.contains("\"body\""), "{json}");
    assert!(!json.contains("\"folder\"") && !json.contains("pm-companion-body"), "{json}");
}
