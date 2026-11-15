//! The live world of Routines and Chains: the [`Io`] the engine talks to, and the few functions the commands call.
//!
//! - [`start`]: the `routines` thread (one tick every 5 seconds, plus a first one at once, which runs a schedule
//!   that came due while the computer was off).
//! - Starting an agent is `agent_runs::run_agent` (a visible pane that stays open), the same as every in-app run.
//!   A chat the person already has (a chain's trigger) is read through the chat session.
//! - Nothing here types into a pane or answers an agent's question.
//!
//! The engine holds all the rules (`engine.rs`) and is tested with a fake world.

use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

use super::engine::{ChatProbe, Engine, Io, SendFail, StartFail, Watch};
use super::model::{valid_id, NewWorkflow, Target};
use super::store::Store;
use super::view::{self, RoutinesView};
use crate::acp::chat;
use crate::acp::state::{Phase, StopKind};
use crate::agent_runs::persist::FollowupOpts;
use crate::agent_runs::AgentRunRequest;
use crate::operations::{self, OperationStatus};

type Registry = Arc<Mutex<crate::pty::PaneRegistry>>;

/// The Tauri event the Routines page listens to (the payload is not read).
pub const CHANGED_EVENT: &str = "routines://changed";
/// A line for the person: `{text, problem}`. The window shows it as a notice.
pub const NOTICE_EVENT: &str = "routines://notice";
const TICK: Duration = Duration::from_secs(5);

pub struct LiveIo {
    registry: Registry,
    app: tauri::AppHandle,
}

impl LiveIo {
    pub fn new(registry: Registry, app: tauri::AppHandle) -> Self {
        Self { registry, app }
    }
}

fn probe_of(pane_id: &str) -> Option<ChatProbe> {
    let session = chat::get(pane_id).filter(|c| !c.is_closed())?;
    let snap = session.session().snapshot();
    let working = matches!(snap.phase, Phase::Starting | Phase::Resuming | Phase::Working | Phase::NeedsInput | Phase::Cancelling);
    let done = if working { snap.turn.saturating_sub(1) } else { snap.turn };
    Some(ChatProbe { done_turns: done, working, ok: snap.last_stop == Some(StopKind::EndTurn) })
}

fn asking(pane_id: &str) -> bool {
    chat::get(pane_id).is_some_and(|c| c.session().snapshot().phase == Phase::NeedsInput)
}

impl Io for LiveIo {
    fn now_ms(&self) -> u64 {
        crate::questions::now_ms()
    }

    fn utc_offset_min(&self) -> i32 {
        chrono::Local::now().offset().local_minus_utc() / 60
    }

    fn running_agents(&self) -> usize {
        self.registry.lock().list().iter().filter(|pane| pane.status == "running").count()
    }

    fn start_agent(&self, agent: &str, project: &str, task: &str, separate_copy: bool, key: &str) -> Result<Target, StartFail> {
        let mut body = json!({
            "project_path": project,
            "task": task,
            "agent_type": agent,
            "headless": false,
            "background": true,
            "keep_pane": true,
            "wait_ms": 0,
            "idempotency_key": key,
        });
        if separate_copy {
            body["isolation"] = json!("worktree");
        }
        let request: AgentRunRequest = serde_json::from_value(body).map_err(|e| StartFail::Refused(e.to_string()))?;
        match crate::agent_runs::run_agent(request, self.registry.clone(), self.app.clone(), None) {
            Ok(view) => Ok(Target { project: project.to_string(), handle: view.handle, mark: 0 }),
            Err(error) if error.code == "MISSION_LIMIT" => Err(StartFail::NoSlot),
            Err(error) => Err(StartFail::Refused(error.message)),
        }
    }

    fn watch(&self, target: &Target) -> Watch {
        if target.project.is_empty() {
            // A chat the person has: its pane id is the handle.
            let Some(probe) = probe_of(&target.handle) else { return Watch::Gone };
            if probe.working {
                return if asking(&target.handle) { Watch::Asked } else { Watch::Working };
            }
            return if probe.done_turns > target.mark { Watch::Idle { ok: probe.ok } } else { Watch::Working };
        }
        match operations::latest_agent_run(&target.project, &target.handle) {
            Err(_) => Watch::Gone,
            Ok(op) => match op.status {
                OperationStatus::Completed => Watch::Idle { ok: true },
                OperationStatus::Failed => Watch::Failed(op.error.map(|e| e.message).unwrap_or_else(|| "The agent stopped with an error.".into())),
                OperationStatus::Cancelled => Watch::Failed("It was stopped before it finished.".into()),
                OperationStatus::WaitingInput => Watch::Asked,
                _ => Watch::Working,
            },
        }
    }

    fn turns_done(&self, target: &Target) -> u64 {
        if target.project.is_empty() {
            probe_of(&target.handle).map_or(0, |p| p.done_turns)
        } else {
            0
        }
    }

