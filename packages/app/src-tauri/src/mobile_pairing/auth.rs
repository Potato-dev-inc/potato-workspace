//! Bridge request authorization for paired mobile devices (public paths, bearer tokens, loopback bypass).

use super::*;

/// Strip a leading `bridge` segment when a reverse proxy forwards `/bridge/*` to the
/// embedded bridge without rewriting the path (common with custom domains).
pub fn normalize_bridge_segments<'a>(segments: &'a [&'a str]) -> &'a [&'a str] {
    match segments.first() {
        Some(&"bridge") if segments.len() > 1 => &segments[1..],
        _ => segments,
    }
}

pub fn is_public_bridge_path(segments: &[&str], method: &str) -> bool {
    let segments = normalize_bridge_segments(segments);
    (segments == ["health"] && method == "GET")
        || (segments == ["pair"] && method == "POST")
        // An Allow/Deny tap from a notification: authorised by its own one-shot token, not a bearer.
        || (segments == ["push", "act"] && method == "POST")
        || (segments.len() == 3
            && segments[0] == "pair"
            && segments[1] == "session"
            && method == "GET")
}

pub fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

pub fn bearer_token(headers: &str) -> Option<String> {
    let auth = header_value(headers, "Authorization")?;
    auth.strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .map(|t| t.trim().to_string())
}

/// Request headers that only a proxy, tunnel or CDN adds. The desktop app's own callers (webview,
/// CLI, MCP shim, Vite dev server) never send any of these to the bridge, so seeing one on a
/// loopback connection means a remote client reached us through a forwarder on this machine.
const REMOTE_INDICATOR_HEADERS: &[&str] = &[
    // our own PWA proxy and the Vite dev proxy
    "X-Potato-Workspace-Proxied",
    // the marker name of the older build: never sent by this app, but a client sending it through a
    // forwarder is still a remote caller, so it fails closed like the rest
    "x-pm-proxied",
    // Cloudflare (cloudflared tunnels)
    "Cf-Connecting-Ip",
    "Cf-Connecting-Ipv6",
    "Cf-Ray",
    "Cf-Visitor",
    "Cf-Ipcountry",
    "Cdn-Loop",
    "True-Client-Ip",
    // generic reverse proxies
    "X-Forwarded-For",
    "X-Forwarded-Host",
    "X-Forwarded-Proto",
    "X-Forwarded-Port",
    "X-Real-Ip",
    "Forwarded",
];

/// True when the request carries any header a forwarder adds.
pub fn has_remote_indicators(headers: &str) -> bool {
    REMOTE_INDICATOR_HEADERS
        .iter()
        .any(|name| header_value(headers, name).is_some())
}

fn is_loopback_host(value: &str) -> bool {
    let value = value.trim();
    let host = match value.strip_prefix('[') {
        // bracketed IPv6, with or without a port
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => match value.matches(':').count() {
            0 => value,
            1 => value.split(':').next().unwrap_or(""),
            _ => value, // bare IPv6
        },
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// True when a `Host` header names something other than this machine. A browser page reaching the
/// bridge by DNS rebinding, or a reverse proxy pointed straight at the bridge port, arrives from
/// loopback but carries its own hostname. No `Host` at all (HTTP/1.0 tooling) is not suspicious.
fn names_foreign_host(headers: &str) -> bool {
    headers.lines().any(|line| {
        line.split_once(':').is_some_and(|(key, value)| {
            key.trim().eq_ignore_ascii_case("host") && !is_loopback_host(value)
        })
    })
}

/// True when an `Origin` header says the request was made by a web page that is not the desktop
/// app. A browser always sends `Origin` on a cross-origin fetch, form post or WebSocket upgrade, so
/// any page open on this machine (a user's dev server on `localhost:5173`, a previewed site) can
/// reach `http://127.0.0.1:<port>`. A loopback peer alone does not make it the app: only the app's
/// own webview origins (see `is_app_origin`) are trusted, every other `Origin` (other localhost
/// ports, `*.localhost`, `null`) is foreign. CLI and MCP clients send no `Origin`.
fn names_foreign_origin(headers: &str) -> bool {
    headers.lines().any(|line| {
        line.split_once(':').is_some_and(|(key, value)| {
            key.trim().eq_ignore_ascii_case("origin") && !is_app_origin(value)
        })
    })
}

/// The webview origins Tauri uses for the packaged app.
const WEBVIEW_ORIGINS: [&str; 3] =
    ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

/// The Vite dev origins (`devUrl` in `tauri.conf.json`, on `127.0.0.1` and `localhost`). Empty in
/// release builds: a shipped app never has a dev server.
fn dev_origins() -> &'static [String] {
    static ORIGINS: once_cell::sync::Lazy<Vec<String>> = once_cell::sync::Lazy::new(|| {
        if cfg!(debug_assertions) {
            dev_origins_from_config(include_str!("../../tauri.conf.json"))
        } else {
            Vec::new()
        }
    });
    &ORIGINS
}

/// `http://127.0.0.1:<port>` and `http://localhost:<port>` for the `build.devUrl` of a Tauri config.
/// Only a loopback `http` devUrl with an explicit port counts; anything else yields nothing.
pub(super) fn dev_origins_from_config(config: &str) -> Vec<String> {
    let url = serde_json::from_str::<serde_json::Value>(config)
        .ok()
        .and_then(|v| v["build"]["devUrl"].as_str().map(str::to_string));
    let Some(authority) = url.as_deref().and_then(|u| u.strip_prefix("http://")) else {
        return Vec::new();
    };
    let authority = authority.split('/').next().unwrap_or("");
    let Some((host, port)) = authority.rsplit_once(':') else {
        return Vec::new();
    };
    if !matches!(host, "127.0.0.1" | "localhost") || port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return Vec::new();
    }
    vec![format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")]
}

/// True for an `Origin` value of the desktop app itself: its webview (`tauri://localhost`,
/// `http(s)://tauri.localhost`) or, in debug builds, the exact Vite dev origin from
/// `tauri.conf.json`. Exact match only: no other localhost port or `*.localhost` name qualifies.
/// These are the only origins the bridge answers with CORS headers.
pub fn is_app_origin(origin: &str) -> bool {
    let origin = origin.trim().trim_end_matches('/').to_ascii_lowercase();
    WEBVIEW_ORIGINS.contains(&origin.as_str()) || dev_origins().iter().any(|o| *o == origin)
}

/// Whether the caller must present a paired-device bearer token. Fails closed: only a loopback
/// peer with no sign of having been forwarded (see `REMOTE_INDICATOR_HEADERS`), no foreign `Host` and no
/// foreign `Origin` is treated as the desktop app itself.
pub fn requires_pairing_token(headers: &str, peer_loopback: bool) -> bool {
    !peer_loopback
        || has_remote_indicators(headers)
        || names_foreign_host(headers)
        || names_foreign_origin(headers)
}

/// True only for a request made on this machine by the app's own tooling: a loopback peer that
/// did not come through the PWA proxy. Gates routes that must never be reached remotely.
pub fn is_local_only_caller(headers: &str, peer_loopback: bool) -> bool {
    !requires_pairing_token(headers, peer_loopback)
}

/// Who is behind an authorized request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// The desktop app or its own tools on this machine (no token needed; never limited by caps).
    Local,
    /// A public route (`/health`, pairing, the push Allow/Deny tap).
    Public,
    /// A paired device, with what it may do right now.
    Device { device_id: String, caps: Caps },
    /// Reserved for non-human callers with no device caps. It is never constructed now, but kept so
    /// the deny/allow arms in kept routes stay explicit.
    #[allow(dead_code)] // kept so the deny/allow arms stay explicit; see the note above
    Brain { bot_id: String },
}

impl Caller {
    pub fn may(&self, cap: Cap) -> bool {
        match self {
            Caller::Local => true,
            Caller::Public | Caller::Brain { .. } => false,
            Caller::Device { caps, .. } => caps.has(cap),
        }
    }
}

/// Who receives an event stream: the fanout filters per viewer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Viewer {
    Local,
    Device(String),
}

