//! `/config/*`: who may call, that apply wants the plan's id, and that an agent needs the person's Allow.

use super::*;
use crate::config_plan::tests::Fake;
use crate::config_plan::PlanStore;
use parking_lot::Mutex;

const LOCAL: &str = "Host: 127.0.0.1:17421\r\nContent-Type: application/json\r\n";

/// Answers every ask with a fixed verdict and remembers that it was asked.
struct Verdict {
    answer: Mutex<Option<&'static str>>,
    asked: Mutex<Vec<String>>,
}

impl Verdict {
    fn new(answer: Option<&'static str>) -> Self {
        Self { answer: Mutex::new(answer), asked: Mutex::default() }
    }
}

impl Consent for Verdict {
    fn ask(&self, _session: &str, plan_id: &str) -> Result<(), OperationError> {
        self.asked.lock().push(plan_id.to_string());
        match *self.answer.lock() {
            None => Ok(()),
            Some(code) => Err(OperationError::new(code, "the person has not said yes", true)),
        }
    }
}

fn call(world: &Fake, plans: &PlanStore, consent: &dyn Consent, method: &str, path: &[&str], body: Value, session: Option<&str>) -> RouteResult {
    handle_request(method, path, &body, LOCAL, true, session, world, plans, consent, 1_000).expect("a config route")
}

fn code_of(result: RouteResult, status: u16, code: &str) {
    match result {
        Err((got, body)) => assert_eq!((got, body["code"].as_str()), (status, Some(code)), "{body}"),
        Ok(ok) => panic!("expected {code}, got {ok:?}"),
    }
}

fn add_plan() -> Value {
    json!({ "ops": [{ "kind": "standby_add", "name": "Cheap helper", "agent": "opencode", "model": "deepseek/deepseek-chat" }] })
}

#[test]
fn the_person_plans_and_applies_with_no_card() {
    let (world, plans, consent) = (Fake::new(), PlanStore::default(), Verdict::new(Some("CONSENT_PENDING")));
    let planned = call(&world, &plans, &consent, "POST", &["config", "plan"], add_plan(), None).unwrap().1;
    let id = planned["plan_id"].as_str().unwrap().to_string();
    assert!(world.store.lock().helpers.is_empty(), "planning changed nothing");
    let applied = call(&world, &plans, &consent, "POST", &["config", "apply"], json!({ "plan_id": id }), None).unwrap().1;
    assert_eq!(applied["applied"], true);
    assert_eq!(world.store.lock().helpers.len(), 1);
    assert!(consent.asked.lock().is_empty(), "a call with no session is never asked here (a shell command meets the shell gate first)");
}

#[test]
fn a_stale_plan_is_a_409_and_changes_nothing() {
    let (world, plans, consent) = (Fake::new(), PlanStore::default(), Verdict::new(None));
    let id = call(&world, &plans, &consent, "POST", &["config", "plan"], add_plan(), None).unwrap().1["plan_id"].as_str().unwrap().to_string();
    // Someone else added a standby while the plan waited.
    let other = crate::standby::helpers::NewHelper { name: "Other".into(), agent: "codex".into(), project: "/work/app".into(), ..Default::default() };
    world.store.lock().add(other, "sb-x".into()).unwrap();
    code_of(call(&world, &plans, &consent, "POST", &["config", "apply"], json!({ "plan_id": id }), None), 409, "PLAN_STALE");
    assert_eq!(world.store.lock().helpers.len(), 1);
    code_of(call(&world, &plans, &consent, "POST", &["config", "apply"], json!({ "plan_id": "plan-made-up" }), None), 404, "PLAN_UNKNOWN");
    code_of(call(&world, &plans, &consent, "POST", &["config", "apply"], json!({}), None), 400, "INVALID_ARGUMENT");
}

#[test]
fn an_agent_session_needs_the_persons_allow_before_apply_and_never_for_plan_or_read() {
    let (world, plans) = (Fake::new(), PlanStore::default());
    let consent = Verdict::new(Some("CONSENT_PENDING"));
    let planned = call(&world, &plans, &consent, "POST", &["config", "op"], json!({ "op": "plan", "ops": add_plan()["ops"] }), Some("s1")).unwrap().1;
    let id = planned["plan_id"].as_str().unwrap().to_string();
    assert!(call(&world, &plans, &consent, "POST", &["config", "op"], json!({ "op": "read", "what": "standby" }), Some("s1")).is_ok());
    assert!(consent.asked.lock().is_empty(), "plan and read are free");
    // No answer yet: 503 and the plan survives for the retry.
    let pending = call(&world, &plans, &consent, "POST", &["config", "op"], json!({ "op": "apply", "plan_id": id }), Some("s1"));
    code_of(pending, 503, "CONSENT_PENDING");
    assert!(world.store.lock().helpers.is_empty(), "nothing before Allow");
    // Deny: refused, nothing changes.
    *consent.answer.lock() = Some("CONSENT_DENIED");
    code_of(call(&world, &plans, &consent, "POST", &["config", "op"], json!({ "op": "apply", "plan_id": id }), Some("s1")), 403, "CONSENT_DENIED");
    assert!(world.store.lock().helpers.is_empty(), "Deny changes nothing");
    // Allow: the same plan goes through.
    *consent.answer.lock() = None;
    let done = call(&world, &plans, &consent, "POST", &["config", "op"], json!({ "op": "apply", "plan_id": id }), Some("s1")).unwrap().1;
    assert_eq!(done["applied"], true);
    assert_eq!(world.store.lock().helpers[0].name, "Cheap helper");
}

