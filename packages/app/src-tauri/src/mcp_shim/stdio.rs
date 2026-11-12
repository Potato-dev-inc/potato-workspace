//! JSON-RPC over stdio: the request loop, `initialize`, tool/resource/prompt listing.

use super::*;
pub(crate) fn run() {
    if env::args().any(|arg| arg == "--version") {
        println!("{SERVER_NAME} {}", server_version());
        return;
    }

    log("starting");
    let session_id = session_id_from(env::var(CLIENT_ID_ENV).ok());
    let launch_args: Vec<String> = env::args().skip(1).collect();
    match initial_mode_from(&launch_args, env::var(MODE_ENV).ok()) {
        Ok(Some(mode)) => match mcp_sessions::set_mode(&session_id, mode.as_str()) {
            Ok(_) => {
                let _ = INITIAL_MODE.set(mode);
                log(format!("starting in {} mode", mode.as_str()));
            }
            Err(err) => log(format!("ignoring starting mode: {}", err.message)),
        },
        Ok(None) => {}
        Err(message) => log(format!("ignoring starting mode: {message}")),
    }
    serve(session_id, io::stdin().lock(), io::stdout());
}

/// How many requests run at once; the next one gets a retryable `RATE_LIMITED` tool error.
const REQUEST_SLOTS: usize = 16;

/// Requests in flight, by JSON-RPC id: how to cancel each, and whether it was cancelled.
type ActiveRequests =
    std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, (std::sync::mpsc::Sender<()>, std::sync::Arc<AtomicBool>)>>>;

/// The request loop: reads JSON-RPC lines from `input`, answers on `output`. A cancelled request
/// (`notifications/cancelled`) gets no response at all, as the MCP spec says.
pub(crate) fn serve<R: BufRead, W: Write + Send + 'static>(session_id: String, input: R, output: W) {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let writer = std::thread::spawn(move || {
        let mut output = output;
        while let Ok(response) = rx.recv() {
            if writeln!(output, "{response}")
                .and_then(|_| output.flush())
                .is_err()
            {
                break;
            }
        }
    });
    let (slots_tx, slots_rx) = std::sync::mpsc::sync_channel::<()>(REQUEST_SLOTS);
    for _ in 0..REQUEST_SLOTS {
        let _ = slots_tx.send(());
    }
    let active: ActiveRequests = Default::default();
    let mut workers = Vec::new();
    for line in input.lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                log(format!("stdin read failed: {err}"));
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                let _ = tx.send(
                    json_rpc_error(Value::Null, -32700, "invalid JSON-RPC request".into())
                        .to_string(),
                );
                continue;
            }
        };
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if method == "notifications/cancelled" {
            if let Some(id) = request.pointer("/params/requestId").map(json_id_key) {
                let entry = active.lock().ok().and_then(|map| map.get(&id).cloned());
                if let Some((cancel, cancelled)) = entry {
                    cancelled.store(true, Ordering::Release);
                    let _ = cancel.send(());
                }
            }
            continue;
        }
        if method == "notifications/initialized" || request.get("id").is_none() {
            continue;
        }
        let id = request.get("id").map(json_id_key).unwrap_or_default();
        if slots_rx.try_recv().is_err() {
            let request_id = request.get("id").cloned().unwrap_or(Value::Null);
            let busy = if method == "tools/call" {
                // A tool error the caller can act on (wait, then retry), not a protocol failure.
                let detail = json!({
                    "code": "RATE_LIMITED",
                    "message": "Too many requests are running at once. Retry shortly.",
                    "recoverable": true,
                    "retryable": true,
                    "retry_after_ms": 500,
                    "context": { "limit": REQUEST_SLOTS }
                });
                json!({ "jsonrpc": "2.0", "id": request_id, "result": tool_error_result(detail) }).to_string()
            } else {
                json_rpc_error(request_id, -32000, "server busy: request concurrency limit reached".into()).to_string()
            };
            let _ = tx.send(busy);
            continue;
        }
        let tx = tx.clone();
        let release = slots_tx.clone();
        let active_ref = active.clone();
        let session_id = session_id.clone();
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let cancel_rx = if id.is_empty() {
            None
        } else {
            let (cancel_tx, cancel_rx) = std::sync::mpsc::channel();
            if let Ok(mut map) = active.lock() {
                map.insert(id.clone(), (cancel_tx, cancelled.clone()));
            }
            Some(cancel_rx)
        };
        let is_tool_call = method == "tools/call";
        let worker = std::thread::spawn(move || {
            set_mcp_session_id(session_id);
            if is_tool_call {
                ensure_initial_mode_synced();
            }
            let response = handle_json_rpc_line_cancellable(&line, cancel_rx, Some(tx.clone()));
            // Drop the entry first so a cancel that arrives from now on finds nothing to cancel.
            if let Ok(mut map) = active_ref.lock() {
                map.remove(&id);
            }
            // A cancelled request gets no response (MCP spec: the receiver SHOULD NOT answer).
            if !cancelled.load(Ordering::Acquire) {
                if let Some(response) = response {
                    let _ = tx.send(response);
                }
            }
            let _ = release.send(());
        });
        workers.push(worker);
        workers.retain(|worker| !worker.is_finished());
    }
    drop(tx);
    for worker in workers {
        let _ = worker.join();
    }
    let _ = writer.join();
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

fn json_id_key(id: &Value) -> String {
    id.to_string()
}

#[cfg(test)]
fn handle_json_rpc_line(line: &str) -> Option<String> {
    handle_json_rpc_line_cancellable(line, None, None)
}

