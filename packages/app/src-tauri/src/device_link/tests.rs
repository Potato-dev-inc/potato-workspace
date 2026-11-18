//! Devices on the in-memory net: two app instances (each with its own keys, trust file and chat engine) pair, and one
//! runs a chat on the other. No sockets. The same story over real iroh on loopback is `local_net_tests.rs`.
//!
//! The far side's routes are a four-route stand-in (`TestBridge`) in front of the REAL chat engine and the fake agent:
//! the app's own route table needs a running Tauri app. What is real here: the pairing and the trust list, the PC
//! link, the wire, the rights (`mobile_pairing::authorize_link`, the same call `bridge::link::call` makes first), the
//! chat engine and the agent process.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::client::Timeouts;
use super::route::MemoryPrefs;
use super::serve::HostBridge;
use super::{Deps, DeviceLink, Options};
use crate::acp::chat::{start, AcpChat, QuietHost, StartDeps, StartRequest};
use crate::acp::config::HostEnv;
use crate::acp::fake_agent;
use crate::keys::KeyStore;
use crate::mobile_pairing::{authorize_link, link_caps};
use crate::p2p::discovery::NoDiscovery;
use crate::p2p::endpoint::TransportFactory;
use crate::p2p::pairing::{Clock, SystemClock};
use crate::p2p::trust::MemoryTrustStorage;
use crate::pty::PaneRegistry;
use crate::secrets::{MemoryBackend, SecretBackend};
use crate::test_support::wait::wait_until;

struct Env(PathBuf);

impl HostEnv for Env {
    fn var(&self, name: &str) -> Option<std::ffi::OsString> {
        std::env::var_os(name)
    }
    fn which(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn adapters_dir(&self) -> PathBuf {
        self.0.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.0.join("homes")
    }
}

/// A stand-in for the app's route table: the routes a remote chat needs, behind the real rights check.
pub(super) struct TestBridge {
    dir: PathBuf,
    chats: Mutex<Vec<Arc<AcpChat>>>,
    deps: StartDeps,
    pub(super) calls: Mutex<Vec<String>>,
    pub(super) event: Mutex<Option<String>>,
    /// What the terminal `p1` shows (the snapshot route answers it).
    pub(super) screen: Mutex<String>,
}

impl TestBridge {
    pub(super) fn new(name: &str) -> Arc<Self> {
        let dir = std::env::temp_dir().join(format!("pm-devices-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let deps = StartDeps {
            registry: Arc::new(Mutex::new(PaneRegistry::new())),
            host: Arc::new(QuietHost),
            env: Arc::new(Env(dir.clone())),
            conversations: None,
        };
        Arc::new(Self { dir, chats: Mutex::new(Vec::new()), deps, calls: Mutex::new(Vec::new()), event: Mutex::new(None), screen: Mutex::new(String::new()) })
    }

    fn chat(&self, id: &str) -> Option<Arc<AcpChat>> {
        self.chats.lock().iter().find(|c| c.pane_id() == id).cloned()
    }

    fn answer(status: u16, value: Value) -> (u16, Vec<u8>) {
        (status, serde_json::to_vec(&value).unwrap())
    }

    pub(super) fn chat_count(&self) -> usize {
        self.chats.lock().len()
    }
}

impl Drop for TestBridge {
    fn drop(&mut self) {
        for c in self.chats.lock().iter() {
            crate::acp::chat::on_pane_closed(c.pane_id());
        }
    }
}

#[async_trait]
impl HostBridge for TestBridge {
    async fn call(&self, node: &str, method: &str, target: &str, body: Vec<u8>) -> (u16, Vec<u8>) {
        self.calls.lock().push(format!("{method} {target}"));
        let path = target.split('?').next().unwrap_or("");
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if let Err((status, value)) = authorize_link(node, &segs, method) {
            return Self::answer(status, value);
        }
        let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        match (method, segs.as_slice()) {
            ("GET", ["panes"]) => {
                let panes: Vec<Value> = self.chats.lock().iter().map(|c| json!({ "id": c.pane_id(), "agent_type": "fake" })).collect();
                Self::answer(200, json!({ "panes": panes }))
            }
            ("POST", ["phone", "chats"]) => {
                let cfg = fake_agent::agent_config("", &self.dir.join("store"));
                let req = StartRequest { agent_id: "fake".into(), folder: self.dir.clone(), explicit: true, account: None, ..Default::default() };
                match start(&self.deps, cfg, req) {
                    Ok(chat) => {
                        let id = chat.pane_id().to_string();
                        self.chats.lock().push(chat);
                        Self::answer(200, json!({ "pane_id": id }))
                    }
                    Err(e) => Self::answer(502, json!({ "error": e.message })),
                }
            }
            ("POST", ["panes", id, "messages"]) => match self.chat(id) {
                Some(chat) => match chat.send(body["text"].as_str().unwrap_or("")) {
                    Ok(_) => Self::answer(200, json!({ "ok": true })),
                    Err(_) => Self::answer(409, json!({ "error": "busy" })),
                },
                None => Self::answer(404, json!({ "error": "no such pane" })),
            },
            ("GET", ["pclink", "sessions", "p1", "screen"]) => Self::answer(200, json!({ "content": self.screen.lock().clone(), "view": "screen" })),
            ("GET", ["panes", id, "chat"]) => match self.chat(id) {
                Some(chat) => Self::answer(200, json!({ "items": chat.items().iter().map(|i| serde_json::to_value(i).unwrap()).collect::<Vec<_>>() })),
                None => Self::answer(404, json!({ "error": "no such pane" })),
            },
            _ => Self::answer(404, json!({ "error": "not found" })),
        }
    }

