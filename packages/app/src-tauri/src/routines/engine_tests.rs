//! The engine with a fake world and a clock the test moves. 2026 dates are built from a Monday found by the
//! weekday maths, so no test depends on today's date.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use super::engine::*;
use super::model::*;
use super::schedule;
use super::store::Store;
use super::view;

const MIN: u64 = 60_000;
const HOUR: u64 = 60 * MIN;
const DAY: u64 = 24 * HOUR;

/// A Monday 00:00 (UTC clock).
fn monday() -> u64 {
    let mut day = 1_790_000_000_000 - 1_790_000_000_000 % DAY;
    while schedule::weekday(day, 0) != 1 {
        day += DAY;
    }
    day
}

#[derive(Default)]
struct World {
    now: u64,
    running: usize,
    next: u32,
    starts: Vec<(String, String, String, bool)>,
    refuse: Option<StartFail>,
    watches: HashMap<String, Watch>,
    turns: HashMap<String, u64>,
    chats: HashMap<String, ChatProbe>,
    sent: Vec<(String, String)>,
    send_fail: Option<SendFail>,
    notices: Vec<(String, bool)>,
    stopped: Vec<String>,
    audits: Vec<String>,
    changes: usize,
}

#[derive(Clone)]
struct Fake(Arc<Mutex<World>>);

impl Fake {
    fn at(now: u64) -> Fake {
        Fake(Arc::new(Mutex::new(World { now, ..Default::default() })))
    }
    fn set_now(&self, now: u64) {
        self.0.lock().now = now;
    }
    fn watch(&self, handle: &str, watch: Watch) {
        self.0.lock().watches.insert(handle.to_string(), watch);
    }
    fn chat(&self, pane: &str, done: u64, working: bool, ok: bool) {
        self.0.lock().chats.insert(pane.to_string(), ChatProbe { done_turns: done, working, ok });
    }
    fn starts(&self) -> usize {
        self.0.lock().starts.len()
    }
}

impl Io for Fake {
    fn now_ms(&self) -> u64 {
        self.0.lock().now
    }
    fn utc_offset_min(&self) -> i32 {
        0
    }
    fn running_agents(&self) -> usize {
        self.0.lock().running
    }
    fn start_agent(&self, agent: &str, project: &str, task: &str, copy: bool, _key: &str) -> Result<Target, StartFail> {
        let mut w = self.0.lock();
        if let Some(fail) = w.refuse.clone() {
            return Err(fail);
        }
        w.next += 1;
        let handle = format!("h{}", w.next);
        w.starts.push((agent.into(), project.into(), task.into(), copy));
        w.watches.insert(handle.clone(), Watch::Working);
        Ok(Target { project: project.into(), handle, mark: 0 })
    }
    fn watch(&self, target: &Target) -> Watch {
        let w = self.0.lock();
        w.watches.get(&target.handle).cloned().unwrap_or(Watch::Gone)
    }
    fn turns_done(&self, target: &Target) -> u64 {
        *self.0.lock().turns.get(&target.handle).unwrap_or(&0)
    }
    fn send(&self, target: &Target, text: &str, _key: &str) -> Result<(), SendFail> {
        let mut w = self.0.lock();
        if let Some(fail) = w.send_fail.clone() {
            return Err(fail);
        }
        w.sent.push((target.handle.clone(), text.into()));
        Ok(())
    }
    fn chat_probe(&self, pane_id: &str) -> Option<ChatProbe> {
        self.0.lock().chats.get(pane_id).cloned()
    }
    fn stop(&self, target: &Target) {
        self.0.lock().stopped.push(target.handle.clone());
    }
    fn notify(&self, text: &str, problem: bool) {
        self.0.lock().notices.push((text.into(), problem));
    }
    fn changed(&self) {
        self.0.lock().changes += 1;
    }
    fn audit(&self, event: &str, _summary: &str) {
        self.0.lock().audits.push(event.into());
    }
}

fn store() -> Store {
    Store::at(std::env::temp_dir().join(format!("pm-routines-engine-{}", uuid::Uuid::new_v4().simple())))
}

fn engine(fake: &Fake) -> Engine<Fake> {
    Engine::new(fake.clone(), store())
}