    fn send(&self, target: &Target, text: &str, key: &str) -> Result<(), SendFail> {
        if target.project.is_empty() {
            let Some(session) = chat::get(&target.handle) else { return Err(SendFail::Refused("The chat was closed.".into())) };
            return match session.send(text) {
                Ok(_) => Ok(()),
                Err(chat::SendError::Busy) => Err(SendFail::Busy),
                Err(chat::SendError::Gone) => Err(SendFail::Refused("The chat was closed.".into())),
                Err(chat::SendError::Refused(sentence)) => Err(SendFail::Refused(sentence)),
            };
        }
        let opts = FollowupOpts { background: true, wait_ms: Some(0), idempotency_key: Some(key.to_string()), ..Default::default() };
        crate::agent_runs::send_agent(&target.project, &target.handle, text.to_string(), None, self.registry.clone(), self.app.clone(), opts)
            .map(|_| ())
            .map_err(|e| SendFail::Refused(e.message))
    }

    fn chat_probe(&self, pane_id: &str) -> Option<ChatProbe> {
        probe_of(pane_id)
    }

    fn stop(&self, target: &Target) {
        if target.project.is_empty() {
            if let Some(session) = chat::get(&target.handle) {
                let _ = session.cancel();
            }
            return;
        }
        let _ = crate::agent_runs::cancel_agent(&target.project, &target.handle, None, self.registry.clone(), self.app.clone());
    }

    fn notify(&self, text: &str, problem: bool) {
        use tauri::Emitter;
        let _ = self.app.emit(NOTICE_EVENT, json!({ "text": text, "problem": problem }));
    }

    fn changed(&self) {
        use tauri::Emitter;
        let _ = self.app.emit(CHANGED_EVENT, ());
    }

    fn audit(&self, event: &str, summary: &str) {
        crate::audit::record(crate::audit::Kind::Routines, crate::audit::Who::Desktop, summary, json!({ "event": event }));
    }
}

// ------------------------------------------------------------------------------- the one engine

static ENGINE: OnceCell<Arc<Engine<LiveIo>>> = OnceCell::new();

#[cfg(not(test))]
fn live_store() -> Store {
    Store::live()
}

#[cfg(test)]
fn live_store() -> Store {
    Store::at(std::env::temp_dir().join(format!("pm-routines-live-{}", std::process::id())))
}

/// Starts the engine and its thread (one line in `lib.rs` setup). A second call does nothing.
pub fn start(registry: Registry, app: tauri::AppHandle) {
    let engine = Arc::new(Engine::new(LiveIo::new(registry, app), live_store()));
    if ENGINE.set(engine.clone()).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new().name("routines".into()).spawn(move || engine.run_loop(TICK));
    if let Err(error) = spawned {
        tracing::warn!(%error, "routines: could not start the scheduler");
    }
}

fn not_ready() -> String {
    "Potato Workspace is still starting.".to_string()
}

fn engine() -> Result<&'static Arc<Engine<LiveIo>>, String> {
    ENGINE.get().ok_or_else(not_ready)
}

/// What the page shows.
pub fn view() -> RoutinesView {
    match ENGINE.get() {
        Some(engine) => {
            let state = engine.snapshot();
            view::build(&state, engine.io().now_ms(), engine.io().utc_offset_min(), engine.io().running_agents())
        }
        None => view::build(&live_store().load(), crate::questions::now_ms(), 0, 0),
    }
}

pub fn create(new: NewWorkflow) -> Result<String, String> {
    let engine = engine()?;
    let id = engine.create(new)?;
    engine.tick(); // a chain on a chat that has just finished runs at once
    Ok(id)
}

fn check_workflow_id(id: &str) -> Result<(), String> {
    if valid_id("rt-", id) {
        Ok(())
    } else {
        Err("That routine is gone.".into())
    }
}

pub fn set_enabled(id: &str, on: bool) -> Result<(), String> {
    check_workflow_id(id)?;
    engine()?.set_enabled(id, on)
}

pub fn delete(id: &str) -> Result<(), String> {
    check_workflow_id(id)?;
    engine()?.delete(id)
}

pub fn run_now(id: &str) -> Result<String, String> {
    check_workflow_id(id)?;
    let engine = engine()?;
    let run = engine.run_now(id)?;
    engine.tick();
    Ok(run)
}

pub fn stop_run(run_id: &str) -> Result<(), String> {
    if !valid_id("rr-", run_id) {
        return Err("That run is gone.".into());
    }
    engine()?.stop_run(run_id)
}

pub fn set_limit(limit: Option<u32>) -> Result<(), String> {
    let engine = engine()?;
    engine.set_limit(limit);
    engine.tick(); // a raised limit lets waiting runs go at once
    Ok(())
}
