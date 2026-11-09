//! `tools/call` entry points: argument shaping, mode gating and result wrapping.

use super::*;

#[cfg(test)]
pub(crate) fn call_tool(params: Value) -> Result<Value, String> {
    call_tool_cancellable(params, None)
}

pub(crate) fn call_tool_cancellable(
    params: Value,
    cancel_rx: Option<std::sync::mpsc::Receiver<()>>,
) -> Result<Value, String> {
    call_tool_with_sink(params, cancel_rx, None)
}

/// Tools whose own loops watch the cancel channel; the others block in one HTTP request and are
/// run on a helper thread so a cancel can stop the wait (see `dispatch_cancellable`).
fn watches_cancel_itself(name: &str) -> bool {
    matches!(
        name,
        "ask_user" | "wait_agents" | "wait_for_operation" | "team_wait" | "wait_for_model" | "wait_for_task" | "wait_for_worker"
    )
}

/// Tools that block on a run for a long time; they send a progress heartbeat while they do.
fn sends_heartbeat(name: &str) -> bool {
    matches!(name, "run_agent" | "quick_ask" | "followup_task" | "send_agent")
}

#[cfg(not(test))]
const HEARTBEAT_EVERY: Duration = Duration::from_secs(10);
#[cfg(test)]
const HEARTBEAT_EVERY: Duration = Duration::from_millis(200);

/// Runs the dispatch for `name`. With a cancel channel and a tool that blocks in one HTTP request, the
/// request runs on a helper thread while this thread waits on both the answer and the cancel. On
/// cancel it stops waiting and reports `REQUEST_CANCELLED`; the helper finishes (or times out) in the
/// background and its answer is dropped. Nothing is sent to the bridge: the run itself is never cancelled.
fn dispatch_cancellable(
    name: &str,
    args: &Value,
    cancel_rx: Option<std::sync::mpsc::Receiver<()>>,
    sink: Option<ProgressSink>,
) -> Result<String, String> {
    let flag = std::sync::Arc::new(AtomicBool::new(false));
    let context = CallContext { sink: sink.clone(), cancelled: Some(flag.clone()) };
    let Some(cancel_rx) = cancel_rx else {
        return with_call_context(context, || dispatch::dispatch(name, args, None));
    };
    if watches_cancel_itself(name) {
        return with_call_context(context, || dispatch::dispatch(name, args, Some(&cancel_rx)));
    }
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let (inner_tx, inner_rx) = std::sync::mpsc::channel::<()>();
    let session = current_mcp_session_id();
    let worker_name = name.to_owned();
    let worker_args = args.clone();
    let worker_context = context.clone();
    std::thread::spawn(move || {
        if let Some(session) = session {
            set_mcp_session_id(session);
        }
        let result = with_call_context(worker_context, || {
            dispatch::dispatch(&worker_name, &worker_args, Some(&inner_rx))
        });
        let _ = done_tx.send(result);
    });
    let heartbeat = sink.filter(|_| sends_heartbeat(name));
    let mut last_beat = std::time::Instant::now();
    loop {
        match done_rx.recv_timeout(Duration::from_millis(25)) {
            Ok(result) => return result,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("tool call ended without a result".into());
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        if cancel_rx.try_recv().is_ok() {
            flag.store(true, Ordering::Release);
            let _ = inner_tx.send(());
            // Give a helper that is between steps a moment to notice (it may still be idle-polling).
            let _ = done_rx.recv_timeout(Duration::from_millis(250));
            return Err(REQUEST_CANCELLED_JSON.into());
        }
        if let Some(sink) = &heartbeat {
            if last_beat.elapsed() >= HEARTBEAT_EVERY {
                sink.send(&format!("{name} is still running"));
                last_beat = std::time::Instant::now();
            }
        }
    }
}

pub(crate) fn call_tool_with_sink(
    params: Value,
    cancel_rx: Option<std::sync::mpsc::Receiver<()>>,
    sink: Option<ProgressSink>,
) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "tools/call missing params.name".to_string())?;
    let mut args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    // Optional `shell` hint (bash|powershell|cmd) shapes the printed watch_command only; the
    // bridge never sees it.
    let shell_hint = take_shell_hint(name, &mut args)?;
    let project_hint: Option<String> = args
        .get("project_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    ensure_tool_mode(name)?;
    let call = dispatch_cancellable(name, &args, cancel_rx, sink);

    let project_hint = project_hint.as_deref();
    let mut text = match call {
        Ok(text) => text,
        Err(error) => {
            // WAIT_TIMEOUT recovery payloads carry a watch_command too.
            let error = error.to_string();
            return Err(match shell_hint {
                Some(hint) => apply_shell_hint(&error, hint, project_hint),
                None => error,
            });
        }
    };
    if let Some(hint) = shell_hint {
        text = apply_shell_hint(&text, hint, project_hint);
    }

    let structured = serde_json::from_str::<Value>(&text).ok();
    let mut result = json!({ "content": [{ "type": "text", "text": text }] });
    if let Some(value) = structured {
        if let Some(object) = result.as_object_mut() {
            object.insert(
                "structuredContent".into(),
                if value.is_object() {
                    value
                } else {
                    json!({"data": value})
                },
            );
        }
    }
    Ok(result)
}
