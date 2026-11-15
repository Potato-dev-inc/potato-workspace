//! The data of a workflow and its runs. Everything here is plain serde data with defaults, so an older
//! file keeps loading when a field is added later.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The format of one workflow (`Workflow::v`). A node editor migrates from this number.
pub const WORKFLOW_VERSION: u32 = 1;
/// The format of the saved file.
pub const FILE_VERSION: u32 = 1;
pub const NAME_MAX: usize = 60;
pub const TEXT_MAX: usize = 4000;
pub const STEPS_MAX: usize = 12;
pub const WORKFLOWS_MAX: usize = 50;
/// Finished runs kept in the list.
pub const RUNS_KEPT: usize = 30;
/// "At most N at once" is clamped to this.
pub const LIMIT_MAX: u32 = 32;
/// A routine that fails this many times in a row pauses itself.
pub const PAUSE_AFTER_FAILS: u32 = 2;
/// A wait that lasts longer than this ends the run (an agent that waits for an answer nobody gives).
pub const WAIT_LIMIT_MS: u64 = 60 * 60 * 1000;
/// A due time older than this counts as "ran late" (the computer was off or asleep).
pub const LATE_AFTER_MS: u64 = 3 * 60 * 1000;

/// What starts a workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    /// Only "Run now".
    Manual,
    /// A time of day on some days. `days` are 1 (Monday) to 7 (Sunday); empty means every day. `time` is `HH:MM`
    /// on this computer's clock.
    Schedule {
        #[serde(default)]
        days: Vec<u8>,
        time: String,
    },
    /// A chat (its pane id) finished a turn. `only_if_ok`: skip it when the turn did not end well.
    ChatFinished {
        pane_id: String,
        #[serde(default)]
        only_if_ok: bool,
    },
}

/// One thing a workflow does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    /// Start an agent in a folder with a task. It becomes the run's agent for the steps that follow.
    StartAgent {
        agent: String,
        project: String,
        task: String,
        /// Work in a separate copy of the folder, so nothing changes until the person keeps it.
        #[serde(default)]
        separate_copy: bool,
    },
    /// Wait until the run's agent (or chat) has finished its turn.
    Wait,
    /// Send text to the run's agent (or chat), once it is idle.
    FollowUp { text: String },
    /// Tell the person.
    Notify { text: String },
}

/// A routine, a chain or a manual workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workflow {
    #[serde(default = "version_now")]
    pub v: u32,
    pub id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub trigger: Trigger,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub created_ms: u64,
    /// The schedule time (UTC ms) this workflow last ran for. A due time is never run twice.
    #[serde(default)]
    pub last_due_ms: u64,
    /// When it last started, for the list.
    #[serde(default)]
    pub last_run_ms: Option<u64>,
    /// How the last run ended (`done`, `failed`, `stopped`, `skipped`).
    #[serde(default)]
    pub last_result: Option<String>,
    /// Failed runs in a row.
    #[serde(default)]
    pub fail_streak: u32,
    /// Why it is off, in plain words (paused after failures, a chain that already ran).
    #[serde(default)]
    pub paused_note: Option<String>,
    /// A chat trigger: the finished turns that were already counted when it was made.
    #[serde(default)]
    pub seen_turns: u64,
}

fn version_now() -> u32 {
    WORKFLOW_VERSION
}

fn yes() -> bool {
    true
}

impl Workflow {
    pub fn is_routine(&self) -> bool {
        matches!(self.trigger, Trigger::Schedule { .. })
    }
}

/// What the person fills in (the form, or the "Then..." sheet). The engine makes the id and the clocks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewWorkflow {
    pub name: String,
    pub trigger: Trigger,
    pub steps: Vec<Step>,
}

/// Where a run is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Over the "at most N" limit: waiting for a free slot.
    Waiting,
    Running,
    Done,
    Failed,
    Stopped,
    /// A chain whose chat did not end well.
    Skipped,
}

impl RunState {
    pub fn is_open(self) -> bool {
        matches!(self, RunState::Waiting | RunState::Running)
    }

    pub fn tag(self) -> &'static str {
        match self {
            RunState::Waiting => "waiting",
            RunState::Running => "running",
            RunState::Done => "done",
            RunState::Failed => "failed",
            RunState::Stopped => "stopped",
            RunState::Skipped => "skipped",
        }
    }
}

/// The agent or chat a run is working with. `handle` is an agent run's handle, or a chat's pane id.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Target {
    #[serde(default)]
    pub project: String,
    pub handle: String,
    /// Finished turns that do not count as "the" answer (taken when a follow-up is sent).
    #[serde(default)]
    pub mark: u64,
}

