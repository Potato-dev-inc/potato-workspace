//! "How agent runs work": the verified flag and the saved choices. Fake agents only: no CLI is started and no app data folder
//! is read or written. The tests of what a choice does to a run (`apply*`) stay with those functions in the app.

use super::store::{self, TestEnv};
use super::verify::{evaluate, Inputs, Verification};
use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

const WITH_HEADLESS: &str = include_str!("../tui/declarative/fixtures/definitions/kilo-like.toml");
const TUI_ONLY: &str = include_str!("../tui/declarative/fixtures/definitions/minimal-tui.toml");

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// What the wizard writes into `<id>.wizard.json` (`wizard/finish.rs::provenance_json`).
fn wizard_json(id: &str, text: &str, stages: &[(&str, &str)]) -> String {
    json!({
        "wizard_schema": 1,
        "id": id,
        "definition_sha256": sha(text),
        "results": {
            "stages": stages.iter().map(|(n, s)| json!({"name": n, "status": s})).collect::<Vec<_>>(),
            "fixtures": {"passed": 5, "total": 5},
        },
    })
    .to_string()
}

const PASSED: &[(&str, &str)] = &[("pong", "passed"), ("sentence", "passed"), ("resume", "passed"), ("bad_model", "skipped")];

fn check(text: &str, wizard: Option<&str>, in_force: bool) -> Verification {
    evaluate(&Inputs { in_force, file_bytes: Some(text.as_bytes()), wizard_json: wizard })
}

// ---- headless_verified -------------------------------------------------------------------------

#[test]
fn a_headless_table_with_a_matching_passed_wizard_test_is_verified() {
    let wizard = wizard_json("kilolike", WITH_HEADLESS, PASSED);
    let verdict = check(WITH_HEADLESS, Some(&wizard), true);
    assert!(verdict.verified, "{verdict:?}");
    assert_eq!(verdict.reason, None);
}

#[test]
fn a_definition_changed_after_the_test_is_not_verified() {
    let wizard = wizard_json("kilolike", WITH_HEADLESS, PASSED);
    // Even a label edit changes the file that was tested.
    let edited = WITH_HEADLESS.replace("label = \"Kilo Code\"", "label = \"Kilo Code 2\"");
    assert_ne!(edited, WITH_HEADLESS);
    let verdict = check(&edited, Some(&wizard), true);
    assert!(!verdict.verified);
    assert_eq!(verdict.reason, Some("changed_since_test"));
    // An argv edit, the case that matters most.
    let argv = WITH_HEADLESS.replace("\"--format\", \"json\"", "\"--format\", \"json\", \"--yolo\"");
    assert_ne!(argv, WITH_HEADLESS);
    assert!(!check(&argv, Some(&wizard), true).verified);
}

#[test]
fn a_definition_nobody_tested_is_not_verified() {
    let verdict = check(WITH_HEADLESS, None, true);
    assert_eq!((verdict.verified, verdict.reason), (false, Some("not_tested")));
    assert!(!check(WITH_HEADLESS, Some("{ not json"), true).verified);
    assert!(!check(WITH_HEADLESS, Some("{}"), true).verified);
}

#[test]
fn a_failed_or_missing_live_stage_is_not_verified() {
    let failed = wizard_json("kilolike", WITH_HEADLESS, &[("pong", "passed"), ("sentence", "failed")]);
    assert!(!check(WITH_HEADLESS, Some(&failed), true).verified);
    let only_pong = wizard_json("kilolike", WITH_HEADLESS, &[("pong", "passed")]);
    assert!(!check(WITH_HEADLESS, Some(&only_pong), true).verified);
    let resume_failed = wizard_json(
        "kilolike",
        WITH_HEADLESS,
        &[("pong", "passed"), ("sentence", "passed"), ("resume", "failed")],
    );
    assert!(!check(WITH_HEADLESS, Some(&resume_failed), true).verified);
}

#[test]
fn a_test_recorded_for_another_agent_does_not_count() {
    let wizard = wizard_json("someone_else", WITH_HEADLESS, PASSED);
    assert!(!check(WITH_HEADLESS, Some(&wizard), true).verified);
}

#[test]
fn a_definition_without_a_headless_mode_is_never_verified() {
    let wizard = wizard_json("minimal", TUI_ONLY, PASSED);
    let verdict = check(TUI_ONLY, Some(&wizard), true);
    assert_eq!((verdict.verified, verdict.reason), (false, Some("no_headless_mode")));
}

