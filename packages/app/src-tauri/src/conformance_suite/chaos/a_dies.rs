//! Chaos cases A01, A02, A03, A04, A05, A06, A07, A08, A09: the agent dies, exits oddly, or is stopped by someone else.
//!
//! Filled by branch `test/chaos-a` from SPEC-CHAOS-1113 section 2. Use only `conformance_suite::rig`
//! (`AcpRig`, `ChatRig`); one test fn per case id, named as the spec says.

use crate::conformance_suite::rig::{wait_until, ChatRig};
use crate::proc_util::pid_alive;

const CRASH_NOTICE: &str = "The agent stopped unexpectedly (exit code 3).";
const CRASHED: &str = "The agent stopped unexpectedly";

/// Sends `text` and waits up to `secs` for its turn to end.
fn send_and_end(rig: &ChatRig, text: &str, secs: u64) -> bool {
    rig.send(text).unwrap_or_else(|e| panic!("send {text:?} was refused: {e:?}"));
    wait_until(secs, || rig.turn_over())
}

/// The text of every agent answer in the chat, in order.
fn answer_text(rig: &ChatRig) -> String {
    rig.items().iter().filter(|i| i["kind"] == "assistant").filter_map(|i| i["text"].as_str().map(str::to_string)).collect()
}

/// How many notices a person reads that start with `prefix`.
fn notices_starting(rig: &ChatRig, prefix: &str) -> usize {
    rig.notices().iter().filter(|n| n.starts_with(prefix)).count()
}

/// Tool calls that have no result yet (the card would still spin).
fn open_tool_calls(rig: &ChatRig) -> Vec<String> {
    let items = rig.items();
    items
        .iter()
        .filter(|i| i["kind"] == "toolCall")
        .filter_map(|i| i["callId"].as_str().map(str::to_string))
        .filter(|call| !items.iter().any(|i| i["kind"] == "toolResult" && i["callId"].as_str() == Some(call.as_str())))
        .collect()
}

/// Tool calls whose result says it failed.
fn failed_tool_results(rig: &ChatRig) -> usize {
    rig.items().iter().filter(|i| i["kind"] == "toolResult" && i["ok"] == false).count()
}

/// The next message after the chaos still gets a normal answer.
fn next_turn_works(rig: &ChatRig) {
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "), "the next message is answered; notices {:?}", rig.notices());
    assert_eq!(rig.outcomes().last().map(String::as_str), Some("completed"), "outcomes {:?}", rig.outcomes());
}

/// Every agent process this rig started is gone (apart from one that is live now).
fn no_agent_left(rig: &ChatRig) {
    assert!(wait_until(5, || rig.alive_pids().is_empty()), "an agent process is still running: {:?}", rig.alive_pids());
}

// Person sees: "The agent stopped unexpectedly (exit code 3)." once; the turn is failed; the pane is not "working".
#[test]
fn chaos_crash_mid_turn() {
    let rig = ChatRig::new("");
    assert!(send_and_end(&rig, "crash", 30), "the turn did not end; kinds {:?}", rig.kinds());
    assert_eq!(notices_starting(&rig, CRASHED), 1, "notices {:?}", rig.notices());
    assert!(rig.notices().iter().any(|n| n == CRASH_NOTICE), "notices {:?}", rig.notices());
    assert_eq!(rig.outcomes().last().map(String::as_str), Some("failed"), "outcomes {:?}", rig.outcomes());
    assert_ne!(rig.pane_status(), "running", "the pane still says it is working");
    no_agent_left(&rig);
    next_turn_works(&rig);
}

// Person sees: the agent stopped unexpectedly; the tool card is closed (failed), not spinning.
#[test]
fn chaos_crash_with_a_tool_open() {
    let rig = ChatRig::new("");
    assert!(send_and_end(&rig, "crashtool", 30), "the turn did not end; kinds {:?}", rig.kinds());
    assert_eq!(notices_starting(&rig, CRASHED), 1, "notices {:?}", rig.notices());
    let open = open_tool_calls(&rig);
    assert!(open.is_empty(), "tool cards still spinning: {open:?}");
    assert!(failed_tool_results(&rig) >= 1, "the tool card was closed but not marked failed: {:?}", rig.items());
    no_agent_left(&rig);
    next_turn_works(&rig);
}

// Person sees: the agent stopped unexpectedly; the question card is gone from the chat and the Inbox.
#[test]
fn chaos_crash_during_a_permission_question() {
    let rig = ChatRig::new("");
    rig.send("permcrash").unwrap_or_else(|e| panic!("send refused: {e:?}"));
    rig.wait_card();
    assert!(wait_until(30, || rig.turn_over()), "the turn did not end; kinds {:?}", rig.kinds());
    assert_eq!(notices_starting(&rig, CRASHED), 1, "notices {:?}", rig.notices());
    assert!(rig.cards().is_empty(), "the question card is still pending: {:?}", rig.cards());
    no_agent_left(&rig);
    next_turn_works(&rig);
}

