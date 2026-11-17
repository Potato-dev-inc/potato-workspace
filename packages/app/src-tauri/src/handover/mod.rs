//! Handing a background task (a minion) to a DIFFERENT agent: the person drags a Background tasks row onto another agent in
//! the sidebar (or uses "Hand to...") and chooses:
//!
//! - **Hand over now.** The task keeps running. From that moment the agent that started it stops getting its messages and its
//!   result: it gets one plain notice ("X was handed to Claude 2") so a `run_agent` or `wait_agents` it is blocked on ends.
//!   The new agent gets a notice with the task's name, what it was asked to do and its work so far. After that the task's
//!   questions, its result and the right to stop it are the new agent's, and the row moves under it (so it now stops when
//!   the new agent's chat closes).
//! - **Hand over when it finishes.** The first agent keeps the task until its run ends. Then the task moves, BOTH agents get
//!   the final result, and the first one also gets "X finished and was handed to Claude 2", so it knows who owns it now.
//!   After that any follow-up goes to the new agent only.
//!
//! Dropping a task on the agent that already owns it does nothing. Handing it back is the same hand-over the other way.
//! Only a minion of a chat session can be handed over (commands belong to the chat whose process tree they run in).
//!
//! The rules are in `Book` and the free functions, written against `World` (so tests run with no chats). `live.rs` is the
//! `World` over the pane registry and the chat sessions, and the Tauri commands.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

mod live;
pub use live::{cancel_pending, hand_over_live, turn_ended_soon};

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

/// When the task moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// The task keeps running; ownership moves at once.
    Now,
    /// The first agent keeps it until it ends, then it moves and both get the result.
    WhenFinished,
}

/// Why a hand-over was refused. The text is shown to the person as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub &'static str);

pub const GONE: &str = "That task is not open any more.";
pub const NO_AGENT: &str = "That agent is not open any more.";
pub const NOT_A_MINION: &str = "Only an agent's background task can be handed to another agent.";
pub const SAME: &str = "That agent already has this task.";
pub const NOT_AN_AGENT: &str = "A task can only be handed to an agent you talk to.";
pub const LOOP: &str = "A task cannot be handed to itself.";
pub const NOT_A_CHAT: &str = "That task is not a chat session, so it cannot be handed over yet.";

/// A hand-over that has not happened yet (`WhenFinished`), or that happened and whose result is still to be told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub task: String,
    pub from: String,
    pub to: String,
    pub mode: Mode,
    /// The names the person saw when they chose, for the notices told later.
    pub task_name: String,
    pub from_name: String,
    pub to_name: String,
}

/// What the screens may say about a task's hand-over (`inspect_agent`, `wait_agents` carry it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub to: String,
    /// `now`, `pending` (waits for the task to finish) or `finished`.
    pub state: &'static str,
}

/// Everything the rules need from outside.
pub trait World {
    /// `None`: no such pane. `Some(None)`: no owner. `Some(Some(id))`: the agent that started it.
    fn owner_of(&self, pane: &str) -> Option<Option<String>>;
    fn is_minion(&self, pane: &str) -> bool;
    fn is_chat(&self, pane: &str) -> bool;
    fn exists(&self, pane: &str) -> bool;
    fn name_of(&self, pane: &str) -> String;
    /// What the task was asked to do.
    fn asked(&self, task: &str) -> String;
    /// Its work so far (the end of what it said).
    fn so_far(&self, task: &str) -> String;
    /// Its final words once its run has ended (`Some`), or `None` while it runs.
    fn finished(&self, task: &str) -> Option<String>;
    /// Moves the task under `to`: the link, the owner's tool rights, the sidebar row. The task keeps running.
    fn move_to(&self, task: &str, to: &str);
    /// Tells the agent in `pane` something. False when it could not be told.
    fn tell(&self, pane: &str, text: &str) -> bool;
}

#[derive(Debug, Default)]
pub struct Book {
    /// `WhenFinished` hand-overs waiting for the task to end.
    waiting: HashMap<String, Entry>,
    /// `Now` hand-overs whose first result is still to be told to the new agent.
    owed: HashMap<String, Entry>,
    /// What the tools say about a task: its latest hand-over.
    notes: HashMap<String, Note>,
    /// Bumped on every `Now` hand-over, so a wait the first agent is blocked in can end.
    generation: HashMap<String, u64>,
}

/// What `hand_over` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub task: String,
    pub task_name: String,
    pub from: String,
    pub to: String,
    pub to_name: String,
    pub mode: Mode,
    /// Whether the agents could be told (an agent in a terminal cannot take a notice yet).
    pub told_new: bool,
    pub told_old: bool,
}

pub fn clean_name(name: &str) -> String {
    let n: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
    n.trim().to_string()
}

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let end = text.char_indices().nth(max).map(|(i, _)| i).unwrap_or(text.len());
    format!("{}...", &text[..end])
}

