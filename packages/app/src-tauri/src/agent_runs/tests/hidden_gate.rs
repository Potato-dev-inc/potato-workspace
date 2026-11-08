//! "Helper agents" (Settings > Agents): always show (the default), let the agent choose, or always run in the
//! background. `quick_ask` stays hidden by design; the automatic fallback is separate and unchanged
//! (see `headless::fallback` tests).

use crate::agent_run_mode::{
    apply_helper_visibility, apply_helper_visibility_with, with_test_env, HelperVisibility, TestEnv,
    VisibilityOutcome,
};
use crate::agent_runs::runtime::AgentRunRequest;
use serde_json::json;

/// A request as the `/agents/run` route builds it.
fn route_request(body: serde_json::Value) -> AgentRunRequest {
    let mut request: AgentRunRequest = serde_json::from_value(body.clone()).unwrap();
    request.headless_unset = body.get("headless").is_none_or(|value| value.is_null());
    request
}

fn helper_body() -> serde_json::Value {
    json!({
        "task": "a simple task", "agent_type": "claude", "model": "claude-haiku-5-5",
        "reasoning": "low", "read_only": true, "headless": true,
    })
}

fn env(mode: HelperVisibility) -> TestEnv {
    TestEnv { helper_visibility: mode, ..TestEnv::default() }
}

#[test]
fn the_default_is_to_always_show_helpers() {
    assert_eq!(HelperVisibility::default(), HelperVisibility::AlwaysShow);
    with_test_env(TestEnv::default(), || {
        assert_eq!(crate::agent_run_mode::helper_visibility(), HelperVisibility::AlwaysShow);
    });
}

#[test]
fn always_show_runs_a_hidden_request_in_a_pane_and_says_so() {
    with_test_env(env(HelperVisibility::AlwaysShow), || {
        let mut request = route_request(helper_body());
        assert!(request.headless);
        assert_eq!(apply_helper_visibility(&mut request), VisibilityOutcome::Shown);
        assert!(!request.headless, "the helper is shown in a pane");
        assert!(request.headless_ignored, "and the result says headless was ignored");
        assert!(!request.headless_forced);
        assert!(crate::agent_run_mode::HEADLESS_IGNORED_NOTE.starts_with("shown:"));
    });
}

#[test]
fn always_show_leaves_a_request_that_did_not_ask_to_hide_alone() {
    with_test_env(env(HelperVisibility::AlwaysShow), || {
        let mut left_out = route_request(json!({"task": "t", "agent_type": "claude"}));
        assert_eq!(apply_helper_visibility(&mut left_out), VisibilityOutcome::Untouched);
        assert!(!left_out.headless && !left_out.headless_ignored);
        let mut visible = route_request(json!({"task": "t", "headless": false}));
        assert_eq!(apply_helper_visibility(&mut visible), VisibilityOutcome::Untouched);
        assert!(!visible.headless_ignored);
    });
}

#[test]
fn agent_chooses_keeps_todays_behaviour() {
    with_test_env(env(HelperVisibility::AgentChooses), || {
        let mut hidden = route_request(helper_body());
        assert_eq!(apply_helper_visibility(&mut hidden), VisibilityOutcome::Untouched);
        assert!(hidden.headless && !hidden.headless_ignored && !hidden.headless_forced);
        let mut shown = route_request(json!({"task": "t", "agent_type": "claude", "headless": false}));
        assert_eq!(apply_helper_visibility(&mut shown), VisibilityOutcome::Untouched);
        assert!(!shown.headless && !shown.headless_forced);
    });
}

#[test]
fn always_background_forces_a_helper_headless_and_says_so() {
    for body in [
        json!({"task": "t", "agent_type": "claude"}),
        json!({"task": "t", "agent_type": "claude", "headless": false}),
    ] {
        let mut request = route_request(body);
        assert_eq!(
            apply_helper_visibility_with(&mut request, HelperVisibility::AlwaysBackground, true),
            VisibilityOutcome::Background
        );
        assert!(request.headless && request.headless_forced && !request.headless_ignored);
    }
    assert!(crate::agent_run_mode::HEADLESS_FORCED_NOTE.starts_with("background:"));
    // Through the real setting and the real agent profile.
    with_test_env(env(HelperVisibility::AlwaysBackground), || {
        let mut request = route_request(json!({"task": "t", "agent_type": "claude"}));
        assert_eq!(apply_helper_visibility(&mut request), VisibilityOutcome::Background);
        assert!(request.headless);
    });
}

#[test]
fn always_background_does_not_force_what_the_agent_cannot_do() {
    let mut request = route_request(json!({"task": "t", "agent_type": "claude"}));
    assert_eq!(
        apply_helper_visibility_with(&mut request, HelperVisibility::AlwaysBackground, false),
        VisibilityOutcome::Untouched
    );
    assert!(!request.headless && !request.headless_forced, "no headless mode: stays a visible pane");
    let mut asked = route_request(helper_body());
    assert_eq!(
        apply_helper_visibility_with(&mut asked, HelperVisibility::AlwaysBackground, true),
        VisibilityOutcome::Untouched
    );
    assert!(asked.headless && !asked.headless_forced, "the agent already asked for it: nothing to report");
}

#[test]
fn only_a_first_turn_that_starts_a_new_helper_is_touched() {
    for mode in [HelperVisibility::AlwaysShow, HelperVisibility::AlwaysBackground] {
        for body in [
            json!({"task": "t", "headless": true, "turn_index": 1}),
            json!({"task": "t", "headless": true, "pane_id": "p1"}),
            json!({"task": "t", "headless": true, "worker_id": "w1"}),
            json!({"task": "t", "headless": true, "until_checks_pass": true}),
        ] {
            let mut request = route_request(body);
            let before = request.headless;
            assert_eq!(apply_helper_visibility_with(&mut request, mode, true), VisibilityOutcome::Untouched);
            assert_eq!(request.headless, before);
        }
    }
}

#[test]
fn quick_ask_stays_hidden_by_design_and_is_not_listed() {
    let ask: crate::agent_runs::quick::QuickAskRequest = serde_json::from_value(json!({"task": "2+2?"})).unwrap();
    let run = crate::agent_runs::quick::build_run_request(&ask, "claude").unwrap();
    assert!(run.headless && run.quick, "quick_ask runs headless and is not an Inbox row");
    assert!(!run.headless_unset, "and it never reaches the route's gate");
}
