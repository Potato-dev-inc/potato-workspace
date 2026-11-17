//! Embedded HTTP server for the mobile PWA (production builds).
//!
//! Serves the staged `pwa-dist` assets on loopback, proxies `/bridge/*` to the
//! embedded bridge, and exposes `/__puppet_master_dev__.json` for tunnel info.
#![allow(dead_code)]

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

pub(crate) mod tunnel_listener;

const HOST: &str = "127.0.0.1";
pub const PWA_PORT: u16 = 1420;

/// The port the PWA server really listens on: `PWA_PORT` for the default profile, a free one for
/// a non-default profile (`app_paths::pwa_port_for`). `PWA_PORT` until the server has started.
pub fn pwa_port() -> u16 {
    BOUND_PORT.get().copied().unwrap_or(PWA_PORT)
}

/// The port the PWA server is really listening on, or `None` when it has not started or its bind
/// failed (then `pwa_port()` would name a port nothing here serves). New callers should use this.
pub fn bound_pwa_port() -> Option<u16> {
    BOUND_PORT.get().copied()
}

/// The largest bridge request body this server buffers for the tunnel (413 above it).
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// The largest body a request WITHOUT a bearer token may send (413 above it). The bridge checks the token only after the
/// body is buffered, so anyone on the internet could otherwise make this server hold 16 MB per connection. Pairing and
/// the push Allow/Deny tap have no bearer either, and send a few hundred bytes.
const UNAUTH_BODY_BYTES: usize = 64 * 1024;
const MAX_HEAD_BYTES: usize = 256 * 1024;
/// The whole request (head and body) must arrive within this long.
const READ_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
/// One read waits at most this long, and never longer than what is left of the overall deadline.
const READ_STEP: std::time::Duration = std::time::Duration::from_secs(10);
/// A connection that arrives while the anonymous slots are all taken gets this long to show a bearer.
const OVERFLOW_HEAD_DEADLINE: std::time::Duration = std::time::Duration::from_secs(3);
/// Connections served at once; more get a 503.
const MAX_CONNECTIONS: usize = 256;
/// Slots only a request that carries a bearer token (or a public pairing route) may use, so a flood of anonymous
/// connections cannot lock out a paired phone.
const RESERVED_FOR_BEARER: usize = 32;

static OPEN_CONNECTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// Connections that have not shown a bearer token (yet). Limited to `MAX_CONNECTIONS - RESERVED_FOR_BEARER`.
static ANON_CONNECTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
/// Pairing tries per visitor address on the quick-address (cloudflared) path. The fixed-address listener has its own.
static QUICK_PAIR_THROTTLE: once_cell::sync::Lazy<tunnel_listener::PairThrottle> =
    once_cell::sync::Lazy::new(tunnel_listener::PairThrottle::default);

/// Headers every reply carries: never framed, never sniffed, no referrer.
pub(crate) const SECURITY_HEADERS: &str = "Content-Security-Policy: frame-ancestors 'none'\r\nX-Frame-Options: DENY\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n";

struct ConnectionSlot(&'static std::sync::atomic::AtomicUsize);

impl ConnectionSlot {
    fn take(limit: usize) -> Option<Self> {
        Self::take_from(&OPEN_CONNECTIONS, limit)
    }

    fn take_from(counter: &'static std::sync::atomic::AtomicUsize, limit: usize) -> Option<Self> {
        use std::sync::atomic::Ordering;
        if counter.fetch_add(1, Ordering::SeqCst) >= limit {
            counter.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Self(counter))
    }
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Try the ports in order; the first free one wins. A list of several ends with "any free port", so it always starts.
fn bind_first_free(candidates: &[u16]) -> std::io::Result<TcpListener> {
    let mut last = None;
    for port in candidates {
        match TcpListener::bind((HOST, *port)) {
            Ok(listener) => return Ok(listener),
            Err(err) => last = Some(err),
        }
    }
    if candidates.len() > 1 {
        return TcpListener::bind((HOST, 0));
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("no port to try")))
}

/// Set when the port this profile asks for was taken by another program and a different one was used.
static PORT_MOVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `moved`: the usual port was busy, so the phone server uses another (an own domain must follow it).
/// `not_running`: it could not start at all. `None`: all is well.
pub fn pwa_port_problem() -> Option<&'static str> {
    if BOUND_PORT.get().is_none() {
        Some("not_running")
    } else if PORT_MOVED.load(std::sync::atomic::Ordering::SeqCst) {
        Some("moved")
    } else {
        None
    }
}

static BOUND_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevInfoPayload {
    pub local_url: String,
    pub pwa_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tunnel_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tunnel_provider: Option<String>,
    pub bridge_proxy_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_direct_url: Option<String>,
    pub updated_at: u64,
}

type DevInfoSupplier = Arc<dyn Fn() -> DevInfoPayload + Send + Sync>;

pub struct PwaServerHandle {
    _join: thread::JoinHandle<()>,
}

pub fn start_pwa_server(
    dist_root: PathBuf,
    bridge_port_file: PathBuf,
    dev_info: DevInfoSupplier,
) -> Result<PwaServerHandle, String> {
    if !dist_root.is_dir() {
        return Err(format!(
            "PWA dist directory missing: {}",
            dist_root.display()
        ));
    }

    let profile = crate::app_paths::profile();
    let wanted = crate::app_paths::pwa_port_for(profile.as_deref());
    let listener = bind_first_free(&crate::app_paths::pwa_port_candidates(profile.as_deref()))
        .map_err(|err| format!("bind PWA server on {HOST}:{wanted}: {err}"))?;
    if listener.local_addr().map(|a| a.port()).ok() != Some(wanted) {
        PORT_MOVED.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    if let Ok(addr) = listener.local_addr() {
        let _ = BOUND_PORT.set(addr.port());
    }

    let join = thread::Builder::new()
        .name("potato-workspace-pwa-server".into())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let dist_root = dist_root.clone();
                        let bridge_port_file = bridge_port_file.clone();
                        let dev_info = dev_info.clone();
                        thread::spawn(move || {
                            if let Err(err) =
                                handle_connection(stream, &dist_root, &bridge_port_file, &dev_info, None)
                            {
                                tracing::debug!(%err, "PWA request failed");
                            }
                        });
                    }
                    Err(err) => tracing::debug!(%err, "PWA accept failed"),
                }
            }
        })
        .map_err(|err| format!("spawn PWA server thread: {err}"))?;

    Ok(PwaServerHandle { _join: join })
}

