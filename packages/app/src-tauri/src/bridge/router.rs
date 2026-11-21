//! Top-level request routing: authorisation, the root and health endpoints, body parsing,
//! then hand-off to the route groups in `routes`.

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;
use tauri::AppHandle;

use super::errors::{enrich_handle_error, operation_http_error, RouteResult};
use super::http::request_session;
use super::routes::{self, Ctx};
use crate::mobile_pairing;
use crate::pty::PaneRegistry;

/// Where this app's phone server answers, for the hints on the bridge's own pages (never a guessed port).
fn phone_server_hint() -> String {
    match crate::pwa_server::bound_pwa_port() {
        Some(port) => format!("http://127.0.0.1:{port}"),
        None => "the phone server, which is not running".to_string(),
    }
}

#[derive(Debug, Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
    catalog_version: String,
    /// Hash of every tool schema; the stdio shim compares it with its own (see `tool_registry::schema_hash`).
    catalog_hash: String,
    /// Per-tool schema hashes, so a mismatch can name the tools that differ.
    tool_hashes: std::collections::BTreeMap<String, String>,
    /// Always `potato-workspace`: lets the shim tell this bridge from any other local listener.
    product: &'static str,
    /// Random per app launch; changes when the app restarts.
    app_instance_id: &'static str,
    /// Git sha, dirty flag and build time of the running binary.
    build_id: &'static str,
    tool_count: usize,
    /// Warm standby pool counts (see `GET /standby` for the detail); absent before it starts.
    #[serde(skip_serializing_if = "Option::is_none")]
    standby: Option<crate::standby::HealthSummary>,
    /// The profile this app runs as (`POTATO_WORKSPACE_PROFILE`); absent for the default profile.
    /// Lets a shim tell the installed app from a dev profile when it has to scan for a bridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    /// Folder name (never the full path) of this app's data directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    app_data_dir: Option<String>,
    /// `dev` for a debug build, `release` otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    build_kind: Option<&'static str>,
}

/// Which app this is, for a shim that has to choose between several: the profile, the app-data
/// folder name (never a full path) and the build kind.
fn health_identity() -> (Option<String>, Option<String>, Option<&'static str>) {
    (
        crate::app_paths::profile(),
        Some(crate::app_paths::app_id()),
        Some(if cfg!(debug_assertions) { "dev" } else { "release" }),
    )
}