#[test]
fn a_definition_that_is_not_in_force_is_not_verified() {
    let wizard = wizard_json("kilolike", WITH_HEADLESS, PASSED);
    let verdict = check(WITH_HEADLESS, Some(&wizard), false);
    assert_eq!((verdict.verified, verdict.reason), (false, Some("not_approved")));
}
// ---- the saved choice ----------------------------------------------------------------------------

#[test]
fn the_default_is_a_visible_pane_for_every_agent() {
    assert_eq!(RunMode::default(), RunMode::Visible);
    assert_eq!(setting_for("anything_at_all"), RunMode::Visible);
    store::with_test_env(TestEnv::default(), || {
        assert_eq!(setting_for("fake_custom"), RunMode::Visible);
    });
}

#[test]
fn a_missing_garbled_or_older_file_means_visible() {
    assert_eq!(store::mode_in(&store::parse_text(""), "x"), RunMode::Visible);
    assert_eq!(store::mode_in(&store::parse_text("{ not json"), "x"), RunMode::Visible);
    assert_eq!(store::mode_in(&store::parse_text("{}"), "x"), RunMode::Visible);
    // A value a newer build wrote is ignored, the others still count.
    let text = r#"{"version":9,"agents":{"x":"warp_speed","y":"one_task"}}"#;
    assert_eq!(store::mode_in(&store::parse_text(text), "x"), RunMode::Visible);
    assert_eq!(store::mode_in(&store::parse_text(text), "y"), RunMode::OneTask);
    assert_eq!(store::mode_in(&store::parse_text(text), "Y"), RunMode::OneTask, "ids are not case sensitive");
}

