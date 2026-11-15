//! The one engine: triggers start runs, runs walk their steps, and the "at most N at once" limit holds starts
//! back in a queue. Everything outside its own memory goes through [`Io`], so the tests use a fake world with a
//! clock they move.
//!
//! One `tick` does it all: look at the schedules and chat triggers, then move every open run as far as it can go.
//! The live loop ticks every few seconds; a tick right after a change makes the screen feel instant.

use parking_lot::Mutex;

use super::model::*;
use super::schedule;
use super::store::Store;

/// What a run's agent or chat is doing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Watch {
    /// A turn is running.
    Working,
    /// It waits for an answer from the person.
    Asked,
    /// It finished a turn. `ok`: the turn ended well.
    Idle { ok: bool },
    /// The agent's run failed; the sentence says why.
    Failed(String),
    /// The agent or chat is gone.
    Gone,
}

/// Why an agent did not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartFail {
    /// The app's own slots are full: try again later.
    NoSlot,
    Refused(String),
}

/// Why a message did not go in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendFail {
    /// A turn runs: try again next tick.
    Busy,
    Refused(String),
}

/// What a chat shows the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatProbe {
    /// Turns that finished.
    pub done_turns: u64,
    /// A turn runs or waits for an answer now.
    pub working: bool,
    /// The last turn ended well (not cancelled, failed or refused).
    pub ok: bool,
}

/// Everything the engine does outside its own memory.
pub trait Io: Send + Sync {
    fn now_ms(&self) -> u64;
    /// Minutes east of UTC on this computer's clock.
    fn utc_offset_min(&self) -> i32;
    /// Agents running right now, whoever started them (the "at most N" count).
    fn running_agents(&self) -> usize;
    fn start_agent(&self, agent: &str, project: &str, task: &str, separate_copy: bool, key: &str) -> Result<Target, StartFail>;
    fn watch(&self, target: &Target) -> Watch;
    /// Finished turns of the target (a chat's count; 0 for others).
    fn turns_done(&self, target: &Target) -> u64;
    fn send(&self, target: &Target, text: &str, key: &str) -> Result<(), SendFail>;
    /// The chat with this pane id, or `None` when it is not open.
    fn chat_probe(&self, pane_id: &str) -> Option<ChatProbe>;
    /// Stop the target's turn. Never types into a pane.
    fn stop(&self, target: &Target);
    /// Tell the person. `problem` is true for a failure.
    fn notify(&self, text: &str, problem: bool);
    /// Tell the windows that something changed.
    fn changed(&self);
    fn audit(&self, event: &str, summary: &str);
}

/// What `tick` found, for the caller's tests and for deciding whether to tell the windows.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Ticked {
    pub changed: bool,
}

pub struct Engine<I: Io> {
    io: I,
    store: Store,
    state: Mutex<State>,
}

impl<I: Io> Engine<I> {
    /// Loads the saved state. A run that was open when the app closed cannot be followed any more, so it ends
    /// with a note instead of hanging in the list.
    pub fn new(io: I, store: Store) -> Self {
        let mut state = store.load();
        let now = io.now_ms();
        let mut closed = false;
        for run in state.runs.iter_mut().filter(|r| r.state.is_open()) {
            end_run(run, RunState::Failed, Some("app_closed"), None, now);
            closed = true;
        }
        let engine = Engine { io, store, state: Mutex::new(state) };
        if closed {
            let _ = engine.store.save(&engine.state.lock());
        }
        engine
    }

    pub fn io(&self) -> &I {
        &self.io
    }

    /// A copy of the state, for the view and the tests.
    pub fn snapshot(&self) -> State {
        self.state.lock().clone()
    }

    fn save(&self, state: &State) {
        if let Err(error) = self.store.save(state) {
            tracing::warn!(%error, "routines: could not save");
        }
    }

    // ------------------------------------------------------------------------------------------------ commands

