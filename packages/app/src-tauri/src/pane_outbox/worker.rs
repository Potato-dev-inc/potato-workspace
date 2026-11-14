//! The loop of one pane's worker, and the one decision it makes per look.

use crate::attach::ChatAttachment;
use super::host::{Attempt, Look};
use super::model::*;
use super::now_ms;
use super::{Inner, PaneQueue, Timing};
use crate::agent_runs::readiness::Readiness;
use crate::tui::ComposerState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

/// What one look at the pane means for the first waiting message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// The agent can take it now.
    Deliver,
    /// Not yet; the sentence says what it waits for.
    Wait(&'static str),
    /// It cannot be sent; the sentence says why.
    Fail(&'static str),
}

/// Every branch but two moves away from `Deliver`: a ready agent, an input box that is empty (or that the
/// profile cannot read) and a pane status of idle give it, and so does a startup notice that declares its own
/// dismiss keys. That one is closed by the same step every typed task goes through (`delivery::await_ready`, which
/// presses only the declared keys, then looks again), so the message is never typed into the notice; if the
/// notice ignores its keys, the attempt comes back as `Gate` and the message waits. The pane status is not asked
/// for there: a screen showing a notice is not a screen the status heuristics read. A dialog or question
/// (a gate with no keys, a prompt) is never answered here.
pub fn decide(look: &Look) -> Step {
    let has_text = look.composer == ComposerState::HasText;
    match &look.readiness {
        Readiness::HostShell(_) => Step::Fail(FAIL_NOT_RUNNING),
        Readiness::Gate(gate) if gate.dismiss.is_some() => Step::Deliver,
        Readiness::Gate(_) => Step::Wait(WAIT_GATE),
        Readiness::Busy => Step::Wait(WAIT_BUSY),
        Readiness::Unknown if has_text => Step::Wait(WAIT_DRAFT),
        // A pane that is not working and shows no input box sits on a menu or a setup screen (a first-run step).
        // It is not "working"; the sentence says to look at what it asks.
        Readiness::Unknown if look.at_rest() => Step::Wait(WAIT_MENU),
        Readiness::Unknown => Step::Wait(WAIT_BUSY),
        Readiness::Ready if has_text => Step::Wait(WAIT_DRAFT),
        Readiness::Ready if look.waiting => Step::Wait(WAIT_MENU),
        Readiness::Ready if !look.idle => Step::Wait(WAIT_BUSY),
        Readiness::Ready => Step::Deliver,
    }
}

/// Why a pane is not a place to send a Point message to right now, for the "To:" list: a dialog or question is up,
/// the agent is gone, or the screen shows no input box. Nothing is typed in any of these. A working agent or text
/// in the box is not a reason: the outbox keeps the message until the turn ends or the box is empty.
pub fn target_block(look: &Look) -> Option<&'static str> {
    match &look.readiness {
        Readiness::Gate(_) => Some(WAIT_GATE),
        Readiness::HostShell(_) => Some(FAIL_NOT_RUNNING),
        Readiness::Unknown if look.composer != ComposerState::HasText => Some(NOT_READY_BOX),
        _ => None,
    }
}

pub(super) fn snapshot(queue: &PaneQueue) -> Vec<OutboxMessage> {
    queue.entries.iter().map(|e| e.message.clone()).collect()
}

/// Drops the messages that finished more than `keep` ago. True when any went.
pub(super) fn prune(queue: &mut PaneQueue, timing: &Timing) -> bool {
    let before = queue.entries.len();
    queue.entries.retain(|e| {
        let keep = if e.message.state == State::Failed || e.message.no_answer { timing.keep_failed.max(timing.keep) } else { timing.keep };
        e.finished.map_or(true, |at| at.elapsed() < keep)
    });
    queue.entries.len() != before
}

/// Runs when the worker thread ends, however it ends. A thread that died of a panic must not leave `worker` set (later
/// messages would wait for a worker that is gone): the flag is cleared, a message that was being sent is marked failed
/// (it may or may not have gone in), the list is published, and when messages still wait one new worker is started.
struct EndGuard {
    inner: Arc<Inner>,
    pane: String,
}

impl Drop for EndGuard {
    fn drop(&mut self) {
        let panicked = std::thread::panicking();
        let (list, restart) = {
            let mut panes = self.inner.panes.lock();
            let Some(queue) = panes.get_mut(&self.pane) else { return };
            queue.worker = false;
            if !panicked {
                return;
            }
            record(queue, "worker stopped after an unexpected error");
            for entry in queue.entries.iter_mut().filter(|e| e.message.state == State::Sending) {
                entry.finish(State::Failed, Some(FAIL_STOPPED));
            }
            let waiting = queue.entries.iter().any(|e| e.message.state == State::Queued);
            let restart = waiting && queue.restarts < 1 && !self.inner.closed.load(Ordering::SeqCst);
            if restart {
                queue.restarts += 1;
                queue.worker = true;
            }
            (snapshot(queue), restart)
        };
        self.inner.host.publish(&self.pane, &list);
        if restart {
            spawn(self.inner.clone(), &self.pane);
        }
    }
}

