//! The standby helper list: limits, the saved file, the policy it adds and the view the screens read.

use super::*;
use crate::acp::warm::AgentProbe;

fn input(name: &str, agent: &str) -> NewHelper {
    NewHelper { name: name.into(), agent: agent.into(), model: Some("gpt-5".into()), project: "C:/work/app".into(), after_task: AfterTask::Wait, home: None, kind: None }
}

fn temp_file() -> HelperFile {
    let dir = std::env::temp_dir().join(format!("pm-standby-helpers-{}", uuid::Uuid::new_v4()));
    HelperFile::at(dir.join("standby-helpers.json"))
}

struct Chat(&'static [&'static str]);

impl AgentProbe for Chat {
    fn runs_as_chat(&self, agent: &str) -> bool {
        self.0.contains(&agent)
    }
}

#[test]
fn a_standby_has_a_name_an_agent_a_model_and_a_project() {
    let mut store = HelperStore::default();
    let helper = store.add(input("  Reviewer  ", "Codex"), "sb-1".into()).unwrap();
    assert_eq!((helper.name.as_str(), helper.agent.as_str(), helper.model.as_deref()), ("Reviewer", "codex", Some("gpt-5")));
    assert!(store.add(input("", "codex"), "x".into()).unwrap_err().contains("name"));
    assert!(store.add(input("A", " "), "x".into()).unwrap_err().contains("agent"));
    let mut no_folder = input("A", "codex");
    no_folder.project = " ".into();
    assert!(store.add(no_folder, "x".into()).unwrap_err().contains("folder"));
    let mut blank_model = input("B", "codex");
    blank_model.model = Some("  ".into());
    assert_eq!(store.add(blank_model, "sb-2".into()).unwrap().model, None, "a blank model means the agent's own");
}

#[test]
fn the_limit_stops_a_new_standby_and_is_never_lowered_under_the_count() {
    let mut store = HelperStore::default();
    store.set_settings(2, 30).unwrap();
    store.add(input("A", "codex"), "1".into()).unwrap();
    store.add(input("B", "codex"), "2".into()).unwrap();
    let err = store.add(input("C", "codex"), "3".into()).unwrap_err();
    assert!(err.contains("2 standbys") && err.contains("most allowed"), "{err}");
    assert!(store.set_settings(1, 30).unwrap_err().contains("Remove some"));
    assert_eq!(store.helpers.len(), 2, "nothing was removed for the person");
    assert!(store.remove("2"));
    assert!(!store.remove("2"));
    store.set_settings(1, 30).unwrap();
    assert_eq!(HelperStore { settings: HelperSettings { max: 99, idle_minutes: 0, idle_explicit: false, ..Default::default() }, ..Default::default() }.clamped_for(None).settings, HelperSettings { max: MAX_HELPERS, idle_minutes: 1, idle_explicit: true, ..Default::default() });
}

#[test]
fn update_renames_and_changes_the_model_and_what_happens_after_a_task() {
    let mut store = HelperStore::default();
    store.add(input("A", "codex"), "1".into()).unwrap();
    store.update("1", Some(" Big  reviewer "), Some(None), Some(AfterTask::Close)).unwrap();
    let helper = &store.helpers[0];
    assert_eq!((helper.name.as_str(), helper.model.as_deref(), helper.after_task), ("Big reviewer", None, AfterTask::Close));
    assert!(store.update("1", Some(" "), None, None).is_err());
    assert!(store.update("nope", None, None, None).unwrap_err().contains("gone"));
    store.update("1", None, Some(Some("opus")), None).unwrap();
    assert_eq!(store.helpers[0].model.as_deref(), Some("opus"));
}

#[test]
fn the_list_is_saved_and_a_refused_change_leaves_it_alone() {
    let file = temp_file();
    file.edit(|s| s.add(input("Reviewer", "codex"), "sb-1".into()).map(|_| ())).unwrap();
    let again = HelperFile::at(file.path.clone());
    assert_eq!(again.snapshot().helpers.len(), 1);
    assert_eq!(again.snapshot().helpers[0].name, "Reviewer");
    let refused = file.edit(|s| s.set_settings(1, 30).and_then(|_| s.add(input("Two", "codex"), "sb-2".into()).map(|_| ())));
    assert!(refused.is_err());
    assert_eq!(file.snapshot().helpers.len(), 1, "the change that failed is not kept");
    assert_eq!(HelperFile::at(file.path.clone()).snapshot().settings.max, DEFAULT_MAX);
    let _ = std::fs::remove_dir_all(file.path.parent().unwrap());
}

