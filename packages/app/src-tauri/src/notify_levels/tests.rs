use super::*;

fn alert(kind: Kind) -> Alert<'static> {
    Alert { kind, high_risk: false, bell_key: Some("codex"), is_helper: false, snooze_keys: &[] }
}

fn prefs_with(level: BellLevel) -> Prefs {
    let mut p = Prefs::default();
    p.bells.insert("codex".into(), level);
    p
}

fn night() -> QuietHours {
    QuietHours { enabled: true, start: 22 * 60, end: 7 * 60 }
}

#[test]
fn the_default_is_everything_and_a_helper_starts_at_needs_me() {
    let p = Prefs::default();
    assert_eq!(p.level_for(Some("codex"), false), BellLevel::Everything);
    assert_eq!(p.level_for(Some("helper:codex"), true), BellLevel::Needs);
    assert_eq!(p.level_for(None, false), BellLevel::Everything);
    assert!(decide(&p, &alert(Kind::RunFinished), 600, 0).notify);
    let helper = Alert { is_helper: true, ..alert(Kind::RunFinished) };
    assert_eq!(decide(&p, &helper, 600, 0).reason, Reason::Level, "a helper's finished run is quiet by default");
    let helper_needs = Alert { is_helper: true, ..alert(Kind::WaitingInput) };
    assert!(decide(&p, &helper_needs, 600, 0).notify);
}

#[test]
fn each_level_lets_through_only_its_kinds() {
    let needs = prefs_with(BellLevel::Needs);
    for kind in [Kind::WaitingInput, Kind::Error, Kind::Question, Kind::TrustGate, Kind::Budget, Kind::Limit, Kind::RunFailed] {
        assert!(decide(&needs, &alert(kind), 600, 0).notify, "{kind:?} needs the person");
    }
    assert_eq!(decide(&needs, &alert(Kind::RunFinished), 600, 0).reason, Reason::Level);

    let finished = prefs_with(BellLevel::Finished);
    assert!(decide(&finished, &alert(Kind::RunFinished), 600, 0).notify);
    assert!(decide(&finished, &alert(Kind::RunFailed), 600, 0).notify);
    assert!(!decide(&finished, &alert(Kind::WaitingInput), 600, 0).notify);

    let silent = prefs_with(BellLevel::Silent);
    for kind in [Kind::WaitingInput, Kind::RunFinished, Kind::Question, Kind::Error] {
        assert!(!decide(&silent, &alert(kind), 600, 0).notify);
    }
    let all = prefs_with(BellLevel::Everything);
    assert!(decide(&all, &alert(Kind::RunFinished), 600, 0).notify);
}

#[test]
fn quiet_hours_cross_midnight_and_stop_ordinary_alerts() {
    let mut p = Prefs::default();
    p.quiet = night();
    assert_eq!(decide(&p, &alert(Kind::WaitingInput), 23 * 60, 0).reason, Reason::QuietHours);
    assert_eq!(decide(&p, &alert(Kind::WaitingInput), 3 * 60, 0).reason, Reason::QuietHours);
    assert!(decide(&p, &alert(Kind::WaitingInput), 7 * 60, 0).notify, "the end minute is outside");
    assert!(decide(&p, &alert(Kind::WaitingInput), 12 * 60, 0).notify);
    p.quiet.enabled = false;
    assert!(decide(&p, &alert(Kind::WaitingInput), 23 * 60, 0).notify, "off means off");
    let same = QuietHours { enabled: true, start: 600, end: 600 };
    assert!(!same.contains(600), "an empty window is never quiet");
    let day = QuietHours { enabled: true, start: 9 * 60, end: 17 * 60 };
    assert!(day.contains(12 * 60) && !day.contains(18 * 60));
}

