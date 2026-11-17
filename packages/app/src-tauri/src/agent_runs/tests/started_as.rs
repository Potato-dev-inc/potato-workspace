//! "Agents that agents start": the decision table of the plan (5.1) through the same function the `/agents/run`
//! route calls, in every setting, with `as` left out and each value. Also: One type ignores `as`, an agent's `as`
//! never touches a run the person started or a follow-up, and a bad `as` is refused.

use crate::agent_run_mode::{
    apply_started_as_with, with_test_env, StartedAgentKind as Setting, StartedAgentTypes, TestEnv,
};
use crate::agent_runs::runtime::AgentRunRequest;
use serde_json::json;

fn request(body: serde_json::Value) -> AgentRunRequest {
    serde_json::from_value(body).unwrap()
}

fn run(types: StartedAgentTypes, setting: Setting, asked: Option<&str>) -> crate::agent_run_mode::StartedRecord {
    let mut body = json!({"task": "t", "agent_type": "claude"});
    if let Some(asked) = asked {
        body["as"] = json!(asked);
    }
    let mut request = request(body);
    apply_started_as_with(&mut request, true, types, setting).unwrap();
    request.started.expect("an agent-started first turn is decided")
}

#[test]
fn the_nine_cases_of_the_table_in_two_types() {
    // (setting, as) -> (as_used, as_reason)
    let table = [
        (Setting::AgentChooses, None, "minion", "default"),
        (Setting::AgentChooses, Some("minion"), "minion", "requested"),
        (Setting::AgentChooses, Some("spin_off"), "spin_off", "requested"),
        (Setting::Minion, None, "minion", "person_setting"),
        (Setting::Minion, Some("minion"), "minion", "requested"),
        (Setting::Minion, Some("spin_off"), "minion", "person_setting"),
        (Setting::SpinOff, None, "spin_off", "person_setting"),
        (Setting::SpinOff, Some("minion"), "spin_off", "person_setting"),
        (Setting::SpinOff, Some("spin_off"), "spin_off", "requested"),
    ];
    for (setting, asked, used, reason) in table {
        let got = run(StartedAgentTypes::Two, setting, asked);
        assert_eq!((got.as_used.as_str(), got.as_reason.as_str()), (used, reason), "{setting:?} as {asked:?}");
        assert_eq!(got.started_as.as_deref(), Some(used), "the pane and the record keep the kind: {setting:?} as {asked:?}");
    }
}

#[test]
fn one_type_ignores_as_and_never_sets_started_as() {
    for setting in [Setting::AgentChooses, Setting::Minion, Setting::SpinOff] {
        for asked in [None, Some("minion"), Some("spin_off")] {
            let got = run(StartedAgentTypes::One, setting, asked);
            assert_eq!((got.as_used.as_str(), got.as_reason.as_str()), ("helper", "one_type"), "{setting:?} as {asked:?}");
            assert_eq!(got.started_as, None);
        }
    }
}

#[test]
fn the_standby_kind_a_run_may_take_follows_the_table() {
    use crate::agent_run_mode::StartedAs;
    // Under "Let it choose" with no `as`: a standby of either kind may take the run, and its kind settles the run.
    let mut got = run(StartedAgentTypes::Two, Setting::AgentChooses, None);
    assert!(got.standby_may_upgrade);
    assert_eq!(got.standby_kind_wanted(false), None);
    got.took_standby(false, StartedAs::SpinOff);
    assert_eq!((got.as_used.as_str(), got.as_reason.as_str(), got.started_as.as_deref()), ("spin_off", "standby", Some("spin_off")));
    let mut minion = run(StartedAgentTypes::Two, Setting::AgentChooses, None);
    minion.took_standby(false, StartedAs::Minion);
    assert_eq!((minion.as_used.as_str(), minion.as_reason.as_str(), minion.started_as.as_deref()), ("minion", "standby", Some("minion")));
    // `as: "minion"` and a forced Minion take only a minion standby; `as: "spin_off"` and a forced Spin-off only a spin-off one.
    for (setting, asked, wanted) in [
        (Setting::AgentChooses, Some("minion"), StartedAs::Minion),
        (Setting::Minion, None, StartedAs::Minion),
        (Setting::Minion, Some("spin_off"), StartedAs::Minion),
        (Setting::AgentChooses, Some("spin_off"), StartedAs::SpinOff),
        (Setting::SpinOff, None, StartedAs::SpinOff),
    ] {
        let got = run(StartedAgentTypes::Two, setting, asked);
        assert!(!got.standby_may_upgrade, "{setting:?} as {asked:?}");
        assert_eq!(got.standby_kind_wanted(false), Some(wanted), "{setting:?} as {asked:?}");
        // A standby named by the agent is taken whatever its kind.
        assert_eq!(got.standby_kind_wanted(true), None);
    }
    // A named standby's own kind wins whatever was asked.
    let mut named = run(StartedAgentTypes::Two, Setting::AgentChooses, Some("minion"));
    named.took_standby(true, StartedAs::SpinOff);
    assert_eq!((named.as_used.as_str(), named.as_reason.as_str()), ("spin_off", "standby"));
    // One type never changes and takes any standby.
    let mut helper = run(StartedAgentTypes::One, Setting::AgentChooses, None);
    assert_eq!(helper.standby_kind_wanted(false), None);
    helper.took_standby(true, StartedAs::Minion);
    assert_eq!(helper.as_used, "helper");
}

#[test]
fn a_bad_as_is_refused_and_nothing_is_decided() {
    let mut request = request(json!({"task": "t", "as": "helper"}));
    let error = apply_started_as_with(&mut request, true, StartedAgentTypes::Two, Setting::AgentChooses).unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");
    assert!(request.started.is_none());
}

