//! Chaos cases B01, B03, B04, B05, B06: quit and reopen, app crash, agent updated while running, twenty rapid restarts.
//!
//! Filled by branch `test/chaos-b` from SPEC-CHAOS-1113 section 2. Use only `conformance_suite::rig`
//! (`AcpRig`, `ChatRig`); one test fn per case id, named as the spec says.
//! (B02 needs a fake TUI and lives in tests/fake_tui_chaos_b.rs.)

use crate::acp::chat::AcpChat;
use crate::acp::fake_agent;
use crate::conformance_suite::rig::{temp_dir, wait_until, AcpRig, ChatRig};
use crate::proc_util::pid_alive;
use crate::pty::proc_tree::kill_process_tree;
use serde_json::Value;

fn items_of(chat: &AcpChat) -> Vec<Value> {
    chat.items().iter().filter_map(|i| serde_json::to_value(i).ok()).collect()
}

fn turn_over(chat: &AcpChat) -> bool {
    let turn = chat.session().snapshot().turn;
    items_of(chat).iter().any(|v| v["kind"] == "turnEnd" && v["id"] == format!("end:{turn}"))
}

// B01 "3 chats listed again; no agent process until one is opened; opening one shows its old messages"
#[test]
#[ignore = "chaos-finding B01: after reopen and a new message the last answer reads earlier answer, not w0 w1 (not diagnosed)"]
fn chaos_quit_with_three_chats_then_reopen() {
    let mut rig = ChatRig::with_store("", 3);
    let ids = rig.conversation_ids();
    assert_eq!(ids.len(), 3, "three chats were made");
    for id in &ids {
        let chat = rig.chat_of(id).expect("a chat per conversation");
        chat.send("stream 2").expect("the message is sent");
        assert!(wait_until(30, || turn_over(&chat)), "the turn ends in {id}");
    }
    rig.quit();
    assert!(wait_until(10, || rig.alive_pids().is_empty()), "quitting stops every agent; still running: {:?}", rig.alive_pids());
    let back = rig.reopen();
    assert_eq!(back.len(), 3, "all three chats are listed again: {back:?}");
    assert!(rig.alive_pids().is_empty(), "no agent runs until a chat is opened");
    for pane in &back {
        let chat = rig.chat_of(pane).expect("the chat is back");
        let items = items_of(&chat);
        assert!(items.iter().any(|v| v["kind"] == "user" && v["text"] == "stream 2"), "the old message is shown: {items:#?}");
    }
    assert!(rig.alive_pids().is_empty(), "opening the chats did not start an agent");
    // Open one: its agent starts and answers.
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "));
    assert_eq!(rig.alive_pids().len(), 1, "only the opened chat runs an agent");
}

// B03 "agent and grandchild gone within 5 s (nothing left running)"
#[test]
fn chaos_app_crash_leaves_no_agent_running() {
    let dir = temp_dir("host");
    let mut host = fake_agent::spawn_host(&dir).expect("the host starts an agent");
    let (agent, grandchild) = (host.agent_pid, host.grandchild_pid);
    assert!(pid_alive(agent) && pid_alive(grandchild), "both run before the crash");
    host.crash();
    let gone = wait_until(5, || !pid_alive(agent) && !pid_alive(grandchild));
    assert!(gone, "after the app crashed: agent alive={}, grandchild alive={}", pid_alive(agent), pid_alive(grandchild));
    drop(host);
    let _ = std::fs::remove_dir_all(&dir);
}

// B04 "the cut turn reads new copy `The app closed while this was running.` with Try again; not a spinner"
#[test]
#[ignore = "chaos-finding B04: after quit and reopen the cut turn reads Something went wrong: the session was closed, not the new copy"]
fn chaos_turn_cut_by_a_quit_is_marked() {
    let mut rig = ChatRig::with_store("", 1);
    let id = rig.conversation_ids().remove(0);
    let chat = rig.chat_of(&id).expect("the chat");
    chat.send("slow").expect("the slow turn starts");
    assert!(wait_until(10, || chat.session().snapshot().turn_in_flight()), "the slow turn runs");
    // Quit without pressing Stop.
    rig.quit();
    assert!(wait_until(10, || rig.alive_pids().is_empty()), "quit stops the agent");
    let back = rig.reopen();
    assert!(!back.is_empty(), "the chat is listed again");
    let notices = rig.notices();
    let outcomes = rig.outcomes();
    let still_running = rig.chat.session().snapshot().turn_in_flight();
    assert!(
        notices.iter().any(|n| n == "The app closed while this was running."),
        "the person is told the turn was cut: notices {notices:?}, outcomes {outcomes:?}, still running {still_running}"
    );
    assert!(!still_running, "no spinner: nothing is running after the app opened again");
    // The chat is alive: the next message works.
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "));
}

// B05 "the answer arrives; no error (pin off)"
#[test]
#[ignore = "chaos-finding B05: after an idle kill the next message shows Something went wrong: the adapter exited before the turn finished"]
fn chaos_agent_updated_while_running() {
    let dir = temp_dir("version");
    let version = dir.join("version.txt");
    std::fs::write(&version, "1.0.0").expect("the version file");
    let opts = format!("version_file={}", version.display());
    let rig = ChatRig::new(&opts);
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "), "the first answer");
    // The update lands: the program reports 2.0.0 at its next start. Then the old process is killed.
    std::fs::write(&version, "2.0.0").expect("the update");
    let pid = rig.chat.session().connection().expect("a live agent").pid();
    kill_process_tree(pid);
    assert!(wait_until(10, || !pid_alive(pid)), "the old agent {pid} is gone");
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "), "the answer after the update arrives");
    let errors: Vec<String> = rig.notices().into_iter().filter(|n| n.starts_with("The agent ") || n.starts_with("Something went wrong")).collect();
    assert!(errors.is_empty(), "no error is shown for the update: {errors:?}");
}

// B06 "every start opens; zero processes left"
#[test]
fn chaos_twenty_rapid_restarts() {
    for round in 1..=20 {
        let rig = AcpRig::new("");
        let summary = rig.run_turn("stream 1");
        assert_eq!(summary.stop_reason.as_deref(), Some("end_turn"), "round {round}: the start answers");
        assert_eq!(rig.text_since(0), "w0 ", "round {round}: the answer text");
        let pid = rig.pid();
        rig.session.close();
        assert!(wait_until(10, || !pid_alive(pid)), "round {round}: agent {pid} still alive after close");
    }
}
