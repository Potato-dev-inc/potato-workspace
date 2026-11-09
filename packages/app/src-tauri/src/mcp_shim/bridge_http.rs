//! Minimal HTTP client for the loopback bridge, plus bridge error normalisation.

use super::*;
use std::net::TcpStream;

/// A loopback connection could not be opened. The app may well still be running: a local port shortage or a
/// transient refusal is not proof that the bridge is down, so it gets its own word (see `is_connect_failure`).
pub(crate) const BRIDGE_UNREACHABLE: &str = "bridge_unreachable";

/// The port file is missing: no app has written one (or it was removed).
pub(crate) const BRIDGE_DOWN: &str = "bridge_down";

/// The connection broke while a call was in flight (reset, abort, EOF before a response): the app
/// most likely restarted or crashed. The request may or may not have been applied.
pub(crate) const BRIDGE_RESET: &str = "bridge_reset";

/// A read or write on an open connection ran out of time.
pub(crate) const BRIDGE_TIMEOUT: &str = "bridge_timeout";

/// Set once any connection to the bridge has opened in this process: from then on a refused
/// connection means "the app went away", not "the app was never started".
static BRIDGE_SEEN_UP: AtomicBool = AtomicBool::new(false);

/// Whether an error means "try again shortly": no port file yet, a connection that failed locally,
/// or a connection that dropped mid-call, or the unavailable/restarting payloads built from those.
pub(crate) fn is_connect_failure(error: &str) -> bool {
    error.starts_with(BRIDGE_UNREACHABLE)
        || error.starts_with(BRIDGE_DOWN)
        || error.starts_with(BRIDGE_RESET)
        || error.contains(r#""code":"BRIDGE_UNAVAILABLE""#)
        || error.contains(r#""code":"BRIDGE_RESTARTING""#)
}

/// Classifies an I/O error from an open connection by `ErrorKind`, so no caller has to match text.
pub(crate) fn io_failure(what: &str, err: &io::Error) -> String {
    use io::ErrorKind::*;
    match err.kind() {
        ConnectionReset | ConnectionAborted | BrokenPipe | UnexpectedEof | NotConnected => {
            format!("{BRIDGE_RESET}: {what}: {err}")
        }
        TimedOut | WouldBlock => format!("{BRIDGE_TIMEOUT}: {what}: {err}"),
        _ => format!("{what}: {err}"),
    }
}

fn bridge_stream(endpoint: &BridgeEndpoint) -> Result<TcpStream, String> {
    let stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port)).map_err(|err| {
        format!(
            "{BRIDGE_UNREACHABLE}: {} ({err}). The bridge may still be running; this was a local connection problem. Retry, or read the agent's transcript or pane before saying you got no reply.",
            endpoint.base_url()
        )
    })?;
    BRIDGE_SEEN_UP.store(true, Ordering::Release);
    Ok(stream)
}

/// Compares this MCP binary's tool catalog with the running app's (from a `/health` body). A
/// mismatch means the client was given an older or newer schema than the bridge enforces, which
/// shows up as missing tools or confusing argument rejections. The call is still served; this
/// only explains, loudly, and says how to fix it (see `notices`).
pub(crate) fn schema_drift_from_health(health: &Value) -> Option<Value> {
    schema_drift_with(health, &tool_registry::tool_schema_hashes())
}

