//! The PC link's door into the bridge (Devices). A request that arrives from a paired Workspace over the link is
//! run by the same route table as every other request, with one difference in how it gets in: the caller is decided
//! here, as a `Caller::Device` for that device's grant (`mobile_pairing::authorize_link`), instead of from request
//! headers. It is never `Local`: the headers handed to the routes carry a forwarder marker and no loopback peer, so
//! every check further in (`requires_pairing_token`, the typing rule, the card rules) sees a remote caller.
//!
//! This file names the device only as a string. The link layer itself (`crate::p2p`) is never mentioned in `bridge/`
//! (`p2p/guard_tests.rs`); `crate::device_link` carries the bytes and builds the node string from the key.

use serde_json::{json, Value};

use super::errors::RouteResult;
use super::http::split_target;
use super::router::route_authorized;
use crate::mobile_pairing;

/// The most body a request over the link may carry (the same as the HTTP bridge, minus the phone's upload size).
pub const MAX_BODY_BYTES: usize = super::http::MAX_BODY_BYTES;

/// Headers every route sees for a link request: a foreign host and the forwarder marker, so the request is a
/// remote caller to `requires_pairing_token` whatever else is true.
const LINK_HEADERS: &str = "Host: device-link\r\nX-Potato-Workspace-Proxied: device-link";

thread_local! {
    /// The paired PC whose request this thread is running (routes read it to say who sent a message). Set only here, from
    /// the link's own door, so a header a caller sends can never make it up.
    static CURRENT_NODE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// The paired PC (node hex) whose request runs on this thread, if it is a link request.
pub(crate) fn current_node() -> Option<String> {
    CURRENT_NODE.with(|n| n.borrow().clone())
}

/// Test door: runs `f` as if a request from `node` were being handled on this thread.
#[cfg(test)]
pub(crate) fn with_node_for_test<R>(node: &str, f: impl FnOnce() -> R) -> R {
    CURRENT_NODE.with(|n| *n.borrow_mut() = Some(node.to_string()));
    let _reset = NodeGuard;
    f()
}

struct NodeGuard;
impl Drop for NodeGuard {
    fn drop(&mut self) {
        CURRENT_NODE.with(|n| *n.borrow_mut() = None);
    }
}

/// Runs one request as the paired device `node` (hex). `target` is the path with its query (`/panes?x=1`).
/// Returns the HTTP status and the JSON body.
pub fn call(node: &str, method: &str, target: &str, body: &[u8]) -> (u16, Value) {
    let result = call_inner(node, method, target, body);
    match result {
        Ok(ok) | Err(ok) => ok,
    }
}

fn call_inner(node: &str, method: &str, target: &str, body: &[u8]) -> RouteResult {
    if body.len() > MAX_BODY_BYTES {
        return Err((413, json!({ "error": "request body too large", "code": "PAYLOAD_TOO_LARGE" })));
    }
    let (path, query) = split_target(target);
    let raw: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let segments = mobile_pairing::normalize_bridge_segments(&raw).to_vec();
    // The streams have their own doors (`poll`); the HTTP-only upgrade is not a link request.
    if segments == ["events", "ws"] || segments == ["events"] || segments == ["events", "poll"] {
        return Err((404, json!({ "error": "not found", "hint": "A device reads events through the link's own stream." })));
    }
    // Writes are the exact methods the bridge knows; anything else is not a request.
    if !matches!(method, "GET" | "POST" | "PATCH" | "DELETE") {
        return Err((405, json!({ "error": "method not allowed" })));
    }
    mobile_pairing::authorize_link(node, &segments, method)?;
    let (Some(app), Some(registry)) = (super::live_app(), super::live_registry()) else {
        return Err((503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" })));
    };
    CURRENT_NODE.with(|n| *n.borrow_mut() = Some(node.to_string()));
    let _reset = NodeGuard;
    route_authorized(method, &segments, query, body, &registry, &app, LINK_HEADERS, false, None)
}

/// The events a device may see, after `cursor` (`None`: from now), waiting up to `wait`. `None`: the device has no
/// grant any more, its stream is over. The payloads are cut down to the device's rights, like a phone's stream.
pub fn poll_events(node: &str, cursor: Option<u64>, wait: std::time::Duration) -> Option<(u64, String)> {
    let id = mobile_pairing::link_device_id(node);
    mobile_pairing::link_caps(node)?;
    let viewer = mobile_pairing::Viewer::Device(id);
    let poll = super::event_log::poll_for(cursor, wait, &|payload| viewer.view(payload).flatten());
    mobile_pairing::link_caps(node)?;
    Some((poll.cursor, poll.data))
}
