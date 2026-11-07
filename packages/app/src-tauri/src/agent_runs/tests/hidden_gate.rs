//! "Allow hidden helpers": while it is off (the default) an agent's `headless: true` shows the helper in a pane
//! instead and the result says so; `quick_ask` stays hidden by design.

use crate::agent_run_mode::{gate_hidden_helper, with_test_env, TestEnv};
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

#[test]
fn a_hidden_request_runs_visible_while_hidden_helpers_are_off() {
    with_test_env(TestEnv::default(), || {
        let mut request = route_request(helper_body());
        assert!(request.headless);
        assert!(gate_hidden_helper(&mut request));
        assert!(!request.headless, "the helper is shown in a pane");
        assert!(request.headless_ignored, "and the result says headless was ignored");
    });
}

#[test]
fn a_hidden_request_stays_hidden_when_the_person_allowed_it() {
    with_test_env(TestEnv { allow_hidden_helpers: true, ..TestEnv::default() }, || {
        let mut request = route_request(helper_body());
        assert!(!gate_hidden_helper(&mut request));
        assert!(request.headless && !request.headless_ignored);
    });
}

#[test]
fn only_an_explicit_hidden_first_turn_is_set_aside() {
    with_test_env(TestEnv::default(), || {
        let mut left_out = route_request(json!({"task": "t", "agent_type": "claude"}));
        assert!(!gate_hidden_helper(&mut left_out) && !left_out.headless);
        let mut visible = route_request(json!({"task": "t", "headless": false}));
        assert!(!gate_hidden_helper(&mut visible) && !visible.headless_ignored);
        let mut followup = route_request(json!({"task": "t", "headless": true, "turn_index": 1}));
        assert!(!gate_hidden_helper(&mut followup) && followup.headless, "a follow-up keeps the mode of its run");
        let mut adopting = route_request(json!({"task": "t", "headless": true, "pane_id": "p1"}));
        assert!(!gate_hidden_helper(&mut adopting));
    });
}

#[test]
fn quick_ask_stays_hidden_by_design_and_is_not_listed() {
    let ask: crate::agent_runs::quick::QuickAskRequest = serde_json::from_value(json!({"task": "2+2?"})).unwrap();
    let run = crate::agent_runs::quick::build_run_request(&ask, "claude").unwrap();
    assert!(run.headless && run.quick, "quick_ask runs headless and is not an Inbox row");
    assert!(!run.headless_unset, "and it never reaches the route's gate");
}