/// Serve one connection. `remote` is `Some` only on the tunnel listener (`tunnel_listener.rs`), where every
/// request is a remote one: its Host is checked against the tunnel's hostname before anything is forwarded.
fn handle_connection(
    mut stream: TcpStream,
    dist_root: &Path,
    bridge_port_file: &Path,
    dev_info: &DevInfoSupplier,
    remote: Option<&tunnel_listener::RemoteCtx>,
) -> Result<(), String> {
    let Some(_slot) = ConnectionSlot::take(MAX_CONNECTIONS) else {
        return write_text(&mut stream, 503, "Too many connections");
    };
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(30)));
    let peer_loopback = stream.peer_addr().map(|addr| addr.ip().is_loopback()).unwrap_or(false);
    // Until a request shows a bearer token it counts against the anonymous limit, which leaves RESERVED_FOR_BEARER slots free.
    let mut anon_slot = ConnectionSlot::take_from(&ANON_CONNECTIONS, MAX_CONNECTIONS - RESERVED_FOR_BEARER);
    let mut deadline = read_deadline_for(anon_slot.is_some(), false);
    let started = std::time::Instant::now();
    let mut buf = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end;
    loop {
        let n = read_within(&mut stream, &mut chunk, started, deadline, "request head")?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_header_end(&buf) {
            header_end = pos;
            break;
        }
        if buf.len() > MAX_HEAD_BYTES {
            return Err("request headers too large".into());
        }
    }

    let headers_raw = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = headers_raw.lines();
    let request_line = lines.next().ok_or("empty request")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let target = parts.next().unwrap_or("/");
    let (path, query) = split_target(target);
    // Trusted: a paired device's token (known, not merely present) or this computer's own app. Those leave the
    // anonymous pool, may send 16 MB and get the full read deadline. The bridge still does its own auth afterwards.
    let has_bearer = known_device_token(&headers_raw)
        || (remote.is_none() && !crate::mobile_pairing::requires_pairing_token(&headers_raw, peer_loopback));
    if has_bearer {
        drop(anon_slot.take());
        deadline = read_deadline_for(false, true);
    }
    let preflight = method == "OPTIONS" && parse_content_length(&headers_raw) == 0 && path.starts_with("/bridge");
    if !admit(anon_slot.is_some(), has_bearer, is_public_request(path, method) || preflight) {
        return write_text(&mut stream, 503, "Too many connections");
    }
    if remote.is_none() && is_pair_path(path) && peer_loopback {
        // Through the quick address Cloudflare sets this header and a visitor cannot choose it. Without it the request is
        // not known to come from the internet, so no per-visitor count applies.
        if let Some(visitor) = cf_connecting_ip(&headers_raw) {
            if !QUICK_PAIR_THROTTLE.allow(Some(visitor), std::time::Instant::now()) {
                return write_text(&mut stream, 429, "Too Many Requests");
            }
        }
    }
    if let Some(remote) = remote {
        if let Some((status, message)) = remote.gate(method, path, &headers_raw) {
            let sent = write_text(&mut stream, status, message);
            // The request's body is still unread. Closing now would reset the connection and the reply could be lost, so read what is left first.
            let _ = stream.shutdown(std::net::Shutdown::Write);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            let mut sink = [0_u8; 4096];
            let mut drained = 0_usize;
            while drained < 64 * 1024 {
                match stream.read(&mut sink) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => drained += n,
                }
            }
            return sent;
        }
    }

    let content_length = parse_content_length(&headers_raw);
    let is_bridge = path == "/bridge" || path.starts_with("/bridge/");
    let body_start = header_end + 4;
    // Only a request headed for the bridge has a body worth reading (the static files and the dev info
    // take none), and the size is checked before a single body byte is buffered.
    let body_cap = if has_bearer { MAX_BODY_BYTES } else { UNAUTH_BODY_BYTES };
    if is_bridge && content_length > body_cap && !is_websocket_upgrade(&headers_raw) {
        return write_text(&mut stream, 413, "Payload Too Large");
    }
    if is_bridge && !is_websocket_upgrade(&headers_raw) {
        while buf.len().saturating_sub(body_start) < content_length {
            let n = read_within(&mut stream, &mut chunk, started, deadline, "request body")?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    }
    // Long-lived paths (a WebSocket tunnel, a long poll) must not be cut off by the head/body timeout.
    let _ = stream.set_read_timeout(None);
    let body_end = if is_bridge { body_start.saturating_add(content_length).min(buf.len()) } else { body_start.min(buf.len()) };
    let body = &buf[body_start.min(buf.len())..body_end];

    // The tunnel address and local URLs are for this computer's own screens. Anyone coming through the tunnel (or any
    // forwarder) gets what an unknown path gets.
    if path == "/__puppet_master_dev__.json"
        && method == "GET"
        && remote.is_none()
        && !crate::mobile_pairing::requires_pairing_token(&headers_raw, peer_loopback)
    {
        let payload = dev_info();
        return write_json(&mut stream, 200, &payload);
    }

    if path == "/bridge" || path.starts_with("/bridge/") {
        let bridge_path = path.strip_prefix("/bridge").unwrap_or("");
        let bridge_path = if bridge_path.is_empty() {
            "/"
        } else {
            bridge_path
        };
        // The query string travels with the path (`/events/poll?cursor=...`, `/panes/x/buffer?view=...`).
        let bridge_path = if query.is_empty() {
            bridge_path.to_string()
        } else {
            format!("{bridge_path}?{query}")
        };
        let bridge_path = bridge_path.as_str();
        if is_websocket_upgrade(&headers_raw) {
            // Bytes the client sent after the head belong to the tunnel, not to a body.
            return proxy_upgrade(
                &mut stream,
                bridge_port_file,
                method,
                bridge_path,
                &headers_raw,
                &buf[body_start..],
            );
        }
        return proxy_bridge(
            &mut stream,
            bridge_port_file,
            method,
            bridge_path,
            &headers_raw,
            body,
        );
    }

    serve_static(&mut stream, dist_root, path, method)
}

