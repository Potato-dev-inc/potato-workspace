//! `run_agents` with fake agents on a fake clock: all / any / first_success, the helper limit and its queue, a task
//! that cannot start, cancel_rest, the size cap and the review hook.

use super::*;

/// What a fake helper does: finishes `after_ms` after it started, with this status and result.
struct Script {
    after_ms: u64,
    status: &'static str,
    result: String,
}

struct Fake {
    now: u64,
    limit: usize,
    scripts: std::collections::HashMap<String, Script>,
    started: Vec<(String, u64)>,
    stopped: Vec<String>,
    reviewed: Vec<String>,
    peak: usize,
    cancel_at: Option<u64>,
}

impl Fake {
    fn new(limit: usize) -> Self {
        Self { now: 0, limit, scripts: Default::default(), started: vec![], stopped: vec![], reviewed: vec![], peak: 0, cancel_at: None }
    }
    fn script(mut self, name: &str, after_ms: u64, status: &'static str, result: &str) -> Self {
        self.scripts.insert(name.into(), Script { after_ms, status, result: result.into() });
        self
    }
    fn start_time(&self, name: &str) -> Option<u64> {
        self.started.iter().find(|(n, _)| n == name).map(|(_, t)| *t)
    }
    fn running_now(&self) -> usize {
        self.started
            .iter()
            .filter(|(n, t)| {
                let s = &self.scripts[n];
                t + s.after_ms > self.now && !self.stopped.contains(n)
            })
            .count()
    }
    fn view_of(&self, name: &str) -> Value {
        let s = &self.scripts[name];
        json!({ "handle": format!("h-{name}"), "status": s.status, "result": s.result, "verified": false })
    }
}

impl BatchIo for Fake {
    fn start(&mut self, body: &Value) -> Result<Value, Value> {
        let name = body["name"].as_str().unwrap().to_string();
        assert_eq!(body["wait_ms"], 0);
        assert!(body["idempotency_key"].as_str().unwrap().ends_with(&format!(":{name}")));
        if body["agent_type"] == "nonexistent" {
            return Err(json!({ "code": "UNKNOWN_AGENT_TYPE", "message": "no such agent", "recoverable": false }));
        }
        self.started.push((name.clone(), self.now));
        self.peak = self.peak.max(self.running_now());
        Ok(json!({ "handle": format!("h-{name}"), "status": "running" }))
    }
    fn wait(&mut self, _project: Option<&Value>, handles: &[String], slice_ms: u64) -> Result<Vec<Value>, String> {
        let names: Vec<String> = handles.iter().map(|h| h.trim_start_matches("h-").to_string()).collect();
        let next_finish = names
            .iter()
            .filter_map(|n| self.start_time(n).map(|t| t + self.scripts[n].after_ms))
            .filter(|t| *t > self.now)
            .min();
        let target = self.now + slice_ms;
        self.now = next_finish.map(|t| t.min(target)).unwrap_or(target);
        Ok(names
            .iter()
            .filter(|n| self.start_time(n).is_some_and(|t| t + self.scripts[*n].after_ms <= self.now))
            .map(|n| self.view_of(n))
            .collect())
    }
    fn stop(&mut self, _project: Option<&Value>, handle: &str) {
        self.stopped.push(handle.trim_start_matches("h-").to_string());
    }
    fn review(&mut self, mut finished: Value, review_by: &Value, _project: Option<&Value>) -> Value {
        self.reviewed.push(finished["handle"].as_str().unwrap().to_string());
        finished["review"] = json!({ "by": review_by["agent_type"], "verdict": "pass" });
        finished
    }
    fn limit(&mut self) -> usize {
        self.limit
    }
    fn cancelled(&self) -> bool {
        self.cancel_at.is_some_and(|t| self.now >= t)
    }
    fn now_ms(&mut self) -> u64 {
        self.now
    }
    fn pause(&mut self, ms: u64) {
        self.now += ms;
    }
    fn progress(&mut self, _message: &str) {}
}

fn args(tasks: Value, extra: Value) -> Value {
    let mut out = json!({ "tasks": tasks });
    for (k, v) in extra.as_object().unwrap() {
        out[k] = v.clone();
    }
    out
}

fn named(names: &[&str]) -> Value {
    Value::Array(names.iter().map(|n| json!({ "name": n, "task": format!("do {n}") })).collect())
}

fn go(args: &Value, io: &mut Fake) -> Value {
    let plan = plan(args, "batch1", 3_600_000).unwrap();
    run(plan, io).ok().unwrap()
}

