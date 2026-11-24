//! Force yes, Fences and Pins in a real chat: the fake agent asks, the app answers or leaves the question to the person.
//! Each rig is its own project folder, so the saved rules (a global store) never touch another test.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

use super::start::start;
use crate::test_support::chat_rig::{agents, conversations_in, deps_for};
use super::{AcpChat, StartRequest};
use crate::agent_rules::{self, Pin};
use crate::test_support::wait::wait_until;

struct Rig {
    dir: PathBuf,
    chat: Arc<AcpChat>,
    _gate: crate::test_support::wait::Permit<'static>,
}

impl Rig {
    /// `before_start` runs with the project folder before the chat starts (pins and fences are read at the start).
    fn new(opts: &str, before_start: impl FnOnce(&str)) -> Rig {
        let gate = crate::test_support::wait::process_permit();
        let dir = std::env::temp_dir().join(format!("pm-acp-rules-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        before_start(&dir.to_string_lossy());
        let conversations = conversations_in(&dir, opts);
        let deps = deps_for(&dir, &conversations);
        let cfg = agents(opts, &dir).0["fake"].as_ref().clone();
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
        assert!(wait_until(30, || self.chat.items().iter().any(|i| serde_json::to_value(i).unwrap()["id"] == format!("end:{turn}"))), "the turn did not end: {:?}", self.texts());
    }

    fn texts(&self) -> Vec<String> {
        self.chat.items().iter().filter_map(|i| serde_json::to_value(i).unwrap().get("text").and_then(Value::as_str).map(str::to_string)).collect()
    }

    fn said(&self, needle: &str) -> bool {
        self.texts().iter().any(|t| t.contains(needle))
    }

    fn asked(&self) -> bool {
        wait_until(30, || self.chat.state()["permissions"][0]["questionId"].is_string())
    }

    fn audit(&self, event: &str) -> usize {
        let id = self.chat.pane_id();
        crate::audit::global().recent(500).iter().filter(|e| e.kind == "agent_rules.event" && e.detail["event"] == event && e.detail["pane_id"] == id).count()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.chat.retire();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ---- Force yes -------------------------------------------------------------------------------------------------

#[test]
fn force_yes_is_off_by_default_and_a_question_waits_for_the_person() {
    let rig = Rig::new("", |_| {});
    assert_eq!(rig.chat.state()["forceYes"], false);
    rig.chat.send("permwith execute cmd:git status").unwrap();
    assert!(rig.asked(), "with Force yes off the question is a card");
    assert!(!rig.said("Auto-allowed"));
}

#[test]
fn force_yes_answers_a_low_risk_question_logs_it_and_leaves_a_quiet_line() {
    let rig = Rig::new("", |_| {});
    rig.chat.set_force_yes(true);
    assert_eq!(rig.chat.state()["forceYes"], true);
    rig.say("permwith execute cmd:git status");
    assert!(rig.said("asked:execute outcome:selected option:allow_once"), "answered with allow once, never allow always: {:?}", rig.texts());
    assert!(rig.said("Auto-allowed: Run git status"), "the quiet line: {:?}", rig.texts());
    assert_eq!(rig.chat.state()["permissions"].as_array().map(Vec::len), Some(0), "no card was raised");
    assert_eq!(rig.audit("auto_allowed"), 1, "the audit log has the answer");
    assert_eq!(rig.audit("force_yes_on"), 1, "and the switch");
    // The audit line holds the program and a hash, never the command text.
    let entries = crate::audit::global().recent(500);
    let line = entries.iter().find(|e| e.detail["event"] == "auto_allowed" && e.detail["pane_id"] == rig.chat.pane_id()).unwrap();
    assert_eq!(line.detail["command"]["program"], "git");
    assert!(!line.detail.to_string().contains("git status"));
}

#[test]
fn force_yes_answers_a_command_that_is_only_in_the_title_like_agy_does() {
    // Agy sends kind execute and the title `dir`, with no rawInput: the title is the command.
    let rig = Rig::new("", |_| {});
    rig.chat.set_force_yes(true);
    rig.say("permwith execute title:dir");
    assert!(rig.said("asked:execute outcome:selected option:allow_once"), "{:?}", rig.texts());
    assert_eq!(rig.chat.state()["permissions"].as_array().map(Vec::len), Some(0), "no card was raised");
    // The prefix some agents add does not matter either.
    let rig = Rig::new("", |_| {});
    rig.chat.set_force_yes(true);
    rig.say("permwith execute title:Run command: dir");
    assert!(rig.said("outcome:selected option:allow_once"), "{:?}", rig.texts());
}

#[test]
fn force_yes_reads_the_command_from_the_tool_call_when_the_question_only_says_run_command() {
    let rig = Rig::new("", |_| {});
    rig.chat.set_force_yes(true);
    rig.say("permwith execute prior:git status");
    assert!(rig.said("asked:execute outcome:selected option:allow_once"), "{:?}", rig.texts());
    assert_eq!(rig.chat.state()["permissions"].as_array().map(Vec::len), Some(0), "no card was raised");
    // The same way, a risky command still goes to the person.
    let rig = Rig::new("", |_| {});
    rig.chat.set_force_yes(true);
    rig.chat.send("permwith execute prior:rm -rf /").unwrap();
    assert!(rig.asked());
    assert!(!rig.said("Auto-allowed"), "{:?}", rig.texts());
}

#[test]
fn force_yes_judges_a_long_command_title_whole_not_the_300_characters_the_card_keeps() {
    // Agy puts a whole script in the title; the state cuts the title for the card (300 characters and an ellipsis).
    let rig = Rig::new("", |_| {});
    rig.chat.set_force_yes(true);
    rig.say(&format!("permwith execute title:echo {}", "a".repeat(500)));
    assert!(rig.said("asked:execute outcome:selected option:allow_once"), "{:?}", rig.texts());
    assert_eq!(rig.chat.state()["permissions"].as_array().map(Vec::len), Some(0), "no card was raised");
}

/// The words the card got for why Force yes left the question to the person.
fn left_line(rig: &Rig) -> String {
    let id = rig.chat.state()["permissions"][0]["questionId"].as_str().unwrap().to_string();
    crate::questions::store().get(&id, crate::questions::now_ms()).and_then(|q| q.context).unwrap_or_default()
}

#[test]
fn a_question_force_yes_leaves_to_the_person_carries_the_reason() {
    for (ask, code) in [("permwith execute title:Run the tests please", "risky"), ("permwith other title:Do a thing", "kind"), ("permwith execute title:cat .env", "secret")] {
        let rig = Rig::new("", |_| {});
        rig.chat.set_force_yes(true);
        rig.chat.send(ask).unwrap();
        assert!(rig.asked(), "{ask}");
        assert!(left_line(&rig).contains(&format!("Force yes asked: {code}")), "{ask}: {}", left_line(&rig));
    }
    // With Force yes off nothing is said.
    let rig = Rig::new("", |_| {});
    rig.chat.send("permwith execute title:Run the tests please").unwrap();
    assert!(rig.asked());
    assert!(!left_line(&rig).contains("Force yes asked"));
}

#[test]
fn a_risky_or_unknown_command_in_the_title_still_asks() {
    for ask in ["permwith execute title:rm -rf /", "permwith execute title:Run the tests please"] {
        let rig = Rig::new("", |_| {});
        rig.chat.set_force_yes(true);
        rig.chat.send(ask).unwrap();
        assert!(rig.asked(), "{ask} must come to the person");
        assert!(!rig.said("Auto-allowed"), "{ask}: {:?}", rig.texts());
    }
}

#[test]
fn titles_that_hide_a_command_inside_a_command_or_were_cut_still_ask() {
    let long = format!("{}; rm -rf ~", "dir ".repeat(600));
    let many = format!("{}rm -rf ~", "dir;".repeat(45));
    let cut = format!("{}…", "dir ".repeat(10));
    let dots = format!("{}...", "dir ".repeat(10));
    let asks = [
        "echo $(rm -rf ~)".to_string(),
        "ls `rm -rf ~`".to_string(),
        "git -c core.pager='rm -rf ~' log".to_string(),
        "cat <(rm -rf ~)".to_string(),
        many,
        long,
        cut,
        dots,
    ];
    for title in asks {
        let rig = Rig::new("", |_| {});
        rig.chat.set_force_yes(true);
        rig.chat.send(&format!("permwith execute title:{title}")).unwrap();
        assert!(rig.asked(), "{} must come to the person", title.chars().take(60).collect::<String>());
        assert!(!rig.said("Auto-allowed"), "{:?}", rig.texts());
    }
}

#[test]
fn a_risky_ask_still_reaches_the_person_with_force_yes_on() {
    let rig = Rig::new("", |_| {});
    rig.chat.set_force_yes(true);
    rig.chat.send("permwith execute cmd:rm -rf /").unwrap();
    assert!(rig.asked(), "a destructive command is a card even with Force yes on");
    assert!(!rig.said("Auto-allowed"), "{:?}", rig.texts());
    assert_eq!(rig.audit("auto_allowed"), 0);
    // The person says no through the card, as always.
    let state = rig.chat.state();
    let option = state["permissions"][0]["options"].as_array().unwrap().iter().find(|o| o["kind"] == "reject_once").unwrap()["id"].as_str().unwrap().to_string();
    let question = state["permissions"][0]["questionId"].as_str().unwrap().to_string();
    crate::questions::store().answer(&question, Some(&option), None, "person", crate::questions::now_ms()).unwrap();
    assert!(wait_until(30, || rig.said("option:reject_once")), "{:?}", rig.texts());
}

#[test]
fn force_yes_never_answers_deleting_moving_unknown_kinds_or_anything_that_looks_like_a_password() {
    for ask in ["permwith delete path:src/a.txt", "permwith move path:src/a.txt", "permwith other cmd:ls", "permwith read path:.env", "permwith execute cmd:echo $PASSWORD"] {
        let rig = Rig::new("", |_| {});
        rig.chat.set_force_yes(true);
        rig.chat.send(ask).unwrap();
        assert!(rig.asked(), "{ask} must come to the person");
        assert!(!rig.said("Auto-allowed"), "{ask}: {:?}", rig.texts());
    }
}

#[test]
fn a_card_that_is_already_open_stays_the_persons_when_force_yes_is_turned_on() {
    let rig = Rig::new("", |_| {});
    rig.chat.send("permwith read path:src/main.rs").unwrap();
    assert!(rig.asked());
    rig.chat.set_force_yes(true);
    // `set_force_yes` is synchronous and never touches a card that is already open, so the state can be read at once.
    assert!(rig.chat.state()["permissions"][0]["questionId"].is_string(), "the open card is still there");
    assert!(!rig.said("Auto-allowed"), "{:?}", rig.texts());
}

// ---- Fences ----------------------------------------------------------------------------------------------------

#[test]
fn a_write_inside_a_fence_is_denied_with_a_note_and_nothing_is_written() {
    let rig = Rig::new("writes=1", |project| {
        agent_rules::store().add_fence(project, "secrets").unwrap();
    });
    rig.say("hello");
    assert!(rig.said("- secrets"), "the first message carries the fence: {:?}", rig.texts());
    rig.say("permwith edit path:secrets/key.txt");
    assert!(rig.said("asked:edit outcome:selected option:reject_once"), "the agent was told no: {:?}", rig.texts());
    assert!(rig.said("Blocked by a fence: secrets/key.txt is fenced (secrets)"), "{:?}", rig.texts());
    assert!(!rig.dir.join("permwith.txt").exists(), "the denied write did not happen");
    assert_eq!(rig.audit("fence_denied"), 1);
    assert_eq!(rig.chat.state()["permissions"].as_array().map(Vec::len), Some(0), "the person was not asked");
}

#[test]
fn the_fence_holds_when_force_yes_is_on_and_a_write_outside_it_is_left_alone() {
    let rig = Rig::new("writes=1", |project| {
        agent_rules::store().add_fence(project, "secrets").unwrap();
    });
    rig.chat.set_force_yes(true);
    rig.say("hello");
    rig.say("permwith edit path:secrets/key.txt");
    assert!(rig.said("option:reject_once"), "{:?}", rig.texts());
    assert!(!rig.said("Auto-allowed"));
    // Outside the fence Force yes answers as usual.
    rig.say("permwith edit path:src/ok.txt");
    assert!(rig.said("Auto-allowed: Touch src/ok.txt"), "{:?}", rig.texts());
    assert!(rig.dir.join("permwith.txt").exists());
}

#[test]
fn a_fence_added_after_the_chat_started_counts_at_once_and_a_command_that_names_it_asks_the_person() {
    let rig = Rig::new("", |_| {});
    rig.chat.set_force_yes(true);
    agent_rules::store().add_fence(&rig.project(), "secrets").unwrap();
    rig.say("hello");
    rig.chat.send("permwith execute cmd:ls secrets").unwrap();
    assert!(rig.asked(), "Force yes does not answer a command that names a fenced path");
}

// ---- Pins ------------------------------------------------------------------------------------------------------

#[test]
fn a_new_chat_starts_with_the_pins_of_its_project() {
    let rig = Rig::new("", |project| {
        agent_rules::store().set_pin(Some(project), Pin { force_yes: Some(true), notes: Some("Run the tests first.".into()), ..Default::default() }).unwrap();
    });
    assert_eq!(rig.chat.state()["forceYes"], true, "the pin turned Force yes on for a new agent");
    rig.say("hello");
    assert!(rig.said("Run the tests first."), "the pinned notes went with the first message: {:?}", rig.texts());
    // Said once: the second message is plain.
    rig.say("again");
    let echoes = rig.texts().iter().filter(|t| t.contains("Run the tests first.")).count();
    assert_eq!(echoes, 1, "{:?}", rig.texts());
}

#[test]
fn a_chat_in_another_project_does_not_pick_up_this_projects_pins() {
    let _ = Rig::new("", |project| {
        agent_rules::store().set_pin(Some(project), Pin { force_yes: Some(true), ..Default::default() }).unwrap();
    });
    let other = Rig::new("", |_| {});
    assert_eq!(other.chat.state()["forceYes"], false);
}