/// One read that waits at most `READ_STEP` and never past `deadline` (counted from `started`), so a client that
/// drips bytes cannot hold the connection longer than the overall deadline.
fn read_within(
    stream: &mut TcpStream,
    chunk: &mut [u8],
    started: std::time::Instant,
    deadline: std::time::Duration,
    what: &str,
) -> Result<usize, String> {
    let left = deadline
        .checked_sub(started.elapsed())
        .filter(|left| !left.is_zero())
        .ok_or_else(|| format!("{what} took too long"))?;
    let _ = stream.set_read_timeout(Some(left.min(READ_STEP)));
    stream.read(chunk).map_err(|err| match err.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => format!("{what} took too long"),
        _ => format!("read {what}: {err}"),
    })
}

/// How long a request has to arrive: the short overflow limit only for an anonymous request that found the anonymous
/// pool full; a trusted one (paired device, this computer) always gets the full limit, for its body too.
fn read_deadline_for(has_anon_slot: bool, trusted: bool) -> std::time::Duration {
    if has_anon_slot || trusted {
        READ_DEADLINE
    } else {
        OVERFLOW_HEAD_DEADLINE
    }
}

/// The bearer token a request names: the `Authorization` header, or the WebSocket subprotocol offer
/// (`pm-bearer.<token>` or `pm-bearer-hex.<hex>`).
fn offered_token(headers_raw: &str) -> Option<String> {
    crate::mobile_pairing::bearer_token(headers_raw)
        .filter(|token| !token.is_empty())
        .or_else(|| {
            let offer = crate::mobile_pairing::header_value(headers_raw, "Sec-WebSocket-Protocol")?;
            crate::bridge::ws::bearer_from_protocols(offer)
        })
}

/// True when the request carries the token of a device that is paired right now (a hash compare, nothing changes and
/// nothing is read from disk). A made-up token, or a store that is not up yet, is not known. It only picks the size
/// limit and the slot; the bridge still authorizes the request in full.
fn known_device_token(headers_raw: &str) -> bool {
    let Some(token) = offered_token(headers_raw) else {
        return false;
    };
    crate::mobile_pairing::pairing_store().is_some_and(|store| store.lock().device_id_for_token(&token).is_some())
}

/// The bridge's public routes (health, pairing, the push tap, share links): no bearer by design.
fn is_public_request(path: &str, method: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    segments.first() == Some(&"bridge") && crate::mobile_pairing::is_public_bridge_path(&segments, method)
}

/// Whether a request may go on: a connection that got no anonymous slot is only for a bearer or a public route.
fn admit(has_anon_slot: bool, has_bearer: bool, public: bool) -> bool {
    has_anon_slot || has_bearer || public
}

/// `/bridge/pair` and `/bridge/pair/session/<code>`.
fn is_pair_path(path: &str) -> bool {
    let mut segments = path.split('/').filter(|part| !part.is_empty());
    segments.next() == Some("bridge") && segments.next() == Some("pair")
}

/// The visitor address Cloudflare names in `CF-Connecting-IP`.
fn cf_connecting_ip(headers_raw: &str) -> Option<std::net::IpAddr> {
    crate::mobile_pairing::header_value(headers_raw, "CF-Connecting-IP")
        .and_then(|value| value.parse::<std::net::IpAddr>().ok())
        .map(|ip| match ip.to_canonical() {
            // One person can rotate through a whole /64, so an IPv6 visitor is counted by its /64.
            std::net::IpAddr::V6(v6) => {
                let mut octets = v6.octets();
                octets[8..].fill(0);
                std::net::IpAddr::V6(octets.into())
            }
            v4 => v4,
        })
}

/// Put the security headers into a response the bridge produced. A header the bridge already set stays as it is, except
/// that a Content-Security-Policy without `frame-ancestors` gets that directive added.
fn with_security_headers(response: Vec<u8>) -> Vec<u8> {
    let Some(end) = find_header_end(&response) else {
        return response;
    };
    let head = String::from_utf8_lossy(&response[..end]).into_owned();
    let mut lines: Vec<String> = head.split("\r\n").map(str::to_string).collect();
    let find = |lines: &[String], name: &str| lines.iter().skip(1).position(|l| is_header_line(l, name)).map(|i| i + 1);
    match find(&lines, "content-security-policy") {
        Some(i) if !lines[i].to_ascii_lowercase().contains("frame-ancestors") => lines[i].push_str("; frame-ancestors 'none'"),
        Some(_) => {}
        None => lines.push("Content-Security-Policy: frame-ancestors 'none'".into()),
    }
    for (name, line) in [
        ("x-frame-options", "X-Frame-Options: DENY"),
        ("x-content-type-options", "X-Content-Type-Options: nosniff"),
        ("referrer-policy", "Referrer-Policy: no-referrer"),
    ] {
        if find(&lines, name).is_none() {
            lines.push(line.into());
        }
    }
    let mut out = lines.join("\r\n").into_bytes();
    out.extend_from_slice(&response[end..]);
    out
}

fn looks_like_asset_path(path: &str) -> bool {
    let rel = path.trim_start_matches('/');
    if rel.is_empty() {
        return false;
    }
    if rel.starts_with("assets/") || rel.starts_with("@") || rel.starts_with("src/") {
        return true;
    }
    rel.rsplit_once('.').is_some_and(|(_, ext)| {
        matches!(
            ext,
            "js" | "mjs"
                | "ts"
                | "tsx"
                | "css"
                | "map"
                | "json"
                | "wasm"
                | "svg"
                | "png"
                | "ico"
                | "woff2"
        )
    })
}

fn serve_static(
    stream: &mut TcpStream,
    dist_root: &Path,
    path: &str,
    method: &str,
) -> Result<(), String> {
    if method != "GET" && method != "HEAD" {
        return write_text(stream, 405, "Method Not Allowed");
    }

    let rel = path.trim_start_matches('/');
    let mut file_path = if rel.is_empty() {
        dist_root.join("index.html")
    } else {
        dist_root.join(rel)
    };

    if file_path.is_dir() {
        file_path = file_path.join("index.html");
    }

    if !file_path.exists() {
        if looks_like_asset_path(path) {
            return write_text(stream, 404, "Not Found");
        }
        file_path = dist_root.join("index.html");
    }

    let canonical_root = dist_root
        .canonicalize()
        .map_err(|err| format!("canonicalize dist root: {err}"))?;
    let canonical_file = file_path
        .canonicalize()
        .map_err(|_| "not found".to_string())?;
    if !canonical_file.starts_with(&canonical_root) {
        return write_text(stream, 403, "Forbidden");
    }

    let bytes = fs::read(&canonical_file).map_err(|_| "not found".to_string())?;
    let content_type = content_type_for(&canonical_file);
    write_bytes(stream, 200, content_type, &bytes, method == "HEAD")
}