fn agent_steps() -> Vec<Step> {
    vec![
        Step::StartAgent { agent: "claude".into(), project: "C:/p".into(), task: "do it".into(), separate_copy: true },
        Step::Wait,
        Step::Notify { text: "all done".into() },
    ]
}

fn routine(days: &[u8], time: &str) -> NewWorkflow {
    NewWorkflow { name: "Morning".into(), trigger: Trigger::Schedule { days: days.to_vec(), time: time.into() }, steps: agent_steps() }
}

fn manual() -> NewWorkflow {
    NewWorkflow { name: "Manual".into(), trigger: Trigger::Manual, steps: agent_steps() }
}

fn only_run(e: &Engine<Fake>) -> Run {
    let s = e.snapshot();
    assert_eq!(s.runs.len(), 1, "runs: {:?}", s.runs);
    s.runs[0].clone()
}

// ------------------------------------------------------------------------------------------- schedules

#[test]
fn a_routine_starts_at_its_time_not_before() {
    let m = monday();
    let fake = Fake::at(m + 8 * HOUR + 50 * MIN);
    let e = engine(&fake);
    e.create(routine(&[1, 2, 3, 4, 5], "09:00")).unwrap();
    e.tick();
    assert_eq!(fake.starts(), 0, "10 minutes early");
    fake.set_now(m + 9 * HOUR + 10_000);
    e.tick();
    assert_eq!(fake.starts(), 1);
    let run = only_run(&e);
    assert_eq!(run.state, RunState::Running);
    assert_eq!(run.note_code, None, "on time: no late note");
    let start = fake.0.lock().starts[0].clone();
    assert_eq!(start, ("claude".into(), "C:/p".into(), "do it".into(), true));
    // The same minute again does not start a second one.
    fake.set_now(m + 9 * HOUR + 40_000);
    e.tick();
    assert_eq!(fake.starts(), 1);
}

#[test]
fn a_routine_walks_start_wait_notify_and_ends_done() {
    let m = monday();
    let fake = Fake::at(m + 9 * HOUR - MIN);
    let e = engine(&fake);
    e.create(routine(&[], "09:00")).unwrap();
    fake.set_now(m + 9 * HOUR + 1000);
    e.tick();
    assert_eq!(only_run(&e).step, 1, "waiting on the agent");
    assert!(fake.0.lock().notices.is_empty());
    fake.watch("h1", Watch::Idle { ok: true });
    fake.set_now(m + 9 * HOUR + 5 * MIN);
    e.tick();
    let run = only_run(&e);
    assert_eq!(run.state, RunState::Done);
    assert_eq!(fake.0.lock().notices, vec![("all done".to_string(), false)]);
    assert_eq!(e.snapshot().workflows[0].last_result.as_deref(), Some("done"));
}

#[test]
fn a_weekday_routine_stays_quiet_on_the_weekend() {
    let m = monday();
    let fake = Fake::at(m + 5 * DAY + 8 * HOUR); // Saturday 08:00
    let e = engine(&fake);
    e.create(routine(&[1, 2, 3, 4, 5], "09:00")).unwrap();
    fake.set_now(m + 5 * DAY + 9 * HOUR + MIN);
    e.tick();
    fake.set_now(m + 6 * DAY + 9 * HOUR + MIN);
    e.tick();
    assert_eq!(fake.starts(), 0);
    fake.set_now(m + 7 * DAY + 9 * HOUR + MIN); // Monday
    e.tick();
    assert_eq!(fake.starts(), 1);
}

#[test]
fn a_run_missed_while_the_computer_was_off_runs_once_with_a_late_note() {
    let m = monday();
    let fake = Fake::at(m + 8 * HOUR);
    let store = store();
    {
        let e = Engine::new(fake.clone(), store.clone());
        e.create(routine(&[1, 2, 3, 4, 5], "09:00")).unwrap();
        e.tick();
    }
    // The app was closed Monday 08:00 and started again Thursday 12:00.
    fake.set_now(m + 3 * DAY + 12 * HOUR);
    let e = Engine::new(fake.clone(), store);
    e.tick();
    assert_eq!(fake.starts(), 1, "one run for four missed mornings");
    let run = only_run(&e);
    assert_eq!(run.note_code.as_deref(), Some("late"));
    assert_eq!(run.due_ms, Some(m + 3 * DAY + 9 * HOUR), "the latest due time");
    // And not again on the next ticks.
    fake.watch("h1", Watch::Idle { ok: true });
    e.tick();
    e.tick();
    assert_eq!(fake.starts(), 1);
}