/// `schema_drift_from_health` against explicit shim-side tool hashes (a seam for tests).
///
/// A health body with `catalog_hash` is judged by content: equal hashes mean no drift whatever the
/// version strings say, and a mismatch names the tools whose schema differs (from `tool_hashes`).
/// An older app that only reports `catalog_version` is compared by that string, as before.
pub(crate) fn schema_drift_with(
    health: &Value,
    shim_hashes: &std::collections::BTreeMap<String, String>,
) -> Option<Value> {
    let build = health
        .get("build_id")
        .and_then(Value::as_str)
        .map(|id| format!(", build {id}"))
        .unwrap_or_default();
    let (shim_label, bridge_label, tools_note, extra) = if let Some(bridge_hash) =
        health.get("catalog_hash").and_then(Value::as_str)
    {
        let shim_hash = tool_registry::catalog_hash_of(shim_hashes);
        if bridge_hash == shim_hash {
            return None;
        }
        let bridge_tools: std::collections::BTreeMap<String, String> = health
            .get("tool_hashes")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(name, hash)| Some((name.clone(), hash.as_str()?.to_owned())))
                    .collect()
            })
            .unwrap_or_default();
        let mut changed = Vec::new();
        let mut only_in_app = Vec::new();
        let mut only_in_shim = Vec::new();
        if !bridge_tools.is_empty() {
            for (name, hash) in shim_hashes {
                match bridge_tools.get(name) {
                    Some(other) if other == hash => {}
                    Some(_) => changed.push(name.clone()),
                    None => only_in_shim.push(name.clone()),
                }
            }
            only_in_app.extend(bridge_tools.keys().filter(|n| !shim_hashes.contains_key(*n)).cloned());
        }
        let mut named = changed.clone();
        named.extend(only_in_app.iter().cloned());
        named.extend(only_in_shim.iter().cloned());
        let note = if named.is_empty() {
            String::new()
        } else {
            format!(" Tools that differ: {}.", named.join(", "))
        };
        (
            shim_hash,
            bridge_hash.to_owned(),
            note,
            json!({"changed_tools": changed, "only_in_app": only_in_app, "only_in_shim": only_in_shim}),
        )
    } else {
        let bridge = health.get("catalog_version").and_then(Value::as_str)?;
        let shim = tool_registry::catalog_version();
        if bridge == shim {
            return None;
        }
        (shim, bridge.to_owned(), String::new(), json!({}))
    };
    let message = format!(
        "This Potato Workspace MCP exe (tool catalog {shim_label}) is not the same build as the running app (tool catalog {bridge_label}{build}). Some tools may be missing or renamed, and calls may be rejected for unknown or missing arguments.{tools_note} Fix: {SCHEMA_DRIFT_FIX} If the app is the older of the two, update the app instead."
    );
    let mut notice = json!({
        "code": "SCHEMA_DRIFT",
        "severity": "warning",
        "shim_catalog_version": shim_label,
        "bridge_catalog_version": bridge_label,
        "bridge_build_id": health.get("build_id"),
        "message": message,
        "fix": SCHEMA_DRIFT_FIX,
        "hint": message,
    });
    if let (Some(target), Some(more)) = (notice.as_object_mut(), extra.as_object()) {
        target.extend(more.clone());
    }
    Some(notice)
}

/// Whether repeating this request after a dropped connection cannot apply it twice: reads, waits,
/// and any call that carries an `idempotency_key` (the bridge returns the first result for it).
pub(crate) fn retry_safe(method: &str, path: &str, body: Option<&Value>) -> bool {
    method == "GET"
        || path.contains("/wait")
        || body
            .and_then(|b| b.get("idempotency_key"))
            .and_then(Value::as_str)
            .is_some_and(|key| !key.is_empty())
}

#[cfg(not(test))]
pub(crate) const RESTART_WAIT: Duration = Duration::from_secs(30);
#[cfg(test)]
pub(crate) const RESTART_WAIT: Duration = Duration::from_secs(6);
#[cfg(not(test))]
const RESTART_POLL: Duration = Duration::from_secs(1);
#[cfg(test)]
const RESTART_POLL: Duration = Duration::from_millis(50);

pub(crate) const REQUEST_CANCELLED_JSON: &str = r#"{"code":"REQUEST_CANCELLED","message":"the call was cancelled","recoverable":true,"retryable":true,"context":{}}"#;

/// Waits for the app to accept connections again, re-reading the port file each poll (a restarted
/// app may pick a new port). Tells the caller via progress, and stops early when the call is cancelled.
fn wait_for_bridge_restart() -> Result<(), String> {
    const MESSAGE: &str = "Waiting for Potato Workspace to start\u{2026}";
    report_progress(MESSAGE);
    let started = std::time::Instant::now();
    let mut last_report = started;
    while started.elapsed() < RESTART_WAIT {
        if call_cancelled() {
            return Err(REQUEST_CANCELLED_JSON.into());
        }
        std::thread::sleep(RESTART_POLL);
        if let Ok(endpoint) = read_bridge_endpoint() {
            if accepts_connection(&endpoint.host, endpoint.port) {
                return Ok(());
            }
        }
        if last_report.elapsed() >= Duration::from_secs(5) {
            report_progress(MESSAGE);
            last_report = std::time::Instant::now();
        }
    }
    Err("the app did not come back in time".into())
}

/// A transport failure that has not been turned into a contract body yet.
fn is_raw_connect_failure(error: &str) -> bool {
    is_connect_failure(error) && !error.starts_with('{')
}

/// Runs `attempt`; if the connection failed because the app is restarting, a retry-safe call waits
/// for it (up to 30 s) and runs once more. Anything else is returned as a contract error body.
pub(crate) fn with_restart_retry(
    safe: bool,
    mut attempt: impl FnMut() -> Result<String, String>,
) -> Result<String, String> {
    let first = match attempt() {
        Err(error) if is_raw_connect_failure(&error) => error,
        other => return other,
    };
    let was_reset = first.starts_with(BRIDGE_RESET);
    if !(BRIDGE_SEEN_UP.load(Ordering::Acquire) || was_reset) {
        // The app was never reachable from this process: say so now instead of waiting.
        return Err(bridge_unavailable(&first));
    }
    if !safe {
        return Err(bridge_restarting(&first, was_reset));
    }
    if let Err(reason) = wait_for_bridge_restart() {
        return Err(if reason.starts_with('{') { reason } else { bridge_unavailable(&first) });
    }
    match attempt() {
        Err(error) if is_raw_connect_failure(&error) => {
            Err(bridge_restarting(&error, error.starts_with(BRIDGE_RESET)))
        }
        other => other,
    }
}