fn is_websocket_upgrade(headers_raw: &str) -> bool {
    headers_raw.lines().skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("upgrade")
                && value.trim().eq_ignore_ascii_case("websocket")
        })
    })
}

/// Header the bridge reads as "this request came through the PWA proxy, so it is a remote caller":
/// it then demands a paired-device bearer token (`mobile_pairing::requires_pairing_token`).
const PROXY_MARKER: &str = "X-Potato-Workspace-Proxied";
/// The older build's marker name. A client's copy is dropped too, so the bridge only ever sees the proxy's own marker.
const LEGACY_PROXY_MARKER: &str = "x-pm-proxied";

/// True for a request-head line that names `name` (case-insensitive, and tolerant of leading
/// whitespace the way the bridge's own header lookup is, so an obs-fold trick cannot slip one by).
fn is_header_line(line: &str, name: &str) -> bool {
    line.split_once(':')
        .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case(name))
}

/// Append the marker. Every request this server forwards came from outside the machine (the
/// tunnel), whatever the client claims, so the marker is not optional and not the client's to set.
fn push_proxy_marker(request: &mut String) {
    request.push_str(PROXY_MARKER);
    request.push_str(": 1\r\n");
}

/// Pass a WebSocket upgrade through: the request head goes upstream as the client sent it
/// (Connection/Upgrade/Sec-WebSocket-* included) except that any client `X-Potato-Workspace-Proxied` is dropped
/// and ours is added, then bytes are copied both ways until either side closes.
fn proxy_upgrade(
    stream: &mut TcpStream,
    bridge_port_file: &Path,
    method: &str,
    path: &str,
    headers_raw: &str,
    leftover: &[u8],
) -> Result<(), String> {
    let Some((mut upstream, _bridge_addr)) = connect_bridge(stream, bridge_port_file)? else {
        return Ok(());
    };

    let mut request = format!("{method} {path} HTTP/1.1\r\n");
    for line in headers_raw.lines().skip(1) {
        if is_header_line(line, PROXY_MARKER) || is_header_line(line, LEGACY_PROXY_MARKER) {
            continue;
        }
        request.push_str(line);
        request.push_str("\r\n");
    }
    push_proxy_marker(&mut request);
    request.push_str("\r\n");
    upstream
        .write_all(request.as_bytes())
        .map_err(|err| format!("write bridge upgrade request: {err}"))?;
    if !leftover.is_empty() {
        upstream
            .write_all(leftover)
            .map_err(|err| format!("write bridge upgrade body: {err}"))?;
    }

    let mut client_reader = stream
        .try_clone()
        .map_err(|err| format!("clone client socket: {err}"))?;
    let mut upstream_writer = upstream
        .try_clone()
        .map_err(|err| format!("clone bridge socket: {err}"))?;
    let client_shutdown = stream
        .try_clone()
        .map_err(|err| format!("clone client socket: {err}"))?;

    // client -> bridge; when the client stops, close the bridge side so the other copy ends too.
    let to_bridge = thread::spawn(move || {
        let _ = std::io::copy(&mut client_reader, &mut upstream_writer);
        let _ = upstream_writer.shutdown(std::net::Shutdown::Both);
    });
    // bridge -> client; when the bridge stops, close the client side so the other copy ends too.
    let _ = std::io::copy(&mut upstream, stream);
    let _ = client_shutdown.shutdown(std::net::Shutdown::Both);
    let _ = to_bridge.join();
    Ok(())
}

fn proxy_bridge(
    stream: &mut TcpStream,
    bridge_port_file: &Path,
    method: &str,
    path: &str,
    headers_raw: &str,
    body: &[u8],
) -> Result<(), String> {
    let Some((mut upstream, bridge_addr)) = connect_bridge(stream, bridge_port_file)? else {
        return Ok(());
    };

    let mut request = format!("{method} {path} HTTP/1.1\r\n");
    for line in headers_raw.lines().skip(1) {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:")
            || lower.starts_with("connection:")
            || lower.starts_with("proxy-connection:")
            || lower.starts_with("content-length:")
            || is_header_line(line, PROXY_MARKER)
            || is_header_line(line, LEGACY_PROXY_MARKER)
        {
            continue;
        }
        request.push_str(line);
        request.push_str("\r\n");
    }
    request.push_str(&format!("Host: {bridge_addr}\r\n"));
    push_proxy_marker(&mut request);
    request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    request.push_str("Connection: close\r\n\r\n");
    upstream
        .write_all(request.as_bytes())
        .map_err(|err| format!("write bridge request: {err}"))?;
    if !body.is_empty() {
        upstream
            .write_all(body)
            .map_err(|err| format!("write bridge body: {err}"))?;
    }

    let mut response = Vec::new();
    upstream
        .read_to_end(&mut response)
        .map_err(|err| format!("read bridge response: {err}"))?;
    stream
        .write_all(&with_security_headers(response))
        .map_err(|err| format!("write proxy response: {err}"))?;
    Ok(())
}

/// Connect to the bridge named by the port file, re-read on every call (the app picks a new port
/// each launch, so nothing is cached). When nothing listens, the phone gets a clear 502 JSON
/// `{code:"BRIDGE_UNREACHABLE", message}` instead of a dropped connection, and `Ok(None)` comes back.
/// The reply never names the port file's path (this server is reachable through the public tunnel).
fn connect_bridge(
    stream: &mut TcpStream,
    bridge_port_file: &Path,
) -> Result<Option<(TcpStream, String)>, String> {
    let bridge_addr = read_bridge_addr(bridge_port_file);
    match TcpStream::connect(&bridge_addr) {
        Ok(upstream) => Ok(Some((upstream, bridge_addr))),
        Err(err) => {
            tracing::debug!(%err, %bridge_addr, "bridge unreachable");
            let port = bridge_addr.rsplit(':').next().unwrap_or("?");
            let body = serde_json::json!({
                "code": "BRIDGE_UNREACHABLE",
                "message": format!("The Potato Workspace app's bridge is not running on port {port}."),
            });
            write_json(stream, 502, &body)?;
            Ok(None)
        }
    }
}

