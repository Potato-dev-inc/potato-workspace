//! P5.2, the far side of a dev-server preview: `POST /pclink/stream/preview` (Full). The body names one chat and one port and carries ONE
//! HTTP request; this PC makes it to its own `localhost:<port>` (the address the chat printed) and answers with the status, the few headers a page needs and the body.
//! The asking PC shows the page through its own `pmfar` protocol (`device_link/far_preview.rs`): no port is ever opened on that PC.
//!
//! Only a port this PC lists for that chat in `pane_previews` (what the chat's own screen printed) is reachable (S8), only for a chat that
//! is open on this PC and not switched off for other PCs. The request is plain HTTP with no cookies and no credentials of its own; the
//! answer is cut at [`BODY_MAX`]. An open stream (a socket, server-sent events) is not carried: it ends at [`WAIT`].

use std::io::Read;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use super::app_services::{bad, Reply};

/// The biggest body one answer carries (base64 makes it a third larger; the link's reply cap is 32 MB).
pub const BODY_MAX: usize = 12 * 1024 * 1024;
/// The biggest request body (the link's own cap is 8 MB).
const REQUEST_MAX: usize = 4 * 1024 * 1024;
/// How long the dev server has to answer.
const WAIT: Duration = Duration::from_secs(20);

/// The request headers a page's own requests may carry through. No cookie, no authorization: the page has no login here.
const SEND: &[&str] = &["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since"];
/// The answer headers a page needs. Nothing that sets a cookie or changes how the link frames the body.
const KEEP: &[&str] = &["content-type", "location", "etag", "last-modified", "cache-control", "content-range", "content-language", "accept-ranges"];
const METHODS: &[&str] = &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/// One request, checked.
#[derive(Debug, PartialEq, Eq)]
pub struct Req {
    pub pane: String,
    pub port: u16,
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The body of `POST /pclink/stream/preview`: `{ paneId, port, method, path, headers: [[name, value]], bodyB64? }`.
pub fn parse(body: &Value) -> Result<Req, Reply> {
    let text = |key: &str| body.get(key).and_then(Value::as_str);
    let pane = text("paneId").filter(|p| !p.trim().is_empty()).ok_or_else(|| bad("INVALID_ARGUMENT", "paneId is required"))?;
    let port = body.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).ok_or_else(|| bad("INVALID_ARGUMENT", "port is required"))?;
    let method = text("method").unwrap_or("GET").to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(bad("INVALID_ARGUMENT", "That method is not carried."));
    }
    // A path and a query only: it starts with one `/`, and no space, control character or second authority can ride on it.
    let path = text("path").unwrap_or("/");
    if !path.starts_with('/') || path.starts_with("//") || path.len() > 2048 || path.chars().any(|c| c.is_control() || c == ' ' || c == '\\') {
        return Err(bad("INVALID_ARGUMENT", "That address is not carried."));
    }
    let mut headers = Vec::new();
    for pair in body.get("headers").and_then(Value::as_array).into_iter().flatten() {
        if let (Some(name), Some(value)) = (pair.get(0).and_then(Value::as_str), pair.get(1).and_then(Value::as_str)) {
            let name = name.to_ascii_lowercase();
            if SEND.contains(&name.as_str()) && !value.chars().any(char::is_control) {
                headers.push((name, value.to_string()));
            }
        }
    }
    let bytes = match text("bodyB64").filter(|b| !b.is_empty()) {
        Some(b64) => STANDARD.decode(b64).ok().filter(|b| b.len() <= REQUEST_MAX).ok_or_else(|| bad("INVALID_ARGUMENT", "The body is not carried."))?,
        None => Vec::new(),
    };
    Ok(Req { pane: pane.to_string(), port, method, path: path.to_string(), headers, body: bytes })
}

/// Whether `port` may be reached: one this PC lists for the chat (`urls` is that chat's `pane_previews` row), and not a port of Potato Workspace
/// itself (its phone server, its bridge, its debugging port). A chat can print any address, so the second check is what keeps a paired PC off the
/// bridge, which trusts the loopback (S1). The same rule the preview window of this PC's own screen holds (`point::origin::resolve_open`).
pub fn check_port(urls: &[crate::pane_preview::PreviewUrl], port: u16) -> Result<String, Reply> {
    use crate::point::origin::{resolve_open, Refusal};
    match resolve_open(port, urls, &[]) {
        // The host the chat printed (`localhost`, which tries `::1` as well as IPv4, or an address on this PC's network): a dev server may listen on only one.
        Ok(url) => Ok(tauri::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| "localhost".to_string())),
        Err(Refusal::OwnPort) => Err((403, json!({ "code": "PREVIEW_OWN_PORT", "error": "That port belongs to Potato Workspace, so it cannot be shown." }))),
        Err(_) => Err((403, json!({ "code": "PREVIEW_NOT_LISTED", "error": "That is not one of this agent's previews." }))),
    }
}

/// The preview rows this PC offers another: only chats a PC may see, each port with its address on this PC. A LAN address is left out.
pub fn rows(snapshot: Vec<(String, Vec<(String, u16)>)>, visible: &dyn Fn(&str) -> bool) -> Value {
    let mut out = serde_json::Map::new();
    for (pane, urls) in snapshot.into_iter().filter(|(pane, _)| visible(pane)) {
        out.insert(pane, Value::Array(urls.into_iter().map(|(url, port)| json!({ "url": url, "port": port })).collect()));
    }
    Value::Object(out)
}

/// Makes the request to this PC's own port. `host` is the one the chat printed for it (`check_port`).
pub fn fetch(host: &str, req: &Req) -> Reply {
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(WAIT).build();
    let mut call = agent.request(&req.method, &format!("http://{host}:{}{}", req.port, req.path)).set("Accept-Encoding", "identity");
    for (name, value) in &req.headers {
        call = call.set(name, value);
    }
    let sent = if req.body.is_empty() { call.call() } else { call.send_bytes(&req.body) };
    // A 4xx or 5xx is still the page's answer.
    let response = match sent {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(_) => return (502, json!({ "code": "PREVIEW_DOWN", "error": "The preview did not answer. Is the server still running?" })),
    };
    let status = response.status();
    let headers: Vec<Value> = KEEP.iter().filter_map(|name| response.header(name).map(|v| json!([name, v]))).collect();
    let mut body = Vec::new();
    if req.method != "HEAD" && response.into_reader().take(BODY_MAX as u64 + 1).read_to_end(&mut body).is_err() {
        return (502, json!({ "code": "PREVIEW_DOWN", "error": "The preview stopped answering." }));
    }
    if body.len() > BODY_MAX {
        return (413, json!({ "code": "PREVIEW_TOO_BIG", "error": "That part of the page is too large to show here." }));
    }
    (200, json!({ "status": status, "headers": headers, "bodyB64": STANDARD.encode(&body) }))
}