fn handle_json_rpc_line_cancellable(
    line: &str,
    cancel_rx: Option<std::sync::mpsc::Receiver<()>>,
    notifications: Option<std::sync::mpsc::Sender<String>>,
) -> Option<String> {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            return Some(
                json_rpc_error(
                    Value::Null,
                    -32700,
                    format!("invalid JSON-RPC request: {err}"),
                )
                .to_string(),
            );
        }
    };
    request.get("id")?;
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = match method {
        "initialize" => {
            if let Some(name) = request.pointer("/params/clientInfo/name").and_then(Value::as_str) {
                set_client_name(name);
            }
            Ok(json!({
            "protocolVersion": negotiate_protocol_version(request.pointer("/params/protocolVersion").and_then(Value::as_str)),
            "capabilities": { "tools": { "listChanged": true }, "resources": {}, "prompts": {} },
            "serverInfo": {
                "name": SERVER_NAME,
                "version": server_version(),
                "catalog_version": tool_registry::catalog_version(),
            },
            "instructions": instructions_with_notices()
            }))
        }
        "tools/list" => Ok(json!({ "tools": mcp_tools() })),
        "resources/list" => Ok(json!({ "resources": tool_registry::resources() })),
        "prompts/list" => Ok(json!({ "prompts": tool_registry::prompts() })),
        "tools/call" => {
            let token = request.pointer("/params/_meta/progressToken").cloned();
            match call_tool_with_progress(
                request.get("params").cloned().unwrap_or_else(|| json!({})),
                cancel_rx,
                token,
                notifications.clone(),
            ) {
                Ok(value) => Ok(value),
                Err(message) => Ok(tool_error_result(tool_error_detail(&message))),
            }
        }
        _ => Err(format!("unknown method: {method}")),
    };

    let mut result = result;
    if method == "tools/call"
        && request.pointer("/params/name").and_then(Value::as_str) == Some("set_mode")
    {
        if let Ok(value) = result.as_mut() {
            if value.get("isError") != Some(&Value::Bool(true)) {
                let sent = notifications.as_ref().is_some_and(|sender| {
                    sender
                        .send(
                            json!({"jsonrpc":"2.0","method":"notifications/tools/list_changed"})
                                .to_string(),
                        )
                        .is_ok()
                });
                annotate_set_mode(value, sent);
            }
        }
    }

    if method == "tools/call" {
        if let Ok(value) = result.as_mut() {
            let name = request
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            annotate_tool_result(name, value);
        }
    }

    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
        Err(message) => json_rpc_error(id, -32603, message).to_string(),
    })
}

/// Tell the caller whether `notifications/tools/list_changed` was sent, and that hosts which
/// read `tools/list` only once at startup will keep showing the old catalog regardless.
fn annotate_set_mode(result: &mut Value, notification_sent: bool) {
    let note = if notification_sent {
        "Sent notifications/tools/list_changed. Hosts that read tools/list only once at startup ignore it and keep the old tool list; if tool_count differs from what you can see, restart the MCP server with --mode <mode> or reconnect."
    } else {
        "This transport could not send notifications/tools/list_changed. The host will keep the old tool list until it re-reads tools/list; restart the MCP server with --mode <mode> or reconnect."
    };
    if let Some(structured) = result
        .get_mut("structuredContent")
        .and_then(Value::as_object_mut)
    {
        structured.insert(
            "tools_list_changed_sent".into(),
            Value::Bool(notification_sent),
        );
        structured.insert("note".into(), Value::String(note.into()));
    }
    if let Some(text) = result
        .pointer_mut("/content/0/text")
        .filter(|text| text.is_string())
    {
        let body = text.as_str().unwrap_or_default().to_owned();
        *text = Value::String(format!(
            "{body}

Note: {note}"
        ));
    }
}

fn json_rpc_error(id: Value, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn mcp_tools() -> Vec<Value> {
    mcp_tools_for_pane(pane_header(env::var(mcp_sessions::PANE_ID_ENV).ok()))
}

/// The tool list for this connection; `pane` is the pane Potato Workspace started this agent in.
fn mcp_tools_for_pane(pane: Option<String>) -> Vec<Value> {
    let session = current_mcp_session_id();
    let mut tools = session
        .as_deref()
        .map(mcp_sessions::tools_for_session)
        .unwrap_or_else(tool_registry::tools);
    // An agent that Potato Workspace started in a companion's pane also gets `companion_recall` in its list.
    let mode = session.as_deref().map(mcp_sessions::mode_for).unwrap_or(tool_registry::McpMode::All);
    if let Some(recall) = tool_registry::companion_recall_for_pane(pane.as_deref(), mode, &tools) {
        tools.push(recall);
    }
    tools
        .into_iter()
        .filter(|tool| tool.visibility.external_mcp)
        .map(|tool| {
            let mut value = json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
            });
            // Output schemas are most of the list's bytes. A narrow mode leaves them out (results
            // still carry structuredContent); mode=all lists them in full.
            if let Some(schema) = tool.output_schema.filter(|_| matches!(mode, tool_registry::McpMode::All)) {
                value["outputSchema"] = schema;
            }
            value
        })
        .collect()
}

fn negotiate_protocol_version(requested: Option<&str>) -> &'static str {
    match requested {
        Some("2025-11-25") => "2025-11-25",
        Some("2025-06-18") => "2025-06-18",
        Some("2025-03-26") => "2025-03-26",
        _ => "2024-11-05",
    }
}