#[test]
fn a_new_routine_does_not_run_for_a_time_before_it_was_made() {
    let m = monday();
    let fake = Fake::at(m + 12 * HOUR);
    let e = engine(&fake);
    e.create(routine(&[], "09:00")).unwrap();
    e.tick();
    assert_eq!(fake.starts(), 0, "09:00 had passed before it existed");
}

#[test]
fn a_turned_off_routine_does_not_run_and_turning_it_on_skips_what_was_missed() {
    let m = monday();
    let fake = Fake::at(m + 8 * HOUR);
    let e = engine(&fake);
    let id = e.create(routine(&[], "09:00")).unwrap();
    e.set_enabled(&id, false).unwrap();
    fake.set_now(m + 9 * HOUR + MIN);
    e.tick();
    assert_eq!(fake.starts(), 0);
    e.set_enabled(&id, true).unwrap();
    e.tick();
    assert_eq!(fake.starts(), 0, "09:00 passed while it was off");
    fake.set_now(m + DAY + 9 * HOUR + MIN);
    e.tick();
    assert_eq!(fake.starts(), 1);
}

#[test]
fn the_same_routine_is_not_stacked_while_its_last_run_is_open() {
    let m = monday();
    let fake = Fake::at(m + 8 * HOUR);
    let e = engine(&fake);
    e.create(routine(&[], "09:00")).unwrap();
    fake.set_now(m + 9 * HOUR + MIN);
    e.tick();
    fake.set_now(m + DAY + 9 * HOUR + MIN); // tomorrow, and yesterday's agent still works
    e.tick();
    assert_eq!(fake.starts(), 1);
    assert_eq!(e.snapshot().runs.len(), 1);
}

// --------------------------------------------------------------------------------------------- failures

#[test]
fn a_routine_that_fails_twice_pauses_itself_and_says_so() {
    let m = monday();
    let fake = Fake::at(m + 8 * HOUR);
    let e = engine(&fake);
    e.create(routine(&[], "09:00")).unwrap();
    fake.0.lock().refuse = Some(StartFail::Refused("That folder is not a project.".into()));
    fake.set_now(m + 9 * HOUR + MIN);
    e.tick();
    let s = e.snapshot();
    assert_eq!(s.runs[0].state, RunState::Failed);
    assert_eq!(s.runs[0].note_detail.as_deref(), Some("That folder is not a project."));
    assert!(s.workflows[0].enabled, "one failure is not enough");
    fake.set_now(m + DAY + 9 * HOUR + MIN);
    e.tick();
    let s = e.snapshot();
    assert!(!s.workflows[0].enabled);
    assert_eq!(s.workflows[0].paused_note.as_deref(), Some("paused_failed"));
    assert!(fake.0.lock().notices.iter().any(|(t, problem)| *problem && t.contains("paused")));
    // Paused: the third morning is quiet.
    fake.set_now(m + 2 * DAY + 9 * HOUR + MIN);
    e.tick();
    assert_eq!(e.snapshot().runs.len(), 2);
}

#[test]
fn a_success_clears_the_failure_streak() {
    let m = monday();
    let fake = Fake::at(m);
    let e = engine(&fake);
    let id = e.create(manual()).unwrap();
    fake.0.lock().refuse = Some(StartFail::Refused("no".into()));
    e.run_now(&id).unwrap();
    e.tick();
    assert_eq!(e.snapshot().workflows[0].fail_streak, 1);
    fake.0.lock().refuse = None;
    e.run_now(&id).unwrap();
    e.tick();
    fake.watch("h1", Watch::Idle { ok: true });
    e.tick();
    assert_eq!(e.snapshot().workflows[0].fail_streak, 0);
}

