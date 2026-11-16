//! Plan then apply: what a plan may hold, what it refuses, and that apply runs exactly the plan (or nothing).

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(crate) struct Fake {
    pub store: Mutex<HelperStore>,
    pub patched: Mutex<Vec<Value>>,
    pub closed: Mutex<Vec<String>>,
    pub saved_language: Mutex<Value>,
    ids: AtomicUsize,
}

impl Fake {
    pub fn new() -> Self {
        Self { store: Mutex::new(HelperStore::default()), patched: Mutex::default(), closed: Mutex::default(), saved_language: Mutex::new(json!("en")), ids: AtomicUsize::new(0) }
    }

    pub fn with_standby(self, name: &str, agent: &str) -> Self {
        self.store.lock().add(NewHelper { name: name.into(), agent: agent.into(), model: None, project: "/work/app".into(), after_task: AfterTask::Wait, home: Some("pane-1".into()) }, format!("sb-{name}")).unwrap();
        self
    }
}

impl World for Fake {
    fn catalog(&self) -> Value {
        json!({
            "settings": [
                { "key": "language", "type": "string", "default": "en", "saved": *self.saved_language.lock(), "effective": "en", "labs": false },
                { "key": "pane_mcp_enabled", "type": "boolean", "default": true, "saved": true, "effective": true, "labs": false },
                { "key": "lend_enabled", "type": "boolean", "default": false, "saved": false, "effective": false, "labs": true }
            ],
            "labs": ["lend_enabled"],
            "refused": ["ui_mode", "api_key"],
        })
    }
    fn patch_settings(&self, patch: &Value) {
        self.patched.lock().push(patch.clone());
    }
    fn helper_store(&self) -> HelperStore {
        self.store.lock().clone()
    }
    fn standby_view(&self) -> Value {
        json!({ "helpers": self.store.lock().helpers.iter().map(|h| json!({ "id": h.id, "name": h.name })).collect::<Vec<_>>() })
    }
    fn edit_helpers(&self, change: &mut dyn FnMut(&mut HelperStore) -> Result<(), String>) -> Result<(), String> {
        let mut guard = self.store.lock();
        let mut next = guard.clone();
        change(&mut next)?;
        *guard = next;
        Ok(())
    }
    fn agent_can_wait(&self, agent: &str) -> bool {
        matches!(agent, "opencode" | "codex" | "claude")
    }
    fn folder_exists(&self, path: &str) -> bool {
        path.starts_with("/work")
    }
    fn default_project(&self) -> Option<String> {
        Some("/work/app".into())
    }
    fn new_id(&self) -> String {
        format!("{}", self.ids.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn helpers_changed(&self, closed: &[String]) {
        self.closed.lock().extend(closed.iter().cloned());
    }
}

fn add_op(name: &str) -> Value {
    json!({ "kind": "standby_add", "name": name, "agent": "opencode", "model": "deepseek/deepseek-chat" })
}

fn plan_of(world: &Fake, plans: &PlanStore, ops: Value) -> Result<PlanView, Refusal> {
    plan(world, plans, &json!({ "ops": ops }), 1_000)
}

#[test]
fn a_plan_says_what_would_change_and_changes_nothing() {
    let (world, plans) = (Fake::new(), PlanStore::default());
    let view = plan_of(&world, &plans, json!([add_op("Cheap helper"), { "kind": "settings", "patch": { "language": "zh-TW" } }])).unwrap();
    assert_eq!(view.lines.len(), 2);
    assert!(view.lines[0].contains("add \"Cheap helper\"") && view.lines[0].contains("deepseek/deepseek-chat"), "{:?}", view.lines);
    assert_eq!(view.lines[1], "setting language: \"en\" -> \"zh-TW\"");
    assert!(view.changes_anything);
    assert!(world.store.lock().helpers.is_empty() && world.patched.lock().is_empty(), "a plan touches nothing");
}

#[test]
fn apply_runs_exactly_the_plan_once() {
    let (world, plans) = (Fake::new(), PlanStore::default());
    let view = plan_of(&world, &plans, json!([add_op("Cheap helper"), { "kind": "settings", "patch": { "language": "zh-TW" } }])).unwrap();
    let done = apply(&world, &plans, &view.plan_id, 2_000).unwrap();
    assert!(done.applied);
    assert_eq!(done.standby_added.len(), 1);
    let store = world.store.lock();
    assert_eq!(store.helpers.len(), 1);
    assert_eq!((store.helpers[0].name.as_str(), store.helpers[0].agent.as_str(), store.helpers[0].model.as_deref()), ("Cheap helper", "opencode", Some("deepseek/deepseek-chat")));
    assert_eq!(store.helpers[0].project, "/work/app", "no project means the open one");
    assert_eq!(*world.patched.lock(), vec![json!({ "language": "zh-TW" })]);
    drop(store);
    // A plan is used once.
    assert_eq!(apply(&world, &plans, &view.plan_id, 2_000).unwrap_err().0, "PLAN_UNKNOWN");
}

#[test]
fn a_stale_plan_is_refused_and_changes_nothing() {
    let (world, plans) = (Fake::new().with_standby("Reviewer", "codex"), PlanStore::default());
    let view = plan_of(&world, &plans, json!([{ "kind": "standby_close", "target": "reviewer" }])).unwrap();
    // The person closed it in the app while the plan waited.
    world.store.lock().remove("sb-Reviewer");
    world.store.lock().add(NewHelper { name: "Other".into(), agent: "codex".into(), model: None, project: "/work/app".into(), after_task: AfterTask::Wait, home: None }, "sb-other".into()).unwrap();
    let error = apply(&world, &plans, &view.plan_id, 2_000).unwrap_err();
    assert_eq!(error.0, "PLAN_STALE", "{error:?}");
    assert_eq!(world.store.lock().helpers.len(), 1, "the other standby is still there");
    assert!(world.closed.lock().is_empty());
    // A setting that moved makes a settings plan stale too.
    let view = plan_of(&world, &plans, json!([{ "kind": "settings", "patch": { "language": "ja" } }])).unwrap();
    *world.saved_language.lock() = json!("fr");
    assert_eq!(apply(&world, &plans, &view.plan_id, 2_000).unwrap_err().0, "PLAN_STALE");
    assert!(world.patched.lock().is_empty());
}

#[test]
fn an_old_plan_expires() {
    let (world, plans) = (Fake::new(), PlanStore::default());
    let view = plan_of(&world, &plans, json!([add_op("A")])).unwrap();
    assert_eq!(apply(&world, &plans, &view.plan_id, 1_000 + PLAN_TTL_MS).unwrap_err().0, "PLAN_STALE");
    assert!(world.store.lock().helpers.is_empty());
}

#[test]
fn remove_only_detaches_and_close_stops_it() {
    let (world, plans) = (Fake::new().with_standby("Reviewer", "codex").with_standby("Tester", "codex"), PlanStore::default());
    let view = plan_of(&world, &plans, json!([{ "kind": "standby_remove", "target": "Reviewer" }, { "kind": "standby_close", "target": "tester" }])).unwrap();
    assert!(view.lines[0].contains("keeps running") && view.lines[1].contains("it stops"), "{:?}", view.lines);
    apply(&world, &plans, &view.plan_id, 2_000).unwrap();
    let store = world.store.lock();
    assert_eq!(store.helpers.len(), 1, "the closed one left the list");
    let kept = &store.helpers[0];
    assert!(kept.warm && kept.home.is_none(), "removed from its agent: still there, running free");
    assert_eq!(*world.closed.lock(), vec!["sb-Tester".to_string()], "only the closed one was told to stop");
}

#[test]
fn what_a_plan_may_not_hold_is_refused_at_plan_time() {
    let (world, plans) = (Fake::new(), PlanStore::default());
    let refused = |ops: Value| plan_of(&world, &plans, ops).unwrap_err();
    assert_eq!(refused(json!([{ "kind": "settings", "patch": { "ui_mode": "x" } }])).0, "REFUSED");
    assert_eq!(refused(json!([{ "kind": "settings", "patch": { "api_key": "x" } }])).0, "REFUSED");
    assert_eq!(refused(json!([{ "kind": "settings", "patch": { "provider_token": "x" } }])).0, "REFUSED", "secret-looking names are refused even if listed");
    assert_eq!(refused(json!([{ "kind": "settings", "patch": { "no_such_key": 1 } }])).0, "UNKNOWN_SETTING");
    assert_eq!(refused(json!([{ "kind": "settings", "patch": { "pane_mcp_enabled": "yes" } }])).0, "INVALID_ARGUMENT");
    assert_eq!(refused(json!([{ "kind": "pair_device" }])).0, "INVALID_ARGUMENT", "devices, lending and logins are not op kinds");
    assert_eq!(refused(json!([{ "kind": "standby_add", "name": "A", "agent": "opencode", "token": "x" }])).0, "INVALID_ARGUMENT", "unknown fields are errors");
    assert_eq!(refused(json!([{ "kind": "standby_add", "name": "A", "agent": "plainshell" }])).0, "INVALID_ARGUMENT");
    assert_eq!(refused(json!([{ "kind": "standby_add", "name": "A", "agent": "codex", "project": "/elsewhere" }])).0, "INVALID_ARGUMENT");
    assert_eq!(refused(json!([{ "kind": "standby_close", "target": "nobody" }])).0, "NOT_FOUND");
    assert_eq!(refused(json!([])).0, "INVALID_ARGUMENT");
    assert!(world.store.lock().helpers.is_empty() && world.patched.lock().is_empty());
}

#[test]
fn the_standby_limit_is_checked_when_planning_so_apply_cannot_half_finish() {
    let (world, plans) = (Fake::new(), PlanStore::default());
    world.store.lock().settings.max = 2;
    let error = plan_of(&world, &plans, json!([add_op("A"), add_op("B"), add_op("C")])).unwrap_err();
    assert_eq!(error.0, "REFUSED");
    assert!(error.1.contains("2 standbys"), "{error:?}");
    assert!(world.store.lock().helpers.is_empty());
}

#[test]
fn a_name_two_standbys_share_needs_the_id() {
    let (world, plans) = (Fake::new().with_standby("Same", "codex"), PlanStore::default());
    world.store.lock().add(NewHelper { name: "same".into(), agent: "codex".into(), model: None, project: "/work/app".into(), after_task: AfterTask::Wait, home: None }, "sb-2".into()).unwrap();
    assert_eq!(plan_of(&world, &plans, json!([{ "kind": "standby_close", "target": "SAME" }])).unwrap_err().0, "AMBIGUOUS");
    plan_of(&world, &plans, json!([{ "kind": "standby_close", "target": "sb-2" }])).expect("the id names exactly one");
}

#[test]
fn the_allow_card_lists_names_and_never_setting_values() {
    let (world, plans) = (Fake::new(), PlanStore::default());
    let view = plan_of(&world, &plans, json!([add_op("Cheap helper"), { "kind": "settings", "patch": { "language": "zh-TW" } }])).unwrap();
    let card = plans.card_lines(&view.plan_id, 1_500).unwrap().join("; ");
    assert!(card.contains("Cheap helper") && card.contains("language"), "{card}");
    assert!(!card.contains("zh-TW"), "values stay off the card: {card}");
    assert!(plans.card_lines("plan-nope", 1_500).is_none());
    assert!(plans.card_lines(&view.plan_id, 1_000 + PLAN_TTL_MS).is_none(), "an expired plan has no card");
}