#[test]
fn a_hand_edited_file_is_pulled_into_range() {
    let dir = std::env::temp_dir().join(format!("pm-standby-helpers-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("standby-helpers.json");
    let helper = |id: &str| serde_json::json!({"id": id, "name": "  x ", "agent": " Codex ", "project": "/p"});
    let mut list: Vec<_> = (0..20).map(|n| helper(&format!("h{n}"))).collect();
    list.push(helper("h0"));
    list.push(serde_json::json!({"id": "", "name": "n", "agent": "a", "project": "/p"}));
    std::fs::write(&path, serde_json::json!({"settings": {"max": 500}, "helpers": list}).to_string()).unwrap();
    let store = HelperFile::at(path).snapshot();
    assert_eq!(store.helpers.len(), MAX_HELPERS);
    assert_eq!(store.settings.max, MAX_HELPERS);
    assert_eq!(store.helpers[0].agent, "codex");
    assert_eq!(store.helpers[0].name, "x");
    std::fs::write(dir.join("bad.json"), "{ not json").unwrap();
    assert!(HelperFile::at(dir.join("bad.json")).snapshot().helpers.is_empty(), "a bad file means no standbys");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn only_helpers_that_can_run_as_a_chat_in_a_real_folder_are_wanted_and_each_counts_against_the_cap() {
    let folder = std::env::temp_dir();
    let mut store = HelperStore::default();
    let mut codex = input("Reviewer", "codex");
    codex.project = folder.to_string_lossy().into_owned();
    let mut shell = input("Shell", "terminalonly");
    shell.project = folder.to_string_lossy().into_owned();
    store.add(codex, "1".into()).unwrap();
    store.add(shell, "2".into()).unwrap();
    store.add(input("Gone", "codex"), "3".into()).unwrap();
    store.settings.idle_minutes = 7;
    let mut policy = Policy { cap: 3, ..Policy::default() };
    extend_policy(&mut policy, &store, &Chat(&["codex"]));
    assert_eq!(policy.helpers.len(), 1, "a terminal-only agent and a missing folder are not started");
    assert_eq!(policy.helpers[0].meta.name, "Reviewer");
    assert_eq!(policy.helpers[0].meta.model.as_deref(), Some("gpt-5"));
    assert_eq!(policy.cap, 4);
    assert_eq!(policy.helper_idle_ms, 7 * 60_000);
    // Past the limit nothing more is started.
    store.settings.max = 1;
    let mut limited = Policy::default();
    extend_policy(&mut limited, &store, &Chat(&["codex", "terminalonly"]));
    assert_eq!(limited.helpers.len(), 1);
}

#[test]
fn the_view_says_why_a_standby_cannot_start() {
    let mut store = HelperStore::default();
    store.add(input("Reviewer", "codex"), "1".into()).unwrap();
    store.add(input("Shell", "terminalonly"), "2".into()).unwrap();
    store.add(input("Gone", "codex"), "3".into()).unwrap();
    let mut statuses = BTreeMap::new();
    statuses.insert("1".to_string(), HelperStatus { state: HelperState::Busy, pane_id: Some("chat-9".into()), ..Default::default() });
    let view = build_view(&store, &statuses, |agent| agent == "codex", |project| project != "C:/gone");
    assert_eq!(view.helpers[0].state, HelperState::Busy);
    assert_eq!(view.helpers[0].pane_id.as_deref(), Some("chat-9"));
    assert_eq!(view.helpers[1].note.as_deref(), Some("needs_chat"));
    let mut missing = store.clone();
    missing.helpers[2].project = "C:/gone".into();
    let view = build_view(&missing, &statuses, |_| true, |project| project != "C:/gone");
    assert_eq!(view.helpers[2].note.as_deref(), Some("folder_missing"));
    assert_eq!(view.helpers[1].state, HelperState::Starting, "no slot yet: it is about to start");
    assert_eq!(view.max, DEFAULT_MAX);
}

#[test]
fn the_view_serialises_with_the_names_the_screens_read() {
    let mut store = HelperStore::default();
    store.add(input("Reviewer", "codex"), "sb-1".into()).unwrap();
    let json = serde_json::to_value(build_view(&store, &BTreeMap::new(), |_| true, |_| true)).unwrap();
    let entry = &json["helpers"][0];
    assert_eq!(entry["state"], "starting");
    assert_eq!(entry["after_task"], "wait");
    assert_eq!((entry["name"].as_str(), entry["agent"].as_str(), entry["model"].as_str()), (Some("Reviewer"), Some("codex"), Some("gpt-5")));
    assert_eq!(json["max"], DEFAULT_MAX);
}

#[test]
fn a_helper_has_a_home_agent_that_can_change_and_old_files_have_none() {
    let mut store = HelperStore::default();
    let mut with_home = input("Reviewer", "codex");
    with_home.home = Some("  pane-1 ".into());
    let helper = store.add(with_home, "sb-1".into()).unwrap();
    assert_eq!(helper.home.as_deref(), Some("pane-1"));
    store.set_home("sb-1", Some("pane-2".into())).unwrap();
    assert_eq!(store.helpers[0].home.as_deref(), Some("pane-2"));
    store.set_home("sb-1", Some("  ".into())).unwrap();
    assert_eq!(store.helpers[0].home, None);
    assert!(store.set_home("nope", None).is_err());
    let old = r#"{"helpers":[{"id":"a","name":"R","agent":"codex","project":"C:/p"}]}"#;
    let loaded: HelperStore = serde_json::from_str(old).unwrap();
    assert_eq!(loaded.helpers[0].home, None);
}

#[test]
fn the_policy_hands_the_home_to_the_pool_and_the_view_says_who_has_a_busy_helper() {
    let mut store = HelperStore::default();
    let mut homed = input("Reviewer", "codex");
    homed.home = Some("pane-1".into());
    homed.project = std::env::temp_dir().to_string_lossy().into_owned();
    store.add(homed, "sb-1".into()).unwrap();
    let mut policy = Policy::default();
    extend_policy(&mut policy, &store, &Chat(&["codex"]));
    assert_eq!(policy.helpers[0].meta.home.as_deref(), Some("pane-1"));
    let statuses = BTreeMap::from([("sb-1".to_string(), HelperStatus { state: HelperState::Busy, pane_id: Some("chat-1".into()), used_by: Some(HelperUser::Person), ..Default::default() })]);
    let view = build_view(&store, &statuses, |_| true, |_| true);
    assert_eq!((view.helpers[0].home.as_deref(), view.helpers[0].used_by), (Some("pane-1"), Some(HelperUser::Person)));
}

#[test]
fn an_entry_carries_the_seats_own_chats_and_never_a_takeover() {
    let mut store = HelperStore::default();
    store.add(input("Reviewer", "codex"), "sb-1".into()).unwrap();
    store.add(input("Tester", "codex"), "sb-2".into()).unwrap();
    let statuses = BTreeMap::from([
        ("sb-1".to_string(), HelperStatus { state: HelperState::Ready, open_pane: Some("chat-1".into()), ..Default::default() }),
        ("sb-2".to_string(), HelperStatus { state: HelperState::Busy, pane_id: Some("chat-2".into()), used_by: Some(HelperUser::Agent), ..Default::default() }),
    ]);
    let view = build_view(&store, &statuses, |_| true, |_| true);
    assert_eq!(view.helpers[0].open_pane.as_deref(), Some("chat-1"));
    assert_eq!((view.helpers[1].pane_id.as_deref(), view.helpers[1].used_by), (Some("chat-2"), Some(HelperUser::Agent)));
    // An agent never takes a standby away from the person: the old fields stay in the shape and are always empty.
    let json = serde_json::to_value(&view.helpers[1]).unwrap();
    assert_eq!((json["taken_over"].clone(), json["person_pane"].clone()), (serde_json::Value::Bool(false), serde_json::Value::Null));
    assert_eq!(json["open_pane"], serde_json::Value::Null);
    // A helper with no slot yet: nothing is open.
    let none = build_view(&store, &BTreeMap::new(), |_| true, |_| true);
    assert_eq!(none.helpers[0].open_pane.clone(), None);
}

#[test]
fn removing_from_an_agent_keeps_the_helper_as_a_free_warm_agent_until_it_is_made_a_standby_again() {
    let mut store = HelperStore::default();
    let mut under = input("Reviewer", "opencode");
    under.home = Some("pane-1".into());
    store.add(under, "sb-1".into()).unwrap();
    assert!(!store.helpers[0].warm);
    store.detach("sb-1").unwrap();
    assert_eq!((store.helpers[0].home.clone(), store.helpers[0].warm), (None, true), "no agent owns it, and it is still in the list (still running)");
    assert_eq!(store.helpers.len(), 1, "nothing is removed: Close is the only thing that stops it");
    let view = build_view(&store, &BTreeMap::new(), |_| true, |_| true);
    assert!(view.helpers[0].warm);
    store.set_home("sb-1", Some("pane-2".into())).unwrap();
    assert_eq!((store.helpers[0].home.as_deref(), store.helpers[0].warm), (Some("pane-2"), false), "a standby of the new agent again");
    assert!(store.detach("nope").is_err());
}

#[test]
fn a_starting_helper_says_where_its_start_is() {
    let mut store = HelperStore::default();
    store.add(input("Reviewer", "opencode"), "sb-1".into()).unwrap();
    let statuses = BTreeMap::from([("sb-1".to_string(), HelperStatus { state: HelperState::Starting, stage: Some("opening session".into()), stage_since_ms: Some(crate::event_log::now_ms() - 2_000), ..Default::default() })]);
    let view = build_view(&store, &statuses, |_| true, |_| true);
    assert_eq!(view.helpers[0].stage.as_deref(), Some("opening session"));
    assert!(view.helpers[0].stage_ms.is_some_and(|ms| ms >= 2_000));
}

const GB: u64 = 1024 * 1024 * 1024;

#[test]
fn a_standby_sleeps_sooner_on_a_small_pc_unless_the_person_set_a_time() {
    let fresh = HelperStore::default();
    assert_eq!(fresh.clone().clamped_for(Some(8 * GB)).settings.idle_minutes, 5);
    assert_eq!(fresh.clone().clamped_for(Some(24 * GB)).settings.idle_minutes, 10);
    assert_eq!(fresh.clone().clamped_for(Some(64 * GB)).settings.idle_minutes, DEFAULT_IDLE_MINUTES);
    assert_eq!(fresh.clamped_for(None).settings.idle_minutes, DEFAULT_IDLE_MINUTES);
    // The tier is not mistaken for a choice when it is saved and read again.
    let saved = HelperStore::default().clamped_for(Some(8 * GB));
    assert!(!saved.settings.idle_explicit);
    assert_eq!(saved.clamped_for(Some(8 * GB)).settings.idle_minutes, 5);
    // A time the person set wins on any PC, also one saved before the flag existed.
    let mut set = HelperStore::default();
    set.set_settings(4, 45).unwrap();
    assert_eq!(set.clone().clamped_for(Some(8 * GB)).settings.idle_minutes, 45);
    let legacy = HelperStore { settings: HelperSettings { max: 4, idle_minutes: 12, idle_explicit: false, ..Default::default() }, ..Default::default() };
    assert_eq!(legacy.clamped_for(Some(8 * GB)).settings.idle_minutes, 12);
    // Choosing today's default on a small PC is still a choice.
    let mut small = HelperStore::default().clamped_for(Some(8 * GB));
    small.set_settings(4, DEFAULT_IDLE_MINUTES).unwrap();
    assert_eq!(small.clamped_for(Some(8 * GB)).settings.idle_minutes, DEFAULT_IDLE_MINUTES);
}

#[test]
fn a_standby_is_a_spin_off_unless_set_to_minion_and_the_setting_decides_when_none_is_picked() {
    use crate::agent_run_mode::StartedAs;
    let mut store = HelperStore::default();
    assert_eq!(store.add(input("A", "codex"), "sb-1".into()).unwrap().kind, StartedAs::SpinOff, "spin-off by default");
    store.settings.default_kind = StartedAs::Minion;
    assert_eq!(store.add(input("B", "codex"), "sb-2".into()).unwrap().kind, StartedAs::Minion, "the setting decides");
    let mut own = input("C", "codex");
    own.kind = Some(StartedAs::SpinOff);
    assert_eq!(store.add(own, "sb-3".into()).unwrap().kind, StartedAs::SpinOff, "the pick decides over the setting");
    store.set_kind("sb-1", StartedAs::Minion).unwrap();
    assert_eq!(store.helpers[0].kind, StartedAs::Minion);
    assert!(store.set_kind("nope", StartedAs::Minion).is_err());
    // Limits keep the setting; the view and the policy carry the kind.
    store.set_settings(5, 30).unwrap();
    assert_eq!(store.settings.default_kind, StartedAs::Minion);
    let view = build_view(&store, &BTreeMap::new(), |_| true, |_| true);
    assert_eq!((view.helpers[0].kind, view.helpers[1].kind, view.default_kind), (StartedAs::Minion, StartedAs::Minion, StartedAs::Minion));
}

#[test]
fn an_old_file_without_kinds_loads_as_spin_offs() {
    use crate::agent_run_mode::StartedAs;
    let old = r#"{"settings":{"max":4,"idle_minutes":30,"idle_explicit":false},"helpers":[{"id":"sb-1","name":"Reviewer","agent":"codex","project":"C:/work/app"}]}"#;
    let store: HelperStore = serde_json::from_str(old).unwrap();
    assert_eq!(store.helpers[0].kind, StartedAs::SpinOff);
    assert_eq!(store.settings.default_kind, StartedAs::SpinOff);
}