impl Viewer {

    /// `None`: the device is gone (revoked or expired) and its stream should close. Otherwise what
    /// this viewer gets for the payload: nothing, the payload, or the payload cut down to what its
    /// caps allow (`caps::project`).
    pub fn view<'a>(&self, payload: &'a str) -> Option<Option<std::borrow::Cow<'a, str>>> {
        match self {
            Viewer::Local => Some(Some(std::borrow::Cow::Borrowed(payload))),
            // An agent switched off for remote control sends a phone nothing but its name and status.
            Viewer::Device(id) => {
                stream_caps(id).map(|caps| project(caps, payload).filter(|_| !pane_rules::hides_event(payload)))
            }
        }
    }
}

/// The viewer of an already-authorized stream request.
pub fn viewer_for(caller: &Caller) -> Viewer {
    match caller {
        Caller::Device { device_id, .. } => Viewer::Device(device_id.clone()),
        Caller::Local | Caller::Public => Viewer::Local,
        // A non-human caller never streams: an id no device has closes the stream at once (fail closed).
        Caller::Brain { .. } => Viewer::Device(String::new()),
    }
}

pub fn authorize_bridge_request(
    headers: &str,
    peer_loopback: bool,
    segments: &[&str],
    method: &str,
) -> Result<(), (u16, serde_json::Value)> {
    authorize_caller(headers, peer_loopback, segments, method).map(|_| ())
}

