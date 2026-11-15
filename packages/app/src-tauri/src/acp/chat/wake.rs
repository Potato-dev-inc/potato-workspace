//! Start and wake: an agent that is itself a chat in the app does not sit inside `run_agent` until its helper is done.
//!
//! An agent cannot read a new message while a tool call is open, so an orchestrator that waits in `run_agent` cannot
//! answer the person. For a caller that is a chat in this app (and did not ask for a wait), `run_agent` returns at once
//! with the helper's handle and `wake.armed`; the orchestrator ends its turn and can talk to the person. When the helper
//! finishes (or needs an answer), the app sends the orchestrator one new message with the helper's result.
//!
//! * Every caller outside the app gets the old behaviour, and so does a chat in the app that says `background` itself
//!   (`false`: wait in the call; `true`: return at once, no wake).
//! * The wake waits for the orchestrator to be free: it queues behind a turn that is running (the person's, usually).
//! * Helpers that finish close together go in one message.
//! * A result the orchestrator already collected with `wait_agents` is not sent again.
//! * The message is marked as the app's (`APP_SENDER`), never as a device of the person.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::{AcpChat, Readiness, SendError};

/// The sender put on a wake message (the screens show "from Potato Workspace").
pub const APP_SENDER: &str = "app:helper-result";

/// What the caller is told to do, in the tool's answer.
pub const NEXT: &str = "The helper is working. Do NOT wait, poll or call wait_agents. Tell the person in one line that the helper is working, then end your turn: you can keep talking with the person meanwhile. Potato Workspace will send you a new message with the helper's result the moment it finishes; finish the job then.";

/// Helpers that finish this close together are told in one message.
const BATCH_WINDOW: Duration = Duration::from_millis(1_200);
const POLL: Duration = Duration::from_millis(250);
/// A wake nobody could be given (the orchestrator never came free) is dropped after this long.
const GIVE_UP: Duration = Duration::from_secs(2 * 60 * 60);
/// A helper is watched this long at most.
const WATCH_MAX: Duration = Duration::from_secs(6 * 60 * 60);
const RESULT_CHARS: usize = 12_000;

/// What one helper has to say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    pub name: String,
    pub handle: String,
    /// `completed`, `failed`, `cancelled`, `waiting_input` or `closed`.
    pub status: String,
    pub result: Option<String>,
    pub problem: Option<String>,
    /// The seat's name when a standby did the task.
    pub standby: Option<String>,
}

/// Whether this `run_agent` is started-and-woken: the caller is a chat in the app and did not say `background` itself.
///
/// `wait_ms` does not count as asking to wait here: agents copy it from the tool's own example on every call (the real
/// Claude orchestrator did, and then could not answer the person for the whole wait). A chat in the app that truly
/// wants the result inside the call says `background: false`.
pub fn wanted(value: &Value, caller_is_chat: bool) -> bool {
    caller_is_chat && value.get("background").is_none_or(Value::is_null)
}

/// What goes in the tool's answer.
pub fn note() -> Value {
    json!({ "armed": true, "how": "The app sends you a new message with the result when the helper finishes.", "next": NEXT })
}

/// The message the orchestrator gets.
pub fn message(done: &[Finished]) -> String {
    let mut out = String::from("[Potato Workspace] This message is from the app, not from the person.\n");
    for one in done {
        let who = match &one.standby {
            Some(seat) => format!("Your standby helper \"{seat}\" ({})", one.handle),
            None => format!("Your helper \"{}\" ({})", one.name, one.handle),
        };
        match one.status.as_str() {
            "completed" => {
                out.push_str(&format!("\n{who} finished its task. Its answer:\n"));
                out.push_str(&clip(one.result.as_deref().unwrap_or("(it gave no text answer)")));
                out.push('\n');
            }
            "waiting_input" => {
                out.push_str(&format!("\n{who} is waiting for an answer before it can go on. Look at it with inspect_agent and answer with answer_prompt (or ask the person). You will get another message when it finishes.\n"));
            }
            "closed" => out.push_str(&format!("\n{who} was closed before it finished.\n")),
            other => {
                out.push_str(&format!("\n{who} ended without finishing ({other})."));
                if let Some(problem) = &one.problem {
                    out.push_str(&format!(" What it said: {}", clip(problem)));
                }
                out.push('\n');
            }
        }
    }
    out.push_str("\nCarry on with what the person asked for and tell them the result. Do not start the same helper again.");
    out
}