#[test]
fn the_mcp_door_needs_a_session_and_a_known_op() {
    let (world, plans, consent) = (Fake::new(), PlanStore::default(), Verdict::new(None));
    code_of(call(&world, &plans, &consent, "POST", &["config", "op"], json!({ "op": "read", "what": "standby" }), None), 400, "SESSION_REQUIRED");
    code_of(call(&world, &plans, &consent, "POST", &["config", "op"], json!({ "op": "wipe" }), Some("s1")), 400, "INVALID_ARGUMENT");
    let settings = call(&world, &plans, &consent, "POST", &["config", "op"], json!({ "op": "read", "what": "settings" }), Some("s1")).unwrap().1;
    assert!(settings["settings"].as_array().unwrap().iter().any(|e| e["key"] == "language"));
    assert!(settings["settings"].as_array().unwrap().iter().all(|e| e.get("effective").is_none()), "only the keys the person may change, with saved values");
}

#[test]
fn a_forwarded_or_foreign_call_is_refused() {
    let (world, plans, consent) = (Fake::new(), PlanStore::default(), Verdict::new(None));
    for headers in [
        "Host: 127.0.0.1:1\r\nX-Forwarded-For: 1.2.3.4\r\n",
        "Host: 127.0.0.1:1\r\nCf-Connecting-Ip: 1.2.3.4\r\n",
        "Host: evil.example\r\n",
        "Host: 127.0.0.1:1\r\nOrigin: http://localhost:5173\r\n",
    ] {
        let result = handle_request("POST", &["config", "plan"], &add_plan(), headers, true, None, &world, &plans, &consent, 1_000).unwrap();
        code_of(result, 403, "CONFIG_LOCAL_ONLY");
    }
    // Not a loopback peer at all.
    code_of(handle_request("GET", &["config", "standby"], &json!({}), LOCAL, false, None, &world, &plans, &consent, 1_000).unwrap(), 403, "CONFIG_LOCAL_ONLY");
    assert!(world.store.lock().helpers.is_empty());
}

#[test]
fn other_routes_are_not_ours_and_a_device_needs_control_at_least() {
    use crate::mobile_pairing::{route_need, Cap, Need};
    let (world, plans, consent) = (Fake::new(), PlanStore::default(), Verdict::new(None));
    assert!(handle_request("GET", &["settings"], &json!({}), LOCAL, true, None, &world, &plans, &consent, 1).is_none());
    assert_eq!(route_need("GET", &["config", "standby"]), Need::Cap(Cap::Control));
    assert_eq!(route_need("POST", &["config", "apply"]), Need::Cap(Cap::Control));
}

#[test]
fn the_real_card_for_an_mcp_apply_names_what_it_would_do_and_not_the_values() {
    use crate::agent_authority::consent::{CHOICE_DENY, CHOICE_ONCE};
    use crate::questions::{self, now_ms};
    let world = Fake::new();
    // The live consent reads the process-wide plan store, so plan there.
    let body = json!({ "ops": [{ "kind": "standby_add", "name": "Cheap helper", "agent": "opencode" }, { "kind": "settings", "patch": { "language": "zh-TW" } }] });
    let view = crate::config_plan::plan(&world, crate::config_plan::store(), &body, now_ms()).unwrap();
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let error = LiveConsent.ask(&session, &view.plan_id).unwrap_err();
    assert_eq!(error.code, "CONSENT_PENDING");
    let id = error.context["consent_id"].as_str().unwrap().to_string();
    let card = questions::store().get(&id, now_ms()).unwrap();
    assert_eq!(card.question, "Allow another agent to change your app setup?");
    let context = card.context.as_deref().unwrap();
    assert!(context.contains("Cheap helper") && context.contains("language"), "{context}");
    assert!(!context.contains("zh-TW"), "values stay off the card: {context}");
    // Deny sticks for that plan; a new plan gets its own card, and Allow once lets it through once.
    assert!(questions::store().answer(&id, Some(CHOICE_DENY), None, "desktop", now_ms()).unwrap().accepted);
    assert_eq!(LiveConsent.ask(&session, &view.plan_id).unwrap_err().code, "CONSENT_DENIED");
    let second = crate::config_plan::plan(&world, crate::config_plan::store(), &body, now_ms()).unwrap();
    let again = LiveConsent.ask(&session, &second.plan_id).unwrap_err();
    assert_eq!(again.code, "CONSENT_PENDING");
    let id2 = again.context["consent_id"].as_str().unwrap().to_string();
    assert!(questions::store().answer(&id2, Some(CHOICE_ONCE), None, "desktop", now_ms()).unwrap().accepted);
    LiveConsent.ask(&session, &second.plan_id).expect("allowed once");
}