    /// Adds a workflow. A chain starts counting from the chat as it is now (see `baseline`).
    pub fn create(&self, new: NewWorkflow) -> Result<String, String> {
        validate(&new)?;
        let mut state = self.state.lock();
        if state.workflows.len() >= WORKFLOWS_MAX {
            return Err(format!("You can have at most {WORKFLOWS_MAX} routines and chains."));
        }
        let mut seen_turns = 0;
        if let Trigger::ChatFinished { pane_id, .. } = &new.trigger {
            let probe = self.io.chat_probe(pane_id).ok_or("That chat is not open any more.")?;
            seen_turns = baseline(&probe);
        }
        let now = self.io.now_ms();
        let id = new_workflow_id();
        state.workflows.push(Workflow {
            v: WORKFLOW_VERSION,
            id: id.clone(),
            name: new.name.trim().to_string(),
            enabled: true,
            trigger: new.trigger,
            steps: new.steps,
            created_ms: now,
            last_due_ms: 0,
            last_run_ms: None,
            last_result: None,
            fail_streak: 0,
            paused_note: None,
            seen_turns,
        });
        self.save(&state);
        drop(state);
        self.io.audit("created", "A routine or chain was made");
        self.io.changed();
        Ok(id)
    }

    pub fn set_enabled(&self, id: &str, on: bool) -> Result<(), String> {
        let mut state = self.state.lock();
        let now = self.io.now_ms();
        let wf = state.workflows.iter_mut().find(|w| w.id == id).ok_or("That routine is gone.")?;
        wf.enabled = on;
        wf.paused_note = None;
        if on {
            wf.fail_streak = 0;
            // Turning it on does not run what came due while it was off.
            wf.created_ms = now;
            if let Trigger::ChatFinished { pane_id, .. } = &wf.trigger {
                if let Some(probe) = self.io.chat_probe(pane_id) {
                    wf.seen_turns = baseline(&probe);
                }
            }
        }
        self.save(&state);
        drop(state);
        self.io.changed();
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut state = self.state.lock();
        let before = state.workflows.len();
        state.workflows.retain(|w| w.id != id);
        if state.workflows.len() == before {
            return Err("That routine is gone.".into());
        }
        let now = self.io.now_ms();
        for run in state.runs.iter_mut().filter(|r| r.workflow_id == id && r.state.is_open()) {
            if let Some(target) = run.target.as_ref().filter(|_| run.state == RunState::Running) {
                self.io.stop(target);
            }
            end_run(run, RunState::Stopped, Some("stopped"), None, now);
        }
        self.save(&state);
        drop(state);
        self.io.changed();
        Ok(())
    }

    /// "Run now". Refused while the same workflow is already running.
    pub fn run_now(&self, id: &str) -> Result<String, String> {
        let mut state = self.state.lock();
        let now = self.io.now_ms();
        let index = state.workflows.iter().position(|w| w.id == id).ok_or("That routine is gone.")?;
        if state.runs.iter().any(|r| r.workflow_id == id && r.state.is_open()) {
            return Err("It is already running.".into());
        }
        let run_id = self.fire(&mut state, index, now, None);
        self.save(&state);
        drop(state);
        self.io.changed();
        Ok(run_id)
    }

    /// Stops one run. The agent it started stays (the person can look at it); only its turn is stopped.
    pub fn stop_run(&self, run_id: &str) -> Result<(), String> {
        let mut state = self.state.lock();
        let now = self.io.now_ms();
        let run = state.runs.iter_mut().find(|r| r.id == run_id).ok_or("That run is gone.")?;
        if !run.state.is_open() {
            return Ok(());
        }
        if let Some(target) = run.target.as_ref().filter(|_| run.state == RunState::Running) {
            self.io.stop(target);
        }
        end_run(run, RunState::Stopped, Some("stopped"), None, now);
        self.save(&state);
        drop(state);
        self.io.changed();
        Ok(())
    }