#[test]
fn a_wait_that_never_ends_stops_after_an_hour() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    let id = e.create(manual()).unwrap();
    e.run_now(&id).unwrap();
    e.tick();
    fake.set_now(monday() + 30 * MIN);
    e.tick();
    assert_eq!(only_run(&e).state, RunState::Running);
    fake.set_now(monday() + WAIT_LIMIT_MS + MIN);
    e.tick();
    let run = only_run(&e);
    assert_eq!(run.state, RunState::Failed);
    assert_eq!(run.note_code.as_deref(), Some("timeout"));
}

#[test]
fn an_agent_that_waits_for_an_answer_is_shown_as_asking_and_never_answered() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    let id = e.create(manual()).unwrap();
    e.run_now(&id).unwrap();
    e.tick();
    fake.watch("h1", Watch::Asked);
    e.tick();
    assert_eq!(only_run(&e).note_code.as_deref(), Some("asked"));
    assert!(fake.0.lock().sent.is_empty(), "the engine never types an answer");
    fake.watch("h1", Watch::Idle { ok: true });
    e.tick();
    assert_eq!(only_run(&e).state, RunState::Done);
}

#[test]
fn a_run_open_when_the_app_closed_ends_with_a_note_at_the_next_start() {
    let fake = Fake::at(monday());
    let store = store();
    {
        let e = Engine::new(fake.clone(), store.clone());
        let id = e.create(manual()).unwrap();
        e.run_now(&id).unwrap();
        e.tick();
        assert_eq!(only_run(&e).state, RunState::Running);
    }
    let e = Engine::new(fake.clone(), store);
    let run = only_run(&e);
    assert_eq!(run.state, RunState::Failed);
    assert_eq!(run.note_code.as_deref(), Some("app_closed"));
}

#[test]
fn stopping_a_run_stops_its_agent_and_ends_it() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    let id = e.create(manual()).unwrap();
    let run = e.run_now(&id).unwrap();
    e.tick();
    e.stop_run(&run).unwrap();
    assert_eq!(only_run(&e).state, RunState::Stopped);
    assert_eq!(fake.0.lock().stopped, vec!["h1".to_string()]);
    e.tick();
    assert_eq!(fake.starts(), 1);
}

#[test]
fn run_now_is_refused_while_it_is_already_running() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    let id = e.create(manual()).unwrap();
    e.run_now(&id).unwrap();
    assert!(e.run_now(&id).is_err());
}

#[test]
fn deleting_a_workflow_stops_its_open_runs() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    let id = e.create(manual()).unwrap();
    e.run_now(&id).unwrap();
    e.tick();
    e.delete(&id).unwrap();
    assert!(e.snapshot().workflows.is_empty());
    assert_eq!(only_run(&e).state, RunState::Stopped);
    assert_eq!(fake.0.lock().stopped.len(), 1);
}

// -------------------------------------------------------------------------------------------- at most N

#[test]
fn with_no_limit_everything_starts_at_once() {
    let fake = Fake::at(monday());
    fake.0.lock().running = 9;
    let e = engine(&fake);
    let a = e.create(manual()).unwrap();
    e.run_now(&a).unwrap();
    e.tick();
    assert_eq!(fake.starts(), 1);
}

#[test]
fn over_the_limit_a_start_waits_in_a_visible_queue_in_order() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    e.set_limit(Some(3));
    fake.0.lock().running = 3;
    let mut ids = Vec::new();
    for name in ["One", "Two", "Three"] {
        let id = e.create(NewWorkflow { name: name.into(), ..manual() }).unwrap();
        e.run_now(&id).unwrap();
        ids.push(id);
    }
    e.tick();
    assert_eq!(fake.starts(), 0);
    let state = e.snapshot();
    assert!(state.runs.iter().all(|r| r.state == RunState::Waiting));
    let v = view::build(&state, fake.now_ms(), 0, 3);
    assert_eq!(v.limit, Some(3));
    assert_eq!(v.running, 3);
    assert_eq!(v.queue.iter().map(|q| (q.position, q.name.as_str())).collect::<Vec<_>>(), vec![(1, "One"), (2, "Two"), (3, "Three")]);

    // One slot frees: only the first in line starts.
    fake.0.lock().running = 2;
    e.tick();
    assert_eq!(fake.starts(), 1);
    let state = e.snapshot();
    let waiting: Vec<&str> = state.runs.iter().filter(|r| r.state == RunState::Waiting).map(|r| r.workflow_name.as_str()).collect();
    assert_eq!(waiting.len(), 2);
    assert!(!waiting.contains(&"One"));
}