/// `host:port` of the embedded bridge from its port file (`127.0.0.1:17421`, or just the port).
/// Bare, not a URL: it goes to `TcpStream::connect` and the upstream `Host` header (it used to be
/// `http://host:port`, which `connect` cannot resolve, so the proxy never reached the bridge).
fn read_bridge_addr(bridge_port_file: &Path) -> String {
    match fs::read_to_string(bridge_port_file) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.contains(':') {
                trimmed.to_string()
            } else if !trimmed.is_empty() {
                format!("127.0.0.1:{trimmed}")
            } else {
                default_bridge_addr()
            }
        }
        Err(_) => default_bridge_addr(),
    }
}

/// Where the bridge is when there is no port file: the first port of Potato Workspace's own range,
/// never the other product's 17321.
fn default_bridge_addr() -> String {
    format!("127.0.0.1:{}", crate::app_paths::bridge_port_range_for(None).0)
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn split_target(target: &str) -> (&str, &str) {
    match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    }
}

fn parse_content_length(headers: &str) -> usize {
    for line in headers.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                if let Ok(n) = value.trim().parse::<usize>() {
                    return n;
                }
            }
        }
    }
    0
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

fn write_json(stream: &mut TcpStream, status: u16, value: &impl Serialize) -> Result<(), String> {
    let body = serde_json::to_string(value).map_err(|err| format!("json encode: {err}"))?;
    write_text_body(stream, status, "application/json; charset=utf-8", &body)
}

fn write_text(stream: &mut TcpStream, status: u16, message: &str) -> Result<(), String> {
    write_text_body(stream, status, "text/plain; charset=utf-8", message)
}

fn write_text_body(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    write_bytes(stream, status, content_type, body.as_bytes(), false)
}

fn write_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        421 => "Misdirected Request",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        502 => "Bad Gateway",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{SECURITY_HEADERS}Connection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|err| format!("write headers: {err}"))?;
    if !head_only {
        stream
            .write_all(body)
            .map_err(|err| format!("write body: {err}"))?;
    }
    Ok(())
}