#[test]
fn the_choice_is_saved_per_agent_and_choosing_the_default_removes_it() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-store", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.join(store::file_name());
    store::save_at(&target, "Alpha", RunMode::OneTask).unwrap();
    store::save_at(&target, "beta", RunMode::OneTask).unwrap();
    let file = store::read_file(&target);
    assert_eq!(store::mode_in(&file, "alpha"), RunMode::OneTask);
    assert_eq!(store::mode_in(&file, "beta"), RunMode::OneTask);
    assert_eq!(store::mode_in(&file, "gamma"), RunMode::Visible);
    store::save_at(&target, "alpha", RunMode::Visible).unwrap();
    let text = std::fs::read_to_string(&target).unwrap();
    assert!(!text.contains("alpha") && text.contains("beta"), "{text}");
    assert!(store::save_at(&target, "  ", RunMode::OneTask).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- what the choice does to a run ---------------------------------------------------------------

#[test]
fn helper_agents_defaults_to_always_show_and_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-helpers", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.join(store::file_name());
    // No file, a broken file and an unknown value all mean the default.
    assert_eq!(store::visibility_at(&target), HelperVisibility::AlwaysShow);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&target, "{ not json").unwrap();
    assert_eq!(store::visibility_at(&target), HelperVisibility::AlwaysShow);
    std::fs::write(&target, r#"{"helper_visibility":"from_the_future"}"#).unwrap();
    assert_eq!(store::visibility_at(&target), HelperVisibility::AlwaysShow);
    for mode in [HelperVisibility::AlwaysBackground, HelperVisibility::AgentChooses, HelperVisibility::AlwaysShow] {
        store::save_visibility_at(&target, mode).unwrap();
        assert_eq!(store::visibility_at(&target), mode, "read back from disk");
    }
    // Saving the helper choice keeps the per-agent choices, and the other way round.
    store::save_at(&target, "alpha", RunMode::OneTask).unwrap();
    store::save_visibility_at(&target, HelperVisibility::AlwaysBackground).unwrap();
    store::save_at(&target, "beta", RunMode::OneTask).unwrap();
    let file = store::read_file(&target);
    assert_eq!(store::mode_in(&file, "alpha"), RunMode::OneTask);
    assert_eq!(store::visibility_at(&target), HelperVisibility::AlwaysBackground);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_older_allow_hidden_helpers_switch_carries_over_as_agent_chooses() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-legacy", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join(store::file_name());
    std::fs::write(&target, r#"{"version":1,"agents":{},"allow_hidden_helpers":true}"#).unwrap();
    assert_eq!(store::visibility_at(&target), HelperVisibility::AgentChooses);
    // Saving something else does not lose it.
    store::save_at(&target, "alpha", RunMode::OneTask).unwrap();
    assert_eq!(store::visibility_at(&target), HelperVisibility::AgentChooses);
    // The new value wins and the old key is not written again.
    store::save_visibility_at(&target, HelperVisibility::AlwaysShow).unwrap();
    assert_eq!(store::visibility_at(&target), HelperVisibility::AlwaysShow);
    assert!(!std::fs::read_to_string(&target).unwrap().contains("allow_hidden_helpers"));
    // "off" in the older file was already the default.
    std::fs::write(&target, r#"{"allow_hidden_helpers":false}"#).unwrap();
    assert_eq!(store::visibility_at(&target), HelperVisibility::AlwaysShow);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn keep_helpers_open_defaults_on_and_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-keep", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.join(store::file_name());
    assert!(store::keep_open_at(&target), "no file: on");
    store::save_keep_open_at(&target, false).unwrap();
    assert!(!store::keep_open_at(&target));
    store::save_visibility_at(&target, HelperVisibility::AlwaysBackground).unwrap();
    assert!(!store::keep_open_at(&target), "the other settings do not reset it");
    store::save_keep_open_at(&target, true).unwrap();
    assert!(store::keep_open_at(&target));
    assert_eq!(store::visibility_at(&target), HelperVisibility::AlwaysBackground);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn close_helpers_with_agent_defaults_on_and_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-close-with-agent", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.join(store::file_name());
    assert!(store::close_with_agent_at(&target), "no file: on");
    store::save_close_with_agent_at(&target, false).unwrap();
    assert!(!store::close_with_agent_at(&target));
    store::save_keep_open_at(&target, false).unwrap();
    assert!(!store::close_with_agent_at(&target), "the other settings do not reset it");
    store::save_close_with_agent_at(&target, true).unwrap();
    assert!(store::close_with_agent_at(&target));
    assert!(!store::keep_open_at(&target), "and it does not reset the others");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn close_helpers_with_agent_reads_the_test_environment() {
    store::with_test_env(TestEnv::default(), || assert!(close_helpers_with_agent(), "default on"));
    store::with_test_env(TestEnv { close_helpers_with_agent: Some(false), ..TestEnv::default() }, || {
        assert!(!close_helpers_with_agent());
        set_close_helpers_with_agent(true).unwrap();
        assert!(close_helpers_with_agent());
    });
}

#[test]
fn most_helpers_at_once_defaults_to_8_survives_a_restart_and_stays_in_range() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-most", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.join(store::file_name());
    assert_eq!(store::most_helpers_at(&target), 8, "no file: 8");
    store::save_most_helpers_at(&target, 3).unwrap();
    assert_eq!(store::most_helpers_at(&target), 3);
    store::save_keep_open_at(&target, false).unwrap();
    assert_eq!(store::most_helpers_at(&target), 3, "the other settings do not reset it");
    assert!(store::save_most_helpers_at(&target, 0).unwrap_err().starts_with("INVALID_ARGUMENT"));
    assert!(store::save_most_helpers_at(&target, 33).is_err());
    assert_eq!(store::most_helpers_at(&target), 3, "a refused value changes nothing");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn most_helpers_at_once_reads_the_test_environment() {
    store::with_test_env(TestEnv::default(), || assert_eq!(most_helpers_at_once(), 8));
    store::with_test_env(TestEnv { most_helpers_at_once: Some(2), ..TestEnv::default() }, || {
        assert_eq!(most_helpers_at_once(), 2);
        set_most_helpers_at_once(5).unwrap();
        assert_eq!(most_helpers_at_once(), 5);
        assert!(set_most_helpers_at_once(99).is_err());
    });
}

#[test]
fn stall_minutes_default_to_5_survive_a_restart_and_stay_in_range() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-stall", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let target = dir.join(store::file_name());
    assert_eq!(store::stall_minutes_at(&target), 5, "no file: 5");
    store::save_stall_minutes_at(&target, 1).unwrap();
    assert_eq!(store::stall_minutes_at(&target), 1);
    store::save_most_helpers_at(&target, 4).unwrap();
    assert_eq!(store::stall_minutes_at(&target), 1, "the other settings do not reset it");
    store::save_stall_minutes_at(&target, 0).unwrap();
    assert_eq!(store::stall_minutes_at(&target), 0, "0 = off");
    assert!(store::save_stall_minutes_at(&target, 121).unwrap_err().starts_with("INVALID_ARGUMENT"));
    assert_eq!(store::stall_minutes_at(&target), 0, "a refused value changes nothing");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stall_minutes_read_the_test_environment() {
    store::with_test_env(TestEnv::default(), || assert_eq!(stall_minutes(), 5));
    store::with_test_env(TestEnv { stall_minutes: Some(2), ..TestEnv::default() }, || {
        assert_eq!(stall_minutes(), 2);
        set_stall_minutes(9).unwrap();
        assert_eq!(stall_minutes(), 9);
        assert!(set_stall_minutes(500).is_err());
    });
}

// ---- what a started agent is (minion / spin-off) -------------------------------------------------

#[test]
fn started_agent_settings_default_to_one_type_and_let_it_choose() {
    store::with_test_env(TestEnv::default(), || {
        assert_eq!(started_agent_types(), StartedAgentTypes::One);
        assert_eq!(started_agent_kind(), StartedAgentKind::AgentChooses);
    });
}

#[test]
fn started_agent_settings_survive_a_restart_and_leave_the_rest_alone() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-started", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join(store::file_name());
    store::save_at(&target, "alpha", RunMode::OneTask).unwrap();
    assert_eq!(store::started_at(&target), (StartedAgentKind::AgentChooses, StartedAgentTypes::One));
    store::save_started_at(&target, Some(StartedAgentKind::SpinOff), Some(StartedAgentTypes::Two)).unwrap();
    assert_eq!(store::started_at(&target), (StartedAgentKind::SpinOff, StartedAgentTypes::Two));
    // Saving one choice leaves the other; neither touches the agents' own run modes.
    store::save_started_at(&target, Some(StartedAgentKind::Minion), None).unwrap();
    assert_eq!(store::started_at(&target), (StartedAgentKind::Minion, StartedAgentTypes::Two));
    assert_eq!(store::mode_in(&store::read_file(&target), "alpha"), RunMode::OneTask);
    // An unknown value (a newer build) means the default instead of discarding the file.
    std::fs::write(&target, r#"{"started_agent_kind":"wizard","started_agent_types":"three"}"#).unwrap();
    assert_eq!(store::started_at(&target), (StartedAgentKind::AgentChooses, StartedAgentTypes::One));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_older_helper_agents_choice_carries_over_to_the_new_kind() {
    let dir = std::env::temp_dir().join(format!("pm-run-mode-{}-started-migrate", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let target = dir.join(store::file_name());
    for (old, kind) in [
        ("always_background", StartedAgentKind::Minion),
        ("always_show", StartedAgentKind::AgentChooses),
        ("agent_chooses", StartedAgentKind::AgentChooses),
    ] {
        std::fs::write(&target, format!(r#"{{"helper_visibility":"{old}"}}"#)).unwrap();
        assert_eq!(store::started_at(&target).0, kind, "{old}");
    }
    // The new value wins once the person has set it, and the old one stays in the file.
    std::fs::write(&target, r#"{"helper_visibility":"always_background"}"#).unwrap();
    store::save_started_at(&target, Some(StartedAgentKind::SpinOff), None).unwrap();
    assert_eq!(store::started_at(&target).0, StartedAgentKind::SpinOff);
    assert!(std::fs::read_to_string(&target).unwrap().contains("always_background"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_unknown_as_value_is_refused_with_the_allowed_words() {
    assert_eq!(parse_asked(None), Ok(None));
    assert_eq!(parse_asked(Some("minion")), Ok(Some(StartedAs::Minion)));
    assert_eq!(parse_asked(Some("spin_off")), Ok(Some(StartedAs::SpinOff)));
    let error = parse_asked(Some("helper")).unwrap_err();
    assert!(error.starts_with("INVALID_ARGUMENT") && error.contains("minion") && error.contains("spin_off"), "{error}");
}

#[test]
fn old_helpers_are_spin_offs_and_hidden_runs_are_minions() {
    assert_eq!(legacy_kind(true, false), StartedAs::SpinOff);
    assert_eq!(legacy_kind(true, true), StartedAs::Minion);
    assert_eq!(legacy_kind(false, true), StartedAs::Minion);
}