#[test]
fn several_free_slots_start_several_in_one_tick_but_never_more_than_free() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    e.set_limit(Some(2));
    for name in ["A", "B", "C"] {
        let id = e.create(NewWorkflow { name: name.into(), ..manual() }).unwrap();
        e.run_now(&id).unwrap();
    }
    e.tick();
    assert_eq!(fake.starts(), 2, "the running count is the fake's 0 plus what this tick started");
    assert_eq!(view::build(&e.snapshot(), 0, 0, 0).queue.len(), 1);
}

#[test]
fn raising_or_removing_the_limit_lets_the_queue_go() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    e.set_limit(Some(1));
    fake.0.lock().running = 1;
    let id = e.create(manual()).unwrap();
    e.run_now(&id).unwrap();
    e.tick();
    assert_eq!(fake.starts(), 0);
    e.set_limit(None);
    e.tick();
    assert_eq!(fake.starts(), 1);
}

#[test]
fn the_limit_is_kept_between_zero_and_the_cap() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    e.set_limit(Some(0));
    assert_eq!(e.snapshot().config.max_at_once, None, "0 means off");
    e.set_limit(Some(1000));
    assert_eq!(e.snapshot().config.max_at_once, Some(LIMIT_MAX));
}

#[test]
fn the_start_slot_error_of_the_app_also_waits() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    fake.0.lock().refuse = Some(StartFail::NoSlot);
    let id = e.create(manual()).unwrap();
    e.run_now(&id).unwrap();
    e.tick();
    assert_eq!(only_run(&e).state, RunState::Waiting);
    fake.0.lock().refuse = None;
    e.tick();
    assert_eq!(only_run(&e).state, RunState::Running);
}

// ------------------------------------------------------------------------------------------------ chains

fn then_follow_up(pane: &str, only_if_ok: bool) -> NewWorkflow {
    NewWorkflow {
        name: "Then".into(),
        trigger: Trigger::ChatFinished { pane_id: pane.into(), only_if_ok },
        steps: vec![Step::FollowUp { text: "now run the tests".into() }, Step::Notify { text: "tests asked for".into() }],
    }
}

#[test]
fn a_chain_waits_for_a_working_chat_to_finish_then_sends_once() {
    let fake = Fake::at(monday());
    fake.chat("pane1", 0, true, true);
    let e = engine(&fake);
    e.create(then_follow_up("pane1", false)).unwrap();
    e.tick();
    assert!(e.snapshot().runs.is_empty(), "the chat is still working");
    fake.chat("pane1", 1, false, true);
    // The chat is idle after its turn: the follow-up goes in (the fake's chat shows the finished turn).
    fake.watch("pane1", Watch::Idle { ok: true });
    e.tick();
    assert_eq!(fake.0.lock().sent, vec![("pane1".to_string(), "now run the tests".to_string())]);
    assert_eq!(only_run(&e).state, RunState::Done);
    // It ran once: the chat's next turn does nothing.
    fake.chat("pane1", 2, false, true);
    e.tick();
    assert_eq!(fake.0.lock().sent.len(), 1);
    let s = e.snapshot();
    assert!(!s.workflows[0].enabled);
    assert_eq!(s.workflows[0].paused_note.as_deref(), Some("ran_once"));
}

#[test]
fn a_chain_made_on_a_chat_that_just_finished_runs_at_once() {
    let fake = Fake::at(monday());
    fake.chat("pane1", 1, false, true);
    fake.watch("pane1", Watch::Idle { ok: true });
    let e = engine(&fake);
    e.create(then_follow_up("pane1", true)).unwrap();
    e.tick();
    assert_eq!(fake.0.lock().sent.len(), 1, "after this, do that: this was already done");
}

#[test]
fn only_if_it_went_well_skips_a_chat_that_did_not() {
    let fake = Fake::at(monday());
    fake.chat("pane1", 0, true, true);
    let e = engine(&fake);
    e.create(then_follow_up("pane1", true)).unwrap();
    fake.chat("pane1", 1, false, false); // cancelled
    e.tick();
    assert!(fake.0.lock().sent.is_empty());
    let run = only_run(&e);
    assert_eq!(run.state, RunState::Skipped);
    assert_eq!(run.note_code.as_deref(), Some("not_ok"));
    assert_eq!(e.snapshot().workflows[0].paused_note.as_deref(), Some("not_ok"));
}