pub(super) fn spawn(inner: Arc<Inner>, pane_id: &str) {
    let pane = pane_id.to_string();
    let worker_inner = inner.clone();
    let started = std::thread::Builder::new().name(format!("pane-outbox-{pane}")).spawn(move || {
        let _end = EndGuard { inner: worker_inner.clone(), pane: pane.clone() };
        run(worker_inner, pane);
    });
    if started.is_err() {
        if let Some(queue) = inner.panes.lock().get_mut(pane_id) {
            queue.worker = false;
        }
    }
}

/// Keeps one line per change of reason in the pane's list of decisions.
pub(super) fn record(queue: &mut PaneQueue, reason: &str) {
    if queue.decisions.back().is_some_and(|(_, last)| last == reason) {
        return;
    }
    if queue.decisions.len() >= super::DECISIONS_KEPT {
        queue.decisions.pop_front();
    }
    queue.decisions.push_back((now_ms(), reason.to_string()));
}

fn run(inner: Arc<Inner>, pane_id: String) {
    while !inner.closed.load(Ordering::SeqCst) {
        if !tick(&inner, &pane_id) {
            return;
        }
        std::thread::sleep(inner.timing.poll);
    }
}

/// The result of the housekeeping part of a pass.
enum Housekeeping {
    /// Nothing is left: the worker is done.
    Empty,
    /// Only finished messages are listed (they leave when their time is up).
    Idle,
    /// The first waiting message: its id, text and files.
    Head(String, String, Vec<ChatAttachment>),
}

/// Finished messages leave after `keep`; a message that waited too long fails. Publishes when the list changed.
fn housekeeping(inner: &Inner, pane_id: &str) -> Housekeeping {
    let timing = inner.timing;
    let mut panes = inner.panes.lock();
    let Some(queue) = panes.get_mut(pane_id) else { return Housekeeping::Empty };
    let mut changed = prune(queue, &timing);
    for entry in queue.entries.iter_mut().filter(|e| e.message.state == State::Queued) {
        if entry.created.elapsed() >= timing.give_up {
            entry.finish(State::Failed, Some(FAIL_TOO_LONG));
            changed = true;
        }
    }
    if queue.entries.is_empty() {
        panes.remove(pane_id);
        drop(panes);
        if changed {
            inner.host.publish(pane_id, &[]);
        }
        return Housekeeping::Empty;
    }
    // A first waiting message the person has open to edit holds the whole queue back (the order stays).
    let head = queue
        .entries
        .iter()
        .find(|e| e.message.state.active())
        .filter(|e| !e.is_held())
        .map(|e| (e.message.id.clone(), e.message.text.clone(), e.message.attachments.clone()));
    let list = changed.then(|| snapshot(queue));
    drop(panes);
    if let Some(list) = list {
        inner.host.publish(pane_id, &list);
    }
    match head {
        Some((id, text, attachments)) => Housekeeping::Head(id, text, attachments),
        None => Housekeeping::Idle,
    }
}

/// For messages that went in: did the chat show anything new? One that did not for `no_answer_after` is marked (the
/// hint only informs); the mark goes when a reply shows. A chat that is starting or waking up does not count the wait.
fn watch_answers(inner: &Inner, pane_id: &str) {
    let watching = inner.panes.lock().get(pane_id).is_some_and(|queue| queue.entries.iter().any(|e| e.watch.is_some()));
    if !watching {
        return;
    }
    let Some(pulse) = inner.host.pulse(pane_id) else { return };
    let mut panes = inner.panes.lock();
    let Some(queue) = panes.get_mut(pane_id) else { return };
    let mut changed = false;
    for entry in queue.entries.iter_mut() {
        let Some(watch) = entry.watch.as_mut() else { continue };
        if pulse.replies > watch.replies {
            entry.watch = None;
            changed |= std::mem::take(&mut entry.message.no_answer);
        } else if pulse.waking {
            watch.since = Instant::now();
        } else if !entry.message.no_answer && watch.since.elapsed() >= inner.timing.no_answer_after {
            entry.message.no_answer = true;
            changed = true;
        }
    }
    let list = changed.then(|| snapshot(queue));
    if changed {
        record(queue, "sent, no answer yet");
    }
    drop(panes);
    if let Some(list) = list {
        inner.host.publish(pane_id, &list);
    }
}

