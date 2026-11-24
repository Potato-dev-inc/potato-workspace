//! Devices on the PC link are not phones and not this PC: they have no bearer token and they are never the
//! loopback-trusted app. The far side of a link holds a *grant* per paired device (what the person switched on for
//! it, as the same four rights a phone has) and every request that arrives over the link is authorized against it,
//! right here, before the bridge router runs it.
//!
//! - A grant is keyed by the device's node id in hex (a plain string: this module never names the link layer).
//! - It lives in the same mirror the event fanout reads (`stream_caps`), under the id `link:<node>`, so a stream a
//!   device has open is cut down to what its rights allow, and ends when the grant is withdrawn.
//! - No grant, no request: `authorize_link` says 403 `not_allowed`. A grant never widens by itself.
//! - Routes a device may never use (pairing, push, tunnel, team, channels, mcp, account and settings writes) are
//!   refused whatever its rights are: they change who can reach this PC, or what is signed in on it.

use super::*;

pub use pm_core::device_link::pclink::calls_files::link_device_id;

/// Sets what the device may do now (`Some`), or withdraws everything (`None`): its open streams end on the next payload.
pub fn set_link_caps(node_hex: &str, caps: Option<Caps>) {
    let id = link_device_id(node_hex);
    let mut view = DEVICE_VIEW.write();
    match caps {
        Some(caps) if caps != Caps::none() => {
            view.insert(id, (caps, None));
        }
        _ => {
            view.remove(&id);
        }
    }
}

/// What the device may do right now. `None`: nothing (no grant).
pub fn link_caps(node_hex: &str) -> Option<Caps> {
    stream_caps(&link_device_id(node_hex))
}

/// The first path parts a device on the link can never use, for any method.
const DENIED_ROOTS: &[&str] =
    &["pair", "push", "tunnel", "hooks", "team", "channels", "mcp", "session", "bridge", "night", "review-desk"];
/// Roots whose writes are denied (their reads are ordinary).
const DENIED_WRITE_ROOTS: &[&str] = &["accounts", "settings"];

/// Whether a device on the link is refused this route whatever it may do.
pub fn link_denies(method: &str, segments: &[&str]) -> bool {
    let segments = normalize_bridge_segments(segments);
    let Some(root) = segments.first() else { return false };
    DENIED_ROOTS.contains(root) || (method != "GET" && DENIED_WRITE_ROOTS.contains(root))
}

/// A pane id or any path part that only the other side's own naming could produce (`dev:<node>:<pane>`): this PC serves
/// its own local panes and never another device's, so a device cannot reach a third one through this PC (no hops).
fn names_another_device(segments: &[&str]) -> bool {
    segments.iter().any(|s| s.starts_with("dev:") || s.starts_with("dev%3A") || s.starts_with("dev%3a"))
}

