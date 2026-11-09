//! Long-poll waits that stream `notifications/progress` while a tool call is blocked.

use super::*;
use puppet_master_app_lib::wait_reasons;

/// The shortest gap between two wait requests when a slice comes back early. A bridge that answers instantly
/// with a non-final reason must not turn the tool program into a hot loop.
const MIN_REQUEST_GAP: Duration = Duration::from_millis(250);
/// The longest that gap grows to: a normal 4-second long poll is never slowed down.
const MAX_REQUEST_GAP: Duration = Duration::from_millis(4_000);

pub(crate) fn call_tool_with_progress(
    params: Value,
    cancel: Option<std::sync::mpsc::Receiver<()>>,
    token: Option<Value>,
    notifications: Option<std::sync::mpsc::Sender<String>>,
) -> Result<Value, String> {
    // The restart wait reports through this sink; the wait loops below still send their own progress.
    let sink = ProgressSink::from_parts(token.clone(), notifications.clone());
    let context = CallContext { sink: sink.clone(), cancelled: None };
    with_call_context(context, || call_tool_with_progress_inner(params, cancel, token, notifications, sink))
}

fn call_tool_with_progress_inner(
    params: Value,
    cancel: Option<std::sync::mpsc::Receiver<()>>,
    token: Option<Value>,
    notifications: Option<std::sync::mpsc::Sender<String>>,
    sink: Option<ProgressSink>,
) -> Result<Value, String> {
    if let Some(name) = params.get("name").and_then(Value::as_str) {
        ensure_tool_mode(name)?;
    }
    let tool_name = params.get("name").and_then(Value::as_str);
    if tool_name == Some("ask_user") {
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        return ask_user::run(&args, cancel.as_ref(), token.as_ref(), notifications.as_ref())
            .map(ask_user::wrap);
    }
    if !matches!(tool_name, Some("wait_for_operation") | Some("wait_agents")) {
        return call_tool_with_sink(params, cancel, sink);
    }
    if tool_name == Some("wait_agents") {
        return call_wait_agents_with_progress(params, cancel, token, notifications);
    }
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let id = required_string(&args, "operation_id")?;
    let timeout_ms = optional_number(&args, "timeout_ms").unwrap_or(120_000);
    let mut revision = optional_number(&args, "after_revision").unwrap_or(0);
    let until = args
        .get("until")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let project = args
        .get("project_path")
        .and_then(Value::as_str)
        .map(|p| format!("?project_path={}", encode_path_segment(p)))
        .unwrap_or_default();
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if cancel.as_ref().is_some_and(|rx| rx.try_recv().is_ok()) {
            return Err(REQUEST_CANCELLED_JSON.into());
        }
        let remaining = deadline
            .saturating_duration_since(std::time::Instant::now())
            .as_millis() as u64;
        let mut body = json!({ "after_revision": revision, "timeout_ms": remaining.min(4_000) });
        if let Some(path) = args.get("project_path").cloned() {
            body["project_path"] = path;
        }
        let response = bridge_request(
            "POST",
            &format!("/operations/{}/wait{}", encode_path_segment(&id), project),
            Some(body),
        )?;
        let value: Value = serde_json::from_str(&response)
            .map_err(|e| format!("invalid operation wait response: {e}"))?;
        let snapshot = value.get("snapshot").unwrap_or(&value);
        let next = snapshot
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(revision);
        let status = snapshot
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if next > revision || matches!(status, "completed" | "failed" | "cancelled") {
            let notification = json!({"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":token,"progress":next,"message":snapshot}}).to_string();
            if let (Some(sender), Some(_progress_token)) = (&notifications, &token) {
                let _ = sender.send(notification);
            }
        }
        revision = next;
        let matched_state = until
            .iter()
            .any(|candidate| candidate.as_str() == Some(status));
        if matches!(status, "completed" | "failed" | "cancelled")
            || matched_state
            || std::time::Instant::now() >= deadline
        {
            let mut result = value.clone();
            if matched_state {
                result["reason"] = json!("matched_state");
            }
            return Ok(
                json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&result).unwrap_or(response)}],"structuredContent":result}),
            );
        }
    }
}

pub(crate) fn call_wait_agents_with_progress(
    params: Value,
    cancel: Option<std::sync::mpsc::Receiver<()>>,
    token: Option<Value>,
    notifications: Option<std::sync::mpsc::Sender<String>>,
) -> Result<Value, String> {
    call_wait_agents_with(params, cancel, token, notifications, |body| {
        bridge_request("POST", "/agents/wait", Some(body.clone()))
    })
}

