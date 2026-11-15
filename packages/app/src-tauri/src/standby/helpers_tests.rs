//! The standby helper list: limits, the saved file, the policy it adds and the view the screens read.

use super::*;
use crate::acp::warm::AgentProbe;

fn input(name: &str, agent: &str) -> NewHelper {
    NewHelper { name: name.into(), agent: agent.into(), model: Some("gpt-5".into()), project: "C:/work/app".into(), after_task: AfterTask::Wait }
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
    assert_eq!(HelperStore { settings: HelperSettings { max: 99, idle_minutes: 0 }, ..Default::default() }.clamped().settings, HelperSettings { max: MAX_HELPERS, idle_minutes: 1 });
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
    statuses.insert("1".to_string(), HelperStatus { state: HelperState::Busy, note: None, pane_id: Some("chat-9".into()) });
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