#[test]
fn runs_that_are_not_a_new_agent_start_are_left_alone() {
    let cases = [
        ("the person started it (no agent session)", json!({"task": "t", "as": "spin_off"}), false),
        ("a follow-up turn", json!({"task": "t", "turn_index": 1}), true),
        ("adopting a pane", json!({"task": "t", "pane_id": "pane-1"}), true),
        ("adopting a worker", json!({"task": "t", "worker_id": "w1"}), true),
        ("a handle", json!({"task": "t", "handle": "h"}), true),
    ];
    for (what, body, by_agent) in cases {
        let mut request = request(body);
        apply_started_as_with(&mut request, by_agent, StartedAgentTypes::Two, Setting::SpinOff).unwrap();
        assert!(request.started.is_none(), "{what}");
    }
}

#[test]
fn the_route_reads_the_saved_settings_and_the_default_is_a_helper() {
    // No saved choice at all: One type, so every existing caller still gets a helper and nothing else changes.
    with_test_env(TestEnv::default(), || {
        let mut request = request(json!({"task": "t", "as": "spin_off"}));
        crate::agent_run_mode::apply_started_as(&mut request, true).unwrap();
        let started = request.started.unwrap();
        assert_eq!((started.as_used.as_str(), started.as_reason.as_str()), ("helper", "one_type"));
    });
    let two = TestEnv { started_agent_types: StartedAgentTypes::Two, started_agent_kind: Some(Setting::SpinOff), ..TestEnv::default() };
    with_test_env(two, || {
        let mut request = request(json!({"task": "t"}));
        crate::agent_run_mode::apply_started_as(&mut request, true).unwrap();
        assert_eq!(request.started.unwrap().as_used, "spin_off");
    });
}

fn pane(started_as: Option<&str>, parent: Option<&str>) -> crate::pty::PaneInfo {
    let mut info: crate::pty::PaneInfo = serde_json::from_value(json!({
        "id": "p1", "pid": 0, "agent_type": "claude", "status": "idle", "cwd": "D:/x", "cols": 80, "rows": 24, "created_at": 0, "last_output_at": null,
    }))
    .unwrap();
    info.started_as = started_as.map(str::to_string);
    info.parent_pane_id = parent.map(str::to_string);
    info
}

#[test]
fn a_pane_without_started_as_is_a_spin_off_when_it_was_a_helper_and_listings_show_it_only_in_two_types() {
    use crate::agent_run_mode::{listed_started_as, StartedAs};
    // The pane's own kind wins; a helper pane from before the field counts as a spin-off; a chat the person started has none.
    assert_eq!(pane(Some("minion"), Some("pane-0")).effective_started_as(), Some(StartedAs::Minion));
    assert_eq!(pane(None, Some("pane-0")).effective_started_as(), Some(StartedAs::SpinOff));
    assert_eq!(pane(None, None).effective_started_as(), None);
    // One type: nothing is shown for a helper pane. Two types: the old helper pane lists as a spin-off.
    with_test_env(TestEnv::default(), || {
        assert_eq!(listed_started_as(&pane(None, Some("pane-0"))), None);
        assert_eq!(listed_started_as(&pane(Some("minion"), Some("pane-0"))), Some("minion"));
    });
    with_test_env(TestEnv { started_agent_types: StartedAgentTypes::Two, ..TestEnv::default() }, || {
        assert_eq!(listed_started_as(&pane(None, Some("pane-0"))), Some("spin_off"));
        assert_eq!(listed_started_as(&pane(None, None)), None);
    });
}

#[test]
fn the_reply_says_up_front_which_kind_ran_and_why_when_it_is_not_the_kind_asked_for() {
    // A minion that was asked for and ran: the plain sentence, nothing about a change.
    let minion = run(StartedAgentTypes::Two, Setting::AgentChooses, Some("minion"));
    assert!(minion.note().starts_with("This is a minion"), "{}", minion.note());
    assert!(!minion.note().contains("You asked"));
    // One type: a minion request is not used, and the note says so with the real page name (never "Helper agents").
    let one = run(StartedAgentTypes::One, Setting::AgentChooses, Some("minion"));
    assert_eq!(one.as_used, "helper");
    let note = one.note();
    assert!(note.contains("You asked for a minion") && note.contains("Two types is off"), "{note}");
    assert!(note.contains("Settings > Agents that agents start"), "{note}");
    assert!(!note.contains("Helper agents"));
    // The person's setting wins: it says so.
    let spin = run(StartedAgentTypes::Two, Setting::SpinOff, Some("minion"));
    let note = spin.note();
    assert!(note.contains("You asked for a minion, but this is a spin-off") && note.contains("setting"), "{note}");
    // A named standby of the other kind: the note names that, so a minion request never turns into a spin-off silently.
    let mut named = run(StartedAgentTypes::Two, Setting::AgentChooses, Some("minion"));
    named.took_standby(true, crate::agent_run_mode::StartedAs::SpinOff);
    assert_eq!(named.as_used, "spin_off");
    assert!(named.note().contains("You asked for a minion, but this is a spin-off") && named.note().contains("standby"), "{}", named.note());
}

#[test]
fn a_run_with_no_task_says_a_task_is_needed_and_points_at_standbys() {
    let error = crate::agent_runs::task_required_error();
    assert_eq!(error.code, "INVALID_TASK");
    assert!(error.message.contains("A task is required") && error.message.contains("no placeholder"));
    assert!(error.message.contains("standby") && error.message.contains("workspace_config"));
}

#[test]
fn an_agent_that_cannot_be_made_read_only_says_so_in_the_receipt_line() {
    let note = crate::agent_runs::read_only_cannot_note("opencode");
    assert!(note.contains("read-only cannot be enforced for opencode") && note.contains("only a request"));
}