    /// "At most N at once": `None` turns it off.
    pub fn set_limit(&self, limit: Option<u32>) {
        let mut state = self.state.lock();
        state.config.max_at_once = limit.filter(|n| *n >= 1).map(|n| n.min(LIMIT_MAX));
        self.save(&state);
        drop(state);
        self.io.audit("limit", "The limit of agents at once was changed");
        self.io.changed();
    }

    // ------------------------------------------------------------------------------------------------ the tick

    /// One look at everything. Safe to call as often as you like.
    pub fn tick(&self) -> Ticked {
        let mut state = self.state.lock();
        let now = self.io.now_ms();
        let mut changed = self.look_at_triggers(&mut state, now);
        changed |= self.move_runs(&mut state, now);
        if changed {
            prune(&mut state);
            self.save(&state);
            drop(state);
            self.io.changed();
        }
        Ticked { changed }
    }

    fn look_at_triggers(&self, state: &mut State, now: u64) -> bool {
        let offset = self.io.utc_offset_min();
        let mut changed = false;
        for index in 0..state.workflows.len() {
            let wf = &state.workflows[index];
            if !wf.enabled {
                continue;
            }
            match wf.trigger.clone() {
                Trigger::Manual => {}
                Trigger::Schedule { days, time } => {
                    let after = wf.last_due_ms.max(wf.created_ms);
                    let Some(due) = schedule::latest_due(&days, &time, after, now, offset) else { continue };
                    state.workflows[index].last_due_ms = due;
                    if state.runs.iter().any(|r| r.workflow_id == state.workflows[index].id && r.state.is_open()) {
                        continue; // still busy with the last one: this due time is skipped, not stacked
                    }
                    let late = now.saturating_sub(due) > LATE_AFTER_MS;
                    self.fire(state, index, now, Some((due, late)));
                    changed = true;
                }
                Trigger::ChatFinished { pane_id, only_if_ok } => {
                    let Some(probe) = self.io.chat_probe(&pane_id) else {
                        let wf = &mut state.workflows[index];
                        wf.enabled = false;
                        wf.paused_note = Some("chat_gone".into());
                        changed = true;
                        continue;
                    };
                    let wf = &mut state.workflows[index];
                    if probe.done_turns < wf.seen_turns {
                        wf.seen_turns = probe.done_turns; // the chat started over (the app restarted)
                    }
                    if probe.working || probe.done_turns <= wf.seen_turns {
                        continue;
                    }
                    wf.seen_turns = probe.done_turns;
                    wf.enabled = false; // a chain runs once
                    changed = true;
                    if only_if_ok && !probe.ok {
                        wf.paused_note = Some("not_ok".into());
                        wf.last_run_ms = Some(now);
                        wf.last_result = Some("skipped".into());
                        let wf = wf.clone();
                        let mut run = new_run(&wf, now, state.next_seq);
                        state.next_seq += 1;
                        end_run(&mut run, RunState::Skipped, Some("not_ok"), None, now);
                        state.runs.insert(0, run);
                        continue;
                    }
                    wf.paused_note = Some("ran_once".into());
                    let fired = self.fire(state, index, now, None);
                    // The chat is the run's agent; its finished turn is the one the person looked at.
                    if let Some(run) = state.runs.iter_mut().find(|r| r.id == fired) {
                        run.target = Some(Target { project: String::new(), handle: pane_id, mark: probe.done_turns.saturating_sub(1) });
                    }
                }
            }
        }
        changed
    }

    /// Starts a run of workflow `index`. `due`: the schedule time and whether it is late.
    fn fire(&self, state: &mut State, index: usize, now: u64, due: Option<(u64, bool)>) -> String {
        let wf = state.workflows[index].clone();
        let mut run = new_run(&wf, now, state.next_seq);
        state.next_seq += 1;
        if let Some((due_ms, late)) = due {
            run.due_ms = Some(due_ms);
            if late {
                run.note_code = Some("late".into());
            }
        }
        let id = run.id.clone();
        state.runs.insert(0, run);
        let wf = &mut state.workflows[index];
        wf.last_run_ms = Some(now);
        self.io.audit("started", "A routine or chain started");
        id
    }