/// The answer without the machine block a helper appends for the tools (```potato-result ... ```): the orchestrator and
/// the person read words, and the block's summary is the answer said twice.
fn without_result_block(text: &str) -> String {
    let Some(start) = text.find("```potato-result") else { return text.to_string() };
    let rest = &text[start + 3..];
    let end = rest.find("```").map(|at| start + 3 + at + 3).unwrap_or(text.len());
    format!("{}{}", &text[..start], &text[end..])
}

fn clip(text: &str) -> String {
    let text = without_result_block(text);
    let text = text.trim();
    if text.chars().count() <= RESULT_CHARS {
        return text.to_string();
    }
    let cut: String = text.chars().take(RESULT_CHARS).collect();
    format!("{cut}\n(the answer is longer: read the rest with inspect_agent)")
}

// ---- the queue ----------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Book {
    /// Results waiting for their orchestrator, by its pane.
    waiting: HashMap<String, Vec<Finished>>,
    /// Orchestrators a thread is delivering to.
    delivering: HashSet<String>,
    /// Helpers whose result the orchestrator already read (`wait_agents`).
    collected: HashSet<String>,
    /// Helpers being watched.
    watched: HashSet<String>,
}

static BOOK: Lazy<Mutex<Book>> = Lazy::new(|| Mutex::new(Book::default()));

/// The orchestrator read helper `handle`'s final result itself: no wake for it.
pub fn note_collected(handle: &str) {
    let mut book = BOOK.lock();
    if book.watched.contains(handle) {
        book.collected.insert(handle.to_string());
    }
}

/// What a wake needs from a chat (the orchestrator's side); a test stands in for it.
pub trait Target: Send + Sync + 'static {
    fn pane(&self) -> String;
    /// `None`: the chat is gone. `Some(true)`: it can take a message now.
    fn free(&self) -> Option<bool>;
    /// Sends the message as the app's. `Err(true)`: busy, try again; `Err(false)`: it will never go.
    fn deliver(&self, text: &str) -> Result<(), bool>;
}

impl Target for Arc<AcpChat> {
    fn pane(&self) -> String {
        self.pane_id().to_string()
    }

    fn free(&self) -> Option<bool> {
        if self.is_closed() {
            return None;
        }
        Some(self.readiness() == Readiness::Ready && !self.session().snapshot().turn_in_flight())
    }

    fn deliver(&self, text: &str) -> Result<(), bool> {
        match self.send_from_app(text, APP_SENDER) {
            Ok(_) => Ok(()),
            Err(SendError::Busy) => Err(true),
            Err(error) => {
                tracing::warn!(pane = %self.pane_id(), ?error, "acp: a helper's result could not be sent to its orchestrator");
                Err(false)
            }
        }
    }
}

/// Queues `done` for `target` and delivers what is queued as soon as the target is free (one thread per target at a time).
pub fn hand_over<T: Target>(target: T, done: Finished, timing: Timing) {
    let pane = target.pane();
    {
        let mut book = BOOK.lock();
        book.waiting.entry(pane.clone()).or_default().push(done);
        if !book.delivering.insert(pane.clone()) {
            return;
        }
    }
    let run = move || deliver_all(&target, timing);
    if std::thread::Builder::new().name("acp-wake".into()).spawn(run).is_err() {
        BOOK.lock().delivering.remove(&pane);
    }
}

/// The waits of a delivery; tests shrink them.
#[derive(Clone, Copy)]
pub struct Timing {
    pub batch: Duration,
    pub poll: Duration,
    pub give_up: Duration,
}

pub const LIVE: Timing = Timing { batch: BATCH_WINDOW, poll: POLL, give_up: GIVE_UP };