/// One go of a workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub workflow_id: String,
    pub workflow_name: String,
    pub state: RunState,
    /// The step in progress (an index into `steps`, which are the workflow's steps as they were at the start).
    #[serde(default)]
    pub step: usize,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub target: Option<Target>,
    pub created_ms: u64,
    #[serde(default)]
    pub finished_ms: Option<u64>,
    /// When the current step began (the wait limit counts from here).
    #[serde(default)]
    pub step_ms: u64,
    /// Why it ended or what it waits for, as a code the screen words (`late`, `asked`, `app_closed`, `timeout`,
    /// `stopped`, `chat_gone`, `unfinished`, `not_ok`, `refused`, `failed`).
    #[serde(default)]
    pub note_code: Option<String>,
    /// The plain sentence an agent or the app gave with a `refused` or `failed` end.
    #[serde(default)]
    pub note_detail: Option<String>,
    /// A schedule run: the time it was due for (the "ran late" line says when).
    #[serde(default)]
    pub due_ms: Option<u64>,
    /// Waiting runs go in this order (oldest first).
    #[serde(default)]
    pub seq: u64,
}

/// The global limit and other settings of the engine.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Config {
    /// "At most N agents at once". `None`: off.
    #[serde(default)]
    pub max_at_once: Option<u32>,
}

/// The saved file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    #[serde(default = "file_version")]
    pub version: u32,
    #[serde(default)]
    pub config: Config,
    #[serde(default)]
    pub workflows: Vec<Workflow>,
    /// Newest first.
    #[serde(default)]
    pub runs: Vec<Run>,
    #[serde(default)]
    pub next_seq: u64,
}

fn file_version() -> u32 {
    FILE_VERSION
}

impl Default for State {
    fn default() -> Self {
        State { version: FILE_VERSION, config: Config::default(), workflows: Vec::new(), runs: Vec::new(), next_seq: 0 }
    }
}

pub fn new_workflow_id() -> String {
    format!("rt-{}", &Uuid::new_v4().simple().to_string()[..8])
}

pub fn new_run_id() -> String {
    format!("rr-{}", &Uuid::new_v4().simple().to_string()[..8])
}

/// `HH:MM` as minutes after midnight.
pub fn parse_hhmm(text: &str) -> Option<u32> {
    let (h, m) = text.trim().split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Checks what the person filled in. The sentence is for the form.
pub fn validate(new: &NewWorkflow) -> Result<(), String> {
    let name = new.name.trim();
    if name.is_empty() {
        return Err("Give it a name.".into());
    }
    if name.chars().count() > NAME_MAX {
        return Err(format!("The name can be at most {NAME_MAX} letters."));
    }
    if new.steps.is_empty() {
        return Err("Add at least one step.".into());
    }
    if new.steps.len() > STEPS_MAX {
        return Err(format!("A workflow can have at most {STEPS_MAX} steps."));
    }
    match &new.trigger {
        Trigger::Manual => {}
        Trigger::Schedule { days, time } => {
            if parse_hhmm(time).is_none() {
                return Err("Pick a time like 09:00.".into());
            }
            if days.iter().any(|d| !(1..=7).contains(d)) {
                return Err("Pick days from Monday to Sunday.".into());
            }
        }
        Trigger::ChatFinished { pane_id, .. } => {
            if pane_id.trim().is_empty() || pane_id.len() > 200 {
                return Err("Pick the chat to wait for.".into());
            }
        }
    }
    for step in &new.steps {
        match step {
            Step::StartAgent { agent, project, task, .. } => {
                if agent.trim().is_empty() {
                    return Err("Pick an agent.".into());
                }
                if project.trim().is_empty() {
                    return Err("Pick a project.".into());
                }
                text_ok(task, "Write the task.")?;
            }
            Step::FollowUp { text } => text_ok(text, "Write the message to send.")?,
            Step::Notify { text } => text_ok(text, "Write what to tell you.")?,
            Step::Wait => {}
        }
    }
    // A step that waits for an agent, or writes to one, needs one: a chain has its chat, a routine must start one.
    let mut has_agent = matches!(new.trigger, Trigger::ChatFinished { .. });
    for step in &new.steps {
        match step {
            Step::StartAgent { .. } => has_agent = true,
            Step::Wait | Step::FollowUp { .. } if !has_agent => {
                return Err("Start an agent before a step that waits for it or writes to it.".into());
            }
            _ => {}
        }
    }
    Ok(())
}

fn text_ok(text: &str, empty: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(empty.into());
    }
    if text.chars().count() > TEXT_MAX {
        return Err(format!("Keep it under {TEXT_MAX} letters."));
    }
    Ok(())
}

/// An id from outside (a command argument) is only accepted in the shapes the engine makes.
pub fn valid_id(prefix: &str, id: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|rest| rest.len() == 8 && rest.chars().all(|c| c.is_ascii_hexdigit()))
}