    /// Moves every open run, oldest first, as far as it can go this tick.
    fn move_runs(&self, state: &mut State, now: u64) -> bool {
        let mut order: Vec<(u64, String)> = state.runs.iter().filter(|r| r.state.is_open()).map(|r| (r.seq, r.id.clone())).collect();
        order.sort();
        let limit = state.config.max_at_once;
        let mut started_now = 0usize;
        let mut changed = false;
        let mut running_known: Option<usize> = None;
        for (_, run_id) in order {
            let Some(index) = state.runs.iter().position(|r| r.id == run_id) else { continue };
            let before = state.runs[index].clone();
            let outcome = self.advance(&mut state.runs[index], now, limit, &mut started_now, &mut running_known);
            let run = &state.runs[index];
            if *run != before {
                changed = true;
            }
            if let Some(result) = outcome {
                self.settle(state, &run_id, result, now);
                changed = true;
            }
        }
        changed
    }

    /// Walks one run. `Some(state)` when it ended.
    fn advance(&self, run: &mut Run, now: u64, limit: Option<u32>, started_now: &mut usize, running_known: &mut Option<usize>) -> Option<RunState> {
        loop {
            let Some(step) = run.steps.get(run.step).cloned() else {
                end_run(run, RunState::Done, None, None, now);
                return Some(RunState::Done);
            };
            match step {
                Step::StartAgent { agent, project, task, separate_copy } => {
                    if let Some(limit) = limit {
                        let running = *running_known.get_or_insert_with(|| self.io.running_agents());
                        if running + *started_now >= limit as usize {
                            run.state = RunState::Waiting;
                            return None;
                        }
                    }
                    let key = format!("routine:{}:{}", run.id, run.step);
                    match self.io.start_agent(&agent, &project, &task, separate_copy, &key) {
                        Ok(target) => {
                            *started_now += 1;
                            run.target = Some(target);
                            run.state = RunState::Running;
                            step_on(run, now);
                        }
                        Err(StartFail::NoSlot) => {
                            run.state = RunState::Waiting;
                            return None;
                        }
                        Err(StartFail::Refused(sentence)) => {
                            end_run(run, RunState::Failed, Some("refused"), Some(sentence), now);
                            return Some(RunState::Failed);
                        }
                    }
                }
                Step::Wait => {
                    let Some(target) = run.target.clone() else { return fail(run, "failed", None, now) };
                    match self.io.watch(&target) {
                        Watch::Idle { ok: true } => step_on(run, now),
                        Watch::Idle { ok: false } => return fail(run, "unfinished", None, now),
                        Watch::Failed(sentence) => return fail(run, "failed", Some(sentence), now),
                        Watch::Gone => return fail(run, "chat_gone", None, now),
                        Watch::Working => return still_waiting(run, None, now),
                        Watch::Asked => return still_waiting(run, Some("asked"), now),
                    }
                }
                Step::FollowUp { text } => {
                    let Some(target) = run.target.clone() else { return fail(run, "failed", None, now) };
                    match self.io.watch(&target) {
                        Watch::Idle { ok: true } => {
                            let key = format!("routine:{}:{}", run.id, run.step);
                            match self.io.send(&target, &text, &key) {
                                Ok(()) => {
                                    let mark = self.io.turns_done(&target);
                                    run.target = Some(Target { mark, ..target });
                                    step_on(run, now);
                                }
                                Err(SendFail::Busy) => return still_waiting(run, None, now),
                                Err(SendFail::Refused(sentence)) => return fail(run, "refused", Some(sentence), now),
                            }
                        }
                        Watch::Idle { ok: false } => return fail(run, "unfinished", None, now),
                        Watch::Failed(sentence) => return fail(run, "failed", Some(sentence), now),
                        Watch::Gone => return fail(run, "chat_gone", None, now),
                        Watch::Working => return still_waiting(run, None, now),
                        Watch::Asked => return still_waiting(run, Some("asked"), now),
                    }
                }
                Step::Notify { text } => {
                    self.io.notify(&text, false);
                    step_on(run, now);
                }
            }
        }
    }

