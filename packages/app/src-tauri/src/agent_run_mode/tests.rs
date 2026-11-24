//! "How agent runs work": the verified flag, the saved choice, and what the choice does to a run.
//! Fake agents only: no CLI is started and no app data folder is read or written.

use super::store::{self, TestEnv};
use super::*;
use crate::agent_runs::AgentRunRequest;
use serde_json::json;


#[test]
fn built_in_agents_report_support_but_no_verification() {
    let fields = agent_fields("claude", false, true);
    assert_eq!(fields["headless_supported"], true);
    assert_eq!(fields["headless_verified"], false);
    assert_eq!(fields["headless_verified_reason"], "built_in");
    assert_eq!(fields["run_mode"], "visible");
}

#[test]
fn the_listing_gets_the_new_fields_on_every_agent() {
    let listing = json!({"agents": [
        {"id": "claude", "dispatchable": true, "modes": {"headless": true, "visible": true}, "definition": null},
        {"id": "fake_custom", "dispatchable": true, "modes": {"headless": true, "visible": true}, "definition": {"state": "active"}},
        {"id": "fake_plain", "dispatchable": true, "modes": {"headless": false, "visible": true}, "definition": {"state": "active"}},
    ], "dispatchable_ids": ["claude"]});
    let mut env = TestEnv::default();
    env.verified.insert("fake_custom".into(), true);
    env.modes.insert("fake_custom".into(), RunMode::OneTask);
    let out = store::with_test_env(env, || decorate_listing(listing));
    let by_id = |id: &str| out["agents"].as_array().unwrap().iter().find(|a| a["id"] == id).unwrap().clone();
    assert_eq!(by_id("claude")["headless_supported"], true);
    assert_eq!(by_id("claude")["headless_verified"], false);
    assert_eq!(by_id("fake_custom")["headless_verified"], true);
    assert_eq!(by_id("fake_custom")["run_mode"], "one_task");
    assert_eq!(by_id("fake_plain")["headless_supported"], false);
    assert_eq!(by_id("fake_plain")["headless_verified"], false);
    assert_eq!(by_id("fake_plain")["run_mode"], "visible");
    assert_eq!(out["dispatchable_ids"], json!(["claude"]), "the rest of the body is untouched");
}

fn request(agent: &str) -> AgentRunRequest {
    serde_json::from_value(json!({"task": "say hi", "agent_type": agent})).unwrap()
}

/// A run whose caller did not pass `headless` (the `/agents/run` route sets this flag).
fn unset(agent: &str) -> AgentRunRequest {
    let mut r = request(agent);
    r.headless_unset = true;
    r
}

fn env(agent: &str, mode: RunMode, verified: bool) -> TestEnv {
    let mut env = TestEnv::default();
    env.modes.insert(agent.into(), mode);
    env.verified.insert(agent.into(), verified);
    env
}

#[test]
fn a_run_without_headless_uses_the_agents_one_task_setting_when_verified() {
    let mut r = unset("claude");
    let decision = store::with_test_env(env("claude", RunMode::OneTask, true), || apply(&mut r));
    assert!(r.headless, "one-task mode runs headless");
    assert_eq!(decision.note, Some(RunModeNote::new("one_task", "agent_setting")));
    assert_eq!(decision.fallback, None);
}

#[test]
fn the_default_setting_changes_nothing() {
    let mut r = unset("claude");
    let decision = store::with_test_env(env("claude", RunMode::Visible, true), || apply(&mut r));
    assert!(!r.headless);
    assert_eq!(decision, Decision::default());
}

#[test]
fn an_explicit_headless_from_the_caller_always_wins() {
    // headless: false was passed (the route leaves headless_unset false): stays visible.
    let mut explicit_false = request("claude");
    let d = store::with_test_env(env("claude", RunMode::OneTask, true), || apply(&mut explicit_false));
    assert!(!explicit_false.headless);
    assert_eq!(d, Decision::default());
    // headless: true was passed: stays headless, the setting adds nothing to the receipt.
    let mut explicit_true = request("claude");
    explicit_true.headless = true;
    let d = store::with_test_env(env("claude", RunMode::Visible, true), || apply(&mut explicit_true));
    assert!(explicit_true.headless);
    assert_eq!(d, Decision::default());
    // Even an unset flag cannot turn an explicit true back into a pane.
    let mut both = unset("claude");
    both.headless = true;
    store::with_test_env(env("claude", RunMode::Visible, false), || apply(&mut both));
    assert!(both.headless);
}

#[test]
fn a_follow_up_turn_keeps_the_mode_of_its_run() {
    // The follow-up request is built with headless_unset=false and a turn index above zero: the
    // setting is not read, so changing it between turns never flips a conversation.
    let mut later = unset("claude");
    later.turn_index = 1;
    later.headless = true; // what send_agent derives from the earlier run having no pane
    let d = store::with_test_env(env("claude", RunMode::Visible, true), || apply(&mut later));
    assert!(later.headless);
    assert_eq!(d, Decision::default());
    let mut visible_later = unset("claude");
    visible_later.turn_index = 2;
    let d = store::with_test_env(env("claude", RunMode::OneTask, true), || apply(&mut visible_later));
    assert!(!visible_later.headless, "a conversation that began in a pane stays there");
    assert_eq!(d, Decision::default());
}