fn deliver_all<T: Target>(target: &T, timing: Timing) {
    let pane = target.pane();
    let started = Instant::now();
    // Helpers that finish together are told together.
    std::thread::sleep(timing.batch);
    loop {
        let stop = |why: &str| {
            let mut book = BOOK.lock();
            let dropped = book.waiting.remove(&pane).map(|list| list.len()).unwrap_or(0);
            book.delivering.remove(&pane);
            if dropped > 0 {
                tracing::info!(pane = %pane, dropped, "acp: helper results were not delivered: {why}");
            }
        };
        match target.free() {
            None => return stop("the orchestrator's chat is gone"),
            Some(false) if started.elapsed() >= timing.give_up => return stop("the orchestrator never came free"),
            Some(false) => {
                std::thread::sleep(timing.poll);
                continue;
            }
            Some(true) => {}
        }
        let batch = {
            let mut book = BOOK.lock();
            match book.waiting.remove(&pane).filter(|list| !list.is_empty()) {
                Some(batch) => batch,
                None => {
                    book.delivering.remove(&pane);
                    return;
                }
            }
        };
        match target.deliver(&message(&batch)) {
            Ok(()) => {
                crate::standby::seat_log::line(&format!("wake sent to {pane}: {} helper result(s)", batch.len()));
                // A turn starts now; anything that arrives meanwhile waits for it to end.
                std::thread::sleep(timing.poll);
            }
            Err(true) => {
                // It became busy between the look and the send: the batch waits, in order.
                let mut book = BOOK.lock();
                let later = book.waiting.remove(&pane).unwrap_or_default();
                book.waiting.insert(pane.clone(), batch.into_iter().chain(later).collect());
                drop(book);
                std::thread::sleep(timing.poll);
            }
            Err(false) => return stop("the orchestrator did not take the message"),
        }
    }
}

// ---- watching a helper -------------------------------------------------------------------------------------------------

fn finished_of(helper: &AcpChat) -> Finished {
    let view = super::surface::view(helper);
    let text = |key: &str| view.get(key).and_then(Value::as_str).map(str::to_string);
    let status = if helper.is_closed() && !matches!(text("status").as_deref(), Some("completed" | "failed" | "cancelled")) { "closed".to_string() } else { text("status").unwrap_or_else(|| "closed".into()) };
    Finished {
        name: text("name").unwrap_or_else(|| helper.label().to_string()),
        handle: helper.pane_id().to_string(),
        status,
        result: text("result"),
        problem: view.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).map(str::to_string),
        standby: view.get("standby").and_then(|s| s.get("name")).and_then(Value::as_str).map(str::to_string),
    }
}

/// Arms the wake: `helper` is watched, and `orchestrator` gets a message when it finishes or needs an answer.
pub fn arrange(orchestrator: Arc<AcpChat>, helper: Arc<AcpChat>) {
    let handle = helper.pane_id().to_string();
    {
        let mut book = BOOK.lock();
        book.collected.remove(&handle);
        if !book.watched.insert(handle.clone()) {
            return;
        }
    }
    crate::standby::seat_log::line(&format!("wake armed: {} will be told when helper {handle} finishes", orchestrator.pane_id()));
    let forget = handle.clone();
    let watch = move || {
        let started = Instant::now();
        let mut told_waiting = false;
        loop {
            std::thread::sleep(POLL);
            let status = super::surface::status_of(&helper.session().snapshot());
            let closed = helper.is_closed();
            let done = closed || matches!(status, "completed" | "failed" | "cancelled");
            if !done && status == "waiting_input" {
                if !told_waiting {
                    told_waiting = true;
                    hand_over(orchestrator.clone(), finished_of(&helper), LIVE);
                }
                continue;
            }
            if status != "waiting_input" {
                told_waiting = false;
            }
            if !done && started.elapsed() < WATCH_MAX {
                continue;
            }
            let collected = {
                let mut book = BOOK.lock();
                book.watched.remove(&handle);
                book.collected.remove(&handle)
            };
            if collected {
                crate::standby::seat_log::line(&format!("wake not needed: the orchestrator already read helper {handle}'s result"));
            } else if done {
                hand_over(orchestrator.clone(), finished_of(&helper), LIVE);
            }
            return;
        }
    };
    if std::thread::Builder::new().name("acp-wake-watch".into()).spawn(watch).is_err() {
        BOOK.lock().watched.remove(&forget);
    }
}

#[cfg(test)]
#[path = "wake_tests.rs"]
mod tests;
