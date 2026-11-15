//! `/browser/*`: the agent browser tools for agents (`browser_open`, `browser_read`, `browser_click`,
//! `browser_type`, `browser_console`; logic in `crate::browser`).
//!
//! Who may call: only an MCP session of an agent on **this computer**, and only while the Labs switch "Agent
//! browser" is on. The router has already checked the bearer token and the device caps; on top of that these routes
//! refuse every paired phone (whatever its caps), every request that carries a forwarder header, a foreign `Host` or
//! a foreign `Origin` (the bridge-auth invariant), and every caller without an MCP session. A phone may watch the
//! page later, never drive it (plan N5-23).

use super::{Ctx, RouteResult};
use crate::browser::page::ToolError;
use crate::browser::tab::Actor;
use crate::mobile_pairing::Caller;
use serde_json::{json, Value};

const OPS: [&str; 5] = ["open", "read", "click", "type", "console"];

/// What the route needs from the app. The live one is [`LiveBrowser`]; tests use a recording fake to prove which
/// callers get as far as the page at all.
pub(crate) trait BrowserBackend {
    fn enabled(&self) -> bool;
    fn actor(&self, session: &str) -> Actor;
    fn run(&self, actor: &Actor, tool: &str, args: &Value) -> Result<Value, ToolError>;
}

pub(crate) struct LiveBrowser<'a> {
    app: &'a tauri::AppHandle,
}

impl BrowserBackend for LiveBrowser<'_> {
    fn enabled(&self) -> bool {
        crate::browser::live::enabled(self.app)
    }
    fn actor(&self, session: &str) -> Actor {
        crate::browser::live::actor_for(session)
    }
    fn run(&self, actor: &Actor, tool: &str, args: &Value) -> Result<Value, ToolError> {
        crate::browser::live::run_tool(self.app, actor, tool, args)
    }
}

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    handle_request(cx.method, cx.segments, &cx.request_body, cx.headers, cx.peer_loopback, cx.session, &LiveBrowser { app: cx.app })
}

fn refuse(status: u16, code: &str, message: &str, recoverable: bool) -> RouteResult {
    Err((status, json!({ "code": code, "error": message, "message": message, "recoverable": recoverable, "context": {} })))
}

/// The HTTP status and whether trying again can help, for a tool error code.
fn status_of(code: &str) -> (u16, bool) {
    match code {
        "INVALID_ARGUMENT" | "BAD_URL" | "NOT_A_TEXT_BOX" => (400, true),
        "UNKNOWN_REF" => (400, true),
        "NO_PAGE" => (404, true),
        "SITE_NOT_ALLOWED" | "PORT_NOT_ALLOWED" | "SENSITIVE_FIELD" => (403, false),
        "STALE_REF" | "PAGE_NOT_REACHED" | "NOT_VISIBLE" => (409, true),
        "PAUSED_BY_PERSON" | "STOPPED_BY_PERSON" | "SIGN_IN_WAITING" => (409, false),
        "PAGE_TIMEOUT" => (504, true),
        _ => (500, false),
    }
}