#[test]
fn adopting_a_pane_or_joining_a_mission_never_uses_the_setting() {
    let mut adopting = unset("claude");
    adopting.pane_id = Some("pane-1".into());
    store::with_test_env(env("claude", RunMode::OneTask, true), || apply(&mut adopting));
    assert!(!adopting.headless);
    let mut mission = unset("claude");
    mission.until_checks_pass = true;
    store::with_test_env(env("claude", RunMode::OneTask, true), || apply(&mut mission));
    assert!(!mission.headless);
}

#[test]
fn an_unverified_one_task_agent_falls_back_to_the_visible_pane_and_says_so() {
    let mut r = unset("claude");
    let decision = store::with_test_env(env("claude", RunMode::OneTask, false), || apply(&mut r));
    assert!(!r.headless, "nothing unverified is run headless");
    let fallback = decision.fallback.expect("the receipt carries the fallback");
    assert_eq!(
        serde_json::to_value(&fallback).unwrap(),
        json!({"from": "one_task", "to": "visible", "reason": "not_verified"})
    );
    assert_eq!(decision.note, Some(RunModeNote::new("visible", "agent_setting")));
}

#[test]
fn an_agent_with_no_headless_mode_at_all_also_falls_back() {
    let d = decide(RunMode::OneTask, true, false);
    assert!(!d.headless);
    assert_eq!(d.fallback.map(|f| f.reason), Some("not_verified".to_string()));
}

#[test]
fn the_decision_is_pure_over_setting_and_verification() {
    assert_eq!(decide(RunMode::Visible, true, true), Decision::default());
    assert_eq!(decide(RunMode::Visible, false, true), Decision::default());
    let go = decide(RunMode::OneTask, true, true);
    assert!(go.headless && go.fallback.is_none());
    let stay = decide(RunMode::OneTask, false, true);
    assert!(!stay.headless && stay.fallback.is_some());
}

#[test]
fn list_agents_rows_carry_lanes_accounts_and_read_only_support() {
    let rows = types_summary();
    let rows = rows.as_array().expect("an array of agent types");
    let claude = rows.iter().find(|r| r["id"] == "claude").expect("claude is dispatchable");
    for key in ["headless_supported", "headless_verified", "run_mode"] {
        assert!(claude.get(key).is_some(), "existing field {key} is kept");
    }
    let lanes = claude["lanes"].as_object().expect("lanes object");
    for key in ["terminal", "headless", "acp"] {
        assert!(lanes[key].is_boolean(), "lanes.{key} is a bool");
    }
    assert_eq!(lanes["terminal"], true);
    assert!(claude["accounts"].is_array());
    for account in claude["accounts"].as_array().unwrap() {
        assert!(account["id"].is_string() && account["label"].is_string());
        assert!(["signed_in", "signed_out", "unknown"].contains(&account["login_state"].as_str().unwrap()));
    }
    assert!(claude["read_only_supported"].is_boolean());
}

#[test]
fn a_caller_that_says_keep_pane_false_is_believed_until_the_person_chooses() {
    // The default (the person never chose): said out loud, the pane closes when done; left out, the default keeps it.
    let mut keep = false;
    assert!(!apply_keep_open_for_caller_with(&mut keep, true, true, false));
    assert!(!keep, "said close, no choice by the person: it closes");
    let mut keep = false;
    assert!(apply_keep_open_for_caller_with(&mut keep, false, true, false));
    assert!(keep, "left out: the default keeps it open");
    // The person chose "keep open": their word wins over the caller.
    let mut keep = false;
    assert!(apply_keep_open_for_caller_with(&mut keep, true, true, true));
    assert!(keep);
    // The person chose "close when done": nothing is kept, whatever the caller said.
    let mut keep = false;
    assert!(!apply_keep_open_for_caller_with(&mut keep, false, false, true));
    assert!(!keep);
}

#[test]
fn one_task_mode_cannot_be_saved_for_an_agent_that_is_not_verified() {
    let mut env = TestEnv::default();
    env.verified.insert("fake_ok".into(), true);
    store::with_test_env(env, || {
        let refused = set_checked("fake_nope", RunMode::OneTask).unwrap_err();
        assert!(refused.starts_with("RUN_MODE_NOT_VERIFIED"), "{refused}");
        assert_eq!(setting_for("fake_nope"), RunMode::Visible);
        set_checked("fake_ok", RunMode::OneTask).unwrap();
        assert_eq!(setting_for("fake_ok"), RunMode::OneTask);
        // Going back to the visible pane is always allowed.
        set_checked("fake_nope", RunMode::Visible).unwrap();
    });
    assert_eq!(RunMode::parse("one_task"), Some(RunMode::OneTask));
    assert_eq!(RunMode::parse("headless"), None);
}

#[test]
fn keep_helpers_open_on_keeps_the_pane_and_off_leaves_the_run_alone() {
    store::with_test_env(TestEnv::default(), || assert!(keep_helpers_open(), "default on"));
    store::with_test_env(TestEnv { keep_helpers_open: Some(false), ..TestEnv::default() }, || {
        assert!(!keep_helpers_open());
        let mut keep = false;
        assert!(!apply_keep_open(&mut keep) && !keep, "off: the run's own keep_pane decides (closes when done)");
    });
    store::with_test_env(TestEnv::default(), || {
        let mut keep = false;
        assert!(apply_keep_open(&mut keep) && keep, "on: kept open although the agent did not ask");
        let mut asked = true;
        assert!(!apply_keep_open(&mut asked) && asked, "already asked for: nothing to report");
    });
}