/// The loop over bridge slices. `request` is a seam so tests can drive it without a real bridge.
fn call_wait_agents_with<F>(
    params: Value,
    cancel: Option<std::sync::mpsc::Receiver<()>>,
    token: Option<Value>,
    notifications: Option<std::sync::mpsc::Sender<String>>,
    mut request: F,
) -> Result<Value, String>
where
    F: FnMut(&Value) -> Result<String, String>,
{
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let timeout_ms = optional_number(&args, "timeout_ms").unwrap_or(DEFAULT_AGENT_WAIT_MS);
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut body = args.clone();
    let mut chunk = 0_u64;
    let mut fast_rounds = 0_u32;
    loop {
        if cancel.as_ref().is_some_and(|rx| rx.try_recv().is_ok()) {
            return Err(REQUEST_CANCELLED_JSON.into());
        }
        let remaining = deadline
            .saturating_duration_since(std::time::Instant::now())
            .as_millis() as u64;
        body["timeout_ms"] = json!(remaining.clamp(1, 4_000));
        let slice_started = std::time::Instant::now();
        let response = request(&body)?;
        let value: Value = serde_json::from_str(&response)
            .map_err(|e| format!("invalid wait_agents response: {e}"))?;
        chunk += 1;
        if let (Some(sender), Some(_progress_token)) = (&notifications, &token) {
            let notification = json!({
                "jsonrpc":"2.0",
                "method":"notifications/progress",
                "params":{"progressToken":token,"progress":chunk,"message":value}
            })
            .to_string();
            let _ = sender.send(notification);
        }
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // A per-chunk "timeout" only means this 4s slice elapsed; the overall deadline decides. `status` is the
        // word an older app used for a matched state (see `wait_reasons`), so it still ends the wait.
        let terminal = wait_reasons::wakes(reason);
        let agents = value.get("agents").and_then(Value::as_array);
        let any_needs_input = agents.is_some_and(|list| {
            list.iter().any(|agent| {
                agent
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s == "needs_input" || s == "waiting_input")
            })
        });
        if terminal || any_needs_input || std::time::Instant::now() >= deadline {
            // The bridge only saw the last <=4s slice; report the caller's whole wait instead.
            let mut value = value;
            if let Some(object) = value.as_object_mut() {
                object.insert("requested_wait_ms".into(), json!(timeout_ms));
                object.insert(
                    "waited_ms".into(),
                    json!(timeout_ms.saturating_sub(
                        deadline
                            .saturating_duration_since(std::time::Instant::now())
                            .as_millis() as u64
                    )),
                );
            }
            return Ok(
                json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&value).unwrap_or(response)}],"structuredContent":value}),
            );
        }
        // The slice ended without finishing. If it came back fast, pause before asking again; a normal long poll
        // (about 4 seconds) leaves the gap at zero.
        let elapsed = slice_started.elapsed();
        if elapsed < MIN_REQUEST_GAP {
            fast_rounds = fast_rounds.saturating_add(1);
            let gap = MIN_REQUEST_GAP
                .saturating_mul(1u32 << (fast_rounds - 1).min(4))
                .min(MAX_REQUEST_GAP);
            let pause = gap.saturating_sub(elapsed);
            if pause > Duration::ZERO {
                std::thread::sleep(pause);
            }
        } else {
            fast_rounds = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn params(timeout_ms: u64) -> Value {
        json!({"name": "wait_agents", "arguments": {"handles": ["h1"], "timeout_ms": timeout_ms}})
    }

    /// Runs the wait against a scripted bridge. `answers` is consumed in order; the last one repeats.
    fn run(answers: Vec<Value>, timeout_ms: u64) -> (Value, usize, std::time::Duration) {
        let started = Instant::now();
        let mut calls = 0usize;
        let result = call_wait_agents_with(
            params(timeout_ms),
            None,
            None,
            None,
            |_body| {
                let answer = answers.get(calls).or_else(|| answers.last()).expect("an answer");
                calls += 1;
                Ok(answer.to_string())
            },
        )
        .expect("the wait succeeds");
        let structured = result.get("structuredContent").cloned().unwrap_or(Value::Null);
        (structured, calls, started.elapsed())
    }

    /// A slice that did not finish.
    fn unfinished(reason: &str) -> Value {
        json!({"agents": [{"status": "running"}], "reason": reason})
    }

    /// A slice that finished.
    fn finished(reason: &str) -> Value {
        json!({"agents": [{"status": "completed", "result": "pong"}], "reason": reason})
    }

    #[test]
    fn a_finished_chat_helper_returns_on_the_first_request() {
        for reason in ["matched_state", "status", "terminal"] {
            let (value, calls, _) = run(vec![finished(reason)], 5_000);
            assert_eq!(calls, 1, "{reason}");
            assert_eq!(value["agents"][0]["result"], "pong", "{reason}");
        }
    }

    #[test]
    fn a_progress_wake_returns_to_the_caller_once() {
        let (value, calls, _) = run(vec![unfinished("revision_changed")], 5_000);
        assert_eq!(calls, 1);
        assert_eq!(value["reason"], "revision_changed");
    }

    #[test]
    fn timeout_keeps_waiting_but_never_spins_and_the_deadline_ends_it() {
        let (value, calls, elapsed) = run(vec![unfinished("timeout")], 600);
        assert_eq!(value["reason"], "timeout");
        assert!(calls <= 5, "{calls} requests in 600 ms");
        assert!(elapsed >= Duration::from_millis(550), "{elapsed:?}");
    }

    #[test]
    fn background_keeps_waiting_but_never_spins() {
        let (value, calls, elapsed) = run(vec![unfinished("background")], 600);
        assert_eq!(value["reason"], "background");
        assert!(calls <= 5, "{calls} requests in 600 ms");
        assert!(elapsed >= Duration::from_millis(550), "{elapsed:?}");
    }

    #[test]
    fn background_then_the_real_reply_returns_the_reply_once() {
        let (value, calls, _) = run(vec![unfinished("background"), finished("matched_state")], 5_000);
        assert_eq!(calls, 2);
        assert_eq!(value["agents"][0]["result"], "pong");
        assert_eq!(value["reason"], "matched_state");
    }

    #[test]
    fn a_slow_slice_is_not_delayed_further() {
        // The fake pauses like a real 4-second long poll would; the backoff must not add to it.
        let started = Instant::now();
        let mut calls = 0usize;
        let result = call_wait_agents_with(params(400), None, None, None, |_body| {
            calls += 1;
            if calls == 1 {
                std::thread::sleep(Duration::from_millis(120));
            }
            Ok(finished("matched_state").to_string())
        })
        .expect("the wait succeeds");
        assert_eq!(calls, 1);
        assert!(started.elapsed() < Duration::from_millis(1_000));
        assert_eq!(result["structuredContent"]["reason"], "matched_state");
    }
}
