//! Chaos cases A20, A21, A22, A23, A24: sizes: a one megabyte line, a million character prompt, ten thousand tool cards, binary junk, four megabytes of diffs.
//!
//! Filled by branch `test/chaos-a` from SPEC-CHAOS-1113 section 2. Use only `conformance_suite::rig`
//! (`AcpRig`, `ChatRig`); one test fn per case id, named as the spec says.

use crate::conformance_suite::rig::{wait_until, ChatRig};

const TOO_BIG_TO_SHOW: &str = "The agent sent one message that is too big to show.";
const TOO_LONG_TO_SEND: &str = "That message is too long to send. Shorten it or attach it as a file.";

/// The text of every agent answer in the chat, in order.
fn answer_text(rig: &ChatRig) -> String {
    rig.items().iter().filter(|i| i["kind"] == "assistant").filter_map(|i| i["text"].as_str().map(str::to_string)).collect()
}

/// Tool calls that have no result yet (the card would still spin).
fn open_tool_calls(rig: &ChatRig) -> usize {
    let items = rig.items();
    items
        .iter()
        .filter(|i| i["kind"] == "toolCall")
        .filter_map(|i| i["callId"].as_str().map(str::to_string))
        .filter(|call| !items.iter().any(|i| i["kind"] == "toolResult" && i["callId"].as_str() == Some(call.as_str())))
        .count()
}

/// The next message after the chaos still gets a normal answer.
fn next_turn_works(rig: &ChatRig) {
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "), "the next message is answered; notices {:?}", rig.notices());
}

// Person sees: the whole text, or "The agent sent one message that is too big to show."; never a hang or a dead chat.
#[test]
fn chaos_one_megabyte_line() {
    let rig = ChatRig::new("");
    rig.send("bigline 1048576").unwrap_or_else(|e| panic!("send refused: {e:?}"));
    assert!(wait_until(30, || rig.turn_over()), "the chat hung; kinds {:?}", rig.kinds().len());
    let text = answer_text(&rig);
    let whole = text.len() == 1_048_576 && text.bytes().all(|b| b == b'a');
    let notice = rig.notices().iter().any(|n| n == TOO_BIG_TO_SHOW);
    println!("A20 seen: {}", if whole { "the whole text" } else if notice { "the too-big notice" } else { "neither" });
    assert!(whole || notice, "shown: {} bytes, notices {:?}", text.len(), rig.notices());
    next_turn_works(&rig);
}

// Person sees: "len:1000011", or "That message is too long to send. Shorten it or attach it as a file."; decided within 20 s.
#[test]
fn chaos_million_character_prompt() {
    let rig = ChatRig::new("");
    let prompt = format!("len {}", "x".repeat(1_000_007));
    match rig.send(&prompt) {
        Err(e) => {
            println!("A21 seen: refused at send ({e:?})");
            assert!(rig.notices().iter().any(|n| n == TOO_LONG_TO_SEND), "refused without a plain message: {e:?}; notices {:?}", rig.notices());
        }
        Ok(_) => {
            assert!(wait_until(20, || rig.turn_over()), "not decided within 20 s; kinds {}", rig.kinds().len());
            let answer = rig.last_answer().unwrap_or_default();
            let refused = rig.notices().iter().any(|n| n == TOO_LONG_TO_SEND);
            println!("A21 seen: answer {answer:?}, too-long notice {refused}");
            assert!(answer == "len:1000011" || refused, "shown: {answer:?}; notices {:?}", rig.notices());
        }
    }
    next_turn_works(&rig);
}

// Person sees: "tools done"; no tool card still running; it ends within 60 s. A turn shows at most MAX_TURN_CARDS cards
// (a chat of 20000 items cannot be read or scrolled); the rest are one line: "9600 more steps hidden".
#[test]
fn chaos_ten_thousand_tool_cards() {
    let rig = ChatRig::new("");
    rig.send("tools 10000").unwrap_or_else(|e| panic!("send refused: {e:?}"));
    assert!(wait_until(60, || rig.turn_over()), "not ended within 60 s");
    assert_eq!(rig.last_answer().as_deref(), Some("tools done"), "notices {:?}", rig.notices());
    assert_eq!(open_tool_calls(&rig), 0, "tool cards still running");
    let shown = crate::acp::chat::mapper::MAX_TURN_CARDS;
    assert_eq!(rig.items().iter().filter(|i| i["kind"] == "toolCall").count(), shown, "the card limit");
    let hidden: Vec<String> = rig.notices().into_iter().filter(|n| n.ends_with("more steps hidden")).collect();
    assert_eq!(hidden, vec![format!("{} more steps hidden", 10_000 - shown)], "one hidden-steps line; notices {:?}", rig.notices());
}

// Person sees: "after junk"; no junk characters anywhere in the chat.
#[test]
fn chaos_binary_junk_on_stdout() {
    let rig = ChatRig::new("");
    rig.send("binary 65536").unwrap_or_else(|e| panic!("send refused: {e:?}"));
    assert!(wait_until(30, || rig.turn_over()), "the turn did not end");
    let text = answer_text(&rig);
    assert!(text.contains("after junk"), "the answer after the junk is missing: {text:?}");
    let everything = format!("{text}{}", rig.notices().join(""));
    assert!(!everything.contains('\u{0}') && !everything.contains('\u{FFFD}'), "junk characters in the chat");
}

// Person sees: one edit card; the chat still scrolls (item count bounded); Done.
#[test]
fn chaos_four_megabytes_of_diffs() {
    let rig = ChatRig::new("");
    rig.send("bigdiff 200").unwrap_or_else(|e| panic!("send refused: {e:?}"));
    assert!(wait_until(60, || rig.turn_over()), "not ended within 60 s");
    let edits = rig.items().iter().filter(|i| i["kind"] == "toolCall").count();
    assert_eq!(edits, 1, "the diffs are not one edit card");
    assert!(rig.items().len() < 500, "the chat holds {} items", rig.items().len());
    assert_eq!(rig.outcomes().last().map(String::as_str), Some("completed"), "outcomes {:?}", rig.outcomes());
}