fn statuses(out: &Value) -> Vec<String> {
    out["runs"].as_array().unwrap().iter().map(|r| r["status"].as_str().unwrap().to_string()).collect()
}

#[test]
fn three_helpers_come_back_in_one_call_in_input_order() {
    let mut io = Fake::new(8).script("a", 3000, "completed", "A done").script("b", 1000, "completed", "B done").script("c", 2000, "failed", "C broke");
    let out = go(&args(named(&["a", "b", "c"]), json!({})), &mut io);
    assert_eq!(out["reason"], "all_finished");
    assert_eq!(statuses(&out), ["completed", "completed", "failed"]);
    assert_eq!(out["runs"][0]["name"], "a");
    assert_eq!(out["runs"][1]["result"], "B done");
    assert_eq!(out["runs"][2]["handle"], "h-c");
    assert!(out.get("next").is_none());
}

#[test]
fn defaults_fill_every_task_and_a_task_value_wins() {
    let tasks = json!([{ "name": "a", "task": "x" }, { "name": "b", "task": "y", "read_only": false }]);
    let p = plan(&args(tasks, json!({ "defaults": { "project_path": "D:/repo", "read_only": true } })), "k", 1000).unwrap();
    assert_eq!(p.slots[0].body["project_path"], "D:/repo");
    assert_eq!(p.slots[0].body["read_only"], true);
    assert_eq!(p.slots[1].body["read_only"], false);
    assert_eq!(p.slots[0].body["idempotency_key"], "k:a");
}

#[test]
fn any_returns_after_the_fastest_and_cancel_rest_stops_the_others() {
    let mut io = Fake::new(8).script("slow", 60_000, "completed", "s").script("fast", 1000, "completed", "f").script("mid", 30_000, "completed", "m");
    let out = go(&args(named(&["slow", "fast", "mid"]), json!({ "until": "any", "cancel_rest": true })), &mut io);
    assert_eq!(out["reason"], "any_finished");
    assert_eq!(statuses(&out), ["cancelled", "completed", "cancelled"]);
    assert_eq!(io.stopped, ["slow", "mid"]);
}

#[test]
fn any_without_cancel_rest_leaves_the_others_running_with_a_wait_hint() {
    let mut io = Fake::new(8).script("slow", 60_000, "completed", "s").script("fast", 1000, "completed", "f");
    let out = go(&args(named(&["slow", "fast"]), json!({ "until": "any" })), &mut io);
    assert_eq!(statuses(&out), ["running", "completed"]);
    assert!(io.stopped.is_empty());
    assert_eq!(out["next"]["wait"]["args"]["handles"][0], "h-slow");
}

#[test]
fn first_success_skips_failures_and_waits_for_a_completed_one() {
    let mut io = Fake::new(8).script("bad", 500, "failed", "no").script("good", 2000, "completed", "yes").script("late", 50_000, "completed", "z");
    let out = go(&args(named(&["bad", "good", "late"]), json!({ "until": "first_success", "cancel_rest": true })), &mut io);
    assert_eq!(out["reason"], "first_success");
    assert_eq!(statuses(&out), ["failed", "completed", "cancelled"]);
    assert_eq!(io.stopped, ["late"]);
}

#[test]
fn first_success_with_only_failures_ends_as_no_success() {
    let mut io = Fake::new(8).script("a", 500, "failed", "no").script("b", 800, "failed", "no");
    let out = go(&args(named(&["a", "b"]), json!({ "until": "first_success" })), &mut io);
    assert_eq!(out["reason"], "no_success");
}

#[test]
fn the_helper_limit_queues_the_rest_and_never_runs_more_than_it_allows() {
    let names: Vec<String> = (0..5).map(|i| format!("t{i}")).collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let mut io = Fake::new(2);
    for n in &names {
        io = io.script(n, 1000, "completed", "ok");
    }
    let out = go(&args(named(&refs), json!({})), &mut io);
    assert_eq!(out["reason"], "all_finished");
    assert_eq!(out["limit"], 2);
    assert!(statuses(&out).iter().all(|s| s == "completed"));
    assert_eq!(io.peak, 2);
    // The third helper only started once the first one ended.
    assert_eq!(io.start_time("t2"), Some(1000));
}

