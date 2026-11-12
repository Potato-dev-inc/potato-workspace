//! `run_agents`: start several helpers in one call and collect them together.
//!
//! The decisions live here (merge the shared defaults, keep at most `limit` helpers running and queue the rest,
//! when the batch is decided for `until`, what one combined and size-capped answer looks like). Everything that
//! touches the app is behind [`BatchIo`], so the engine is tested with a fake clock and fake agents. A task that
//! cannot start comes back with its own error and never blocks the others. Queued tasks start while this call is
//! alive; whatever was not started when it returns is listed in `next.start_rest` so nothing is dropped silently.

use serde_json::{json, Map, Value};

/// The most tasks one call takes.
pub(super) const MAX_TASKS: usize = 32;
/// One run's `result` in a batch answer.
const RESULT_CAP: usize = 4_000;
/// All results together; with many tasks each one gets a share.
const TOTAL_CAP: usize = 60_000;
const MIN_SHARE: usize = 400;
const SLICE_MS: u64 = 4_000;
const BEAT_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Until {
    All,
    Any,
    FirstSuccess,
}

impl Until {
    fn parse(value: Option<&Value>) -> Result<Self, String> {
        match value.and_then(Value::as_str) {
            None | Some("all") => Ok(Self::All),
            Some("any") => Ok(Self::Any),
            Some("first_success") => Ok(Self::FirstSuccess),
            Some(other) => Err(format!("until must be all, any or first_success, not {other}")),
        }
    }
}

pub(super) enum Stop {
    /// The caller's tool call was cancelled; the helpers keep running.
    Cancelled,
}

pub(super) trait BatchIo {
    /// Start one run (`wait_ms: 0`). `Err` is the typed error the app gave.
    fn start(&mut self, body: &Value) -> Result<Value, Value>;
    /// Wait up to `slice_ms` for any of `handles` (one project) to leave `running`; returns the changed run views.
    fn wait(&mut self, project: Option<&Value>, handles: &[String], slice_ms: u64) -> Result<Vec<Value>, String>;
    /// End a helper the batch no longer needs (stop its turn and close its pane).
    fn stop(&mut self, project: Option<&Value>, handle: &str);
    /// A finished run with `review_by`: the run's view with `review` added.
    fn review(&mut self, finished: Value, review_by: &Value, project: Option<&Value>) -> Value;
    /// "Most helpers at once".
    fn limit(&mut self) -> usize;
    fn cancelled(&self) -> bool;
    fn now_ms(&mut self) -> u64;
    fn pause(&mut self, ms: u64);
    fn progress(&mut self, message: &str);
}

enum State {
    Pending,
    Running(String),
    Finished(Value),
}

struct Slot {
    name: String,
    original: Value,
    body: Value,
    review_by: Option<Value>,
    project: Option<Value>,
    state: State,
}

pub(super) struct Plan {
    slots: Vec<Slot>,
    until: Until,
    wait_ms: u64,
    cancel_rest: bool,
}