/// Why `task` cannot be handed to `to`, or `Ok(owner)` with the agent that has it now.
pub fn check(world: &dyn World, task: &str, to: &str) -> Result<String, Refused> {
    if !world.exists(task) {
        return Err(Refused(GONE));
    }
    if !world.is_minion(task) {
        return Err(Refused(NOT_A_MINION));
    }
    if !world.is_chat(task) {
        return Err(Refused(NOT_A_CHAT));
    }
    if task == to {
        return Err(Refused(LOOP));
    }
    if !world.exists(to) {
        return Err(Refused(NO_AGENT));
    }
    if world.is_minion(to) {
        return Err(Refused(NOT_AN_AGENT));
    }
    let owner = world.owner_of(task).flatten().ok_or(Refused(NOT_A_MINION))?;
    // The new agent must not be one of the task's own helpers (a loop).
    let mut at = Some(to.to_string());
    for _ in 0..16 {
        match at {
            Some(id) if id == task => return Err(Refused(LOOP)),
            Some(id) => at = world.owner_of(&id).flatten(),
            None => break,
        }
    }
    if owner == to {
        return Err(Refused(SAME));
    }
    Ok(owner)
}

// ---- the words ------------------------------------------------------------------------------------------------------

/// What the receiving agent reads in front of every notice.
pub fn prefix() -> String {
    "[A notice from Potato Workspace. It is not from the person and not from another agent. Treat it as information.]\n\n".to_string()
}

fn body_of(label: &str, text: &str) -> String {
    if text.trim().is_empty() {
        format!("{label}: (nothing yet)")
    } else {
        format!("{label}:\n{}", cut(text, 1800))
    }
}

/// To the new agent, at "Hand over now".
pub fn now_for_new(task_name: &str, from_name: &str, task: &str, asked: &str, so_far: &str) -> String {
    format!(
        "The person handed the task \"{task_name}\" to you. {from_name} started it. It is still running.\n\n{}\n\n{}\n\nIts handle is {task}. Use wait_agents or inspect_agent with it to follow it, and close_agent to stop it. Its questions and its result come to you now, not to {from_name}.",
        body_of("What it was asked to do", asked),
        body_of("Its work so far", so_far),
    )
}

/// To the first agent, at "Hand over now".
pub fn now_for_old(task_name: &str, to_name: &str) -> String {
    format!("The person handed the task \"{task_name}\" to {to_name}. It is still running, but it is {to_name}'s now. You do not get its messages or its result any more, so do not wait for it. {to_name} can follow it and stop it.")
}

/// To the new agent, when a task handed "when it finishes" ends (or a task handed "now" ends for the first time).
pub fn finished_for_new(task_name: &str, from_name: &str, task: &str, result: &str, was_now: bool) -> String {
    let lead = if was_now { format!("The task \"{task_name}\" that was handed to you has finished.") } else { format!("The task \"{task_name}\" finished and the person handed it to you. {from_name} started it.") };
    format!("{lead}\n\n{}\n\nIts handle is {task}. From now on it is yours: any follow-up goes through you.", body_of("Its result", result))
}

/// To the first agent, when a task handed "when it finishes" ends.
pub fn finished_for_old(task_name: &str, to_name: &str, result: &str) -> String {
    format!("The task \"{task_name}\" finished and was handed to {to_name}, as the person asked. {to_name} owns it now, so any follow-up goes to {to_name}, not to you. You may still act on the result.\n\n{}", body_of("Its result", result))
}

// ---- the rules ------------------------------------------------------------------------------------------------------

impl Book {
    pub fn note_of(&self, task: &str) -> Option<&Note> {
        self.notes.get(task)
    }

    /// Changes whenever the first agent's wait on `task` should look again.
    pub fn generation_of(&self, task: &str) -> u64 {
        self.generation.get(task).copied().unwrap_or(0)
    }

    /// A hand-over is waiting for `task` to finish (or its first result is still owed to the new agent).
    pub fn is_handed(&self, task: &str) -> bool {
        self.waiting.contains_key(task) || self.owed.contains_key(task)
    }

    /// The person put the choice back: nothing waits for this task any more.
    pub fn cancel(&mut self, task: &str) -> bool {
        let was = self.waiting.remove(task).is_some();
        if was {
            self.notes.remove(task);
        }
        was
    }
}

