//! The same story as `tests.rs`, over REAL iroh endpoints on this PC's loopback: two app instances, two key stores, two
//! trust files, no relay and no public server. Run by hand (it binds real UDP sockets on 127.0.0.1):
//!   cargo test --lib device_link::local_net_tests -- --ignored --nocapture

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use super::tests::{instance, pair};
use crate::p2p::endpoint::{BindSpec, P2pError, Transport, TransportFactory};
use crate::p2p::identity::DeviceIdentity;
use crate::p2p::iroh_net::IrohFactory;
use crate::test_support::wait::wait_until;

struct LocalIroh;

#[async_trait]
impl TransportFactory for LocalIroh {
    async fn bind(&self, identity: &DeviceIdentity, spec: &BindSpec) -> Result<Arc<dyn Transport>, P2pError> {
        let mut local = spec.clone();
        local.relays = false;
        local.loopback_only = true;
        IrohFactory.bind(identity, &local).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "binds real iroh endpoints on 127.0.0.1; run by hand with --ignored"]
async fn two_instances_pair_and_run_a_chat_over_real_iroh_on_loopback() {
    let a = instance("real-alpha", Arc::new(LocalIroh), true);
    let b = instance("real-beta", Arc::new(LocalIroh), true);
    // Firewall rule: nothing may be bound beyond 127.0.0.1, or Windows asks the person to allow the test program.
    for side in [&a, &b] {
        let addrs = side.link.p2p().local_addrs();
        assert!(!addrs.is_empty() && addrs.iter().all(|x| x.ip().is_loopback()), "bound beyond loopback: {addrs:?}");
    }
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    assert_eq!(a.link.view()["devices"][0]["lets_run"], false);

    // The switch is off on B: the door is closed, and this time the refusal code really crosses the network.
    let (status, body) = a.link.request(&b_node, "GET", "/panes", None).await.unwrap();
    assert_eq!((status, body["error"].as_str()), (403, Some("not_allowed")), "{body}");

    b.link.set_permission(&a_node, true, Some("full")).unwrap();
    let (status, body) = a.link.request(&b_node, "POST", "/phone/chats", Some(json!({}))).await.unwrap();
    assert_eq!(status, 200, "{body}");
    let pane = body["pane_id"].as_str().unwrap().to_string();
    assert_eq!((b.bridge.chat_count(), a.bridge.chat_count()), (1, 0));
    let (status, _) = a.link.request(&b_node, "POST", &format!("/panes/{pane}/messages"), Some(json!({ "text": "stream 4" }))).await.unwrap();
    assert_eq!(status, 200);
    let path = format!("/panes/{pane}/chat");
    let ok = wait_until(30, || {
        let (link, path, node) = (a.link.clone(), path.clone(), b_node.clone());
        let got = tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(async move { link.request(&node, "GET", &path, None).await }));
        matches!(got, Ok((200, body)) if body["items"].as_array().is_some_and(|i| i.iter().any(|x| x["kind"] == "turnEnd")))
    });
    assert!(ok, "the far chat never finished its turn");
    assert_eq!(a.link.view()["devices"][0]["state"], "online");
    assert_eq!(a.link.view()["devices"][0]["path"], "direct");

    // Remove on B: A is cut off.
    b.link.remove(&a_node).await.unwrap();
    assert_eq!(a.link.request(&b_node, "GET", "/panes", None).await.unwrap().0, 403);
}
