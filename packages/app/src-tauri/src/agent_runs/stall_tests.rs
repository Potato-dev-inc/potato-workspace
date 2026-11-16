//! Stall detection on a fake clock: every time below is a number the test chooses.

use super::*;

const MIN: u64 = 60_000;

fn quiet(now_min: u64) -> Signals {
    Signals { now_ms: now_min * MIN, screen_ms: 0, file_ms: None, event_ms: 0, running: true, waiting: false }
}

#[test]
fn a_run_with_no_progress_for_the_threshold_is_stuck() {
    assert_eq!(stalled_minutes(&quiet(4), 5), None);
    assert_eq!(stalled_minutes(&quiet(5), 5), Some(5));
    assert_eq!(stalled_minutes(&quiet(6), 5), Some(6));
}

#[test]
fn new_output_a_tool_event_or_a_file_change_resets_it() {
    let mut s = quiet(6);
    s.screen_ms = 3 * MIN;
    assert_eq!(stalled_minutes(&s, 5), None, "output 3 min ago");
    let mut s = quiet(6);
    s.event_ms = 4 * MIN;
    assert_eq!(stalled_minutes(&s, 5), None, "tool event 2 min ago");
    let mut s = quiet(6);
    s.file_ms = Some(5 * MIN);
    assert_eq!(stalled_minutes(&s, 5), None, "file changed 1 min ago");
    s.file_ms = Some(0);
    assert_eq!(stalled_minutes(&s, 5), Some(6), "an old file change resets nothing");
}

#[test]
fn a_pending_prompt_or_a_run_that_is_not_running_is_not_a_stall() {
    let mut s = quiet(30);
    s.waiting = true;
    assert_eq!(stalled_minutes(&s, 5), None, "waiting on the person");
    let mut s = quiet(30);
    s.running = false;
    assert_eq!(stalled_minutes(&s, 5), None, "finished or queued");
}

#[test]
fn the_threshold_setting_decides_and_zero_turns_it_off() {
    let s = quiet(3);
    assert_eq!(stalled_minutes(&s, 1), Some(3));
    assert_eq!(stalled_minutes(&s, 3), Some(3));
    assert_eq!(stalled_minutes(&s, 4), None);
    assert_eq!(stalled_minutes(&quiet(500), 0), None, "0 = off");
}

#[test]
fn spinners_and_clocks_do_not_count_as_output_but_words_do() {
    let a = screen_fingerprint("\u{280b} Working 12s  [\u{2588}\u{2588}  ]\n> sleep 400");
    let b = screen_fingerprint("\u{2819} Working 13s  [\u{2588}\u{2588}\u{2588} ]\n> sleep 400");
    assert!(a.is_some() && a == b, "only the spinner and the clock moved");
    let c = screen_fingerprint("\u{2819} Working 14s\n> sleep 400\ndone");
    assert_ne!(a, c, "a new word is output");
    assert_eq!(screen_fingerprint("   \n 12 \u{280b}"), None, "an empty screen has no fingerprint");
}

struct Fake {
    state: RunState,
    threshold: u32,
    file: Option<u64>,
}

impl Source for Fake {
    fn run_state(&self, _pane: &str) -> Option<RunState> {
        Some(self.state)
    }
    fn newest_file_ms(&self, _cwd: &str, _now: u64) -> Option<u64> {
        self.file
    }
    fn threshold_min(&self) -> u32 {
        self.threshold
    }
}

fn sample(screen: u64) -> PaneSample {
    PaneSample { id: "p1".into(), cwd: "C:/x".into(), screen: Some(screen), last_output_ms: 0 }
}

fn running() -> RunState {
    RunState { running: true, waiting: false, event_ms: 0 }
}

#[test]
fn the_sampler_flags_a_silent_helper_and_clears_it_when_it_speaks() {
    let src = Fake { state: running(), threshold: 5, file: None };
    let mut t = Tracker::default();
    assert!(t.tick(&[sample(1)], &src, 10 * MIN).is_empty(), "first sight starts the clock");
    assert!(t.tick(&[sample(1)], &src, 14 * MIN).is_empty());
    assert_eq!(t.tick(&[sample(1)], &src, 15 * MIN), vec![("p1".to_string(), Some(5))]);
    assert_eq!(t.minutes_of("p1"), Some(5));
    assert_eq!(t.all(), vec![("p1".to_string(), 5)]);
    // Same screen next minute: the number grows, so the row updates.
    assert_eq!(t.tick(&[sample(1)], &src, 16 * MIN), vec![("p1".to_string(), Some(6))]);
    // New output.
    assert_eq!(t.tick(&[sample(2)], &src, 17 * MIN), vec![("p1".to_string(), None)]);
    assert_eq!(t.minutes_of("p1"), None);
    assert!(t.tick(&[sample(2)], &src, 21 * MIN).is_empty(), "4 quiet minutes is under the threshold");
}

#[test]
fn a_file_change_or_a_prompt_or_a_vanished_pane_clears_the_sampler() {
    let mut t = Tracker::default();
    let quiet_src = Fake { state: running(), threshold: 5, file: None };
    t.tick(&[sample(1)], &quiet_src, 0);
    assert_eq!(t.tick(&[sample(1)], &quiet_src, 6 * MIN).len(), 1);
    let writing = Fake { state: running(), threshold: 5, file: Some(6 * MIN) };
    assert_eq!(t.tick(&[sample(1)], &writing, 7 * MIN), vec![("p1".to_string(), None)], "a file changed in its folder");
    let asking = Fake { state: RunState { running: false, waiting: true, event_ms: 0 }, threshold: 5, file: None };
    assert!(t.tick(&[sample(1)], &asking, 30 * MIN).is_empty(), "waiting on a prompt is never a stall");
    t.tick(&[sample(1)], &quiet_src, 31 * MIN);
    assert_eq!(t.minutes_of("p1"), Some(31), "quiet since its last change at minute 0");
    assert_eq!(t.tick(&[], &quiet_src, 32 * MIN), vec![("p1".to_string(), None)], "pane closed");
}