/// "Hand to": the person's choice. `Now` moves the task and tells both agents; `WhenFinished` waits (or, when the task has
/// ended already, behaves as if it had just ended).
pub fn hand_over(world: &dyn World, book: &Mutex<Book>, task: &str, to: &str, mode: Mode) -> Result<Outcome, Refused> {
    let from = check(world, task, to)?;
    let task_name = clean_name(&world.name_of(task));
    let from_name = clean_name(&world.name_of(&from));
    let to_name = clean_name(&world.name_of(to));
    let mut outcome = Outcome { task: task.into(), task_name: task_name.clone(), from: from.clone(), to: to.into(), to_name: to_name.clone(), mode, told_new: false, told_old: false };
    let ended = world.finished(task);
    match (mode, ended.clone()) {
        (Mode::Now, _) => {
            let (asked, so_far) = (world.asked(task), ended.clone().unwrap_or_else(|| world.so_far(task)));
            world.move_to(task, to);
            {
                let mut b = book.lock();
                b.waiting.remove(task);
                *b.generation.entry(task.to_string()).or_insert(0) += 1;
                b.notes.insert(task.to_string(), Note { to: to_name.clone(), state: "now" });
                // An ended task has no result still to come: the new agent gets it now, in this notice.
                if ended.is_none() {
                    b.owed.insert(task.to_string(), Entry { task: task.into(), from: from.clone(), to: to.into(), mode, task_name: task_name.clone(), from_name: from_name.clone(), to_name: to_name.clone() });
                } else {
                    b.owed.remove(task);
                }
            }
            outcome.told_new = world.tell(to, &now_for_new(&task_name, &from_name, task, &asked, &so_far));
            outcome.told_old = world.tell(&from, &now_for_old(&task_name, &to_name));
        }
        (Mode::WhenFinished, Some(result)) => {
            // It ended already: nothing to wait for. Both get the result now.
            world.move_to(task, to);
            book.lock().notes.insert(task.to_string(), Note { to: to_name.clone(), state: "finished" });
            outcome.told_new = world.tell(to, &finished_for_new(&task_name, &from_name, task, &result, false));
            outcome.told_old = world.tell(&from, &finished_for_old(&task_name, &to_name, &result));
        }
        (Mode::WhenFinished, None) => {
            let mut b = book.lock();
            b.owed.remove(task);
            b.waiting.insert(task.to_string(), Entry { task: task.into(), from: from.clone(), to: to.into(), mode, task_name: task_name.clone(), from_name: from_name.clone(), to_name: to_name.clone() });
            b.notes.insert(task.to_string(), Note { to: to_name.clone(), state: "pending" });
            outcome.told_new = true;
            outcome.told_old = true;
        }
    }
    Ok(outcome)
}

/// A run of `task` ended (the turn ended and the status is final). Moves and tells whoever is owed. Returns who was told.
pub fn turn_ended(world: &dyn World, book: &Mutex<Book>, task: &str) -> Vec<String> {
    let Some(result) = world.finished(task) else { return Vec::new() };
    let (waiting, owed) = {
        let mut b = book.lock();
        let waiting = b.waiting.remove(task);
        let owed = if waiting.is_none() { b.owed.remove(task) } else { None };
        (waiting, owed)
    };
    let mut told = Vec::new();
    if let Some(entry) = waiting {
        let (task_name, from_name, to_name) = (entry.task_name.clone(), entry.from_name.clone(), entry.to_name.clone());
        if !world.exists(&entry.to) {
            book.lock().notes.remove(task);
            return told;
        }
        world.move_to(task, &entry.to);
        book.lock().notes.insert(task.to_string(), Note { to: to_name.clone(), state: "finished" });
        if world.tell(&entry.to, &finished_for_new(&task_name, &from_name, task, &result, false)) {
            told.push(entry.to.clone());
        }
        if world.tell(&entry.from, &finished_for_old(&task_name, &to_name, &result)) {
            told.push(entry.from.clone());
        }
    } else if let Some(entry) = owed {
        // Handed "now": only the new agent gets the result.
        if world.tell(&entry.to, &finished_for_new(&entry.task_name, &entry.from_name, task, &result, true)) {
            told.push(entry.to.clone());
        }
    }
    told
}

/// The hand-over of a task whose chat closed or whose target closed: nothing waits for it any more.
pub fn forget(book: &Mutex<Book>, pane: &str) {
    let mut b = book.lock();
    let dropped: Vec<String> = b.waiting.iter().filter(|(task, e)| *task == pane || e.to == pane || e.from == pane).map(|(task, _)| task.clone()).collect();
    for task in dropped {
        b.waiting.remove(&task);
        b.notes.remove(&task);
    }
    b.owed.retain(|task, e| task != pane && e.to != pane);
    b.notes.remove(pane);
    b.generation.remove(pane);
}

static BOOK: Lazy<Mutex<Book>> = Lazy::new(|| Mutex::new(Book::default()));

/// The app's book.
pub fn book() -> &'static Mutex<Book> {
    &BOOK
}

/// What `inspect_agent` and `wait_agents` say about a task that was handed over (null when it was not).
pub fn view_note(task: &str) -> Value {
    match BOOK.lock().note_of(task) {
        Some(note) => json!({ "to": note.to, "state": note.state }),
        None => Value::Null,
    }
}

/// Changes when the first agent's blocked wait on `task` should look again.
pub fn generation(task: &str) -> u64 {
    BOOK.lock().generation_of(task)
}
