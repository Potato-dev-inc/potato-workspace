//! Presence on the Team page: the share level decides what leaves this PC (nothing, here, project,
//! title), a teammate's beat is untrusted and memory-only, and a presence event is never a card.

use super::config::TeamConfig;
use super::crypto::key_id;
use super::event::*;
use super::leakcheck::readable_in;
use super::presence::*;
use super::secure::{Opened, Payload, Session};
use super::service::open_and_ingest;
use super::store::TeamStore;
use super::tests_v1::{config_for, folder, temp_dir, world, NOW};
use super::transport::Inbound;

const T0: u64 = 1_790_000_000_000;

fn report() -> Report {
    Report {
        away: false,
        project_name: Some("secret-launch".into()),
        project_path: Some("D:\\work\\secret-launch".into()),
        title: Some("Fix the payroll export".into()),
        running: 2,
        waiting: 1,
    }
}

// ------------------------------------------------------------------------- what leaves this PC

#[test]
fn the_default_is_here_only_and_an_old_team_file_gets_it() {
    assert_eq!(ShareLevel::default(), ShareLevel::Here);
    assert_eq!(TeamConfig::default().share_level, ShareLevel::Here);
    let old: TeamConfig = serde_json::from_str(r#"{"enabled":true,"team":"t","name":"Acme"}"#).unwrap();
    assert_eq!(old.share_level, ShareLevel::Here);
    assert!(old.share_exclude.is_empty());
}

#[test]
fn level_nothing_sends_no_event_at_all() {
    assert_eq!(share(ShareLevel::Nothing, &[], &report()), None);
    // Never visible before: nothing to take back either.
    assert_eq!(plan_beat(ShareLevel::Nothing, &[], Some((&report(), T0)), None, T0), Beat::Nothing);
}

#[test]
fn switching_to_nothing_sends_one_gone_so_others_stop_showing_me() {
    let last = Sent { shared: share(ShareLevel::Here, &[], &report()).unwrap(), at_ms: T0 };
    assert_eq!(plan_beat(ShareLevel::Nothing, &[], Some((&report(), T0 + 1000)), Some(&last), T0 + 1000), Beat::Gone);
    let gone = Sent { shared: Shared { state: State::Gone, project: None, title: None, running: 0, waiting: 0 }, at_ms: T0 + 1000 };
    assert_eq!(plan_beat(ShareLevel::Nothing, &[], Some((&report(), T0 + 2000)), Some(&gone), T0 + 2000), Beat::Nothing);
}

#[test]
fn level_here_sends_no_project_no_title_and_no_counts_in_the_sealed_plaintext() {
    let shared = share(ShareLevel::Here, &[], &report()).unwrap();
    assert_eq!(shared, Shared { state: State::Here, project: None, title: None, running: 0, waiting: 0 });
    let event = build_event("team", "member", "device", "Maya", &shared, T0);
    let plaintext = serde_json::to_string(&Payload::Event { event }).unwrap();
    assert!(readable_in(&plaintext, &["secret-launch", "payroll", "D:\\\\work"]).is_empty(), "{plaintext}");
    assert!(!plaintext.contains("working"), "{plaintext}");
    assert!(plaintext.contains(r#""presence":"here""#), "{plaintext}");
}

#[test]
fn level_project_sends_the_project_name_but_not_the_title_or_the_path() {
    let shared = share(ShareLevel::Project, &[], &report()).unwrap();
    assert_eq!(shared.project.as_deref(), Some("secret-launch"));
    assert_eq!(shared.title, None);
    assert_eq!((shared.running, shared.waiting), (2, 1));
    let plaintext = serde_json::to_string(&Payload::Event { event: build_event("t", "m", "d", "Maya", &shared, T0) }).unwrap();
    assert!(plaintext.contains("secret-launch"));
    assert!(!plaintext.contains("payroll"));
    assert!(!plaintext.contains("D:\\\\work") && !plaintext.contains("D:/work"));
}

#[test]
fn level_title_sends_the_title_too() {
    let shared = share(ShareLevel::Title, &[], &report()).unwrap();
    assert_eq!(shared.title.as_deref(), Some("Fix the payroll export"));
}

#[test]
fn an_excluded_project_is_shared_as_here_only_whatever_the_level() {
    let exclude = vec!["d:/work/SECRET-LAUNCH/".to_string()];
    assert!(is_excluded(&exclude, Some("D:\\work\\secret-launch")));
    assert!(is_excluded(&exclude, Some("D:\\work\\secret-launch\\sub\\dir")));
    assert!(!is_excluded(&exclude, Some("D:\\work\\secret-launch-2")));
    for level in [ShareLevel::Project, ShareLevel::Title] {
        let shared = share(level, &exclude, &report()).unwrap();
        assert_eq!(shared, Shared { state: State::Here, project: None, title: None, running: 0, waiting: 0 });
    }
}

#[test]
fn a_title_with_a_key_inside_is_redacted_and_a_long_one_is_cut_before_sending() {
    let mut r = report();
    r.title = Some(format!("Use sk-ant-api03-{} for the call {}", "A1b2C3d4E5f6G7h8".repeat(3), "x".repeat(10_000)));
    let shared = share(ShareLevel::Title, &[], &r).unwrap();
    let title = shared.title.unwrap();
    assert!(!title.contains("A1b2C3d4E5f6G7h8"), "{title}");
    assert!(title.chars().count() <= MAX_WORDS, "{}", title.chars().count());
}

#[test]
fn away_follows_the_report_and_counts_are_capped() {
    let mut r = report();
    r.away = true;
    r.running = 5000;
    let shared = share(ShareLevel::Project, &[], &r).unwrap();
    assert_eq!(shared.state, State::Away);
    assert_eq!(shared.running, 99);
}

// ------------------------------------------------------------------------------------ the beat

#[test]
fn a_beat_goes_on_change_and_every_minute_and_stays_quiet_otherwise() {
    let r = report();
    let first = match plan_beat(ShareLevel::Here, &[], Some((&r, T0)), None, T0) {
        Beat::Send(s) => s,
        other => panic!("{other:?}"),
    };
    let last = Sent { shared: first, at_ms: T0 };
    // Same facts, 30 s later: quiet.
    assert_eq!(plan_beat(ShareLevel::Here, &[], Some((&r, T0 + 30_000)), Some(&last), T0 + 30_000), Beat::Nothing);
    // A minute later: the beat.
    assert!(matches!(plan_beat(ShareLevel::Here, &[], Some((&r, T0 + BEAT_MS)), Some(&last), T0 + BEAT_MS), Beat::Send(_)));
    // Went away: at once.
    let mut away = r.clone();
    away.away = true;
    assert!(matches!(plan_beat(ShareLevel::Here, &[], Some((&away, T0 + 5_000)), Some(&last), T0 + 5_000), Beat::Send(s) if s.state == State::Away));
}

#[test]
fn no_fresh_report_means_nothing_is_sent() {
    let r = report();
    assert_eq!(plan_beat(ShareLevel::Title, &[], None, None, T0), Beat::Nothing);
    assert_eq!(plan_beat(ShareLevel::Title, &[], Some((&r, T0)), None, T0 + REPORT_FRESH_MS + 1), Beat::Nothing);
}

// ------------------------------------------------------------------- what a teammate sends me

fn beat_from(keys: &super::keystore::KeyStore, team: &str, shared: &Shared, at: u64) -> TeamEvent {
    let member = key_id(&keys.member().unwrap());
    let device = key_id(&keys.device_sign().unwrap());
    build_event(team, &member, &device, "Maya", shared, at)
}

fn shared(state: State) -> Shared {
    Shared { state, project: Some("billing".into()), title: Some("Fix invoices".into()), running: 1, waiting: 0 }
}

#[test]
fn a_sealed_beat_reaches_a_teammate_as_presence_and_never_as_a_card_or_a_remembered_event() {
    let dir = temp_dir("presence-rt");
    let wire = folder(&dir);
    let w = world(&wire, &["Leo"], NOW);
    let (_, leo_keys, leo_roster) = &w.others[0];
    let maya = Session::new(w.roster.clone(), w.maya.clone());
    let leo = Session::new(leo_roster.clone(), leo_keys.clone());
    let event = beat_from(&w.maya, &w.roster.team, &shared(State::Here), super::tests_v1::now());
    let env = maya.seal(&Payload::Event { event }, 1, super::tests_v1::now()).unwrap();
    // Nothing readable on the wire.
    let wire_json = serde_json::to_string(&env).unwrap();
    assert!(readable_in(&wire_json, &["billing", "Fix invoices", "Maya"]).is_empty());

    let mut store = TeamStore::default();
    let leo_config = config_for(leo_keys, leo_roster, "Leo");
    let inbound = Inbound { envelope: env.clone(), received_at_ms: super::tests_v1::now(), cursor: 1, reset: false };
    let got = open_and_ingest(&leo, &mut store, &leo_config, &inbound);
    let (member, seen, _) = got.presence.expect("a presence beat");
    assert_eq!(member, w.roster.root, "keyed by the signed sender");
    assert_eq!(seen, shared(State::Here));
    assert!(got.card.is_none());
    assert!(store.cards.is_empty(), "never a card");
    assert!(store.seen.is_empty(), "not remembered as an event");
    // My own beat echoed back is not a teammate's.
    assert_eq!(maya.open(&env, &mut Default::default(), super::tests_v1::now()), Ok(Opened::Mine));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_beat_for_another_team_or_from_me_is_dropped() {
    let mut mine = TeamConfig { team: "acme".into(), ..TeamConfig::default() };
    mine.me.id = "me".into();
    let mut event = build_event("acme", "x", "d", "Maya", &shared(State::Here), T0);
    assert!(super::service::read_presence(&mine, "maya", event.clone(), T0).is_some());
    assert!(super::service::read_presence(&mine, "me", event.clone(), T0).is_none(), "my other PC");
    event.team = "other".into();
    assert!(super::service::read_presence(&mine, "maya", event, T0).is_none());
}

#[test]
fn a_teammates_words_are_cleaned_and_cut_and_an_unknown_state_is_refused() {
    let mine = TeamConfig { team: "acme".into(), ..TeamConfig::default() };
    let mut big = shared(State::Here);
    big.title = Some(format!("\u{202E}evil\u{0007} {}", "t".repeat(10_000)));
    big.running = 70_000;
    let event = build_event("acme", "maya", "d", "Maya", &big, T0);
    let (_, read, _) = super::service::read_presence(&mine, "maya", event.clone(), T0).unwrap();
    let title = read.title.unwrap();
    assert!(title.chars().count() <= MAX_WORDS && !title.contains('\u{202E}') && !title.contains('\u{0007}'), "{title}");
    assert_eq!(read.running, 99);
    let mut odd = event;
    odd.subject.presence = Some("online-ish".into());
    assert!(super::service::read_presence(&mine, "maya", odd, T0).is_none());
}

#[test]
fn a_presence_event_is_never_a_card_kind() {
    assert!(!TeamEventKind::Presence.shown_as_card());
}

// ---------------------------------------------------------------------------------- the table

#[test]
fn a_state_older_than_three_minutes_reads_as_not_here_and_loses_its_words() {
    let mut table = Table::default();
    table.apply("maya", shared(State::Here), T0, T0);
    let fresh = &table.views(T0 + 60_000)[0];
    assert_eq!((fresh.state, fresh.project.as_deref(), fresh.title.as_deref()), ("here", Some("billing"), Some("Fix invoices")));
    let stale = &table.views(T0 + STALE_MS + 1)[0];
    assert_eq!((stale.state, stale.project.as_deref(), stale.title.as_deref(), stale.running), ("gone", None, None, 0));
}

#[test]
fn a_future_beat_is_clamped_and_a_late_old_beat_never_overwrites_a_newer_one() {
    let mut table = Table::default();
    table.apply("maya", shared(State::Here), T0 + 3_600_000, T0);
    assert_eq!(table.views(T0)[0].at_ms, T0, "clamped to now");
    let mut away = shared(State::Away);
    away.project = None;
    table.apply("maya", away, T0 - 10_000, T0);
    assert_eq!(table.views(T0)[0].state, "here", "the older beat lost");
}

#[test]
fn since_moves_only_when_the_state_changes_and_gone_removes_the_words() {
    let mut table = Table::default();
    table.apply("maya", shared(State::Here), T0, T0);
    table.apply("maya", shared(State::Here), T0 + 60_000, T0 + 60_000);
    assert_eq!(table.views(T0 + 60_000)[0].since_ms, T0);
    table.apply("maya", shared(State::Away), T0 + 120_000, T0 + 120_000);
    assert_eq!(table.views(T0 + 120_000)[0].since_ms, T0 + 120_000);
    table.apply("maya", shared(State::Gone), T0 + 130_000, T0 + 130_000);
    let v = &table.views(T0 + 130_000)[0];
    assert_eq!((v.state, v.project.as_deref()), ("gone", None));
}

#[test]
fn people_who_left_the_roster_are_dropped_from_the_table() {
    let mut table = Table::default();
    table.apply("maya", shared(State::Here), T0, T0);
    table.apply("leo", shared(State::Here), T0, T0);
    table.retain_members(|m| m == "leo");
    assert_eq!(table.views(T0).len(), 1);
}

#[test]
fn the_exclude_list_is_trimmed_deduplicated_and_capped() {
    let list = clean_exclude(vec![" D:\\a ".into(), "d:/a/".into(), "".into(), "D:\\b".into()]);
    assert_eq!(list, vec!["D:\\a".to_string(), "D:\\b".to_string()]);
    assert_eq!(clean_exclude((0..80).map(|i| format!("D:\\p{i}")).collect()).len(), 50);
}