#[test]
fn a_lower_threshold_flags_sooner() {
    let src = Fake { state: running(), threshold: 1, file: None };
    let mut t = Tracker::default();
    t.tick(&[sample(1)], &src, 0);
    assert!(t.tick(&[sample(1)], &src, 59_000).is_empty());
    assert_eq!(t.tick(&[sample(1)], &src, MIN), vec![("p1".to_string(), Some(1))]);
}

#[test]
fn a_chat_helper_with_no_screen_text_goes_by_its_last_output() {
    let src = Fake { state: running(), threshold: 5, file: None };
    let mut t = Tracker::default();
    let mut s = PaneSample { id: "c1".into(), cwd: "C:/x".into(), screen: None, last_output_ms: 9 * MIN };
    t.tick(&[s.clone()], &src, 10 * MIN);
    assert!(t.tick(&[s.clone()], &src, 13 * MIN).is_empty(), "output 4 min ago");
    assert_eq!(t.tick(&[s.clone()], &src, 15 * MIN), vec![("c1".to_string(), Some(5))], "first sight at minute 10 started the clock");
    s.last_output_ms = 16 * MIN;
    assert_eq!(t.tick(&[s], &src, 17 * MIN), vec![("c1".to_string(), None)]);
}

#[test]
fn the_newest_file_looks_inside_the_folder_but_not_into_node_modules() {
    let dir = std::env::temp_dir().join(format!("pm-stall-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::create_dir_all(dir.join("node_modules")).unwrap();
    assert_eq!(newest_file_ms_in(&dir), None, "no files yet");
    std::fs::write(dir.join("node_modules").join("noise.js"), "x").unwrap();
    assert_eq!(newest_file_ms_in(&dir), None, "node_modules is skipped");
    std::fs::write(dir.join("src").join("a.rs"), "x").unwrap();
    let found = newest_file_ms_in(&dir).expect("a file");
    assert!(now_ms().saturating_sub(found) < 60_000);
    let _ = std::fs::remove_dir_all(&dir);
}

fn run_request(project: &std::path::Path, pane: Option<&str>, model: Option<&str>) -> crate::operations::DelegateWorkRequest {
    crate::operations::DelegateWorkRequest {
        project_path: project.to_string_lossy().into_owned(),
        task: "sleep 400 seconds using a shell command, then reply done".into(),
        agent_type: "opencode_native".into(),
        pane_id: pane.map(String::from),
        idempotency_key: uuid::Uuid::new_v4().to_string(),
        acceptance_criteria: None,
        task_id: None,
        exclusive: false,
        locks: vec![],
        timeout_ms: 900_000,
        read_only: false,
        keep_pane: true,
        placement: None,
        owner_session_id: None,
        parent_pane_id: None,
        worker_has_mcp_tools: false,
        agent_run_id: None,
        turn_index: 0,
        worker: crate::operations::WorkerPersist { requested_model: model.map(String::from), ..Default::default() },
        context_policy: None,
        checks: Vec::new(),
    }
}

#[test]
fn a_stuck_run_reads_stalled_true_with_minutes_in_the_agents_view() {
    use crate::operations::OperationStatus;
    let project = std::env::temp_dir().join(format!("pm-stall-view-{}", uuid::Uuid::new_v4()));
    let mut snapshot = crate::operations::create_operation(run_request(&project, Some("pane-stall-view"), None)).unwrap().0;
    snapshot.status = OperationStatus::Running;
    let healthy = serde_json::to_value(crate::agent_runs::AgentRunView::from(snapshot.clone())).unwrap();
    assert!(healthy.get("stalled").is_none(), "a healthy run has no stalled field");
    // Put the pane in the store the way the sampler does.
    let src = Fake { state: running(), threshold: 5, file: None };
    let pane = PaneSample { id: "pane-stall-view".into(), cwd: "C:/x".into(), screen: Some(7), last_output_ms: 0 };
    TRACKER.lock().tick(std::slice::from_ref(&pane), &src, 0);
    TRACKER.lock().tick(std::slice::from_ref(&pane), &src, 6 * MIN);
    let view = serde_json::to_value(crate::agent_runs::AgentRunView::from(snapshot.clone())).unwrap();
    assert_eq!(view["stalled"], true);
    assert_eq!(view["stalled_minutes"], 6);
    // A finished run is never stuck.
    snapshot.status = OperationStatus::Completed;
    let done = serde_json::to_value(crate::agent_runs::AgentRunView::from(snapshot)).unwrap();
    assert!(done.get("stalled").is_none());
    TRACKER.lock().tick(&[], &src, 7 * MIN);
}

#[test]
fn respawn_repeats_the_same_task_agent_and_model() {
    let project = std::env::temp_dir().join(format!("pm-stall-respawn-{}", uuid::Uuid::new_v4()));
    let snapshot = crate::operations::create_operation(run_request(&project, None, Some("opencode-go/deepseek-v4.1-flash"))).unwrap().0;
    let body = respawn_request(&snapshot);
    assert_eq!(body["task"], "sleep 400 seconds using a shell command, then reply done");
    assert_eq!(body["agent_type"], "opencode_native");
    assert_eq!(body["model"], "opencode-go/deepseek-v4.1-flash");
    let parsed: Result<super::super::runtime::AgentRunRequest, _> = serde_json::from_value(body);
    assert!(parsed.is_ok(), "the app can start it");
}
