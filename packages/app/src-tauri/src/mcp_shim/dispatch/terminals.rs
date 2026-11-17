//! The agent background terminals (`start_terminal`, `read_terminal`, `wait_terminal`, `stop_terminal`): one bridge request
//! each (`bridge/routes/terminals.rs` decides who may ask and asks the person). A wait longer than one request may last is
//! kept inside this call with several requests, each carrying the cursor of the last, so no line is read twice or lost.

use super::super::*;
use std::sync::mpsc::Receiver;
use std::time::Instant;

/// The longest one request waits (the bridge reads up to this plus a margin).
const SLICE_MS: u64 = 120_000;
/// The longest wait a caller may ask for.
const MAX_WAIT_MS: u64 = 3_600_000;
/// Lines kept from a long wait.
const KEEP_LINES: usize = 200;

pub(super) fn dispatch(name: &str, args: &Value, cancel_rx: Option<&Receiver<()>>) -> Option<Result<String, String>> {
    Some(match name {
        "start_terminal" => bridge_request("POST", "/terminals/start", Some(args.clone())),
        "read_terminal" => bridge_request("POST", "/terminals/read", Some(args.clone())),
        "stop_terminal" => bridge_request("POST", "/terminals/stop", Some(args.clone())),
        "wait_terminal" => wait(args, cancel_rx),
        _ => return None,
    })
}

fn wait(args: &Value, cancel_rx: Option<&Receiver<()>>) -> Result<String, String> {
    let total = args.get("timeout_ms").and_then(Value::as_u64).unwrap_or(60_000).min(MAX_WAIT_MS);
    let started = Instant::now();
    let mut body = args.clone();
    let mut lines: Vec<Value> = Vec::new();
    loop {
        if cancel_rx.is_some_and(|rx| rx.try_recv().is_ok()) || call_cancelled() {
            return Err(REQUEST_CANCELLED_JSON.into());
        }
        let remaining = total.saturating_sub(started.elapsed().as_millis() as u64);
        body["timeout_ms"] = json!(remaining.min(SLICE_MS));
        let text = bridge_request("POST", "/terminals/wait", Some(body.clone()))?;
        let Ok(mut answer) = serde_json::from_str::<Value>(&text) else { return Ok(text) };
        if let Some(new) = answer.get("lines").and_then(Value::as_array) {
            lines.extend(new.iter().cloned());
            let extra = lines.len().saturating_sub(KEEP_LINES);
            lines.drain(..extra);
        }
        let timed_out = answer.get("reason").and_then(Value::as_str) == Some("timeout");
        if !timed_out || remaining <= SLICE_MS {
            answer["lines"] = json!(lines);
            return Ok(answer.to_string());
        }
        if let Some(cursor) = answer.get("next_cursor").cloned() {
            body["after_cursor"] = cursor;
        }
    }
}