/// One pass. `false` when the queue is empty and the worker is done.
fn tick(inner: &Arc<Inner>, pane_id: &str) -> bool {
    watch_answers(inner, pane_id);
    let (head_id, head_text, head_attachments) = match housekeeping(inner, pane_id) {
        Housekeeping::Empty => return false,
        Housekeeping::Idle => return true,
        Housekeeping::Head(id, text, attachments) => (id, text, attachments),
    };
    let step = match inner.host.look(pane_id) {
        // The pane is gone.
        None => Step::Fail(FAIL_CLOSED),
        Some(look) => match decide(&look) {
            Step::Deliver => {
                let cooling = inner
                    .panes
                    .lock()
                    .get(pane_id)
                    .and_then(|queue| queue.last_sent)
                    .is_some_and(|at| at.elapsed() < inner.timing.after_send);
                // A notice that did not react to its keys is left alone for a while (one Esc per poll is a spam).
                let gate_cooling = matches!(look.readiness, Readiness::Gate(_))
                    && inner
                        .panes
                        .lock()
                        .get(pane_id)
                        .and_then(|queue| queue.gate_tried)
                        .is_some_and(|at| at.elapsed() < inner.timing.gate_retry);
                if gate_cooling {
                    Step::Wait(WAIT_GATE)
                } else if cooling {
                    Step::Wait(WAIT_BUSY)
                } else if inner.host.run_controls(pane_id) {
                    Step::Wait(WAIT_RUN)
                } else {
                    Step::Deliver
                }
            }
            other => other,
        },
    };
    let reason = match &step {
        Step::Deliver => "deliver".to_string(),
        Step::Wait(why) => format!("wait: {why}"),
        Step::Fail(why) => format!("fail: {why}"),
    };
    if let Some(queue) = inner.panes.lock().get_mut(pane_id) {
        record(queue, &reason);
    }
    match step {
        Step::Fail(why) => settle_waiting(inner, pane_id, |entry, _| entry.finish(State::Failed, Some(why))),
        Step::Wait(why) => settle_waiting(inner, pane_id, |entry, is_head| entry.wait(if is_head { why } else { WAIT_TURN })),
        Step::Deliver => deliver(inner, pane_id, &head_id, &head_text, &head_attachments),
    }
    true
}

/// Applies `change` to every message still waiting (`is_head`: it is the first of them) and publishes when
/// something differs afterwards.
fn settle_waiting(inner: &Inner, pane_id: &str, change: impl Fn(&mut Entry, bool)) {
    let mut panes = inner.panes.lock();
    let Some(queue) = panes.get_mut(pane_id) else { return };
    let before = snapshot(queue);
    let mut first = true;
    for entry in queue.entries.iter_mut().filter(|e| e.message.state == State::Queued) {
        change(entry, first);
        first = false;
    }
    let list = snapshot(queue);
    drop(panes);
    if list != before {
        inner.host.publish(pane_id, &list);
    }
}

/// Types the first waiting message. Marks it `sending` first (so a cancel that comes now is refused), and
/// settles it from what the attempt found.
fn deliver(inner: &Inner, pane_id: &str, id: &str, text: &str, attachments: &[ChatAttachment]) {
    {
        let mut panes = inner.panes.lock();
        let Some(queue) = panes.get_mut(pane_id) else { return };
        let Some(entry) = queue.entries.iter_mut().find(|e| e.message.id == id) else { return };
        // A cancel between the look and now wins.
        if entry.message.state != State::Queued || entry.is_held() {
            return;
        }
        entry.message.state = State::Sending;
        entry.message.waiting_for = None;
        let list = snapshot(queue);
        drop(panes);
        inner.host.publish(pane_id, &list);
    }
    let baseline = inner.host.pulse(pane_id).map(|pulse| pulse.replies);
    let attempt = inner.host.type_message_with(pane_id, text, attachments);
    let mut panes = inner.panes.lock();
    let Some(queue) = panes.get_mut(pane_id) else { return };
    if matches!(attempt, Attempt::Sent) {
        queue.last_sent = Some(Instant::now());
        queue.restarts = 0;
    }
    queue.gate_tried = matches!(attempt, Attempt::Gate).then(Instant::now);
    if let Some(entry) = queue.entries.iter_mut().find(|e| e.message.id == id) {
        match attempt {
            Attempt::Sent => {
                entry.finish(State::Sent, None);
                entry.watch = baseline.map(|replies| Watch { since: Instant::now(), replies });
            }
            Attempt::Draft => entry.wait(WAIT_DRAFT),
            Attempt::Gate => entry.wait(WAIT_GATE),
            Attempt::NotTyped => entry.wait(WAIT_BUSY),
            Attempt::Gone => entry.finish(State::Failed, Some(FAIL_NOT_RUNNING)),
            Attempt::Failed(why) => entry.finish(State::Failed, Some(&why)),
        }
    }
    let list = snapshot(queue);
    drop(panes);
    inner.host.publish(pane_id, &list);
}