#[test]
fn a_snooze_holds_a_card_for_thirty_minutes_then_ends() {
    let mut p = Prefs::default();
    p.snoozes.insert("card-1".into(), 1_000 + SNOOZE_MS);
    let keys = ["pane-9", "card-1"];
    let snoozed = Alert { snooze_keys: &keys, ..alert(Kind::WaitingInput) };
    assert_eq!(decide(&p, &snoozed, 600, 1_000).reason, Reason::Snoozed);
    assert!(decide(&p, &snoozed, 600, 1_000 + SNOOZE_MS).notify, "the snooze ends on time");
    let other = Alert { snooze_keys: &["card-2"], ..alert(Kind::WaitingInput) };
    assert!(decide(&p, &other, 600, 1_000).notify, "another card is not snoozed");
}

#[test]
fn a_high_risk_approval_and_a_consent_card_always_come_through() {
    let mut p = prefs_with(BellLevel::Silent);
    p.quiet = night();
    p.snoozes.insert("c".into(), u64::MAX);
    let keys = ["c"];
    let risky = Alert { high_risk: true, snooze_keys: &keys, ..alert(Kind::WaitingInput) };
    assert_eq!(decide(&p, &risky, 23 * 60, 5), Decision { notify: true, reason: Reason::Risky });
    let consent = Alert { snooze_keys: &keys, ..alert(Kind::Consent) };
    assert_eq!(decide(&p, &consent, 23 * 60, 5), Decision { notify: true, reason: Reason::Risky });
    let plain = Alert { snooze_keys: &keys, ..alert(Kind::WaitingInput) };
    assert!(!decide(&p, &plain, 23 * 60, 5).notify);
}

#[test]
fn companion_replies_and_the_morning_push_are_not_filtered_here() {
    let p = prefs_with(BellLevel::Silent);
    assert!(decide(&p, &alert(Kind::CompanionReply), 0, 0).notify);
    assert!(decide(&p, &alert(Kind::NightShift), 0, 0).notify);
}

fn temp_store(tag: &str) -> (Store, PathBuf) {
    let dir = std::env::temp_dir().join(format!("pm-notify-levels-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("n.json");
    (Store::new(path.clone()), path)
}

#[test]
fn the_choices_are_kept_on_disk_and_come_back() {
    let (store, path) = temp_store("disk");
    assert_eq!(store.get(), Prefs::default());
    store.set_bell("claude", BellLevel::Silent);
    store.set_quiet(QuietHours { enabled: true, start: 9999, end: 60 });
    let (until, _) = store.snooze(&["pane-1".to_string()], 10);
    assert_eq!(until, 10 + SNOOZE_MS);
    let again = Store::new(path.clone());
    let p = again.get();
    assert_eq!(p.bells.get("claude"), Some(&BellLevel::Silent));
    assert_eq!(p.quiet, QuietHours { enabled: true, start: 1439, end: 60 }, "minutes are kept inside the day");
    assert_eq!(p.snoozes.get("pane-1"), Some(&until));
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn expired_snoozes_are_dropped_on_the_next_snooze() {
    let (store, path) = temp_store("expire");
    store.snooze(&["old".to_string()], 0);
    let (_, p) = store.snooze(&["new".to_string()], SNOOZE_MS + 1);
    assert!(!p.snoozes.contains_key("old") && p.snoozes.contains_key("new"));
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn old_browser_choices_are_taken_over_once() {
    let (store, path) = temp_store("import");
    let mut bells = BTreeMap::new();
    bells.insert("codex".to_string(), BellLevel::Needs);
    let p = store.import_once(bells.clone(), night());
    assert_eq!(p.bells.get("codex"), Some(&BellLevel::Needs));
    assert!(p.quiet.enabled && p.imported);
    store.set_bell("codex", BellLevel::Silent);
    let mut other = BTreeMap::new();
    other.insert("codex".to_string(), BellLevel::Finished);
    let p = store.import_once(other, QuietHours::default());
    assert_eq!(p.bells.get("codex"), Some(&BellLevel::Silent), "a second import changes nothing");
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn a_damaged_file_reads_as_the_defaults() {
    let (store, path) = temp_store("bad");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "{not json").unwrap();
    assert_eq!(store.get(), Prefs::default());
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}