/// Test hook: serve `handle_connection` on an ephemeral loopback port (the production listener is
/// pinned to `PWA_PORT`). Returns the address to connect to.
#[cfg(test)]
pub(crate) fn spawn_test_server(dist_root: PathBuf, bridge_port_file: PathBuf) -> std::net::SocketAddr {
    let listener = TcpListener::bind((HOST, 0)).expect("bind test pwa server");
    let addr = listener.local_addr().expect("test pwa server addr");
    let dev_info: DevInfoSupplier = Arc::new(|| DevInfoPayload {
        local_url: "http://127.0.0.1:1".into(),
        pwa_url: "http://127.0.0.1:1".into(),
        tunnel_url: Some("https://secret-tunnel.example".into()),
        tunnel_provider: None,
        bridge_proxy_url: "http://127.0.0.1:1/bridge".into(),
        bridge_direct_url: None,
        updated_at: 0,
    });
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (dist_root, bridge_port_file, dev_info) =
                (dist_root.clone(), bridge_port_file.clone(), dev_info.clone());
            thread::spawn(move || {
                let _ = handle_connection(stream, &dist_root, &bridge_port_file, &dev_info, None);
            });
        }
    });
    addr
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_bridge_addr_parses_host_port_file() {
        let dir = std::env::temp_dir().join(format!("pm-pwa-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("port");
        fs::write(&file, "127.0.0.1:17455\n").unwrap();
        assert_eq!(read_bridge_addr(&file), "127.0.0.1:17455");
        // Empty or missing file: the first port of our own range, never the other product's 17321.
        fs::write(&file, "\n").unwrap();
        assert_eq!(read_bridge_addr(&file), "127.0.0.1:17421");
        assert_eq!(read_bridge_addr(&dir.join("missing")), "127.0.0.1:17421");
        let _ = fs::remove_dir_all(dir);
    }

    /// A one-shot HTTP upstream on a free loopback port: answers every request with `label`.
    fn tiny_upstream(label: &'static str) -> u16 {
        let listener = TcpListener::bind((HOST, 0)).expect("bind upstream");
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0_u8; 4096];
                let _ = stream.read(&mut buf);
                let body = format!("{{\"from\":\"{label}\"}}");
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    fn free_port() -> u16 {
        let listener = TcpListener::bind((HOST, 0)).expect("bind probe");
        listener.local_addr().unwrap().port()
    }

    fn raw_get(addr: std::net::SocketAddr, path: &str) -> String {
        let mut client = TcpStream::connect(addr).expect("connect pwa server");
        write!(client, "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
        let mut out = String::new();
        client.read_to_string(&mut out).unwrap();
        out
    }

    /// The built app's phone server must follow the port file on every request: the bridge takes a
    /// new port each launch, and a phone page that stays open across an app restart must reach it.
    #[test]
    fn bridge_proxy_rereads_the_port_file_on_every_request() {
        let dir = std::env::temp_dir().join(format!("pm-pwa-rr-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let port_file = dir.join("bridge.port");
        let (a, b) = (tiny_upstream("a"), tiny_upstream("b"));
        let pwa = spawn_test_server(dir.clone(), port_file.clone());

        fs::write(&port_file, format!("127.0.0.1:{a}\n")).unwrap();
        assert!(raw_get(pwa, "/bridge/health").contains("\"from\":\"a\""));
        fs::write(&port_file, format!("127.0.0.1:{b}\n")).unwrap();
        let second = raw_get(pwa, "/bridge/health");
        assert!(second.contains("\"from\":\"b\""), "second request must go to the new port: {second}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn bridge_proxy_answers_502_json_when_nothing_listens() {
        let dir = std::env::temp_dir().join(format!("pm-pwa-502-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let port_file = dir.join("bridge.port");
        let dead = free_port();
        fs::write(&port_file, format!("127.0.0.1:{dead}\n")).unwrap();
        let pwa = spawn_test_server(dir.clone(), port_file.clone());

        let reply = raw_get(pwa, "/bridge/health");
        assert!(reply.starts_with("HTTP/1.1 502 Bad Gateway"), "{reply}");
        assert!(reply.contains("application/json"), "{reply}");
        assert!(reply.contains("\"code\":\"BRIDGE_UNREACHABLE\""), "{reply}");
        assert!(reply.contains(&format!("port {dead}")), "{reply}");
        assert!(!reply.contains(port_file.to_string_lossy().as_ref()), "the reply must not leak the port file path");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn looks_like_asset_path_detects_js_and_vite_paths() {
        assert!(looks_like_asset_path("/src/main.tsx"));
        assert!(looks_like_asset_path("/assets/index.js"));
        assert!(looks_like_asset_path("/@vite/client"));
        assert!(!looks_like_asset_path("/pair/invite"));
    }

    #[test]
    fn content_length_is_found_whatever_the_header_case() {
        assert_eq!(parse_content_length("POST / HTTP/1.1\r\nCONTENT-LENGTH: 12\r\n"), 12);
        assert_eq!(parse_content_length("POST / HTTP/1.1\r\ncontent-Length:7\r\n"), 7);
        assert_eq!(parse_content_length("POST / HTTP/1.1\r\nHost: x\r\n"), 0);
    }

    #[test]
    fn an_oversized_bridge_body_gets_413_before_it_is_read() {
        let dir = std::env::temp_dir().join(format!("pm-pwa-413-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let pwa = spawn_test_server(dir.clone(), dir.join("bridge.port"));
        let mut client = TcpStream::connect(pwa).unwrap();
        client.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        write!(
            client,
            "POST /bridge/x HTTP/1.1\r\nHost: x\r\nCONTENT-LENGTH: {}\r\nConnection: close\r\n\r\n",
            MAX_BODY_BYTES + 1
        )
        .unwrap();
        let mut out = String::new();
        let _ = client.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 413"), "{out}");
        let _ = fs::remove_dir_all(dir);
    }

    /// An upstream that reads each whole request (head and body) before it answers 200, so a big body never meets a reset.
    fn draining_upstream() -> u16 {
        let listener = TcpListener::bind((HOST, 0)).expect("bind upstream");
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                thread::spawn(move || {
                    let mut got = Vec::new();
                    let mut chunk = [0_u8; 65536];
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(20)));
                    while let Ok(n) = stream.read(&mut chunk) {
                        if n == 0 {
                            break;
                        }
                        got.extend_from_slice(&chunk[..n]);
                        if let Some(end) = find_header_end(&got) {
                            let head = String::from_utf8_lossy(&got[..end]).into_owned();
                            if got.len() >= end + 4 + parse_content_length(&head) {
                                break;
                            }
                        }
                    }
                    let body = format!("{{\"got\":{}}}", got.len());
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                });
            }
        });
        port
    }

    fn bridge_rig(name: &str, upstream: u16) -> std::net::SocketAddr {
        let dir = std::env::temp_dir().join(format!("pm-pwa-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("index.html"), "<html>phone</html>").unwrap();
        fs::write(dir.join("bridge.port"), format!("127.0.0.1:{upstream}\n")).unwrap();
        spawn_test_server(dir.clone(), dir.join("bridge.port"))
    }

    fn send_raw(addr: std::net::SocketAddr, head: &str, body_len: usize) -> String {
        let mut client = TcpStream::connect(addr).expect("connect pwa server");
        client.set_read_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
        client.write_all(head.as_bytes()).unwrap();
        let body = vec![b'a'; body_len];
        // The server may answer (413) and close before the body is all sent; that is fine.
        let _ = client.write_all(&body);
        let mut out = Vec::new();
        let _ = client.read_to_end(&mut out);
        String::from_utf8_lossy(&out).into_owned()
    }

    /// A header only a forwarder adds: marks the request as coming from outside (not this computer's own app).
    const FROM_OUTSIDE: &str = "X-Forwarded-For: 203.0.113.9\r\n";

    /// A paired phone's token, from the process-wide store (the first store set wins, as in the other tests).
    fn paired_token() -> String {
        use crate::mobile_pairing::{init_pairing_store, pairing_store, Caps, PairRequestBody};
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        while pairing_store().is_none() {
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("pm-pwa-store-{}-{n}", std::process::id()));
            let _ = fs::create_dir_all(&dir);
            let _ = init_pairing_store(dir.join("pairing.json"));
        }
        let store = pairing_store().expect("pairing store");
        let mut guard = store.lock();
        let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), Caps::all());
        guard
            .pair_device(PairRequestBody {
                pairing_code: session.pairing_code,
                device_name: "pwa server test phone".into(),
                device_public_key: session.server_public_key,
            })
            .expect("pair")
            .device_token
    }

    fn post(path: &str, extra: &str, len: usize) -> String {
        format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}Content-Length: {len}\r\nConnection: close\r\n\r\n")
    }

    #[test]
    fn a_body_over_64_kb_without_a_bearer_gets_413_but_a_small_one_goes_through() {
        let pwa = bridge_rig("unauth", draining_upstream());
        let big = UNAUTH_BODY_BYTES + 1;
        let reply = send_raw(pwa, &post("/bridge/panes", FROM_OUTSIDE, big), big);
        assert!(reply.starts_with("HTTP/1.1 413"), "{reply}");
        // Pairing has no bearer either; its small body is passed on.
        let small = send_raw(pwa, &post("/bridge/pair", FROM_OUTSIDE, 200), 200);
        assert!(small.starts_with("HTTP/1.1 200") && small.contains("\"got\""), "{small}");
        // exactly at the cap is allowed
        let at_cap = send_raw(pwa, &post("/bridge/push/act", FROM_OUTSIDE, UNAUTH_BODY_BYTES), UNAUTH_BODY_BYTES);
        assert!(at_cap.starts_with("HTTP/1.1 200"), "{at_cap}");
    }

    #[test]
    fn a_bearer_request_may_send_up_to_16_mb() {
        let pwa = bridge_rig("bearer", draining_upstream());
        let auth = &format!("Authorization: Bearer {}\r\n{FROM_OUTSIDE}", paired_token());
        let full = send_raw(pwa, &post("/bridge/panes", auth, MAX_BODY_BYTES), MAX_BODY_BYTES);
        assert!(full.starts_with("HTTP/1.1 200"), "a 16 MB body with a bearer must go through: {}", &full[..full.len().min(200)]);
        // the upstream saw the whole body (it counts head + body bytes, so at least the body)
        let got: usize = full.rsplit("\"got\":").next().unwrap().trim_end_matches('}').parse().unwrap();
        assert!(got >= MAX_BODY_BYTES, "upstream got {got}");
        let over = send_raw(pwa, &post("/bridge/panes", auth, MAX_BODY_BYTES + 1), 0);
        assert!(over.starts_with("HTTP/1.1 413"), "{over}");
    }

    #[test]
    fn a_made_up_bearer_gets_no_more_than_an_anonymous_request() {
        let pwa = bridge_rig("fakebearer", draining_upstream());
        let fake = format!("Authorization: Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\r\n{FROM_OUTSIDE}");
        let big = UNAUTH_BODY_BYTES + 1;
        let reply = send_raw(pwa, &post("/bridge/panes", &fake, big), big);
        assert!(reply.starts_with("HTTP/1.1 413"), "{reply}");
        assert!(!known_device_token(&post("/bridge/panes", &fake, 0)));
        // the phone's WebSocket form of a real token counts as known
        let token = paired_token();
        let hex: String = token.bytes().map(|b| format!("{b:02x}")).collect();
        assert!(known_device_token(&format!("GET /bridge/events/ws HTTP/1.1\r\nSec-WebSocket-Protocol: pm-events, pm-bearer-hex.{hex}\r\n")));
        assert!(known_device_token(&format!("GET /bridge/events/ws HTTP/1.1\r\nSec-WebSocket-Protocol: pm-events, pm-bearer.{token}\r\n")));
    }

    #[test]
    fn this_computers_own_app_may_send_a_big_body_without_a_token() {
        let pwa = bridge_rig("localbig", draining_upstream());
        let size = UNAUTH_BODY_BYTES * 4;
        // no forwarder header, loopback Host: the app itself (an unpaired page opened at 127.0.0.1)
        let local = send_raw(pwa, &post("/bridge/panes", "", size), size);
        assert!(local.starts_with("HTTP/1.1 200"), "{}", &local[..local.len().min(200)]);
        // the same body from outside is refused
        let outside = send_raw(pwa, &post("/bridge/panes", FROM_OUTSIDE, size), size);
        assert!(outside.starts_with("HTTP/1.1 413"), "{outside}");
    }

    #[test]
    fn a_pairing_visitor_is_counted_by_its_ipv6_block() {
        let a = cf_connecting_ip("GET / HTTP/1.1\r\nCf-Connecting-Ip: 2001:db8:1:2:aaaa:bbbb:cccc:dddd\r\n");
        let b = cf_connecting_ip("GET / HTTP/1.1\r\nCf-Connecting-Ip: 2001:db8:1:2:1:2:3:4\r\n");
        let c = cf_connecting_ip("GET / HTTP/1.1\r\nCf-Connecting-Ip: 2001:db8:1:3::1\r\n");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(cf_connecting_ip("GET / HTTP/1.1\r\nCf-Connecting-Ip: 203.0.113.9\r\n"), Some("203.0.113.9".parse().unwrap()));
    }

    #[test]
    fn a_read_never_waits_past_what_is_left_of_the_deadline() {
        let listener = TcpListener::bind((HOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        // A client that sends one byte every 100 ms for far longer than the deadline.
        let dripper = thread::spawn(move || {
            let mut client = TcpStream::connect(addr).unwrap();
            for _ in 0..50 {
                if client.write_all(b"a").is_err() {
                    break;
                }
                thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        let (mut server_side, _) = listener.accept().unwrap();
        let started = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(400);
        let mut chunk = [0_u8; 16];
        let outcome = loop {
            match read_within(&mut server_side, &mut chunk, started, deadline, "request body") {
                Ok(0) => break Ok(()),
                Ok(_) => continue,
                Err(err) => break Err(err),
            }
        };
        let took = started.elapsed();
        assert!(outcome.is_err_and(|e| e.contains("took too long")));
        assert!(took < std::time::Duration::from_millis(1500), "held for {took:?}; READ_STEP is {READ_STEP:?}");
        drop(server_side);
        let _ = dripper.join();
    }

    #[test]
    fn a_silent_client_is_cut_off_at_the_deadline_not_a_step_later() {
        // One read is limited by what is left: with 300 ms left it must not wait the whole 10 s step.
        let listener = TcpListener::bind((HOST, 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let _client = TcpStream::connect(addr).unwrap();
        let (mut server_side, _) = listener.accept().unwrap();
        let started = std::time::Instant::now();
        let mut chunk = [0_u8; 16];
        let err = read_within(&mut server_side, &mut chunk, started, std::time::Duration::from_millis(300), "request head").unwrap_err();
        assert!(err.contains("request head"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "{:?}", started.elapsed());
    }

    #[test]
    fn slots_are_kept_for_requests_with_a_bearer() {
        assert!(admit(true, false, false), "an anonymous slot lets an anonymous request go on");
        assert!(!admit(false, false, false), "no anonymous slot and no bearer: turned away");
        assert!(admit(false, true, false), "a bearer request uses the reserved slots");
        assert!(admit(false, false, true), "pairing and the push tap stay reachable");
        assert!(is_public_request("/bridge/pair", "POST"));
        assert!(is_public_request("/bridge/pair/session/123456", "GET"));
        assert!(is_public_request("/bridge/push/act", "POST"));
        assert!(!is_public_request("/bridge/panes", "GET"));
        assert!(!is_public_request("/pair", "POST"));
        assert_eq!(offered_token("GET / HTTP/1.1\r\nauthorization: Bearer abc\r\n").as_deref(), Some("abc"));
        assert_eq!(offered_token("GET /bridge/events/ws HTTP/1.1\r\nSec-WebSocket-Protocol: pm-events, pm-bearer.abc\r\n").as_deref(), Some("abc"));
        // the form the phone's page really sends: the token's UTF-8 bytes in hex ("tok+/=" has characters a subprotocol cannot hold)
        assert_eq!(offered_token("GET /bridge/events/ws HTTP/1.1\r\nSec-WebSocket-Protocol: pm-events, pm-bearer-hex.746f6b2b2f3d\r\n").as_deref(), Some("tok+/="));
        assert_eq!(offered_token("GET / HTTP/1.1\r\nAuthorization: Basic abc\r\n"), None);
        assert_eq!(offered_token("GET / HTTP/1.1\r\nAuthorization: Bearer \r\n"), None);
        assert!(!known_device_token("GET / HTTP/1.1\r\nAuthorization: Bearer not-a-real-token\r\n"));
        // a trusted request is never put on the short overflow deadline, body included
        assert_eq!(read_deadline_for(false, false), OVERFLOW_HEAD_DEADLINE);
        assert_eq!(read_deadline_for(false, true), READ_DEADLINE);
        assert_eq!(read_deadline_for(true, false), READ_DEADLINE);
        // The anonymous pool is smaller than the whole, by the reserve.
        let pool: &'static std::sync::atomic::AtomicUsize = Box::leak(Box::new(std::sync::atomic::AtomicUsize::new(0)));
        let held: Vec<_> = (0..MAX_CONNECTIONS - RESERVED_FOR_BEARER).map(|_| ConnectionSlot::take_from(pool, MAX_CONNECTIONS - RESERVED_FOR_BEARER).expect("anon slot")).collect();
        assert!(ConnectionSlot::take_from(pool, MAX_CONNECTIONS - RESERVED_FOR_BEARER).is_none());
        assert_eq!(held.len() + RESERVED_FOR_BEARER, MAX_CONNECTIONS);
    }

    #[test]
    fn every_reply_carries_the_security_headers() {
        let upstream = tiny_upstream("h");
        let pwa = bridge_rig("headers", upstream);
        for target in ["/", "/assets/missing.js", "/bridge/health", "/some/page"] {
            let reply = send_raw(pwa, &format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"), 0);
            let head = reply.split("\r\n\r\n").next().unwrap().to_ascii_lowercase();
            for needle in [
                "content-security-policy: frame-ancestors 'none'",
                "x-frame-options: deny",
                "x-content-type-options: nosniff",
                "referrer-policy: no-referrer",
            ] {
                assert!(head.contains(needle), "{target} lacks {needle}: {reply}");
            }
        }
        // 405 replies too
        let r405 = send_raw(pwa, "DELETE / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", 0);
        assert!(r405.starts_with("HTTP/1.1 405") && r405.contains("X-Frame-Options: DENY"), "{r405}");
    }

    #[test]
    fn security_headers_merge_into_a_policy_the_bridge_already_sent() {
        let with_policy = b"HTTP/1.1 200 OK\r\nContent-Security-Policy: sandbox; default-src 'none'\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 2\r\n\r\nhi".to_vec();
        let out = String::from_utf8(with_security_headers(with_policy)).unwrap();
        assert!(out.contains("Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'\r\n"), "{out}");
        assert_eq!(out.matches("X-Content-Type-Options").count(), 1, "{out}");
        assert!(out.contains("X-Frame-Options: DENY") && out.contains("Referrer-Policy: no-referrer"), "{out}");
        assert!(out.ends_with("\r\n\r\nhi"), "{out}");
        // a policy that already has it is left alone
        let already = b"HTTP/1.1 200 OK\r\ncontent-security-policy: frame-ancestors 'none'\r\n\r\n".to_vec();
        let out = String::from_utf8(with_security_headers(already)).unwrap();
        assert_eq!(out.to_ascii_lowercase().matches("content-security-policy").count(), 1, "{out}");
    }

    #[test]
    fn the_dev_info_is_for_this_computer_only() {
        let pwa = bridge_rig("devinfo", tiny_upstream("d"));
        let ask = |extra: &str, host: &str| {
            send_raw(pwa, &format!("GET /__puppet_master_dev__.json HTTP/1.1\r\nHost: {host}\r\n{extra}Connection: close\r\n\r\n"), 0)
        };
        let local = ask("", "127.0.0.1:1420");
        assert!(local.starts_with("HTTP/1.1 200") && local.contains("secret-tunnel.example"), "{local}");
        // through a forwarder (any of the usual headers), or with a public Host, or from a web page on another origin
        for (extra, host) in [
            ("X-Forwarded-For: 203.0.113.9\r\n", "127.0.0.1"),
            ("Cf-Connecting-Ip: 203.0.113.9\r\n", "127.0.0.1"),
            ("X-Potato-Workspace-Proxied: 1\r\n", "127.0.0.1"),
            ("", "abc.trycloudflare.com"),
            ("Origin: https://evil.example\r\n", "127.0.0.1"),
        ] {
            let reply = ask(extra, host);
            assert!(reply.starts_with("HTTP/1.1 404"), "{extra}{host}: {reply}");
            assert!(!reply.contains("secret-tunnel.example"), "{reply}");
        }
    }

    #[test]
    fn the_quick_address_slows_a_visitor_that_keeps_pairing() {
        let pwa = bridge_rig("quickthrottle", draining_upstream());
        let pair = |ip: &str| {
            let extra = if ip.is_empty() { String::new() } else { format!("Cf-Connecting-Ip: {ip}\r\n") };
            send_raw(pwa, &post("/bridge/pair", &extra, 2), 2)
        };
        let mut last = String::new();
        for _ in 0..=tunnel_listener::PAIR_TRIES {
            last = pair("198.51.100.201");
        }
        assert!(last.starts_with("HTTP/1.1 429"), "{last}");
        assert!(pair("198.51.100.202").starts_with("HTTP/1.1 200"), "another visitor is not slowed");
        // no visitor address: nothing to count by, so the local app is never slowed
        for _ in 0..=tunnel_listener::PAIR_TRIES + 2 {
            assert!(pair("").starts_with("HTTP/1.1 200"));
        }
        // a made-up address is not an address
        assert!(pair("not-an-ip").starts_with("HTTP/1.1 200"));
        // other bridge paths are not counted
        for _ in 0..=tunnel_listener::PAIR_TRIES + 2 {
            let r = send_raw(pwa, &post("/bridge/panes", "Cf-Connecting-Ip: 198.51.100.203\r\n", 2), 2);
            assert!(!r.starts_with("HTTP/1.1 429"), "{r}");
        }
    }


    #[test]
    fn connection_slots_are_bounded_and_released() {
        static LOCAL: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let a = ConnectionSlot::take_from(&LOCAL, 1).expect("first slot");
        assert!(ConnectionSlot::take_from(&LOCAL, 1).is_none());
        drop(a);
        assert!(ConnectionSlot::take_from(&LOCAL, 1).is_some());
    }
}