/// The one authorization decision for a request that arrived over the PC link: the device's grant must cover
/// the route (`route_need`), the route must not be one a device is never given, and the agent the route is about must
/// allow remote use (`pane_rules`). Returns the caller, always a `Caller::Device`: never `Local`, never `Public`.
pub fn authorize_link(node_hex: &str, segments: &[&str], method: &str) -> Result<Caller, (u16, serde_json::Value)> {
    let segments = normalize_bridge_segments(segments);
    let id = link_device_id(node_hex);
    let not_allowed = |needs: String| {
        (
            403,
            serde_json::json!({
                "error": "not_allowed",
                "code": "DEVICE_NOT_ALLOWED",
                "needs": needs,
                "hint": "This PC does not let that device do this. Change it in Settings > Devices.",
            }),
        )
    };
    if names_another_device(segments) {
        return Err((404, serde_json::json!({ "error": "not found", "code": "NOT_LOCAL" })));
    }
    let Some(caps) = stream_caps(&id) else {
        return Err(not_allowed("agents/remote".into()));
    };
    if link_denies(method, segments) {
        return Err(not_allowed("a route devices never get".into()));
    }
    let need = route_need(method, segments);
    if !caps.satisfies(need) {
        events::emit(events::SecurityEvent::CapDenied {
            device_id: id,
            method: method.to_string(),
            route: format!("/{}", segments.join("/")),
            needs: need_name(need),
        });
        return Err(not_allowed(need_name(need)));
    }
    if let Some(refusal) = pane_rule_refusal(segments, need) {
        return Err(refusal);
    }
    Ok(Caller::Device { device_id: id, caps })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODE: &str = "ab12";

    #[test]
    fn no_grant_means_no_request() {
        set_link_caps("never-granted", None);
        assert_eq!(authorize_link("never-granted", &["panes"], "GET").unwrap_err().0, 403);
    }

    #[test]
    fn a_grant_is_never_the_local_app_or_a_public_caller() {
        set_link_caps(NODE, Some(Caps::all()));
        let caller = authorize_link(NODE, &["panes"], "GET").unwrap();
        assert!(matches!(caller, Caller::Device { .. }), "{caller:?}");
        set_link_caps(NODE, None);
    }

    #[test]
    fn watch_and_answer_reads_and_answers_but_cannot_start_or_type() {
        let node = "wa01";
        set_link_caps(node, Some(Caps::watch_and_answer()));
        assert!(authorize_link(node, &["panes"], "GET").is_ok());
        assert!(authorize_link(node, &["panes", "p1", "chat"], "GET").is_ok());
        assert!(authorize_link(node, &["questions", "q1", "answer"], "POST").is_ok());
        let start = authorize_link(node, &["panes"], "POST").unwrap_err();
        assert_eq!((start.0, start.1["error"].as_str()), (403, Some("not_allowed")));
        assert_eq!(authorize_link(node, &["panes", "p1", "input"], "POST").unwrap_err().0, 403);
        assert_eq!(authorize_link(node, &["phone", "chats"], "POST").unwrap_err().0, 403);
        set_link_caps(node, None);
    }

    #[test]
    fn full_control_still_never_reaches_pairing_push_tunnel_or_account_writes() {
        let node = "fc01";
        set_link_caps(node, Some(Caps::all()));
        for (method, path) in [
            ("POST", vec!["pair"]),
            ("GET", vec!["pair", "me"]),
            ("POST", vec!["push", "subscribe"]),
            ("POST", vec!["tunnel", "start"]),
            ("POST", vec!["accounts", "a1", "use"]),
            ("POST", vec!["settings"]),
            ("POST", vec!["team", "cards"]),
            ("POST", vec!["hooks", "event"]),
            ("POST", vec!["bridge", "pair"]),
        ] {
            let refused = authorize_link(node, &path, method).unwrap_err();
            assert_eq!(refused.0, 403, "{method} {path:?}");
        }
        assert!(authorize_link(node, &["accounts"], "GET").is_ok());
        assert!(authorize_link(node, &["settings"], "GET").is_ok());
        set_link_caps(node, None);
    }

    #[test]
    fn a_device_cannot_reach_a_third_device_through_this_pc() {
        let node = "hop1";
        set_link_caps(node, Some(Caps::all()));
        let refused = authorize_link(node, &["panes", "dev:aa:p1", "chat"], "GET").unwrap_err();
        assert_eq!(refused.0, 404);
        let refused = authorize_link(node, &["panes", "dev%3Aaa%3Ap1", "chat"], "GET").unwrap_err();
        assert_eq!(refused.0, 404);
        set_link_caps(node, None);
    }

    #[test]
    fn withdrawing_the_grant_closes_the_event_view() {
        let node = "ev01";
        set_link_caps(node, Some(Caps::all()));
        assert!(Viewer::Device(link_device_id(node)).view("event: x\ndata: {}\n\n").is_some());
        set_link_caps(node, None);
        assert!(Viewer::Device(link_device_id(node)).view("event: x\ndata: {}\n\n").is_none());
    }

    /// The bridge-auth invariant, from the other side: a loopback request that carries a link marker still needs a token.
    #[test]
    fn a_link_marker_over_the_loopback_socket_still_needs_a_token() {
        let headers = "Host: 127.0.0.1\r\nX-Potato-Workspace-Proxied: device-link\r\n";
        assert!(requires_pairing_token(headers, true));
        assert!(authorize_caller(headers, true, &["panes"], "GET").is_err());
    }
}