/// What `GET /health` says to a caller that is not on this computer: `ok` and the version, nothing about the
/// profile folder, build, tools or standby pool. `None` for a local caller (the MCP, CLI and watch commands need all of it).
fn public_health(remote: bool, query: &str) -> Option<serde_json::Value> {
    remote.then(|| {
        let mut body = json!({ "ok": true, "version": crate::app_lifecycle::app_version() });
        // "Check" of the person's own address: a fresh nonce in, a proof only this running app can make out.
        if let Some(nonce) = super::http::query_param(query, "nonce").filter(|n| super::identity::valid_nonce(n)) {
            body["proof"] = json!(super::identity::own_domain_proof(&nonce));
        }
        body
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn route(
    method: &str,
    segments: &[&str],
    query: &str,
    body: &[u8],
    registry: &Arc<Mutex<PaneRegistry>>,
    app: &AppHandle,
    headers: &str,
    peer_loopback: bool,
    peer: Option<crate::companion::peer::Peer>,
) -> RouteResult {
    let caller = mobile_pairing::authorize_caller(headers, peer_loopback, segments, method)?;
    // A paired phone leaves one line in "Phone and remote activity" (a kind only, never the body).
    crate::phone_log::note_authorized(&caller, method, segments);
    route_authorized(method, segments, query, body, registry, app, headers, peer_loopback, peer)
}

/// Everything after authorization. Only `route` (a request the HTTP gate let in) and `link::call` (a request that
/// arrived over the PC link and passed `mobile_pairing::authorize_link`) enter here.
#[allow(clippy::too_many_arguments)]
pub(super) fn route_authorized(
    method: &str,
    segments: &[&str],
    query: &str,
    body: &[u8],
    registry: &Arc<Mutex<PaneRegistry>>,
    app: &AppHandle,
    headers: &str,
    peer_loopback: bool,
    peer: Option<crate::companion::peer::Peer>,
) -> RouteResult {
    // Hook Lane: append-only, local-only, its own token (agent_hooks::route); before body parsing.
    if crate::agent_hooks::route::is_hook_ingest(method, segments) {
        let (status, value) = crate::agent_hooks::route::handle(headers, body, peer_loopback);
        return if status < 300 { Ok((status, value)) } else { Err((status, value)) };
    }
    if segments.is_empty() && method == "GET" {
        return Ok((
            200,
            json!({
                "service": "potato-workspace-bridge",
                "hint": format!("This is the API bridge, not the mobile UI. Point your address at the phone server ({}) and use /bridge on that origin.", phone_server_hint()),
                "health": "/health",
            }),
        ));
    }

    if segments == ["health"] && method == "GET" {
        // A caller that is not this computer (a public address, a phone, another PC) learns only that the bridge is up.
        if let Some(short) = public_health(mobile_pairing::requires_pairing_token(headers, peer_loopback), query) {
            return Ok((200, short));
        }
        crate::mcp_sessions::authorize(request_session(headers), method, "/health", &json!({}))
            .map_err(operation_http_error)?;
        let hashes = crate::tool_registry::tool_schema_hashes();
        let (profile, app_data_dir, build_kind) = health_identity();
        return Ok((
            200,
            serde_json::to_value(Health {
                ok: true,
                version: crate::app_lifecycle::app_version(),
                catalog_version: crate::tool_registry::catalog_version(),
                catalog_hash: crate::tool_registry::catalog_hash_of(&hashes),
                tool_hashes: hashes,
                product: super::identity::PRODUCT,
                app_instance_id: super::identity::app_instance_id(),
                build_id: env!("PM_BUILD_ID"),
                tool_count: crate::tool_registry::external_mcp_tool_count(),
                standby: crate::standby::health_summary(),
                profile,
                app_data_dir,
                build_kind,
            })
            .unwrap(),
        ));
    }

    let session = request_session(headers);
    let request_body: serde_json::Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(body).map_err(|error| {
            (
                400,
                json!({"code":"INVALID_ARGUMENT","error":error.to_string()}),
            )
        })?
    };
    let route_path = format!("/{}", segments.join("/"));
    // A chat that runs on another computer over SSH can only be used from the app window: no MCP tool and no phone drives it.
    if let Some(refusal) = remote_pane_refusal(&crate::acp::chat::remote_pane_ids(), segments, query, body, &request_body) {
        return Err(refusal);
    }
    // A paired phone (it got past the pairing token check above) is the user at another screen:
    // like the desktop pane window, it may type into any pane, including ones an MCP run manages.
    let paired_phone_typing = session.is_none()
        && mobile_pairing::requires_pairing_token(headers, peer_loopback)
        && is_pane_typing_route(method, segments);
    if !paired_phone_typing {
        crate::mcp_sessions::authorize(session, method, &route_path, &request_body)
            .map_err(|error| {
                // A refused write must not be silent: the app log hears of it once per pane.
                if let (true, ["panes", pane_id, _]) = (is_pane_typing_route(method, segments), segments) {
                    super::typing_refusals::note_refused(pane_id, super::typing_refusals::Channel::Http, &error.message);
                }
                enrich_handle_error(error, registry)
            })
            .map_err(operation_http_error)?;
    }

    // A long call keeps its session's pane leases alive until it returns.
    let _keepalive = session
        .filter(|_| crate::agent_runs::pane_lease::is_long_call(&route_path))
        .map(crate::agent_runs::pane_lease::KeepAlive::start);

    // A companion's agent may start helpers and see that one waits, but it can never answer a card (trust,
    // permission, question) or type a key into a pane. Those are the person's, always.
    if let Some(session) = session {
        crate::companion::guard::check_session(registry, session, method, &route_path).map_err(operation_http_error)?;
    }
    // The same rule for a plain loopback request: a companion's shell can `curl` the routes that answer a card
    // or type into a pane, with no MCP session. The other end of the connection tells who is calling.
    if !mobile_pairing::requires_pairing_token(headers, peer_loopback) {
        crate::companion::peer::check(registry, &crate::companion::peer::SystemTcp, peer, method, &route_path, &request_body)
            .map_err(operation_http_error)?;
    }
    // The same door for what a plain `curl` or the CLI does inside an agent's window: no MCP session does not
    // mean "the app". A call that CHANGES something and comes from an agent pane needs the person's Allow
    // (a card in the Inbox); the app's own UI is in no pane and is never asked. See `agent_authority::shell_gate`.
    if session.is_none() && !mobile_pairing::requires_pairing_token(headers, peer_loopback) {
        crate::agent_authority::shell_gate::check_request(
            registry,
            &crate::companion::peer::SystemTcp,
            &crate::pty::agent_proc::snapshot,
            peer,
            headers,
            method,
            segments,
            &request_body,
        )
        .map_err(operation_http_error)?;
    }
    // A session header is only a caller's own claim (any local process can make one up), so it proves nothing: a session
    // call nobody can place (no key, not in a window's tree, not the app) asks like a shell command does.
    if session.is_some() && !mobile_pairing::requires_pairing_token(headers, peer_loopback) {
        crate::agent_authority::shell_gate::check_session_request(
            registry,
            &crate::companion::peer::SystemTcp,
            &crate::pty::agent_proc::snapshot,
            peer,
            headers,
            method,
            segments,
            &request_body,
        )
        .map_err(operation_http_error)?;
    }
    if let Some(reply) = crate::questions::routes::handle(
        method,
        segments,
        &request_body,
        session,
        mobile_pairing::requires_pairing_token(headers, peer_loopback),
        &|| crate::questions::routes::publish_changed(app),
    ) {
        return reply;
    }

    let cx = Ctx {
        method,
        segments,
        query,
        body,
        request_body,
        headers,
        peer_loopback,
        peer,
        session,
        registry,
        app,
    };
    // A helper started from a pane is nested under that pane: the process on the other end of the connection says which.
    let _caller = (is_helper_start_route(method, segments) && !mobile_pairing::requires_pairing_token(headers, peer_loopback)).then(|| {
        // The pane's own key first (it also names a process that left its window), then the process tree.
        crate::pty::pane_parent::RequestCaller::enter(crate::agent_authority::pane_keys::pane_from_headers(headers).or_else(|| {
            crate::companion::peer::caller_pane(registry, &crate::companion::peer::SystemTcp, &crate::pty::agent_proc::snapshot, peer)
        }))
    });
    routes::dispatch(&cx).unwrap_or_else(|| {
        Err((
            404,
            json!({
                "error": "not found",
                "hint": format!("Unknown bridge route. The mobile UI is served at {}; the API lives under /health, /events, /panes.", phone_server_hint()),
            }),
        ))
    })
}

/// The routes that start a new agent (a helper): `run_agent`, `quick_ask`, `followup_task`, `delegate_work`, `spawn_agent`; and
/// `message_parent`, whose caller (a spin-off) is found the same way.
/// The plain sentence for a refused request that names a chat on another computer (shared: `acp::chat`).
pub(crate) use crate::acp::chat::REMOTE_PANE_REFUSED;

/// Percent-decoding that never fails (a malformed `%` stays as it is): the text a route would read from a query or a path.
fn lenient_percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() {
            out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap_or(b'%'));
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Every string a request can carry a pane id in, AS A ROUTE WILL READ IT: path segments and query percent-decoded, and every
/// key and string value of the parsed JSON body (so `7` escapes are already plain). The raw texts are included too.
fn request_strings(segments: &[&str], query: &str, body: &[u8], parsed: &serde_json::Value) -> Vec<String> {
    fn walk(value: &serde_json::Value, out: &mut Vec<String>) {
        match value {
            serde_json::Value::String(s) => out.push(s.clone()),
            serde_json::Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            serde_json::Value::Object(map) => map.iter().for_each(|(k, v)| {
                out.push(k.clone());
                walk(v, out);
            }),
            _ => {}
        }
    }
    let mut out: Vec<String> = segments.iter().map(|s| s.to_string()).collect();
    out.extend(segments.iter().map(|s| lenient_percent_decode(s)));
    out.push(query.to_string());
    out.push(lenient_percent_decode(query));
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        out.push(lenient_percent_decode(key));
        out.push(lenient_percent_decode(&value.replace('+', " ")));
    }
    out.push(String::from_utf8_lossy(body).into_owned());
    walk(parsed, &mut out);
    out
}

/// `Some(error)` when a request names one of `remote_ids`, in ANY form a route could decode it from: the raw text, a percent-encoded
/// path or query value, or a JSON-escaped string (the parsed body is searched, not only its bytes). Pane ids are random uuids, so a
/// text search cannot hit anything else. Covers sends, follow-ups, adoption, reads and waits by pane id or handle in one place.
pub(crate) fn remote_pane_refusal(remote_ids: &[String], segments: &[&str], query: &str, body: &[u8], parsed: &serde_json::Value) -> Option<(u16, serde_json::Value)> {
    if remote_ids.is_empty() {
        return None;
    }
    let strings = request_strings(segments, query, body, parsed);
    // The whole text names it, OR a whole value is a prefix of it with at least 4 characters (the MCP layer resolves such prefixes).
    let named = remote_ids.iter().any(|id| {
        !id.is_empty()
            && strings.iter().any(|s| {
                let value = s.trim().to_ascii_lowercase();
                s.contains(id.as_str()) || (value.len() >= crate::mcp_sessions::MIN_PANE_PREFIX_LEN && id.to_ascii_lowercase().starts_with(value.as_str()))
            })
    });
    named.then(crate::acp::chat::remote_refusal)
}

fn is_helper_start_route(method: &str, segments: &[&str]) -> bool {
    method == "POST" && matches!(segments, ["agents", "run" | "quick" | "followup" | "message-parent"] | ["operations", "delegate"] | ["panes"] | ["terminals", "start" | "read" | "wait" | "stop"])
}

/// `POST /panes/{id}/input` and `POST /panes/{id}/key`: typing into a pane.
fn is_pane_typing_route(method: &str, segments: &[&str]) -> bool {
    method == "POST" && matches!(segments, ["panes", _, "input" | "key"])
}

#[cfg(test)]
mod tests {
    use super::{health_identity, is_helper_start_route, is_pane_typing_route, remote_pane_refusal, Health, REMOTE_PANE_REFUSED};

    #[test]
    fn a_request_that_names_a_chat_on_another_computer_is_refused_in_any_form_a_route_can_decode() {
        let ids = vec!["7d1c0a52-aaaa-4bbb-8ccc-0123456789ab".to_string()];
        let id = ids[0].clone();
        // `d` written as a JSON unicode escape, and as a percent escape: the bytes differ, the decoded id is the same.
        let json_escaped = id.replacen('d', "\\u0064", 1);
        let percent = id.replacen('d', "%64", 1);
        let upper_percent = id.replace('-', "%2D");
        let cases: Vec<(Vec<String>, String, String)> = vec![
            (vec!["panes".into(), id.clone(), "input".into()], String::new(), "{}".into()),
            (vec!["panes".into(), percent.clone(), "input".into()], String::new(), "{}".into()),
            (vec!["agents".into(), "followup".into()], String::new(), format!("{{\"handle\":\"{id}\",\"task\":\"x\"}}")),
            (vec!["agents".into(), "followup".into()], String::new(), format!("{{\"handle\":\"{json_escaped}\",\"task\":\"x\"}}")),
            (vec!["agents".into(), "run".into()], String::new(), format!("{{\"nested\":{{\"pane_id\":[\"{json_escaped}\"]}}}}")),
            (vec!["chat".into(), "messages".into()], format!("pane_id={id}"), "{}".into()),
            (vec!["chat".into(), "messages".into()], format!("handle={percent}"), "{}".into()),
            (vec!["chat".into(), "messages".into()], format!("handle={upper_percent}"), "{}".into()),
        ];
        for (segments, query, body) in cases {
            let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
            let segs: Vec<&str> = segments.iter().map(String::as_str).collect();
            let refused = remote_pane_refusal(&ids, &segs, &query, body.as_bytes(), &parsed).unwrap_or_else(|| panic!("not refused: {segs:?} {query} {body}"));
            assert_eq!(refused.0, 403);
            assert_eq!(refused.1["error"], REMOTE_PANE_REFUSED);
            assert_eq!(refused.1["code"], "REMOTE_PANE");
        }
        // A prefix of the id (4 or more characters), as the MCP layer accepts it, is refused too; a shorter one or another text is not.
        for prefix in ["7d1c", "7D1C0A52", "7d1c0a52-aaaa"] {
            let parsed = serde_json::json!({ "handle": prefix });
            assert!(remote_pane_refusal(&ids, &["agents", "followup"], "", b"{}", &parsed).is_some(), "{prefix}");
            assert!(remote_pane_refusal(&ids, &["panes", prefix, "input"], "", b"{}", &serde_json::json!({})).is_some(), "{prefix}");
            assert!(remote_pane_refusal(&ids, &["chat"], &format!("pane_id={prefix}"), b"{}", &serde_json::json!({})).is_some(), "{prefix}");
        }
        assert!(remote_pane_refusal(&ids, &["agents", "followup"], "", b"{}", &serde_json::json!({ "handle": "7d1" })).is_none());
        assert!(remote_pane_refusal(&ids, &["agents", "followup"], "", b"{}", &serde_json::json!({ "handle": "hello world" })).is_none());
        // The old raw substring search alone would have let these through.
        assert!(!format!("{{\"handle\":\"{json_escaped}\"}}").contains(&id));
        assert!(!format!("handle={percent}").contains(&id));
        let none = serde_json::json!({});
        assert!(remote_pane_refusal(&ids, &["panes", "other-pane", "input"], "", b"{}", &none).is_none());
        assert!(remote_pane_refusal(&[], &["panes", id.as_str(), "input"], "", b"{}", &none).is_none());
    }

    #[test]
    fn the_routes_that_start_a_helper_are_the_ones_that_record_a_caller() {
        assert!(is_helper_start_route("POST", &["agents", "run"]));
        assert!(is_helper_start_route("POST", &["agents", "quick"]));
        assert!(is_helper_start_route("POST", &["operations", "delegate"]));
        assert!(is_helper_start_route("POST", &["panes"]));
        assert!(is_helper_start_route("POST", &["agents", "message-parent"]));
        assert!(!is_helper_start_route("GET", &["panes"]));
        assert!(!is_helper_start_route("POST", &["panes", "p1", "input"]));
        assert!(!is_helper_start_route("POST", &["agents", "send"]));
    }

    #[test]
    fn only_pane_input_and_keys_count_as_typing() {
        assert!(is_pane_typing_route("POST", &["panes", "p1", "input"]));
        assert!(is_pane_typing_route("POST", &["panes", "p1", "key"]));
        assert!(!is_pane_typing_route("GET", &["panes", "p1", "input"]));
        assert!(!is_pane_typing_route("DELETE", &["panes", "p1"]));
        assert!(!is_pane_typing_route("POST", &["panes", "p1", "viewport"]));
        assert!(!is_pane_typing_route("POST", &["agents", "run"]));
    }

    #[test]
    fn health_names_the_profile_data_folder_and_build_kind_without_a_path() {
        let (profile, app_data_dir, build_kind) = health_identity();
        let health = Health {
            ok: true,
            version: "1",
            catalog_version: String::new(),
            catalog_hash: String::new(),
            tool_hashes: Default::default(),
            product: "potato-workspace",
            app_instance_id: "i",
            build_id: "b",
            tool_count: 0,
            standby: None,
            profile,
            app_data_dir,
            build_kind,
        };
        let body = serde_json::to_value(&health).unwrap();
        let folder = body["app_data_dir"].as_str().unwrap();
        assert!(folder.starts_with("com.potatodev.workspace"), "{folder}");
        assert!(!folder.contains('/') && !folder.contains('\\'), "{folder}");
        assert_eq!(body["build_kind"], if cfg!(debug_assertions) { "dev" } else { "release" });
        // Older shims keep parsing: unset fields are left out.
        let bare = serde_json::to_value(Health { profile: None, app_data_dir: None, build_kind: None, ..health }).unwrap();
        assert!(bare.get("profile").is_none() && bare.get("app_data_dir").is_none() && bare.get("build_kind").is_none());
    }
}

#[cfg(test)]
mod health_tests {
    use super::public_health;

    #[test]
    fn a_public_caller_gets_only_ok_and_the_version() {
        let body = public_health(true, "").expect("remote callers get the short answer");
        let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, vec!["ok".to_string(), "version".to_string()]);
        assert_eq!(body["ok"], true);
    }

    #[test]
    fn a_check_with_a_nonce_gets_a_proof_and_nothing_else_new() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let body = public_health(true, &format!("nonce={nonce}")).unwrap();
        assert_eq!(body["proof"], crate::bridge::identity::own_domain_proof(nonce));
        assert!(body.get("nonce").is_none() && body.get("app_instance_id").is_none());
        // another nonce gives another proof; a junk or short nonce gets none
        assert_ne!(body["proof"], crate::bridge::identity::own_domain_proof("fedcba9876543210fedcba9876543210"));
        for bad in ["nonce=abc", "nonce=zzzzzzzzzzzzzzzzzzzzzzzz", "nonce=", "x=1"] {
            assert!(public_health(true, bad).unwrap().get("proof").is_none(), "{bad}");
        }
    }

    #[test]
    fn a_caller_on_this_computer_gets_the_full_answer() {
        assert!(public_health(false, "").is_none());
    }

    #[test]
    fn a_forwarded_loopback_request_counts_as_public() {
        let remote = |headers: &str, loopback: bool| crate::mobile_pairing::requires_pairing_token(headers, loopback);
        assert!(public_health(remote("Cf-Connecting-Ip: 1.2.3.4\r\n", true), "").is_some());
        assert!(public_health(remote("Host: 127.0.0.1:17421\r\n", true), "").is_none());
        assert!(public_health(remote("", false), "").is_some());
    }
}