/// Merge defaults into every task and fix the idempotency keys. `Err` is an argument problem for the whole call.
pub(super) fn plan(args: &Value, batch_key: &str, max_wait_ms: u64) -> Result<Plan, String> {
    let tasks = args.get("tasks").and_then(Value::as_array).filter(|t| !t.is_empty()).ok_or("tasks must be a non-empty array")?;
    if tasks.len() > MAX_TASKS {
        return Err(format!("at most {MAX_TASKS} tasks per call; split the list"));
    }
    let defaults = args.get("defaults").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut slots = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (index, task) in tasks.iter().enumerate() {
        let mut merged: Map<String, Value> = defaults.clone();
        if let Some(own) = task.as_object() {
            for (key, value) in own {
                merged.insert(key.clone(), value.clone());
            }
        }
        let fallback = format!("task-{}", index + 1);
        let mut name = merged.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).unwrap_or(&fallback).to_string();
        if !seen.insert(name.clone()) {
            name = format!("{name}-{}", index + 1);
            seen.insert(name.clone());
        }
        merged.insert("name".into(), json!(name));
        merged.insert("wait_ms".into(), json!(0));
        merged.insert("idempotency_key".into(), json!(format!("{batch_key}:{name}")));
        let review_by = merged.remove("review_by").filter(Value::is_object);
        let project = merged.get("project_path").cloned();
        slots.push(Slot { name, original: task.clone(), body: Value::Object(merged), review_by, project, state: State::Pending });
    }
    let wait_ms = args.get("wait_ms").and_then(Value::as_u64).unwrap_or(120_000).min(max_wait_ms);
    Ok(Plan {
        slots,
        until: Until::parse(args.get("until"))?,
        wait_ms,
        cancel_rest: args.get("cancel_rest").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn still_running(status: &str) -> bool {
    matches!(status, "running" | "queued" | "starting" | "cancelling")
}

fn status_of(value: &Value) -> &str {
    value.get("status").and_then(Value::as_str).unwrap_or_default()
}

fn succeeded(value: &Value) -> bool {
    status_of(value) == "completed"
}

impl Plan {
    fn running(&self) -> usize {
        self.slots.iter().filter(|s| matches!(s.state, State::Running(_))).count()
    }

    fn pending(&self) -> usize {
        self.slots.iter().filter(|s| matches!(s.state, State::Pending)).count()
    }

    fn decided(&self) -> bool {
        let finished = || self.slots.iter().filter_map(|s| if let State::Finished(v) = &s.state { Some(v) } else { None });
        match self.until {
            Until::All => false,
            Until::Any => finished().next().is_some(),
            Until::FirstSuccess => finished().any(succeeded),
        }
    }
}

/// Run the batch. `Err(Stop::Cancelled)` when the caller cancelled the tool call.
pub(super) fn run(mut plan: Plan, io: &mut dyn BatchIo) -> Result<Value, Stop> {
    let started = io.now_ms();
    let limit = io.limit().clamp(1, MAX_TASKS);
    let mut last_beat = started;
    let reason;
    loop {
        if io.cancelled() {
            return Err(Stop::Cancelled);
        }
        // Start what the limit allows (nothing new once the batch is decided).
        if !plan.decided() {
            for index in 0..plan.slots.len() {
                if plan.running() >= limit {
                    break;
                }
                if !matches!(plan.slots[index].state, State::Pending) {
                    continue;
                }
                start_slot(&mut plan, index, io);
                if plan.decided() {
                    break;
                }
            }
        }
        let decided = plan.decided();
        let nothing_left = plan.running() == 0 && (plan.pending() == 0 || decided);
        if nothing_left || (decided && plan.until != Until::All) {
            reason = match plan.until {
                Until::All => "all_finished",
                Until::Any => "any_finished",
                Until::FirstSuccess if decided => "first_success",
                Until::FirstSuccess => "no_success",
            };
            break;
        }
        let elapsed = io.now_ms().saturating_sub(started);
        if elapsed >= plan.wait_ms {
            reason = "timeout";
            break;
        }
        // Wait for the running helpers, one project at a time.
        let mut groups: Vec<(Option<Value>, Vec<String>)> = Vec::new();
        for slot in &plan.slots {
            if let State::Running(handle) = &slot.state {
                match groups.iter_mut().find(|(project, _)| *project == slot.project) {
                    Some((_, handles)) => handles.push(handle.clone()),
                    None => groups.push((slot.project.clone(), vec![handle.clone()])),
                }
            }
        }
        let slice = (plan.wait_ms - elapsed).clamp(1, SLICE_MS) / groups.len().max(1) as u64;
        let mut changed = false;
        for (project, handles) in &groups {
            match io.wait(project.as_ref(), handles, slice.max(250)) {
                Ok(views) => {
                    for view in views {
                        if still_running(status_of(&view)) {
                            continue;
                        }
                        let handle = view.get("handle").and_then(Value::as_str).unwrap_or_default().to_string();
                        if let Some(index) = plan.slots.iter().position(|s| matches!(&s.state, State::Running(h) if *h == handle)) {
                            finish_slot(&mut plan, index, view, io);
                            changed = true;
                        }
                    }
                }
                // A bridge hiccup must not lose the runs: hand back the last state.
                Err(_) => return Ok(answer(plan, "timeout", io.now_ms().saturating_sub(started), limit)),
            }
        }
        let now = io.now_ms();
        if now.saturating_sub(last_beat) >= BEAT_MS {
            io.progress(&format!("{} running, {} waiting ({}s)", plan.running(), plan.pending(), now.saturating_sub(started) / 1000));
            last_beat = now;
        }
        if !changed && groups.is_empty() {
            io.pause(250);
        }
    }
    if plan.cancel_rest && plan.until != Until::All {
        for index in 0..plan.slots.len() {
            let handle = match &plan.slots[index].state {
                State::Running(handle) => handle.clone(),
                _ => continue,
            };
            let project = plan.slots[index].project.clone();
            io.stop(project.as_ref(), &handle);
            plan.slots[index].state = State::Finished(json!({
                "handle": handle,
                "status": "cancelled",
                "note": "stopped: the batch was already decided",
            }));
        }
    }
    let waited = io.now_ms().saturating_sub(started);
    Ok(answer(plan, reason, waited, limit))
}

fn start_slot(plan: &mut Plan, index: usize, io: &mut dyn BatchIo) {
    let body = plan.slots[index].body.clone();
    if body.get("task").and_then(Value::as_str).is_none_or(|t| t.trim().is_empty()) {
        let error = json!({ "code": "INVALID_ARGUMENT", "message": "this task has no task text", "recoverable": false });
        plan.slots[index].state = State::Finished(json!({ "status": "not_started", "error": error }));
        return;
    }
    match io.start(&body) {
        Ok(view) => {
            let handle = view.get("handle").and_then(Value::as_str).map(str::to_string);
            match handle {
                Some(handle) if still_running(status_of(&view)) => plan.slots[index].state = State::Running(handle),
                _ => finish_slot(plan, index, view, io),
            }
        }
        Err(error) => plan.slots[index].state = State::Finished(json!({ "status": "not_started", "error": error })),
    }
}

fn finish_slot(plan: &mut Plan, index: usize, view: Value, io: &mut dyn BatchIo) {
    let slot = &plan.slots[index];
    let view = match (&slot.review_by, succeeded(&view)) {
        (Some(review_by), true) => io.review(view, review_by, slot.project.as_ref()),
        _ => view,
    };
    plan.slots[index].state = State::Finished(view);
}

/// One run in the combined answer: the fields a caller acts on, `result` capped to `cap` characters.
fn brief(slot: &Slot, view: &Value, cap: usize) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), json!(slot.name));
    for key in ["handle", "status", "verified", "resolved_model", "error", "prompt", "review", "note", "warnings"] {
        if let Some(value) = view.get(key).filter(|v| !v.is_null()) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(result) = view.get("result").and_then(Value::as_str) {
        let (text, cut) = cut_chars(result, cap);
        out.insert("result".into(), json!(text));
        if cut || view.get("result_truncated").and_then(Value::as_bool) == Some(true) {
            out.insert("result_truncated".into(), json!(true));
            if let Some(handle) = view.get("handle") {
                out.insert("more".into(), json!({ "tool": "agent_transcript", "args": { "handle": handle } }));
            }
        }
    }
    Value::Object(out)
}