// Person sees (new copy): `The agent stopped. It said: "authentication failed". Sign in, then try again.` Never "done".
// known-weird A04: exit 0 with an error line.
#[ignore = "known-weird A04"]
#[test]
fn chaos_exit_zero_with_an_error_line() {
    let rig = ChatRig::new("");
    let ended = send_and_end(&rig, "exit0err", 30);
    assert!(ended, "the turn did not end; kinds {:?}", rig.kinds());
    let want = r#"The agent stopped. It said: "authentication failed". Sign in, then try again."#;
    assert!(rig.notices().iter().any(|n| n == want), "shown instead: {:?}", rig.notices());
    assert_ne!(rig.outcomes().last().map(String::as_str), Some("completed"), "the turn was shown as done");
    assert!(!rig.notices().iter().any(|n| n.contains("exit code 0")), "exit code 0 was shown");
    next_turn_works(&rig);
}

// Person sees: the chat was started by a person, then the agent process was killed from outside.
// The chat starts with "The agent stopped unexpectedly"; the agent's grandchild is gone within 5 s.
#[test]
fn chaos_killed_from_outside() {
    let rig = ChatRig::with("grandchild=1", |_| {});
    rig.send("slow").unwrap_or_else(|e| panic!("send refused: {e:?}"));
    assert!(wait_until(10, || !answer_text(&rig).is_empty()), "the slow turn never started");
    let pid = rig.chat.session().connection().expect("a live agent connection").pid();
    let grandchild_file = rig.dir.join("store").join("grandchild.pid");
    let grandchild: u32 = std::fs::read_to_string(&grandchild_file).expect("the agent wrote its grandchild pid").trim().parse().expect("a pid");
    // Kill the agent process itself by its pid (not the tree, not by name): the grandchild must clean up by itself.
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
    assert!(wait_until(10, || !pid_alive(pid)), "the killed agent is still alive");
    assert!(wait_until(10, || rig.turn_over()), "the turn did not end after the kill; kinds {:?}", rig.kinds());
    assert_eq!(notices_starting(&rig, "The agent stopped unexpectedly"), 1, "notices {:?}", rig.notices());
    assert!(wait_until(5, || !pid_alive(grandchild)), "the grandchild {grandchild} is still running 5 s after the agent died");
    no_agent_left(&rig);
}

// Person sees (new copy E8): `Something went wrong: 401 Unauthorized ...`; never "You stopped it".
// known-weird A06: the agent cancels a turn nobody stopped.
#[ignore = "known-weird A06"]
#[test]
fn chaos_cancelled_without_a_cancel_is_an_error() {
    let rig = ChatRig::new("");
    assert!(send_and_end(&rig, "selfcancel", 30), "the turn did not end; kinds {:?}", rig.kinds());
    let shown = rig.last_notice().unwrap_or_default();
    assert!(shown.starts_with("Something went wrong:") && shown.contains("401 Unauthorized"), "shown instead: {shown:?}");
    assert!(!rig.notices().iter().any(|n| n == "You stopped it"), "shown as stopped by the person: {:?}", rig.notices());
    next_turn_works(&rig);
}

// Person sees: "You stopped it"; the next message is answered. New copy if history was lost:
// `The agent forgot this chat when it was stopped. A fresh one is ready.`
// known-weird A07: a stop can destroy the agent's session.
#[ignore = "known-weird A07"]
#[test]
fn chaos_stop_that_destroys_the_session() {
    let rig = ChatRig::with("cancel_kills_session=1", |_| {});
    rig.send("slow").unwrap_or_else(|e| panic!("send refused: {e:?}"));
    assert!(wait_until(10, || !answer_text(&rig).is_empty()), "the slow turn never started");
    rig.chat.cancel().expect("the stop is sent");
    assert!(wait_until(30, || rig.turn_over()), "the stopped turn did not end; kinds {:?}", rig.kinds());
    assert!(rig.notices().iter().any(|n| n == "You stopped it"), "notices {:?}", rig.notices());
    rig.say("stream 2");
    let answer = rig.last_answer().unwrap_or_default();
    assert_eq!(answer, "w0 w1 ", "the next message is not answered; notices {:?}", rig.notices());
}

// Person sees: "reply is fresh"; the text "STALE" from the replaced session is never shown.
// known-weird A08: a chunk from an old session is shown (needs the A3 fix).
#[test]
fn chaos_late_chunk_from_an_old_session_is_dropped() {
    let rig = ChatRig::new("");
    assert!(send_and_end(&rig, "latechunk", 30), "the turn did not end; kinds {:?}", rig.kinds());
    let text = answer_text(&rig);
    assert!(text.contains("fresh"), "the fresh answer is missing: {text:?}");
    assert!(!text.contains("STALE"), "a chunk from the old session is shown: {text:?}");
    next_turn_works(&rig);
}

// Person sees: three "The agent stopped unexpectedly (exit code 3)." notices, no restart loop; the fourth message works.
#[test]
fn chaos_three_crashes_in_a_row() {
    let rig = ChatRig::new("");
    for n in 1..=3 {
        assert!(send_and_end(&rig, "crash", 30), "crash {n} did not end; kinds {:?}", rig.kinds());
    }
    assert_eq!(rig.notices().iter().filter(|n| n.as_str() == CRASH_NOTICE).count(), 3, "notices {:?}", rig.notices());
    assert_eq!(rig.outcomes().iter().filter(|o| o.as_str() == "failed").count(), 3, "outcomes {:?}", rig.outcomes());
    no_agent_left(&rig);
    next_turn_works(&rig);
}
