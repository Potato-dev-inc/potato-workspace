//! `/crews` routes: read-only, this computer only, and a check that saves nothing.

use super::*;
use crate::crews::validate::AgentState;
use serde_json::json;

const LOCAL: &str = "Host: 127.0.0.1:1\r\n";

fn ready(agent: &str) -> AgentState {
    if agent == "claude" { AgentState::Ready } else { AgentState::Unknown }
}

fn model_ok(_agent: &str, model: &str) -> bool {
    model != "gpt-9"
}

fn dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-crews-route-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn call(dir: &Path, method: &str, path: &[&str], body: Value) -> RouteResult {
    handle_request(method, path, &body, LOCAL, true, dir, &ready, &model_ok).expect("a crews route")
}

fn code_of(result: RouteResult, status: u16, code: &str) {
    let (got, body) = result.expect_err("a refusal");
    assert_eq!((got, body["code"].as_str()), (status, Some(code)), "{body}");
}

const SAVED: &str = "name = \"Mine\"\n[[roles]]\nname = \"Lead\"\nagent_type = \"claude\"\ntask = \"Lead in {folder}\"\n";

#[test]
fn the_list_has_saved_crews_and_the_template() {
    let d = dir("list");
    std::fs::write(d.join("mine.toml"), SAVED).unwrap();
    let (status, body) = call(&d, "GET", &["crews"], json!({})).unwrap();
    assert_eq!(status, 200);
    assert_eq!(body["crews"][0]["slug"], "mine");
    assert_eq!(body["crews"][0]["name"], "Mine");
    assert_eq!(body["templates"][0]["slug"], "template:our-way");
    // The template uses an agent this fake registry lacks: the row says so, it is not hidden.
    assert!(body["templates"][0]["problem"].is_string());
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn one_crew_comes_with_its_problems_and_a_missing_one_is_a_404() {
    let d = dir("show");
    std::fs::write(d.join("mine.toml"), SAVED).unwrap();
    let (_, body) = call(&d, "GET", &["crews", "mine"], json!({})).unwrap();
    assert_eq!((body["kind"].as_str(), body["crew"]["roles"][0]["name"].as_str()), (Some("saved"), Some("Lead")));
    assert_eq!(body["problems"], json!([]));
    let (_, ours) = call(&d, "GET", &["crews", "template:our-way"], json!({})).unwrap();
    assert_eq!(ours["kind"], "template");
    assert!(ours["routing_text"].as_str().unwrap().starts_with("# How work is routed"));
    code_of(call(&d, "GET", &["crews", "nope"], json!({})), 404, "CREW_NOT_FOUND");
    code_of(call(&d, "GET", &["crews", "..%2Fx"], json!({})), 404, "CREW_NOT_FOUND");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn validate_checks_a_text_and_writes_nothing() {
    let d = dir("validate");
    let (status, ok) = call(&d, "POST", &["crews", "validate"], json!({ "text": SAVED })).unwrap();
    assert_eq!((status, ok["ok"].as_bool()), (200, Some(true)));
    let bad = SAVED.replace("claude", "mystery");
    let (_, body) = call(&d, "POST", &["crews", "validate"], json!({ "text": bad })).unwrap();
    assert_eq!(body["ok"], false);
    assert_eq!(body["crews"][0]["problems"][0]["code"], "CREW_AGENT_UNKNOWN");
    let model = SAVED.replace("task =", "model = \"gpt-9\"\ntask =");
    let (_, body) = call(&d, "POST", &["crews", "validate"], json!({ "text": model })).unwrap();
    assert_eq!(body["crews"][0]["problems"][0]["code"], "CREW_MODEL_UNKNOWN");
    code_of(call(&d, "POST", &["crews", "validate"], json!({})), 400, "INVALID_ARGUMENT");
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0, "nothing was saved");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn there_is_no_way_to_change_a_crew() {
    let d = dir("readonly");
    for (method, path) in [("POST", vec!["crews"]), ("PUT", vec!["crews", "mine"]), ("DELETE", vec!["crews", "mine"]), ("POST", vec!["crews", "mine", "apply"]), ("POST", vec!["crews", "apply"])] {
        code_of(call(&d, method, &path, json!({ "text": SAVED })), 404, "NOT_FOUND");
    }
    assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_forwarded_foreign_or_remote_call_is_refused_and_other_routes_are_not_ours() {
    let d = dir("auth");
    for headers in [
        "Host: 127.0.0.1:1\r\nX-Forwarded-For: 1.2.3.4\r\n",
        "Host: 127.0.0.1:1\r\nCf-Connecting-Ip: 1.2.3.4\r\n",
        "Host: evil.example\r\n",
        "Host: 127.0.0.1:1\r\nOrigin: http://localhost:5173\r\n",
    ] {
        code_of(handle_request("GET", &["crews"], &json!({}), headers, true, &d, &ready, &model_ok).unwrap(), 403, "CREWS_LOCAL_ONLY");
    }
    code_of(handle_request("GET", &["crews"], &json!({}), LOCAL, false, &d, &ready, &model_ok).unwrap(), 403, "CREWS_LOCAL_ONLY");
    assert!(handle_request("GET", &["config", "standby"], &json!({}), LOCAL, true, &d, &ready, &model_ok).is_none());
    use crate::mobile_pairing::{route_need, Cap, Need};
    assert_eq!(route_need("GET", &["crews"]), Need::Cap(Cap::Control));
    assert_eq!(route_need("POST", &["crews", "validate"]), Need::Cap(Cap::Control));
    let _ = std::fs::remove_dir_all(&d);
}