    async fn poll(&self, node: &str, cursor: Option<u64>, wait: Duration) -> Option<(u64, String)> {
        link_caps(node)?;
        if let Some(e) = self.event.lock().take() {
            return Some((cursor.unwrap_or(0) + 1, e));
        }
        tokio::time::sleep(wait.min(Duration::from_millis(100))).await;
        link_caps(node)?;
        Some((cursor.unwrap_or(0), String::new()))
    }
}

/// One app instance: its own keys, its own trust file, its own chat engine.
pub(super) struct Instance {
    pub(super) link: Arc<DeviceLink>,
    pub(super) bridge: Arc<TestBridge>,
}

impl Instance {
    pub(super) fn node(&self) -> String {
        self.link.p2p().node_id().map(|n| n.to_hex()).unwrap_or_default()
    }
}

pub(super) fn instance(name: &str, factory: Arc<dyn TransportFactory>, loopback: bool) -> Instance {
    instance_with(name, factory, loopback, Arc::new(SystemClock), Arc::new(real_now), Options::memory())
}

pub(super) fn real_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

pub(super) fn instance_with(
    name: &str,
    factory: Arc<dyn TransportFactory>,
    loopback: bool,
    clock: Arc<dyn Clock>,
    now_secs: Arc<dyn Fn() -> u64 + Send + Sync>,
    options: Options,
) -> Instance {
    let backend: Arc<dyn SecretBackend> = Arc::new(MemoryBackend::new());
    let bridge = TestBridge::new(name);
    let link = DeviceLink::new(Deps {
        keys: KeyStore::with_backend(backend, name),
        factory,
        trust_storage: MemoryTrustStorage::new(),
        prefs: MemoryPrefs::new(),
        addr_store: MemoryPrefs::new(),
        bridge: bridge.clone(),
        clock,
        discovery: Arc::new(NoDiscovery),
        name: name.to_string(),
        loopback_only: loopback,
        timeouts: Timeouts { dial: Duration::from_secs(5), answer: Duration::from_secs(20) },
        now_secs,
        options,
    })
    .unwrap();
    link.apply_settings(&json!({ "devices_enabled": true }));
    Instance { link, bridge }
}

pub(super) async fn until(what: &str, mut f: impl FnMut() -> bool) {
    let end = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < end {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for: {what}");
}

/// `host` shows a code, `joiner` types it, both people press Allow. Returns once both lists have the other.
pub(super) async fn pair(host: &Instance, joiner: &Instance) {
    let shown = host.link.show_code().await.unwrap();
    let address = shown["hosting"]["address"].as_str().unwrap().to_string();
    let code = shown["hosting"]["code"].as_str().unwrap().to_string();
    let j = joiner.link.clone();
    let task = tokio::spawn(async move { j.join(&address, &code).await });
    until("both sheets", || !host.link.view()["pending"].is_null() && !joiner.link.view()["pending"].is_null()).await;
    for side in [host, joiner] {
        let v = side.link.view();
        assert!(v["pending"]["code"].as_str().is_some(), "the sheet shows the code");
        side.link.pair_answer(v["pending"]["id"].as_u64().unwrap(), true).unwrap();
    }
    task.await.unwrap().expect("the join finished");
    until("host lists the joiner", || host.link.view()["devices"].as_array().is_some_and(|d| d.len() == 1)).await;
}

pub(super) fn memory() -> (crate::p2p::memory::MemoryNet, Instance, Instance) {
    let net = crate::p2p::memory::MemoryNet::new();
    let a = instance("alpha", net.factory(), false);
    let b = instance("beta", net.factory(), false);
    (net, a, b)
}

/// One request from this thread's async context, for the polling helpers.
pub(super) fn ask_blocking(link: &Arc<DeviceLink>, node: &str, method: &str, path: &str) -> Option<(u16, Value)> {
    let (link, node, method, path) = (link.clone(), node.to_string(), method.to_string(), path.to_string());
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(async move { link.request(&node, &method, &path, None).await.ok() }))
}

// ----- the story -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instances_pair_with_both_confirming_and_nothing_is_switched_on() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    for (me, other) in [(&a, &b), (&b, &a)] {
        let v = me.link.view();
        let d = &v["devices"][0];
        assert_eq!(d["node"], other.node(), "each lists the other");
        assert_eq!(d["lets_run"], false, "a new device can do nothing");
        assert_eq!(v["pending"], Value::Null);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wrong_code_pairs_nothing() {
    let (_net, a, b) = memory();
    let shown = b.link.show_code().await.unwrap();
    let address = shown["hosting"]["address"].as_str().unwrap().to_string();
    assert!(a.link.join(&address, "AAAA-AAAA").await.is_err());
    assert!(a.link.view()["devices"].as_array().unwrap().is_empty());
    assert!(b.link.view()["devices"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_remote_chat_runs_on_the_other_device_with_its_own_engine_and_the_levels_hold() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let b_node = b.node();
    let a_node = a.node();

    // B's switch for A is off: the door is closed, A is told in plain words, and B's engine was not touched.
    let (status, body) = a.link.request(&b_node, "GET", "/panes", None).await.unwrap();
    assert_eq!((status, body["error"].as_str()), (403, Some("not_allowed")), "{body}");
    assert_eq!(a.link.view()["devices"][0]["state"], "not_allowed");
    assert!(b.bridge.calls.lock().is_empty());

    // The person at B turns it on: Watch and answer.
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    let (status, body) = a.link.request(&b_node, "GET", "/panes", None).await.unwrap();
    assert_eq!(status, 200, "{body}");
    assert_eq!(a.link.view()["devices"][0]["state"], "online");
    assert_eq!(a.link.view()["devices"][0]["path"], "direct");
    // It cannot start anything, and B's engine ran nothing.
    let (status, body) = a.link.request(&b_node, "POST", "/phone/chats", Some(json!({}))).await.unwrap();
    assert_eq!((status, body["error"].as_str()), (403, Some("not_allowed")));
    assert_eq!(b.bridge.chat_count(), 0);
    assert_eq!(a.bridge.chat_count(), 0);

    // Full control: the chat starts on B (not on A), takes a message, and the reply comes back to A.
    b.link.set_permission(&a_node, true, Some("full")).unwrap();
    let (status, body) = a.link.request(&b_node, "POST", "/phone/chats", Some(json!({}))).await.unwrap();
    assert_eq!(status, 200, "{body}");
    let pane = body["pane_id"].as_str().unwrap().to_string();
    assert_eq!((b.bridge.chat_count(), a.bridge.chat_count()), (1, 0), "the chat lives on the far device");
    let (status, _) = a.link.request(&b_node, "POST", &format!("/panes/{pane}/messages"), Some(json!({ "text": "stream 4" }))).await.unwrap();
    assert_eq!(status, 200);
    let path = format!("/panes/{pane}/chat");
    let mut reply = String::new();
    let ok = wait_until(30, || {
        let Some((200, body)) = ask_blocking(&a.link, &b_node, "GET", &path) else { return false };
        let items = body["items"].as_array().cloned().unwrap_or_default();
        if items.iter().any(|i| i["kind"] == "turnEnd") {
            reply = items.iter().find(|i| i["kind"] == "assistant").and_then(|i| i["text"].as_str()).unwrap_or("").to_string();
            true
        } else {
            false
        }
    });
    assert!(ok, "the far chat never finished its turn");
    assert_eq!(reply, "w0 w1 w2 w3 ");

    // Never a hop through B to a third device, and never a route devices do not get.
    let (status, _) = a.link.request(&b_node, "GET", "/panes/dev:abcd:p1/chat", None).await.unwrap();
    assert_eq!(status, 404);
    let (status, _) = a.link.request(&b_node, "POST", "/pair", Some(json!({}))).await.unwrap();
    assert_eq!(status, 403);

    // Turning the switch off closes the open link at once.
    b.link.set_permission(&a_node, false, None).unwrap();
    let (status, _) = a.link.request(&b_node, "GET", "/panes", None).await.unwrap();
    assert_eq!(status, 403);
    assert_eq!(a.link.view()["devices"][0]["state"], "not_allowed");
    assert!(link_caps(&a_node).is_none(), "the grant is withdrawn");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removing_a_device_on_one_side_cuts_the_other_off_and_a_stranger_cannot_ask() {
    let (net, a, b) = memory();
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("full")).unwrap();
    assert_eq!(a.link.request(&b_node, "GET", "/panes", None).await.unwrap().0, 200);
    b.link.remove(&a_node).await.unwrap();
    assert!(link_caps(&a_node).is_none());
    assert_eq!(a.link.request(&b_node, "GET", "/panes", None).await.unwrap().0, 403);

    // A third engine that was never paired has no entry for B, so it cannot even ask.
    let c = instance("gamma", net.factory(), false);
    c.link.start().await.unwrap();
    assert!(c.link.request(&b_node, "GET", "/panes", None).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_labs_switch_off_ends_everything_and_withdraws_every_right() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("full")).unwrap();
    assert_eq!(a.link.request(&b_node, "GET", "/panes", None).await.unwrap().0, 200);
    b.link.apply_settings(&json!({ "devices_enabled": false }));
    assert!(link_caps(&a_node).is_none(), "grants are withdrawn");
    assert!(b.link.request(&a_node, "GET", "/panes", None).await.is_err());
    assert_eq!(b.link.view()["enabled"], false);
    until("far side closed", || ask_blocking(&a.link, &b_node, "GET", "/panes").map(|r| r.0 != 200).unwrap_or(true)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_route_choice_is_kept_and_my_own_route_only_uses_no_relay() {
    let (_net, a, _b) = memory();
    assert_eq!(a.link.view()["route_pref"], "auto");
    assert!(a.link.p2p().relays_allowed());
    a.link.set_route("own").await.unwrap();
    assert_eq!(a.link.view()["route_pref"], "own");
    assert!(!a.link.p2p().relays_allowed());
    assert!(a.link.set_route("nonsense").await.is_err());
    a.link.set_route("public").await.unwrap();
    assert!(a.link.p2p().relays_allowed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_event_stream_reaches_this_side() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    let got: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let sink = got.clone();
    a.link.set_event_sink(Arc::new(move |n, f| sink.lock().push((n.to_string(), f.to_string()))));
    *b.bridge.event.lock() = Some("event: ping\ndata: {\"n\":1}\n\n".into());
    a.link.subscribe(&b_node).unwrap();
    until("the frame", || got.lock().iter().any(|(n, f)| *n == b_node && f.starts_with("event: ping"))).await;
    a.link.unsubscribe(&b_node).unwrap();
}