#[test]
fn a_task_that_cannot_start_comes_back_with_its_own_error_and_the_rest_run() {
    let tasks = json!([{ "name": "ok1", "task": "a" }, { "name": "bad", "task": "b", "agent_type": "nonexistent" }, { "name": "ok2", "task": "c" }, { "name": "empty", "task": " " }]);
    let mut io = Fake::new(8).script("ok1", 1000, "completed", "1").script("ok2", 1000, "completed", "2");
    let out = go(&args(tasks, json!({})), &mut io);
    assert_eq!(statuses(&out), ["completed", "not_started", "completed", "not_started"]);
    assert_eq!(out["runs"][1]["error"]["code"], "UNKNOWN_AGENT_TYPE");
    assert_eq!(out["runs"][3]["error"]["code"], "INVALID_ARGUMENT");
}

#[test]
fn running_out_of_time_returns_handles_and_the_tasks_not_started_yet() {
    let mut io = Fake::new(1).script("a", 500_000, "completed", "x").script("b", 1000, "completed", "y");
    let out = go(&args(named(&["a", "b"]), json!({ "wait_ms": 10_000 })), &mut io);
    assert_eq!(out["reason"], "timeout");
    assert_eq!(statuses(&out), ["running", "not_started"]);
    assert_eq!(out["queued"], 1);
    assert_eq!(out["next"]["start_rest"]["args"]["tasks"][0]["name"], "b");
    assert_eq!(out["next"]["wait"]["args"]["handles"][0], "h-a");
}

#[test]
fn the_combined_answer_is_size_capped_and_points_at_the_transcript() {
    let big = "x".repeat(20_000);
    let mut io = Fake::new(8).script("a", 100, "completed", &big).script("b", 100, "completed", "short");
    let out = go(&args(named(&["a", "b"]), json!({})), &mut io);
    assert_eq!(out["runs"][0]["result"].as_str().unwrap().chars().count(), RESULT_CAP);
    assert_eq!(out["runs"][0]["result_truncated"], true);
    assert_eq!(out["runs"][0]["more"]["tool"], "agent_transcript");
    assert_eq!(out["runs"][1]["result"], "short");
    assert!(out["runs"][1].get("result_truncated").is_none());
    // Many tasks share the total instead of each taking the full cap.
    let names: Vec<String> = (0..30).map(|i| format!("t{i}")).collect();
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let mut io = Fake::new(32);
    for n in &names {
        io = io.script(n, 100, "completed", &big);
    }
    let out = go(&args(named(&refs), json!({})), &mut io);
    assert!(out.to_string().len() < 90_000, "{}", out.to_string().len());
}

#[test]
fn a_finished_task_with_review_by_gets_its_review_and_a_failed_one_does_not() {
    let tasks = json!([
        { "name": "a", "task": "x", "review_by": { "agent_type": "codex" } },
        { "name": "b", "task": "y", "review_by": { "agent_type": "codex" } }
    ]);
    let mut io = Fake::new(8).script("a", 100, "completed", "1").script("b", 100, "failed", "2");
    let out = go(&args(tasks, json!({})), &mut io);
    assert_eq!(out["runs"][0]["review"]["verdict"], "pass");
    assert!(out["runs"][1].get("review").is_none());
    assert_eq!(io.reviewed, ["h-a"]);
}

#[test]
fn a_cancelled_call_stops_waiting_and_leaves_the_helpers_alone() {
    let mut io = Fake::new(8).script("a", 500_000, "completed", "x");
    io.cancel_at = Some(5_000);
    let plan = plan(&args(named(&["a"]), json!({})), "k", 3_600_000).unwrap();
    assert!(matches!(run(plan, &mut io), Err(Stop::Cancelled)));
    assert!(io.stopped.is_empty());
}

#[test]
fn bad_arguments_are_refused_before_anything_starts() {
    assert!(plan(&json!({ "tasks": [] }), "k", 1).is_err());
    assert!(plan(&json!({}), "k", 1).is_err());
    assert!(plan(&args(named(&["a"]), json!({ "until": "sometime" })), "k", 1).is_err());
    let many: Vec<Value> = (0..MAX_TASKS + 1).map(|i| json!({ "task": format!("t{i}") })).collect();
    assert!(plan(&json!({ "tasks": many }), "k", 1).is_err());
}

#[test]
fn two_tasks_with_the_same_name_get_different_keys() {
    let tasks = json!([{ "name": "same", "task": "x" }, { "name": "same", "task": "y" }]);
    let p = plan(&json!({ "tasks": tasks }), "k", 1).unwrap();
    assert_ne!(p.slots[0].body["idempotency_key"], p.slots[1].body["idempotency_key"]);
}