pub(crate) fn bridge_request(
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<String, String> {
    let safe = retry_safe(method, path, body.as_ref());
    with_restart_retry(safe, || bridge_request_once(method, path, body.clone()))
}

fn bridge_request_once(
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<String, String> {
    if call_cancelled() {
        return Err(REQUEST_CANCELLED_JSON.into());
    }
    let endpoint = read_bridge_endpoint()?;
    let body_text = body
        .as_ref()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let read_timeout_secs = bridge_read_timeout_secs(method, path, body.as_ref());
    let mut stream = bridge_stream(&endpoint)?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(read_timeout_secs)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let session_header = current_mcp_session_id()
        .map(|id| session_headers(&id))
        .unwrap_or_default()
        + &local_secret_header();
    let request = format!(
        "{method} {path} HTTP/1.1\r\n\
         Host: {}:{}\r\n\
         {session_header}\
         Connection: close\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         \r\n\
         {}",
        endpoint.host,
        endpoint.port,
        body_text.len(),
        body_text
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| io_failure("bridge write failed", &err))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|err| io_failure("bridge read failed", &err))?;
    parse_http_response(&response)
}

pub(crate) fn bridge_request_wait(
    id: &str,
    query: &str,
    body: Value,
    timeout_ms: u64,
    cancel: Option<&std::sync::mpsc::Receiver<()>>,
) -> Result<String, String> {
    with_restart_retry(true, || bridge_request_wait_once(id, query, &body, timeout_ms, cancel))
}

fn bridge_request_wait_once(
    id: &str,
    query: &str,
    body: &Value,
    timeout_ms: u64,
    cancel: Option<&std::sync::mpsc::Receiver<()>>,
) -> Result<String, String> {
    let endpoint = read_bridge_endpoint()?;
    let body_text = body.to_string();
    let mut stream = bridge_stream(&endpoint)?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let session_header = current_mcp_session_id()
        .map(|id| session_headers(&id))
        .unwrap_or_default()
        + &local_secret_header();
    let request = format!("POST /operations/{}/wait{} HTTP/1.1\r\nHost: {}:{}\r\n{}Connection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", encode_path_segment(id), query, endpoint.host, endpoint.port, session_header, body_text.len(), body_text);
    stream
        .write_all(request.as_bytes())
        .map_err(|err| io_failure("bridge write failed", &err))?;
    let deadline =
        std::time::Instant::now() + Duration::from_millis(timeout_ms.saturating_add(20_000));
    loop {
        if cancel.is_some_and(|rx| rx.try_recv().is_ok()) {
            return Err(REQUEST_CANCELLED_JSON.into());
        }
        let mut chunk = [0_u8; 8192];
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(_) => {}
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("{BRIDGE_TIMEOUT}: bridge wait timed out"));
                }
            }
            Err(err) => return Err(io_failure("bridge read failed", &err)),
        }
    }
    // Fallback response path uses ordinary parsing; the bridge's wait endpoint still
    // returns a final snapshot if notifications were unavailable.
    Err("bridge closed operation wait without a response".into())
}

pub(crate) fn bridge_request_wait_agents(
    body: &Value,
    cancel: Option<&std::sync::mpsc::Receiver<()>>,
) -> Result<String, String> {
    with_restart_retry(true, || bridge_request_wait_agents_once(body, cancel))
}

fn bridge_request_wait_agents_once(
    body: &Value,
    cancel: Option<&std::sync::mpsc::Receiver<()>>,
) -> Result<String, String> {
    let endpoint = read_bridge_endpoint()?;
    let body_text = body.to_string();
    let timeout_ms = body
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_AGENT_WAIT_MS);
    let mut stream = bridge_stream(&endpoint)?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let session_header = current_mcp_session_id()
        .map(|id| session_headers(&id))
        .unwrap_or_default()
        + &local_secret_header();
    let request = format!(
        "POST /agents/wait HTTP/1.1\r\nHost: {}:{}\r\n{}Connection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        endpoint.host, endpoint.port, session_header, body_text.len(), body_text
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| io_failure("bridge write failed", &err))?;
    let deadline =
        std::time::Instant::now() + Duration::from_millis(timeout_ms.saturating_add(20_000));
    let mut response = Vec::new();
    loop {
        if cancel.is_some_and(|rx| rx.try_recv().is_ok()) {
            return Err(REQUEST_CANCELLED_JSON.into());
        }
        let mut chunk = [0_u8; 8192];
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => response.extend_from_slice(&chunk[..count]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("{BRIDGE_TIMEOUT}: agent wait exceeded its timeout grace period"));
                }
            }
            Err(error) => return Err(io_failure("bridge read failed", &error)),
        }
    }
    parse_http_response(&response)
}

