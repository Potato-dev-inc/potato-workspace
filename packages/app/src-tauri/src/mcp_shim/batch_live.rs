//! `run_agents` against the running app: every task starts through the same `/agents/run` route as `run_agent`
//! (so the helper rules, lanes and checks are identical), is waited for with short `/agents/wait` slices, and can
//! get a second opinion through `/agents/review`. The engine is `batch`; this file only connects it.

use super::batch::{plan, run, BatchIo, Stop};
use super::*;
use std::sync::mpsc::Receiver;
use std::time::Instant;

struct Live<'a> {
    cancel_rx: Option<&'a Receiver<()>>,
    started: Instant,
}

fn error_value(text: String) -> Value {
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "code": "BRIDGE_ERROR", "message": text, "recoverable": true }))
}

impl BatchIo for Live<'_> {
    fn start(&mut self, body: &Value) -> Result<Value, Value> {
        let mut body = body.clone();
        // A helper started under a budget draws from it, like a run_agent call does.
        inject_budget_parent(&mut body, std::env::var(PARENT_RUN_ENV).ok());
        match bridge_request("POST", "/agents/run", Some(body)) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| json!({ "code": "BAD_RESPONSE", "message": e.to_string() })),
            Err(error) => Err(error_value(error)),
        }
    }

    fn wait(&mut self, project: Option<&Value>, handles: &[String], slice_ms: u64) -> Result<Vec<Value>, String> {
        let mut body = json!({ "handles": handles, "timeout_ms": slice_ms });
        if let Some(project) = project {
            body["project_path"] = project.clone();
        }
        let text = bridge_request_wait_agents(&body, self.cancel_rx)?;
        let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        Ok(value.get("agents").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    fn stop(&mut self, project: Option<&Value>, handle: &str) {
        let mut body = json!({ "handle": handle });
        if let Some(project) = project {
            body["project_path"] = project.clone();
        }
        // Stop the turn, then close the helper and its pane. Either may already be done: nothing to report.
        let _ = bridge_request("POST", "/agents/cancel", Some(body.clone()));
        let _ = bridge_request("POST", "/agents/close", Some(body));
    }

    fn review(&mut self, finished: Value, review_by: &Value, project: Option<&Value>) -> Value {
        let text = review::attach_review(finished.to_string(), Some(review_by), project, |request| {
            bridge_request("POST", "/agents/review", Some(request))
        });
        serde_json::from_str(&text).unwrap_or(finished)
    }

    fn limit(&mut self) -> usize {
        bridge_request("POST", "/agents/batch", Some(json!({})))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|v| v.get("limit").and_then(Value::as_u64))
            // An app that does not know the setting yet: the documented default.
            .unwrap_or(8) as usize
    }

    fn cancelled(&self) -> bool {
        call_cancelled() || self.cancel_rx.is_some_and(|rx| rx.try_recv().is_ok())
    }

    fn now_ms(&mut self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn pause(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn progress(&mut self, message: &str) {
        report_progress(message);
    }
}

/// The `run_agents` tool call.
pub(super) fn run_live(args: &Value, cancel_rx: Option<&Receiver<()>>) -> Result<String, String> {
    let mut body = args.clone();
    let key = ensure_stable_idempotency_key("run_agents", &mut body);
    let plan = plan(&body, &key, super::long_wait::MAX_EXTENDED_WAIT_MS).map_err(|message| {
        serde_json::to_string(&json!({ "code": "INVALID_ARGUMENT", "message": message, "recoverable": false, "retryable": false }))
            .unwrap_or(message)
    })?;
    let mut io = Live { cancel_rx, started: Instant::now() };
    match run(plan, &mut io) {
        Ok(value) => Ok(value.to_string()),
        Err(Stop::Cancelled) => Err(REQUEST_CANCELLED_JSON.into()),
    }
}
