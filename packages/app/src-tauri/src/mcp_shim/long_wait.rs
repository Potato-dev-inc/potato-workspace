//! One-call "launch and wait" for `run_agent` / `followup_task`.
//!
//! The bridge caps one request at 300 s. A caller may ask for up to one hour with `wait_ms`: the first
//! request carries at most the cap (so nothing changes for waits within it), and while the turn is still
//! running the shim keeps waiting inside the same tool call with short `/agents/wait` slices. It only
//! waits; it never starts a second turn. Hosts such as Claude Code move a long call to the background and
//! hand the result to the model when it ends, and `notifications/progress` keeps the call alive.

use super::*;
use std::sync::mpsc::Receiver;
use std::time::Instant;

/// The most the bridge accepts for one request (older and current apps reject larger).
pub(crate) const BRIDGE_WAIT_CAP_MS: u64 = 300_000;
/// The longest `wait_ms` a caller may ask for.
pub(crate) const MAX_EXTENDED_WAIT_MS: u64 = 3_600_000;

/// The timing knobs; tests shrink them.
#[derive(Clone, Copy)]
struct Limits {
    cap_ms: u64,
    slice_ms: u64,
    beat: Duration,
    min_gap: Duration,
}

const LIVE: Limits = Limits {
    cap_ms: BRIDGE_WAIT_CAP_MS,
    slice_ms: 4_000,
    beat: Duration::from_secs(15),
    min_gap: Duration::from_millis(250),
};

/// Statuses that mean the turn is still going. Anything else (completed, failed, cancelled, needs_input,
/// waiting_input, timeout, interrupted, closed) ends the wait.
fn still_running(status: &str) -> bool {
    matches!(status, "running" | "queued" | "starting" | "cancelling")
}

/// Posts `body` to `path` and, when `wait_ms` asks for more than the bridge cap and the turn is still
/// running, keeps waiting in this call. Without a larger `wait_ms` this is exactly one bridge request.
pub(super) fn launch_and_wait(
    path: &str,
    body: Value,
    cancel_rx: Option<&Receiver<()>>,
) -> Result<String, String> {
    launch_and_wait_with(
        path,
        body,
        cancel_rx,
        LIVE,
        |first| match bridge_request("POST", path, Some(first.clone())) {
            Ok(response) => Ok(response),
            Err(error) => Err(wait_timeout_recovery(path, first, error)),
        },
        |wait_body| bridge_request_wait_agents(wait_body, cancel_rx),
    )
}

fn launch_and_wait_with<P, W>(
    _path: &str,
    body: Value,
    cancel_rx: Option<&Receiver<()>>,
    limits: Limits,
    mut post: P,
    mut wait: W,
) -> Result<String, String>
where
    P: FnMut(&Value) -> Result<String, String>,
    W: FnMut(&Value) -> Result<String, String>,
{
    let started = Instant::now();
    let requested = body
        .get("wait_ms")
        .and_then(Value::as_u64)
        .map(|ms| ms.min(MAX_EXTENDED_WAIT_MS));
    let mut first = body.clone();
    if let Some(ms) = requested {
        first["wait_ms"] = json!(ms.min(limits.cap_ms));
    }
    let response = post(&first)?;
    let Some(requested) = requested.filter(|ms| *ms > limits.cap_ms) else {
        return Ok(response);
    };
    let Ok(mut result) = serde_json::from_str::<Value>(&response) else {
        return Ok(response);
    };
    let Some(handle) = result.get("handle").and_then(Value::as_str).map(str::to_owned) else {
        return Ok(response);
    };
    if !result.get("status").and_then(Value::as_str).is_some_and(still_running) {
        return Ok(response);
    }

    let deadline = started + Duration::from_millis(requested);
    let cursor = result.get("revision").and_then(Value::as_u64);
    let mut last_beat = Instant::now();
    let mut fast_rounds = 0_u32;
    let mut settled = false;
    loop {
        if cancel_rx.is_some_and(|rx| rx.try_recv().is_ok()) || call_cancelled() {
            return Err(REQUEST_CANCELLED_JSON.into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now()).as_millis() as u64;
        if remaining == 0 {
            break;
        }
        let mut wait_body = json!({
            "handles": [handle],
            "timeout_ms": remaining.clamp(1, limits.slice_ms),
        });
        if let Some(project) = body.get("project_path").cloned() {
            wait_body["project_path"] = project;
        }
        if let Some(cursor) = cursor {
            wait_body["after_cursor"] = json!(cursor);
        }
        let slice_started = Instant::now();
        let slice = match wait(&wait_body) {
            Ok(text) => text,
            Err(error) if error == REQUEST_CANCELLED_JSON => return Err(error),
            // A bridge hiccup must not lose the run: hand back the last state with its watch_command.
            Err(_) => break,
        };
        let value: Value = serde_json::from_str(&slice).unwrap_or(Value::Null);
        let entry = value
            .get("agents")
            .and_then(Value::as_array)
            .and_then(|agents| {
                agents
                    .iter()
                    .find(|agent| agent.get("handle").and_then(Value::as_str) == Some(handle.as_str()))
                    .or_else(|| agents.first())
            })
            .cloned();
        if let Some(entry) = entry {
            let running = entry.get("status").and_then(Value::as_str).is_some_and(still_running);
            merge_entry(&mut result, &entry);
            if !running {
                settled = true;
                break;
            }
        }
        if last_beat.elapsed() >= limits.beat {
            report_progress(&format!("still running ({}s)", started.elapsed().as_secs()));
            last_beat = Instant::now();
        }
        // A slice that comes back fast must not turn this into a hot loop.
        let elapsed = slice_started.elapsed();
        if elapsed < limits.min_gap {
            fast_rounds = fast_rounds.saturating_add(1);
            let gap = limits
                .min_gap
                .saturating_mul(1u32 << (fast_rounds - 1).min(4))
                .min(Duration::from_millis(limits.slice_ms));
            let pause = gap
                .saturating_sub(elapsed)
                .min(deadline.saturating_duration_since(Instant::now()));
            if pause > Duration::ZERO {
                std::thread::sleep(pause);
            }
        } else {
            fast_rounds = 0;
        }
    }
    if let Some(object) = result.as_object_mut() {
        if settled {
            object.remove("watch_command");
        }
        object.insert("waited_ms".into(), json!(started.elapsed().as_millis() as u64));
        object.insert("wait_extended".into(), json!(true));
    }
    Ok(result.to_string())
}

/// Lays the wait entry's fields over the run response, keeping run-only fields (lane_used, fallback, ...).
fn merge_entry(result: &mut Value, entry: &Value) {
    let (Some(target), Some(entry)) = (result.as_object_mut(), entry.as_object()) else {
        return;
    };
    let unchanged = entry.get("result_unchanged").and_then(Value::as_bool) == Some(true);
    for (key, value) in entry {
        if key == "result" && unchanged && value.is_null() {
            continue;
        }
        target.insert(key.clone(), value.clone());
    }
}

#[cfg(test)]
#[path = "long_wait_tests.rs"]
mod tests;
