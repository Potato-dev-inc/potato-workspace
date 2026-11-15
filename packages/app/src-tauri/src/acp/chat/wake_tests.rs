//! Start and wake: who gets it, what the message says, and how results reach an orchestrator that is busy.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;

use super::*;
use crate::test_support::wait::wait_until;

fn done(name: &str, handle: &str, status: &str, result: Option<&str>) -> Finished {
    Finished { name: name.into(), handle: handle.into(), status: status.into(), result: result.map(str::to_string), problem: None, standby: None }
}

#[test]
fn only_a_chat_in_the_app_is_started_and_woken_unless_it_says_background_itself() {
    let plain = json!({ "agent_type": "opencode", "task": "say ping" });
    assert!(wanted(&plain, true), "an orchestrator chat in the app, no wait named");
    assert!(!wanted(&plain, false), "a caller outside the app (or a terminal agent) waits in the call as before");
    assert!(wanted(&json!({ "agent_type": "opencode", "task": "x", "wait_ms": 180000 }), true), "wait_ms is copied from the tool's example by every agent: it is not a wish to block");
    assert!(wanted(&json!({ "agent_type": "opencode", "task": "x", "background": null }), true));
    assert!(!wanted(&json!({ "agent_type": "opencode", "task": "x", "background": false }), true), "background: false is the way to ask for the result inside the call");
    assert!(!wanted(&json!({ "agent_type": "opencode", "task": "x", "background": true }), true), "background: true is the caller's own way, with no wake");
    assert!(!wanted(&json!({ "agent_type": "opencode", "task": "x", "wait_ms": 180000 }), false), "outside the app wait_ms waits, as before");
    let note = note();
    assert_eq!(note["armed"], true);
    assert!(NEXT.contains("Do NOT wait, poll or call wait_agents") && NEXT.contains("end your turn"), "{NEXT}");
}

#[test]
fn the_message_says_it_is_from_the_app_and_carries_each_result() {
    let one = message(&[done("OpenCode", "h1", "completed", Some("ping"))]);
    assert!(one.starts_with("[Potato Workspace] This message is from the app, not from the person."), "{one}");
    assert!(one.contains("Your helper \"OpenCode\" (h1) finished its task. Its answer:\nping\n"), "{one}");
    assert!(one.contains("tell them the result") && one.contains("Do not start the same helper again"), "{one}");

    let mut seat = done("OpenCode", "h2", "completed", Some("pong"));
    seat.standby = Some("Reviewer".into());
    assert!(message(&[seat]).contains("Your standby helper \"Reviewer\" (h2) finished its task"), "a standby is called by its seat's name");

    let mut failed = done("Codex", "h3", "failed", None);
    failed.problem = Some("the model refused".into());
    let text = message(&[failed, done("Claude", "h4", "waiting_input", None), done("Kilo", "h5", "closed", None), done("Quiet", "h6", "completed", None)]);
    assert!(text.contains("(h3) ended without finishing (failed). What it said: the model refused"), "{text}");
    assert!(text.contains("(h4) is waiting for an answer") && text.contains("answer_prompt"), "{text}");
    assert!(text.contains("(h5) was closed before it finished"), "{text}");
    assert!(text.contains("(it gave no text answer)"), "{text}");
    assert_eq!(text.matches("[Potato Workspace]").count(), 1, "several helpers, one message");

    let block = message(&[done("OpenCode", "h8", "completed", Some("ping

```potato-result
{\"summary\": \"Waited\"}
```
"))]);
    assert!(block.contains("Its answer:
ping
") && !block.contains("potato-result") && !block.contains("summary"), "{block}");

    let long = "x".repeat(20_000);
    let clipped = message(&[done("Big", "h7", "completed", Some(&long))]);
    assert!(clipped.len() < 13_000 && clipped.contains("read the rest with inspect_agent"), "{}", clipped.len());
}

/// An orchestrator chat that can be made busy.
#[derive(Clone)]
struct FakeChat {
    pane: String,
    busy: Arc<AtomicBool>,
    gone: Arc<AtomicBool>,
    got: Arc<Mutex<Vec<String>>>,
}

impl FakeChat {
    fn new(pane: &str) -> Self {
        FakeChat { pane: pane.into(), busy: Arc::new(AtomicBool::new(false)), gone: Arc::new(AtomicBool::new(false)), got: Arc::new(Mutex::new(Vec::new())) }
    }
}

impl Target for FakeChat {
    fn pane(&self) -> String {
        self.pane.clone()
    }
    fn free(&self) -> Option<bool> {
        if self.gone.load(Ordering::SeqCst) {
            return None;
        }
        Some(!self.busy.load(Ordering::SeqCst))
    }
    fn deliver(&self, text: &str) -> Result<(), bool> {
        if self.busy.load(Ordering::SeqCst) {
            return Err(true);
        }
        self.got.lock().push(text.to_string());
        Ok(())
    }
}

const FAST: Timing = Timing { batch: Duration::from_millis(60), poll: Duration::from_millis(10), give_up: Duration::from_secs(20) };

#[test]
fn a_wake_waits_behind_the_turn_that_is_running_and_then_arrives_once() {
    let chat = FakeChat::new("wake-test-busy");
    chat.busy.store(true, Ordering::SeqCst);
    hand_over(chat.clone(), done("OpenCode", "hb", "completed", Some("ping")), FAST);
    assert!(!wait_until(1, || !chat.got.lock().is_empty()), "the person's turn is running: nothing is pushed into it");
    chat.busy.store(false, Ordering::SeqCst);
    assert!(wait_until(10, || chat.got.lock().len() == 1), "it arrives when the orchestrator is free");
    assert!(!wait_until(1, || chat.got.lock().len() > 1), "once");
    assert!(chat.got.lock()[0].contains("(hb) finished its task"));
}

#[test]
fn helpers_that_finish_close_together_are_told_in_one_message_and_a_later_one_gets_its_own() {
    let chat = FakeChat::new("wake-test-batch");
    hand_over(chat.clone(), done("A", "h-a", "completed", Some("one")), FAST);
    hand_over(chat.clone(), done("B", "h-b", "completed", Some("two")), FAST);
    assert!(wait_until(10, || chat.got.lock().len() == 1));
    let first = chat.got.lock()[0].clone();
    assert!(first.contains("(h-a)") && first.contains("(h-b)"), "{first}");
    hand_over(chat.clone(), done("C", "h-c", "completed", Some("three")), FAST);
    assert!(wait_until(10, || chat.got.lock().len() == 2));
    let second = chat.got.lock()[1].clone();
    assert!(second.contains("(h-c)") && !second.contains("(h-a)"), "{second}");
}

#[test]
fn a_wake_for_a_chat_that_is_gone_is_dropped() {
    let chat = FakeChat::new("wake-test-gone");
    chat.gone.store(true, Ordering::SeqCst);
    hand_over(chat.clone(), done("A", "h-g", "completed", Some("one")), FAST);
    assert!(!wait_until(1, || !chat.got.lock().is_empty()));
    // And nothing is left queued for it: a new chat under the same id starts clean.
    chat.gone.store(false, Ordering::SeqCst);
    hand_over(chat.clone(), done("B", "h-n", "completed", Some("two")), FAST);
    assert!(wait_until(10, || chat.got.lock().len() == 1));
    assert!(!chat.got.lock()[0].contains("(h-g)"));
}