    /// A run ended: tell the workflow, and pause a routine that keeps failing.
    fn settle(&self, state: &mut State, run_id: &str, result: RunState, _now: u64) {
        let Some(run) = state.runs.iter().find(|r| r.id == run_id).cloned() else { return };
        let Some(wf) = state.workflows.iter_mut().find(|w| w.id == run.workflow_id) else { return };
        wf.last_result = Some(result.tag().to_string());
        match result {
            RunState::Failed => {
                wf.fail_streak += 1;
                self.io.notify(&format!("{} did not finish.", wf.name), true);
                if wf.is_routine() && wf.fail_streak >= PAUSE_AFTER_FAILS && wf.enabled {
                    wf.enabled = false;
                    wf.paused_note = Some("paused_failed".into());
                    self.io.notify(&format!("{} is paused after {} failed runs.", wf.name, wf.fail_streak), true);
                }
            }
            RunState::Done => wf.fail_streak = 0,
            _ => {}
        }
        self.io.audit(result.tag(), "A routine or chain ended");
    }

    /// The loop of the live app: a tick every few seconds, forever. Run on its own thread.
    pub fn run_loop(&self, every: std::time::Duration) -> ! {
        loop {
            self.tick();
            std::thread::sleep(every);
        }
    }
}

/// The finished turns a new chain does not count. A chat that works now: its turn in flight will count. A chat
/// that is idle: the turn on the screen counts ("after this, do that" runs at once).
pub fn baseline(probe: &ChatProbe) -> u64 {
    if probe.working {
        probe.done_turns
    } else {
        probe.done_turns.saturating_sub(1)
    }
}

fn new_run(wf: &Workflow, now: u64, seq: u64) -> Run {
    Run {
        id: new_run_id(),
        workflow_id: wf.id.clone(),
        workflow_name: wf.name.clone(),
        state: RunState::Running,
        step: 0,
        steps: wf.steps.clone(),
        target: None,
        created_ms: now,
        finished_ms: None,
        step_ms: now,
        note_code: None,
        note_detail: None,
        due_ms: None,
        seq,
    }
}

fn step_on(run: &mut Run, now: u64) {
    run.step += 1;
    run.step_ms = now;
    if run.note_code.as_deref() == Some("asked") {
        run.note_code = None;
    }
}

fn end_run(run: &mut Run, state: RunState, code: Option<&str>, detail: Option<String>, now: u64) {
    run.state = state;
    run.finished_ms = Some(now);
    if let Some(code) = code {
        run.note_code = Some(code.to_string());
    }
    run.note_detail = detail;
}

fn fail(run: &mut Run, code: &str, detail: Option<String>, now: u64) -> Option<RunState> {
    end_run(run, RunState::Failed, Some(code), detail, now);
    Some(RunState::Failed)
}

/// Still waiting on the agent. Over the limit the run ends, so nothing waits for ever for an answer nobody gives.
fn still_waiting(run: &mut Run, code: Option<&str>, now: u64) -> Option<RunState> {
    run.state = RunState::Running;
    if now.saturating_sub(run.step_ms) > WAIT_LIMIT_MS {
        return fail(run, "timeout", None, now);
    }
    match code {
        Some(code) => run.note_code = Some(code.to_string()),
        None if run.note_code.as_deref() == Some("asked") => run.note_code = None,
        None => {}
    }
    None
}

/// Keeps the open runs and the newest finished ones.
fn prune(state: &mut State) {
    let mut finished = 0;
    state.runs.retain(|r| {
        if r.state.is_open() {
            return true;
        }
        finished += 1;
        finished <= RUNS_KEPT
    });
}