#[test]
fn a_chain_on_a_chat_that_is_not_open_is_refused() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    assert!(e.create(then_follow_up("nope", false)).is_err());
}

#[test]
fn a_chain_can_start_another_agent_and_wait_for_it() {
    let fake = Fake::at(monday());
    fake.chat("pane1", 0, true, true);
    let e = engine(&fake);
    e.create(NewWorkflow {
        name: "Review it".into(),
        trigger: Trigger::ChatFinished { pane_id: "pane1".into(), only_if_ok: true },
        steps: vec![
            Step::StartAgent { agent: "codex".into(), project: "C:/p".into(), task: "review".into(), separate_copy: false },
            Step::Wait,
            Step::Notify { text: "review done".into() },
        ],
    })
    .unwrap();
    fake.chat("pane1", 1, false, true);
    e.tick();
    assert_eq!(fake.starts(), 1);
    fake.watch("h1", Watch::Idle { ok: true });
    e.tick();
    assert_eq!(only_run(&e).state, RunState::Done);
}

#[test]
fn a_chat_that_closed_turns_its_chain_off_with_a_note() {
    let fake = Fake::at(monday());
    fake.chat("pane1", 0, true, true);
    let e = engine(&fake);
    e.create(then_follow_up("pane1", false)).unwrap();
    fake.0.lock().chats.clear();
    e.tick();
    let s = e.snapshot();
    assert!(!s.workflows[0].enabled);
    assert_eq!(s.workflows[0].paused_note.as_deref(), Some("chat_gone"));
}

#[test]
fn a_follow_up_waits_until_the_agent_is_idle_and_remembers_the_turn_count() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    let id = e
        .create(NewWorkflow {
            name: "Twice".into(),
            trigger: Trigger::Manual,
            steps: vec![
                Step::StartAgent { agent: "claude".into(), project: "C:/p".into(), task: "first".into(), separate_copy: false },
                Step::FollowUp { text: "second".into() },
                Step::Wait,
            ],
        })
        .unwrap();
    e.run_now(&id).unwrap();
    e.tick();
    assert!(fake.0.lock().sent.is_empty(), "the first turn still runs");
    fake.0.lock().turns.insert("h1".into(), 1);
    fake.watch("h1", Watch::Idle { ok: true });
    e.tick();
    assert_eq!(fake.0.lock().sent.len(), 1);
    assert_eq!(only_run(&e).target.unwrap().mark, 1);
}

#[test]
fn a_busy_chat_is_tried_again_next_tick() {
    let fake = Fake::at(monday());
    fake.chat("pane1", 1, false, true);
    fake.watch("pane1", Watch::Idle { ok: true });
    let e = engine(&fake);
    fake.0.lock().send_fail = Some(SendFail::Busy);
    e.create(then_follow_up("pane1", false)).unwrap();
    e.tick();
    assert_eq!(only_run(&e).state, RunState::Running);
    fake.0.lock().send_fail = None;
    e.tick();
    assert_eq!(only_run(&e).state, RunState::Done);
}

#[test]
fn only_recent_finished_runs_are_kept() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    let id = e
        .create(NewWorkflow { name: "Ping".into(), trigger: Trigger::Manual, steps: vec![Step::Notify { text: "hi".into() }] })
        .unwrap();
    for _ in 0..(RUNS_KEPT + 5) {
        e.run_now(&id).unwrap();
        e.tick();
    }
    assert_eq!(e.snapshot().runs.len(), RUNS_KEPT);
}

#[test]
fn the_audit_log_and_the_windows_hear_about_changes() {
    let fake = Fake::at(monday());
    let e = engine(&fake);
    let id = e.create(manual()).unwrap();
    e.run_now(&id).unwrap();
    let w = fake.0.lock();
    assert!(w.audits.contains(&"created".to_string()) && w.audits.contains(&"started".to_string()));
    assert!(w.changes >= 2);
}
