//! What the Routines page reads: plain camelCase data, words are made by the screen (so they can be translated).

use serde::Serialize;

use super::model::*;
use super::schedule;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StepView {
    /// `start_agent`, `wait`, `follow_up`, `notify`.
    pub kind: String,
    pub agent: Option<String>,
    pub project: Option<String>,
    pub text: Option<String>,
    pub separate_copy: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowView {
    pub id: String,
    pub name: String,
    /// `routine`, `chain` or `manual`.
    pub kind: String,
    pub enabled: bool,
    /// Days 1-7 (empty: every day) and `HH:MM`, for a routine.
    pub days: Vec<u8>,
    pub time: Option<String>,
    pub pane_id: Option<String>,
    pub only_if_ok: bool,
    pub steps: Vec<StepView>,
    pub next_ms: Option<u64>,
    pub last_run_ms: Option<u64>,
    pub last_result: Option<String>,
    /// Why it is off: `paused_failed`, `chat_gone`, `not_ok`, `ran_once`.
    pub paused_note: Option<String>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub id: String,
    pub workflow_id: String,
    pub name: String,
    pub state: String,
    pub step: usize,
    pub step_count: usize,
    pub note_code: Option<String>,
    pub note_detail: Option<String>,
    pub due_ms: Option<u64>,
    pub created_ms: u64,
    pub finished_ms: Option<u64>,
}

/// One run that waits for a free slot.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueRow {
    pub run_id: String,
    pub name: String,
    /// 1 is next.
    pub position: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutinesView {
    /// "At most N at once": `None` is off.
    pub limit: Option<u32>,
    /// Agents running now (the number the queue line says).
    pub running: usize,
    pub workflows: Vec<WorkflowView>,
    pub queue: Vec<QueueRow>,
    pub runs: Vec<RunView>,
}

pub fn build(state: &State, now: u64, offset_min: i32, running: usize) -> RoutinesView {
    let workflows = state.workflows.iter().map(|w| workflow_view(w, state, now, offset_min)).collect();
    let mut waiting: Vec<&Run> = state.runs.iter().filter(|r| r.state == RunState::Waiting).collect();
    waiting.sort_by_key(|r| r.seq);
    let queue = waiting
        .iter()
        .enumerate()
        .map(|(i, r)| QueueRow { run_id: r.id.clone(), name: r.workflow_name.clone(), position: i + 1 })
        .collect();
    RoutinesView {
        limit: state.config.max_at_once,
        running,
        workflows,
        queue,
        runs: state.runs.iter().map(run_view).collect(),
    }
}

fn run_view(r: &Run) -> RunView {
    RunView {
        id: r.id.clone(),
        workflow_id: r.workflow_id.clone(),
        name: r.workflow_name.clone(),
        state: r.state.tag().to_string(),
        step: r.step,
        step_count: r.steps.len(),
        note_code: r.note_code.clone(),
        note_detail: r.note_detail.clone(),
        due_ms: r.due_ms,
        created_ms: r.created_ms,
        finished_ms: r.finished_ms,
    }
}

fn workflow_view(w: &Workflow, state: &State, now: u64, offset_min: i32) -> WorkflowView {
    let (kind, days, time, pane_id, only_if_ok) = match &w.trigger {
        Trigger::Manual => ("manual", Vec::new(), None, None, false),
        Trigger::Schedule { days, time } => ("routine", days.clone(), Some(time.clone()), None, false),
        Trigger::ChatFinished { pane_id, only_if_ok } => ("chain", Vec::new(), None, Some(pane_id.clone()), *only_if_ok),
    };
    let next_ms = match &w.trigger {
        Trigger::Schedule { days, time } if w.enabled => schedule::next_after(days, time, now, offset_min),
        _ => None,
    };
    WorkflowView {
        id: w.id.clone(),
        name: w.name.clone(),
        kind: kind.to_string(),
        enabled: w.enabled,
        days,
        time,
        pane_id,
        only_if_ok,
        steps: w.steps.iter().map(step_view).collect(),
        next_ms,
        last_run_ms: w.last_run_ms,
        last_result: w.last_result.clone(),
        paused_note: w.paused_note.clone(),
        running: state.runs.iter().any(|r| r.workflow_id == w.id && r.state.is_open()),
    }
}

fn step_view(step: &Step) -> StepView {
    let blank = StepView { kind: String::new(), agent: None, project: None, text: None, separate_copy: false };
    match step {
        Step::StartAgent { agent, project, task, separate_copy } => StepView {
            kind: "start_agent".into(),
            agent: Some(agent.clone()),
            project: Some(project.clone()),
            text: Some(task.clone()),
            separate_copy: *separate_copy,
            ..blank
        },
        Step::Wait => StepView { kind: "wait".into(), ..blank },
        Step::FollowUp { text } => StepView { kind: "follow_up".into(), text: Some(text.clone()), ..blank },
        Step::Notify { text } => StepView { kind: "notify".into(), text: Some(text.clone()), ..blank },
    }
}
