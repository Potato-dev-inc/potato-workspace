//! `POST /lend/item`: a lend ask / yes / take-back item from one of the person's own paired PCs, over the device link.
//!
//! Who sent it is the link's door (`bridge::link::current_node`), never anything in the body. A phone, the local app or an
//! agent has no such door, so they are refused here; the route also needs `Cap::Lend`, which only the device link grants.

use serde_json::{json, Value};

use super::{Ctx, RouteResult};

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    match (cx.method, cx.segments) {
        ("POST", ["lend", "item"]) => Some(respond(crate::bridge::link::current_node(), &cx.request_body)),
        _ => None,
    }
}

fn respond(node: Option<String>, body: &Value) -> RouteResult {
    let Some(node) = node.filter(|n| crate::own_lend::is_node_hex(n)) else {
        return Err((403, json!({ "error": "Only one of your own paired PCs can send this.", "code": "NOT_A_DEVICE" })));
    };
    crate::own_lend::deliver(&node, body.clone()).map(|v| (200, v)).map_err(|e| (409, json!({ "error": e, "code": "LEND_ITEM_REFUSED" })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_link_door_means_no_item() {
        // The local app, an agent or a phone has no node on the thread: refused, whatever the body says.
        let body = json!({ "node": "a".repeat(64), "msg_id": "m", "sent_ms": 1, "body": { "kind": "ack", "of": "x" } });
        assert_eq!(respond(None, &body).unwrap_err().0, 403);
        assert_eq!(respond(Some("not-a-node".into()), &body).unwrap_err().0, 403);
    }

    #[test]
    fn a_link_node_with_no_lend_service_is_told_plainly() {
        let node = "a".repeat(64);
        let err = respond(Some(node), &json!({})).unwrap_err();
        assert_eq!(err.0, 409);
        assert_eq!(err.1["code"], "LEND_ITEM_REFUSED");
    }
}