pub(crate) fn bridge_read_timeout_secs(method: &str, path: &str, body: Option<&Value>) -> u64 {
    if method == "POST"
        && (path.contains("/panes/wait")
            || path.contains("/operations/") && path.ends_with("/wait")
            || path == "/agents/wait"
            || path == "/agents/run"
            || path == "/agents/quick"
            || path == "/agents/followup")
    {
        if path == "/agents/quick" {
            // quick_ask waits wait_ms (default 90s, clamped to 120s) like the bridge does.
            let wait_ms = body
                .and_then(|value| value.get("wait_ms"))
                .and_then(Value::as_u64)
                .unwrap_or(90_000)
                .min(120_000);
            return (wait_ms / 1000).saturating_add(15);
        }
        if path == "/agents/run"
            && body
                .and_then(|value| value.get("background"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return 30;
        }
        let default_timeout_ms = DEFAULT_AGENT_WAIT_MS;
        let timeout_key = if path == "/agents/run" || path == "/agents/followup" {
            "wait_ms"
        } else {
            "timeout_ms"
        };
        let timeout_ms = body
            .and_then(|value| value.get(timeout_key))
            .and_then(Value::as_u64)
            .unwrap_or(default_timeout_ms);
        return (timeout_ms / 1000).saturating_add(15).min(330);
    }
    30
}

pub(crate) fn parse_http_response(response: &[u8]) -> Result<String, String> {
    let marker = b"\r\n\r\n";
    if response.is_empty() {
        // EOF before any byte: the app closed the connection without answering (restart or crash).
        return Err(format!("{BRIDGE_RESET}: bridge closed the connection without a response"));
    }
    let header_end = response
        .windows(marker.len())
        .position(|window| window == marker)
        .ok_or_else(|| format!("{BRIDGE_RESET}: bridge response was cut off before its headers ended"))?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "bridge returned invalid HTTP status".to_string())?;
    let body = String::from_utf8_lossy(&response[header_end + marker.len()..]).to_string();
    if status >= 400 {
        return Err(legacy_http_error(status, &body).to_string());
    }
    Ok(body)
}

pub(crate) fn ensure_error_message(mut value: Value) -> Value {
    if value.get("message").and_then(Value::as_str).is_none() {
        if let Some(error) = value.get("error").cloned() {
            if let Some(object) = value.as_object_mut() {
                object.insert("message".into(), error);
            }
        }
    }
    value
}

pub(crate) fn legacy_http_error(status: u16, body: &str) -> Value {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if value.get("code").is_some() && value.get("recoverable").is_some() {
            return ensure_error_message(value);
        }
    }
    let (code, recoverable, retry_after_ms) = match status {
        400 => ("INVALID_ARGUMENT", false, Value::Null),
        401 | 403 => ("AUTHORIZATION_DENIED", false, Value::Null),
        404 => ("NOT_FOUND", false, Value::Null),
        409 => ("CONFLICT", true, json!(1000)),
        429 => ("RATE_LIMITED", true, json!(1000)),
        500..=u16::MAX => ("BRIDGE_UNAVAILABLE", true, Value::Null),
        _ => ("BRIDGE_ERROR", true, Value::Null),
    };
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| body.to_owned());
    json!({"code":code,"message":message,"recoverable":recoverable,"retry_after_ms":retry_after_ms,"context":{"http_status":status}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_connection_failure_is_not_called_bridge_down() {
        // Bind a port, then close it: nothing is listening on it when the connection is tried.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = bridge_stream(&BridgeEndpoint { host: "127.0.0.1".into(), port }).unwrap_err();
        assert!(error.starts_with(BRIDGE_UNREACHABLE), "{error}");
        assert!(!error.starts_with(BRIDGE_DOWN), "{error}");
        assert!(error.contains("may still be running"), "{error}");
        assert!(is_connect_failure(&error));
    }

    #[test]
    fn a_missing_port_file_still_counts_as_a_connection_failure() {
        assert!(is_connect_failure("bridge_down: no port file"));
        assert!(is_connect_failure("bridge_unreachable: refused"));
        assert!(!is_connect_failure("bridge read failed: reset"));
    }
}
