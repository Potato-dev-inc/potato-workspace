//! The budget of each project in a real chat: the fake agent answers, the app counts the turns of the day, and the
//! turn after the limit does not start. Each rig is its own project folder, so the saved limits never touch another test.

use std::path::PathBuf;
use std::sync::Arc;

use super::start::start;
use super::workspace_tests::{agents, conversations_in, deps_for};
use super::{AcpChat, SendError, StartRequest};
use crate::project_budget::{self, Limits, Reached};
use crate::test_support::wait::wait_until;

struct Rig {
    dir: PathBuf,
    chat: Arc<AcpChat>,
    _gate: crate::test_support::wait::Permit<'static>,
}

impl Rig {
    fn new(limits: Limits) -> Rig {
        let gate = crate::test_support::wait::process_permit();
        let dir = std::env::temp_dir().join(format!("pm-acp-project-budget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        project_budget::set_limits(&dir.to_string_lossy(), limits);
        let conversations = conversations_in(&dir, "");
        let deps = deps_for(&dir, &conversations);
        let cfg = agents("", &dir).0["fake"].as_ref().clone();
        let chat = start(&deps, cfg, StartRequest { agent_id: "fake".into(), folder: dir.clone(), explicit: true, ..Default::default() }).expect("the fake agent starts");
        Rig { dir, chat, _gate: gate }
    }

    fn project(&self) -> String {
        self.dir.to_string_lossy().into_owned()
    }

    /// Sends and waits for the turn to end.
    fn say(&self, text: &str) {
        self.chat.send(text).unwrap_or_else(|e| panic!("send {text:?}: {e:?}"));
        let turn = self.chat.session().snapshot().turn;
        assert!(wait_until(30, || self.chat.items().iter().any(|i| serde_json::to_value(i).unwrap()["id"] == format!("end:{turn}"))), "the turn did not end");
        // The count is made before the end line goes out.
    }

    fn said(&self, needle: &str) -> bool {
        self.chat.items().iter().any(|i| serde_json::to_value(i).unwrap().get("text").and_then(serde_json::Value::as_str).is_some_and(|t| t.contains(needle)))
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.chat.retire();
        project_budget::set_limits(&self.project(), Limits::default());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_project_without_limits_never_pauses_and_has_no_card() {
    let rig = Rig::new(Limits::default());
    rig.say("one");
    rig.say("two");
    assert!(rig.chat.project_budget_status().is_none(), "no limits, no card");
}

#[test]
fn the_turn_after_the_limit_does_not_start_and_the_chat_says_why() {
    let rig = Rig::new(Limits { turns_per_day: Some(2), ..Default::default() });
    rig.say("one");
    assert_eq!(rig.chat.project_budget_status().unwrap().used_turns, 1);
    assert!(rig.chat.project_budget_status().unwrap().reached.is_none());
    rig.say("two");
    let status = rig.chat.project_budget_status().unwrap();
    assert_eq!((status.used_turns, status.reached), (2, Some(Reached::Turns)));

    let turns_before = rig.chat.session().snapshot().turn;
    match rig.chat.send("three") {
        Err(SendError::Refused(text)) => assert!(text.contains("Project budget reached") && text.contains("2 turns"), "{text}"),
        other => panic!("the third turn must be refused, got {other:?}"),
    }
    assert_eq!(rig.chat.session().snapshot().turn, turns_before, "no turn was started");
    assert!(rig.said("Project budget reached"), "a line in the chat says so");
}

#[test]
fn raise_lets_the_next_turn_start() {
    let rig = Rig::new(Limits { turns_per_day: Some(1), ..Default::default() });
    rig.say("one");
    assert!(matches!(rig.chat.send("two"), Err(SendError::Refused(_))));
    let after = rig.chat.project_budget_raise().expect("limits stay");
    assert_eq!(after.limits.turns_per_day, Some(6), "1 + at least 5");
    assert!(after.reached.is_none());
    rig.say("two");
    assert_eq!(rig.chat.project_budget_status().unwrap().used_turns, 2);
}

#[test]
fn a_turn_that_is_running_finishes_even_when_it_used_the_last_turn() {
    let rig = Rig::new(Limits { turns_per_day: Some(1), ..Default::default() });
    rig.chat.send("stall 2 400").unwrap();
    // The turn is counted at its start; the limit is reached while it runs, and it still ends by itself.
    assert!(wait_until(30, || rig.chat.project_budget_status().is_some_and(|s| s.reached == Some(Reached::Turns))));
    let turn = rig.chat.session().snapshot().turn;
    assert!(wait_until(30, || rig.chat.items().iter().any(|i| serde_json::to_value(i).unwrap()["id"] == format!("end:{turn}"))), "the running turn finished");
    assert_eq!(rig.chat.items().iter().filter(|i| serde_json::to_value(i).unwrap()["kind"] == "turnEnd").count(), 1);
}

#[test]
fn agent_minutes_of_finished_turns_are_added_to_the_day() {
    let rig = Rig::new(Limits { minutes_per_day: Some(60), ..Default::default() });
    rig.say("stall 2 300");
    let status = rig.chat.project_budget_status().unwrap();
    assert_eq!(status.used_turns, 1);
    // A 0.3 second turn is under a minute; the sum is kept in milliseconds, so two turns never round away.
    assert_eq!(status.used_minutes, 0);
    assert!(status.reached.is_none());
}
