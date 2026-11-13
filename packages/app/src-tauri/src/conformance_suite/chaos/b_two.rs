//! Chaos cases B10, B11, B12, B13, B14, B15: two windows, two sends, one conversation opened twice (B13 B14 B15 need the fake TUI and live in tests/fake_tui_chaos_b.rs).
//!
//! Filled by branch `test/chaos-b` from SPEC-CHAOS-1113 section 2. Use only `conformance_suite::rig`
//! (`AcpRig`, `ChatRig`); one test fn per case id, named as the spec says.

use crate::acp::chat::SendError;
use crate::conformance_suite::rig::{wait_until, ChatRig};
use crate::questions::{self, now_ms};

// B10 "both see the same items in order; card closes in both; second answer: new copy `Already answered.`"
#[test]
fn chaos_two_windows_on_one_chat() {
    let rig = ChatRig::new("");
    let viewer = rig.add_viewer();
    rig.send("perm").expect("the message is sent");
    let card = rig.wait_card();
    let choice = card.choices.first().expect("the agent offered a choice").id.clone();
    // Window 1 answers.
    let first = questions::store().answer(&card.id, Some(&choice), None, "desktop", now_ms()).expect("the answer is stored");
    assert!(first.accepted, "the first answer counts");
    assert!(wait_until(30, || rig.turn_over()), "the turn goes on and ends: {:#?}", rig.kinds());
    assert_eq!(viewer.items(), rig.items(), "both windows show the same items in order");
    assert!(rig.cards().is_empty(), "the card is closed in every window");
    // Window 2 answers the same card again.
    let second = questions::store().answer(&card.id, Some(&choice), None, "desktop", now_ms()).expect("the answer is stored");
    assert!(!second.accepted, "a second answer is not applied");
    let notices = rig.notices();
    assert!(notices.iter().any(|n| n == "Already answered."), "the person is told: notices {notices:?}");
}

// B11 "one runs; the other: new copy `Still working on the last message. Wait, or press Stop.` (no internal error text)"
#[test]
fn chaos_two_sends_at_once() {
    let rig = ChatRig::new("");
    rig.send("slow").expect("the first send starts a turn");
    assert!(wait_until(10, || rig.chat.session().snapshot().turn_in_flight()), "the first turn runs");
    let refused = match rig.send("stream 2") {
        Err(e) => e,
        Ok(_) => panic!("the second send must wait for the first turn"),
    };
    assert!(matches!(refused, SendError::Busy), "the refusal is the busy one: {refused:?}");
    let notices = rig.notices();
    assert!(
        notices.iter().any(|n| n == "Still working on the last message. Wait, or press Stop."),
        "the person is told in the chat: notices {notices:?}"
    );
    // Stop the slow turn; the chat works again.
    let _ = rig.chat.cancel();
    assert!(wait_until(30, || rig.turn_over()), "the stopped turn ends");
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "));
}

// B12 "both answer, or the second says new copy `This chat is open somewhere else.`; never mixed text"
// needs-switch: a second ChatRig that resumes the same agent session id. ChatRig has no way to start a chat
// on an existing session id (its `with_store` makes new conversations only), so the case cannot be written yet.
#[test]
#[ignore = "needs-switch resume-same-session-in-second-chat-rig"]
fn chaos_one_conversation_opened_twice() {
    panic!("needs-switch: ChatRig cannot open a second chat on the same agent session id");
}
