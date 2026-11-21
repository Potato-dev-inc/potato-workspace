//! P2.1 rows (`calls_agents.rs`): the level matrix through `pclink::handle`, and the real answers of the app's own services.

use serde_json::{json, Value};

use super::app_services::AppServices;
use super::tests::Fake;
use super::*;

fn rows() -> Vec<(&'static str, Value)> {
    vec![
        ("agents_list", json!({})),
        ("agent_lane_get", json!({})),
        ("agent_default_models", json!({})),
        ("agent_rules_effective", json!({ "agent": "claude", "project": "remote:p1" })),
        ("project_recent", json!({ "limit": 8 })),
    ]
}

fn post(level: Option<Level>, fake: &Fake, cmd: &str, body: &Value) -> (u16, Value) {
    let who = Caller { node: "aa", name: "Laptop", level, now_ms: 1_000, marked: false };
    handle(&who, fake, &Asks::new(), "POST", &format!("/pclink/call/{cmd}"), &serde_json::to_vec(body).unwrap())
}

#[test]
fn every_p21_row_is_a_watch_read_for_any_paired_pc_and_nothing_for_a_pc_that_is_off() {
    // Other phases add their own blocks to the table; here only that every row of this one is present, at Watch.
    for (cmd, _) in rows() {
        assert!(calls::TABLE.iter().any(|(c, level, pane)| *c == cmd && *level == Level::Watch && !*pane), "{cmd} is a Watch row that names no chat");
    }
    for (cmd, body) in rows() {
        assert_eq!(calls::need(cmd), Some(Level::Watch), "{cmd}");
        for level in [Level::Watch, Level::Answer, Level::Full] {
            let fake = Fake::default();
            let (status, answer) = post(Some(level), &fake, cmd, &body);
            assert_eq!(status, 200, "{level:?} {cmd}: {answer}");
            assert_eq!(fake.calls().len(), 1, "{level:?} {cmd} reached the app once");
        }
        let fake = Fake::default();
        assert_eq!(post(None, &fake, cmd, &body).1["code"], "REMOTE_OFF", "{cmd}");
        assert!(fake.calls().is_empty(), "{cmd}: a PC that is off reaches nothing");
    }
}

#[test]
fn a_row_that_changes_something_is_not_in_the_block() {
    for cmd in ["agent_lane_set", "agent_rules_set_force_yes_agent", "agent_rules_pin_set", "agent_rules_fence_add", "project_forget", "project_remember", "project_pick_folder", "agents_definition_approve"] {
        assert_eq!(calls::need(cmd), None, "{cmd}");
    }
}

#[test]
fn the_real_services_answer_with_the_same_shape_this_pcs_own_page_reads() {
    let svc = AppServices::new(std::sync::Arc::new(|| "Desk".into()));
    // The agents: the registry listing itself, so the far page draws the rows and the "not installed" notes this PC's page draws.
    let (status, list) = svc.call("aa", "agents_list", &json!({}));
    assert_eq!(status, 200);
    // Nothing a user-defined agent carries for this PC's own screens (its definition, command lines, paths) travels.
    assert_eq!(list["agents"].as_array().map(Vec::len), crate::commands::agents_list()["agents"].as_array().map(Vec::len));
    assert!(list["agents"].as_array().unwrap().iter().all(|r| r["definition"].is_null() && r["install_hint"].is_null() && r["install_fallback"].is_null()));
    assert!(list["agents"].as_array().is_some_and(|a| a.iter().all(|r| r["id"].is_string() && r["installed"].is_boolean() && r["modes"]["visible"].is_boolean())));
    let (status, lanes) = svc.call("aa", "agent_lane_get", &json!({}));
    assert_eq!((status, lanes["agents"].is_array()), (200, true));
    // The rules need an agent; a project handle the app is not ready to resolve (or does not know) is an error in the link's shape, not a path.
    assert_eq!(svc.call("aa", "agent_rules_effective", &json!({})).1["code"], "INVALID_ARGUMENT");
    let (status, answer) = svc.call("aa", "agent_rules_effective", &json!({ "agent": "claude", "project": "remote:nope" }));
    assert!(matches!(status, 404 | 503), "{status} {answer}");
    let (status, pins) = svc.call("aa", "agent_rules_effective", &json!({ "agent": "claude" }));
    assert_eq!(status, 200);
    assert!(pins["fences"].is_array() && pins.get("force_yes").is_some());
    // No app handle in a unit test: the rows that read the app say so, and never invent a list.
    assert_eq!(svc.call("aa", "project_recent", &json!({})).0, 503);
    assert_eq!(svc.call("aa", "agent_default_models", &json!({})).0, 503);
    // The default models: only an object of saved ids is an answer.
    assert_eq!(crate::commands::agent_default_models_of(&json!({ "agent_default_models": { "claude": "opus" } })), json!({ "claude": "opus" }));
    assert_eq!(crate::commands::agent_default_models_of(&json!({ "agent_default_models": "x" })), json!({}));
    assert_eq!(crate::commands::agent_default_models_of(&json!({})), json!({}));
}