/// `None` when the request is not a `/browser/*` route.
pub(crate) fn handle_request(
    method: &str,
    raw_segments: &[&str],
    body: &Value,
    headers: &str,
    peer_loopback: bool,
    session: Option<&str>,
    backend: &dyn BrowserBackend,
) -> Option<RouteResult> {
    let segments = crate::mobile_pairing::normalize_bridge_segments(raw_segments);
    let ["browser", op] = segments else { return None };
    match crate::mobile_pairing::authorize_caller(headers, peer_loopback, raw_segments, method) {
        Ok(Caller::Local) => {}
        Ok(_) | Err(_) => {
            return Some(refuse(
                403,
                "BROWSER_LOCAL_ONLY",
                "The agent browser is for the agents on this computer. A phone or any remote caller cannot use it.",
                false,
            ))
        }
    }
    let Some(session) = session.filter(|s| !s.trim().is_empty()) else {
        return Some(refuse(400, "SESSION_REQUIRED", "The agent browser needs an MCP session id.", false));
    };
    if method != "POST" {
        return Some(refuse(405, "METHOD_NOT_ALLOWED", "Use POST.", false));
    }
    if !OPS.contains(op) {
        return Some(refuse(404, "NOT_FOUND", "Unknown browser tool route.", false));
    }
    if !backend.enabled() {
        return Some(refuse(
            409,
            "BROWSER_OFF",
            "The agent browser is off. The person can turn it on in Settings > Labs > Agent browser.",
            false,
        ));
    }
    let actor = backend.actor(session);
    let tool = format!("browser_{op}");
    Some(match backend.run(&actor, &tool, body) {
        Ok(value) => Ok((200, value)),
        Err(error) => {
            let (status, recoverable) = status_of(error.code);
            refuse(status, error.code, &error.message, recoverable)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Spy {
        off: bool,
        calls: RefCell<Vec<String>>,
        fail_with: Option<&'static str>,
    }

    impl BrowserBackend for Spy {
        fn enabled(&self) -> bool {
            !self.off
        }
        fn actor(&self, session: &str) -> Actor {
            Actor { label: "Claude Code".into(), session: session.into() }
        }
        fn run(&self, actor: &Actor, tool: &str, args: &Value) -> Result<Value, ToolError> {
            self.calls.borrow_mut().push(format!("{tool} {} {args}", actor.session));
            match self.fail_with {
                Some(code) => Err(ToolError::new(code, "no")),
                None => Ok(json!({ "ok": true })),
            }
        }
    }

    const LOCAL: &str = "Host: 127.0.0.1:17421\r\nContent-Type: application/json\r\n";

    fn call(spy: &Spy, op: &str, headers: &str, loopback: bool, session: Option<&str>) -> RouteResult {
        handle_request("POST", &["browser", op], &json!({ "url": "http://localhost:5173/" }), headers, loopback, session, spy).expect("a browser route")
    }

    fn refused_with(result: RouteResult, status: u16, code: &str) {
        match result {
            Err((got, body)) => {
                assert_eq!(got, status, "{body}");
                assert_eq!(body["code"], code, "{body}");
            }
            Ok(ok) => panic!("expected {code}, got {ok:?}"),
        }
    }

    #[test]
    fn a_local_mcp_session_reaches_every_tool_with_its_own_name() {
        let spy = Spy::default();
        for op in OPS {
            assert_eq!(call(&spy, op, LOCAL, true, Some("session-1")).unwrap().0, 200, "{op}");
        }
        let calls = spy.calls.borrow();
        assert_eq!(calls.len(), 5);
        assert!(calls[0].starts_with("browser_open session-1 ") && calls[4].starts_with("browser_console session-1 "));
    }

    #[test]
    fn with_the_labs_switch_off_nothing_reaches_the_page() {
        let spy = Spy { off: true, ..Default::default() };
        for op in OPS {
            refused_with(call(&spy, op, LOCAL, true, Some("s")), 409, "BROWSER_OFF");
        }
        assert!(spy.calls.borrow().is_empty());
    }

    #[test]
    fn no_mcp_session_no_browser() {
        let spy = Spy::default();
        refused_with(call(&spy, "open", LOCAL, true, None), 400, "SESSION_REQUIRED");
        refused_with(call(&spy, "click", LOCAL, true, Some("  ")), 400, "SESSION_REQUIRED");
        assert!(spy.calls.borrow().is_empty());
    }

    #[test]
    fn a_remote_caller_never_reaches_the_browser() {
        let spy = Spy::default();
        let cases = [
            format!("{LOCAL}X-Forwarded-For: 203.0.113.9\r\n"),
            format!("{LOCAL}Cf-Connecting-Ip: 203.0.113.9\r\n"),
            format!("{LOCAL}X-Potato-Workspace-Proxied: 1\r\n"),
            format!("{LOCAL}Origin: https://evil.example\r\n"),
            format!("{LOCAL}Origin: null\r\n"),
            "Host: browser.example.com\r\n".to_string(),
            format!("{LOCAL}Authorization: Bearer not-a-token\r\nX-Forwarded-For: 1.2.3.4\r\n"),
        ];
        for headers in cases {
            for op in OPS {
                refused_with(call(&spy, op, &headers, true, Some("session-1")), 403, "BROWSER_LOCAL_ONLY");
            }
        }
        for op in OPS {
            refused_with(call(&spy, op, LOCAL, false, Some("session-1")), 403, "BROWSER_LOCAL_ONLY");
        }
        assert!(spy.calls.borrow().is_empty(), "{:?}", spy.calls.borrow());
    }

    #[test]
    fn a_paired_phone_with_every_cap_is_refused_even_with_a_session_header() {
        use crate::mobile_pairing::{init_pairing_store, pairing_store, Caps, PairRequestBody};
        let dir = std::env::temp_dir().join(format!("pm-browser-mcp-phone-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = init_pairing_store(dir.join("pairing.json"));
        let token = {
            let store = pairing_store().expect("pairing store");
            let mut guard = store.lock();
            let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), Caps::all());
            guard
                .pair_device(PairRequestBody { pairing_code: session.pairing_code, device_name: "test phone".into(), device_public_key: session.server_public_key })
                .expect("pair a test phone")
                .device_token
        };
        let spy = Spy::default();
        for headers in [
            format!("Host: tunnel.example\r\nAuthorization: Bearer {token}\r\n"),
            format!("{LOCAL}Authorization: Bearer {token}\r\nX-Forwarded-For: 203.0.113.9\r\n"),
            format!("{LOCAL}Authorization: Bearer {token}\r\nX-Potato-Workspace-Proxied: 1\r\n"),
        ] {
            for op in OPS {
                refused_with(call(&spy, op, &headers, true, Some("spoofed-session")), 403, "BROWSER_LOCAL_ONLY");
            }
        }
        assert!(spy.calls.borrow().is_empty());
    }

    #[test]
    fn only_post_is_served_and_other_routes_are_left_alone() {
        let spy = Spy::default();
        let reply = handle_request("GET", &["browser", "read"], &json!({}), LOCAL, true, Some("s"), &spy).unwrap();
        refused_with(reply, 405, "METHOD_NOT_ALLOWED");
        let reply = handle_request("POST", &["browser", "screenshot"], &json!({}), LOCAL, true, Some("s"), &spy).unwrap();
        refused_with(reply, 404, "NOT_FOUND");
        for segments in [&["browser"][..], &["browser", "read", "x"], &["panes"], &["team", "agent", "roster"]] {
            assert!(handle_request("POST", segments, &json!({}), LOCAL, true, Some("s"), &spy).is_none(), "{segments:?}");
        }
        assert!(spy.calls.borrow().is_empty());
    }

    #[test]
    fn tool_errors_keep_their_code_and_say_whether_trying_again_can_help() {
        for (code, status, recoverable) in [
            ("SENSITIVE_FIELD", 403, false),
            ("SITE_NOT_ALLOWED", 403, false),
            ("PAUSED_BY_PERSON", 409, false),
            ("STOPPED_BY_PERSON", 409, false),
            ("SIGN_IN_WAITING", 409, false),
            ("STALE_REF", 409, true),
            ("NO_PAGE", 404, true),
            ("INVALID_ARGUMENT", 400, true),
        ] {
            let spy = Spy { fail_with: Some(code), ..Default::default() };
            let Err((got, body)) = call(&spy, "click", LOCAL, true, Some("s")) else { panic!("expected an error") };
            assert_eq!((got, body["code"].as_str().unwrap(), body["recoverable"].as_bool().unwrap()), (status, code, recoverable));
            assert!(body["message"].is_string() && body["context"].is_object(), "{body}");
        }
    }
}