/// The bridge's one authorization decision: public route, the local app, or a paired device whose
/// token is valid, unexpired and whose caps cover the route ([`route_need`]). A device that lacks
/// the cap gets 403 `not_allowed` naming it; an expired one 401 `device_expired`.
pub fn authorize_caller(
    headers: &str,
    peer_loopback: bool,
    segments: &[&str],
    method: &str,
) -> Result<Caller, (u16, serde_json::Value)> {
    let segments = normalize_bridge_segments(segments);
    if is_public_bridge_path(segments, method) {
        return Ok(Caller::Public);
    }

    let needs_token = requires_pairing_token(headers, peer_loopback);
    if !needs_token {
        return Ok(Caller::Local);
    }

    let token = bearer_token(headers).ok_or_else(|| {
        (
            401,
            serde_json::json!({
                "error": "pairing_required",
                "hint": "Scan the desktop QR code to pair this device before remote control.",
            }),
        )
    })?;

    let store = pairing_store()
        .ok_or_else(|| (503, serde_json::json!({ "error": "pairing_unavailable" })))?;
    let check = store.lock().check_token(&token);
    match check {
        TokenCheck::Unknown => Err((401, serde_json::json!({ "error": "invalid_token" }))),
        TokenCheck::Expired { .. } => Err((
            401,
            serde_json::json!({
                "error": "device_expired",
                "hint": "This phone was signed out after 30 days without use. Pair again from your PC.",
            }),
        )),
        TokenCheck::Valid { device_id, caps } => {
            let need = route_need(method, segments);
            if caps.satisfies(need) {
                // The phone's own caps cover the route; the agent it names may still be switched off
                // or capped lower (`pane_rules`). This is the one place that is enforced for pane routes.
                if let Some(refusal) = pane_rule_refusal(segments, need) {
                    events::emit(events::SecurityEvent::CapDenied {
                        device_id,
                        method: method.to_string(),
                        route: format!("/{}", segments.join("/")),
                        needs: format!("{} (this agent)", need_name(need)),
                    });
                    return Err(refusal);
                }
                return Ok(Caller::Device { device_id, caps });
            }
            let needs = need_name(need);
            events::emit(events::SecurityEvent::CapDenied {
                device_id,
                method: method.to_string(),
                route: format!("/{}", segments.join("/")),
                needs: needs.clone(),
            });
            Err((
                403,
                serde_json::json!({
                    "error": "not_allowed",
                    "code": "DEVICE_NOT_ALLOWED",
                    "needs": needs,
                    "hint": "This phone is not allowed to do that. You can change what it may do on your PC: Settings > Phone > Devices.",
                }),
            ))
        }
    }
}

/// A refusal when the route is about one agent pane whose remote rule does not allow what the route needs.
/// A route that needs only "a paired device" (the lists and streams) names no agent content and passes.
fn pane_rule_refusal(segments: &[&str], need: Need) -> Option<(u16, serde_json::Value)> {
    let pane_id = pane_rules::pane_of_route(segments)?;
    let refused = match need {
        Need::Device => false,
        Need::Cap(cap) => pane_rules::refuses(pane_id, cap),
        Need::AnyOf(a, b) => pane_rules::refuses(pane_id, a) && pane_rules::refuses(pane_id, b),
    };
    refused.then(|| pane_rule_error(pane_id))
}

/// The 403 a phone gets for an agent whose remote rule says no.
pub fn pane_rule_error(pane_id: &str) -> (u16, serde_json::Value) {
    let off = !pane_rules::rule(pane_id).remote;
    (
        403,
        serde_json::json!({
            "error": "not_allowed",
            "code": if off { "PANE_REMOTE_OFF" } else { "PANE_LEVEL" },
            "hint": if off {
                "Remote control is off for this agent. Switch it on in the agent's Remote control card on your PC."
            } else {
                "This agent lets phones do less than that. Change it in the agent's Remote control card on your PC."
            },
        }),
    )
}

fn need_name(need: Need) -> String {
    match need {
        Need::Device => "device".into(),
        Need::Cap(cap) => cap.as_str().into(),
        Need::AnyOf(a, b) => format!("{}|{}", a.as_str(), b.as_str()),
    }
}

/// Whether the caller behind these headers may use `cap` right now (re-checks the token, so a
/// change of caps or a revoke applies at once). For checks inside an open connection, e.g. the
/// WebSocket `input` frame.
#[cfg(test)]
pub fn caller_may(headers: &str, peer_loopback: bool, cap: Cap) -> bool {
    caller_may_on(headers, peer_loopback, cap, None)
}

/// [`caller_may`] for one agent pane: the phone's caps and that agent's remote rule must both allow `cap`.
pub fn caller_may_on(headers: &str, peer_loopback: bool, cap: Cap, pane_id: Option<&str>) -> bool {
    if requires_pairing_token(headers, peer_loopback) && pane_id.is_some_and(|id| pane_rules::refuses(id, cap)) {
        return false;
    }
    if !requires_pairing_token(headers, peer_loopback) {
        return true;
    }
    let Some(token) = bearer_token(headers) else { return false };
    let Some(store) = pairing_store() else { return false };
    let check = store.lock().check_token(&token);
    matches!(check, TokenCheck::Valid { caps, .. } if caps.has(cap))
}
