//! The real agent: one hidden, read-only, fresh-context helper run per question (the same path `quick_ask` uses), on
//! the person's own agent and plan. Generic code: the backend name comes from the person's choice and is never matched
//! here. The run is polled until it ends or the stop flag is set.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;

use super::run::{GuideAgent, Reply};

const POLL: Duration = Duration::from_millis(1500);
/// One ask may take this long (the helper path itself stops a run at five minutes).
const ASK_LIMIT: Duration = Duration::from_secs(6 * 60);

pub struct HelperAgent {
    app: tauri::AppHandle,
    registry: Arc<Mutex<crate::pty::PaneRegistry>>,
    backend: Option<String>,
    model: Option<String>,
}

impl HelperAgent {
    pub fn new(app: tauri::AppHandle, registry: Arc<Mutex<crate::pty::PaneRegistry>>, backend: Option<String>, model: Option<String>) -> Self {
        Self { app, registry, backend, model }
    }
}

impl GuideAgent for HelperAgent {
    fn label(&self) -> String {
        self.backend.clone().unwrap_or_else(|| "agent".into())
    }

    fn model(&self) -> Option<String> {
        self.model.clone()
    }

    fn ask(&self, task: &str, project: &Path, stop: &AtomicBool) -> Result<Reply, String> {
        let request: crate::agent_runs::quick::QuickAskRequest = serde_json::from_value(serde_json::json!({
            "task": task,
            "project_path": project.to_string_lossy(),
            "backend": self.backend,
            "model": self.model,
            "wait_ms": 20_000,
            "read_only": true,
        }))
        .map_err(|e| e.to_string())?;
        let answer = crate::agent_runs::quick::quick_ask(request, self.registry.clone(), self.app.clone(), None).map_err(|e| e.message.clone())?;
        if let Some(text) = answer.get("answer").and_then(Value::as_str) {
            return Ok(Reply { text: text.to_string(), tokens: tokens_of(&answer) });
        }
        // Still running: poll the run until it ends.
        let handle = answer.get("handle").and_then(Value::as_str).ok_or("The helper did not start.")?.to_string();
        let started = Instant::now();
        loop {
            if stop.load(Ordering::SeqCst) {
                return Err("stopped".into());
            }
            if started.elapsed() > ASK_LIMIT {
                return Err("The agent took too long.".into());
            }
            let snapshot = crate::operations::latest_agent_run(&project.to_string_lossy(), &handle).map_err(|e| e.message.clone())?;
            if snapshot.status.terminal() {
                return match (snapshot.status, snapshot.result) {
                    (crate::operations::OperationStatus::Completed, Some(text)) if !text.trim().is_empty() => Ok(Reply { text, tokens: None }),
                    _ => Err("The agent did not finish this step.".into()),
                };
            }
            std::thread::sleep(POLL);
        }
    }
}

/// Tokens from the receipt, when it names them.
fn tokens_of(answer: &Value) -> Option<u64> {
    let usage = answer.get("receipt")?.get("usage")?;
    let sum = ["input_tokens", "output_tokens"].iter().filter_map(|k| usage.get(*k).and_then(Value::as_u64)).sum::<u64>();
    (sum > 0).then_some(sum)
}