fn cut_chars(text: &str, cap: usize) -> (String, bool) {
    if text.chars().count() <= cap {
        return (text.to_string(), false);
    }
    (text.chars().take(cap).collect(), true)
}

fn answer(plan: Plan, reason: &str, waited_ms: u64, limit: usize) -> Value {
    let share = (TOTAL_CAP / plan.slots.len().max(1)).clamp(MIN_SHARE, RESULT_CAP);
    let mut runs = Vec::new();
    let mut running = Vec::new();
    let mut unstarted = Vec::new();
    for slot in &plan.slots {
        match &slot.state {
            State::Finished(view) => runs.push(brief(slot, view, share)),
            State::Running(handle) => {
                running.push(handle.clone());
                runs.push(json!({ "name": slot.name, "handle": handle, "status": "running" }));
            }
            State::Pending => {
                unstarted.push(slot.original.clone());
                runs.push(json!({ "name": slot.name, "status": "not_started" }));
            }
        }
    }
    let mut out = json!({
        "runs": runs,
        "reason": reason,
        "waited_ms": waited_ms,
        "limit": limit,
    });
    let mut next = Map::new();
    if !running.is_empty() {
        next.insert("wait".into(), json!({ "tool": "wait_agents", "args": { "handles": running } }));
    }
    if !unstarted.is_empty() {
        out["queued"] = json!(unstarted.len());
        next.insert("start_rest".into(), json!({ "tool": "run_agents", "args": { "tasks": unstarted } }));
    }
    if !next.is_empty() {
        out["next"] = Value::Object(next);
    }
    out
}

#[cfg(test)]
#[path = "batch_tests.rs"]
mod tests;
