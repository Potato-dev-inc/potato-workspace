//! Devices phase 2 on the in-memory net: the clear states, the activity log on both sides, far-away pairing with a
//! single-use link, the route choices (per device too) with the web address as the own route, and the live terminal.
//! No sockets, no relay and no real web request: the web route's two ends are fakes that write down what they were asked.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::tests::{ask_blocking, instance, instance_with, memory, pair, until, real_now, Instance};
use super::web::{WebCall, WebGrant};
use super::Options;
use crate::mobile_pairing::link_caps;
use crate::p2p::memory::MemoryNet;
use crate::p2p::pairing::{ManualClock, SystemClock, LINK_TTL_MS};

fn state_of(side: &Instance) -> String {
    side.link.view()["devices"][0]["state"].as_str().unwrap_or("").to_string()
}

/// `host` makes a pairing link, `joiner` pastes it, both people press Allow.
async fn pair_with_link(host: &Instance, joiner: &Instance) {
    let shown = host.link.make_link().await.unwrap();
    let link = shown["hosting"]["link"].as_str().unwrap().to_string();
    let j = joiner.link.clone();
    let task = tokio::spawn(async move { j.join_link(&link).await });
    until("both sheets", || !host.link.view()["pending"].is_null() && !joiner.link.view()["pending"].is_null()).await;
    for side in [host, joiner] {
        let v = side.link.view();
        assert!(v["pending"]["code"].as_str().is_some(), "both sheets show the code");
        side.link.pair_answer(v["pending"]["id"].as_u64().unwrap(), true).unwrap();
    }
    task.await.unwrap().expect("the join finished");
    until("host lists the joiner", || host.link.view()["devices"].as_array().is_some_and(|d| d.len() == 1)).await;
}

// ----- far-away pairing -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pairing_link_pairs_two_devices_over_a_relay_and_both_confirm_and_nothing_is_on() {
    let net = MemoryNet::new();
    net.default_to_relayed(true);
    net.set_home_relay(Some("https://relay.test"));
    let a = instance("alpha", net.factory(), false);
    let b = instance("beta", net.factory(), false);
    pair_with_link(&b, &a).await;
    for (me, other) in [(&a, &b), (&b, &a)] {
        let v = me.link.view();
        assert_eq!(v["devices"][0]["node"], other.node());
        assert_eq!(v["devices"][0]["lets_run"], false, "a new device can do nothing");
        assert_eq!(v["hosting"], Value::Null, "the link is gone once it was used");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_link_carries_its_own_code_and_is_single_use() {
    let net = MemoryNet::new();
    net.default_to_relayed(true);
    let a = instance("alpha", net.factory(), false);
    let b = instance("beta", net.factory(), false);
    let c = instance("gamma", net.factory(), false);
    let shown = b.link.make_link().await.unwrap();
    assert_eq!(shown["hosting"]["kind"], "link");
    let link = shown["hosting"]["link"].as_str().unwrap().to_string();
    assert!(link.starts_with("pm2:"), "{link}");
    assert_eq!(shown["hosting"]["code"], "", "no code to read aloud: it is inside the link");
    pair_with_link_text(&b, &a, &link).await;
    // The link was used up: a third device pasting it gets nowhere, and nothing is listed.
    assert!(c.link.join_link(&link).await.is_err());
    assert_eq!(b.link.view()["devices"].as_array().unwrap().len(), 1);
    assert!(c.link.view()["devices"].as_array().unwrap().is_empty());
}

async fn pair_with_link_text(host: &Instance, joiner: &Instance, link: &str) {
    let (j, l) = (joiner.link.clone(), link.to_string());
    let task = tokio::spawn(async move { j.join_link(&l).await });
    until("both sheets", || !host.link.view()["pending"].is_null() && !joiner.link.view()["pending"].is_null()).await;
    for side in [host, joiner] {
        side.link.pair_answer(side.link.view()["pending"]["id"].as_u64().unwrap(), true).unwrap();
    }
    task.await.unwrap().expect("the join finished");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pairing_link_that_was_not_used_in_ten_minutes_is_refused() {
    let net = MemoryNet::new();
    let clock = ManualClock::new(1_000_000);
    let b = instance_with("beta", net.factory(), false, clock.clone(), Arc::new(real_now), Options::memory());
    let a = instance("alpha", net.factory(), false);
    let shown = b.link.make_link().await.unwrap();
    let link = shown["hosting"]["link"].as_str().unwrap().to_string();
    assert!(b.link.view()["hosting"]["link"].is_string());
    clock.advance(LINK_TTL_MS + 1);
    assert!(b.link.view()["hosting"].is_null(), "an expired link is not shown any more");
    assert!(a.link.join_link(&link).await.is_err());
    assert!(a.link.view()["devices"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_code_read_off_the_screen_still_cannot_cross_a_relay() {
    let net = MemoryNet::new();
    net.default_to_relayed(true);
    let a = instance("alpha", net.factory(), false);
    let b = instance("beta", net.factory(), false);
    let shown = b.link.show_code().await.unwrap();
    let address = shown["hosting"]["address"].as_str().unwrap().to_string();
    let code = shown["hosting"]["code"].as_str().unwrap().to_string();
    assert!(a.link.join(&address, &code).await.is_err(), "an announced device over a relay is refused");
    assert!(a.link.view()["devices"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pairing_link_is_not_a_code_and_a_code_is_not_a_link() {
    let (_net, a, b) = memory();
    let shown = b.link.show_code().await.unwrap();
    let address = shown["hosting"]["address"].as_str().unwrap().to_string();
    // The ticket of a code is not a pairing link.
    assert!(a.link.join_link(&address).await.unwrap_err().contains("not a pairing link"));
    assert!(a.link.join_link("pm2:%%%").await.is_err());
    assert!(a.link.view()["devices"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn my_own_route_only_makes_no_pairing_link_because_it_needs_the_public_relay() {
    let (_net, a, _b) = memory();
    a.link.set_route("own").await.unwrap();
    assert!(a.link.make_link().await.unwrap_err().contains("public relay"));
    a.link.set_route("public").await.unwrap();
    assert!(a.link.make_link().await.is_ok());
}

// ----- the states -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_goodbye_says_closed_and_a_vanishing_after_online_says_asleep_and_never_online_says_offline() {
    // Goodbye: the app on the far side quits.
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    assert_eq!(a.link.request(&b_node, "GET", "/panes", None).await.unwrap().0, 200);
    assert_eq!(state_of(&a), "online");
    b.link.shutdown();
    until("closed", || state_of(&a) == "closed").await;

    // Vanishing without a word: asleep or off.
    let (_net2, c, d) = memory();
    pair(&d, &c).await;
    d.link.set_permission(&c.node(), true, Some("watch")).unwrap();
    assert_eq!(c.link.request(&d.node(), "GET", "/panes", None).await.unwrap().0, 200);
    d.link.live.vanish();
    until("asleep", || state_of(&c) == "asleep").await;

    // Never answered since this app started: offline (not asleep).
    let (_net3, e, f) = memory();
    pair(&f, &e).await;
    f.link.p2p().stop();
    e.link.probe_all().await;
    assert_eq!(state_of(&e), "offline");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn what_only_a_person_there_can_fix_comes_back_in_the_hello_as_plain_text() {
    let net = MemoryNet::new();
    let mut opts = Options::memory();
    opts.health = Arc::new(|| {
        json!({
            "signed_out": ["claude", "bad\u{0}agent"],
            "needs_person": [{ "pane": "p1", "what": "Trust this folder?" }, { "pane": "", "what": "dropped" }],
        })
    });
    let b = instance_with("beta", net.factory(), false, Arc::new(SystemClock), Arc::new(real_now), opts);
    let a = instance("alpha", net.factory(), false);
    pair(&b, &a).await;
    b.link.set_permission(&a.node(), true, Some("watch")).unwrap();
    a.link.probe_all().await;
    let d = &a.link.view()["devices"][0];
    assert_eq!(d["state"], "online");
    assert_eq!(d["signed_out"], json!(["claude", "badagent"]), "control characters never get through");
    assert_eq!(d["needs_person"], json!([{ "pane": "p1", "what": "Trust this folder?" }]));
}

// ----- the activity log -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn both_sides_keep_a_line_for_what_happened_and_neither_holds_a_prompt() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("full")).unwrap();
    let (status, body) = a.link.request(&b_node, "POST", "/phone/chats", Some(json!({}))).await.unwrap();
    assert_eq!(status, 200, "{body}");
    let pane = body["pane_id"].as_str().unwrap().to_string();
    let canary = "CANARY-secret-prompt-7731";
    let (status, _) = a.link.request(&b_node, "POST", &format!("/panes/{pane}/messages"), Some(json!({ "text": canary }))).await.unwrap();
    assert_eq!(status, 200);
    let _ = a.link.request(&b_node, "GET", "/panes", None).await.unwrap();

    let far: Vec<(String, String)> = b.link.activity(None).unwrap().as_array().unwrap().iter().map(|r| (r["dir"].as_str().unwrap().to_string(), r["kind"].as_str().unwrap().to_string())).collect();
    for want in ["connected", "started", "messaged"] {
        assert!(far.contains(&("in".to_string(), want.to_string())), "far side: {want} in {far:?}");
    }
    let near: Vec<(String, String)> = a.link.activity(None).unwrap().as_array().unwrap().iter().map(|r| (r["dir"].as_str().unwrap().to_string(), r["kind"].as_str().unwrap().to_string())).collect();
    for want in ["started", "messaged"] {
        assert!(near.contains(&("out".to_string(), want.to_string())), "this side: {want} in {near:?}");
    }
    assert!(!near.iter().any(|(_, k)| k == "connected"), "a reading is not an action");
    // Neither log holds the prompt, the pane id, or any path.
    for side in [&a, &b] {
        let text = side.link.activity(None).unwrap().to_string();
        assert!(!text.contains(canary) && !text.contains(&pane) && !text.contains("/panes"), "{text}");
    }
    assert_eq!(b.link.activity(Some(&a_node)).unwrap().as_array().unwrap().len(), far.len());
    assert!(b.link.activity(Some(&"00".repeat(32))).unwrap().as_array().unwrap().is_empty());
    // A refused request is a line too ("refused"), and a removed device takes its lines with it.
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    let (status, _) = a.link.request(&b_node, "POST", "/phone/chats", Some(json!({}))).await.unwrap();
    assert_eq!(status, 403);
    assert!(b.link.activity(None).unwrap().as_array().unwrap().iter().any(|r| r["kind"] == "refused"));
    b.link.remove(&a_node).await.unwrap();
    assert!(b.link.activity(None).unwrap().as_array().unwrap().is_empty());
}

// ----- connected, disconnect -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_that_is_using_this_pc_shows_as_connected_and_disconnect_ends_it() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("full")).unwrap();
    assert_eq!(b.link.view()["devices"][0]["connected"], false, "paired and allowed, but not using it yet");
    assert_eq!(a.link.request(&b_node, "GET", "/panes", None).await.unwrap().0, 200);
    assert_eq!(b.link.view()["devices"][0]["connected"], true);
    let after = b.link.disconnect(&a_node).unwrap();
    assert_eq!(after["devices"][0]["lets_run"], false);
    assert_eq!(after["devices"][0]["connected"], false);
    assert!(link_caps(&a_node).is_none());
    assert_eq!(a.link.request(&b_node, "GET", "/panes", None).await.unwrap().0, 403);
    assert_eq!(state_of(&a), "not_allowed");
}

// ----- routes -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_can_have_its_own_route_choice_and_the_relay_follows_the_choices() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let b_node = b.node();
    assert_eq!(a.link.view()["devices"][0]["route_override"], Value::Null);
    a.link.set_device_route(&b_node, Some("own")).await.unwrap();
    assert_eq!(a.link.view()["devices"][0]["route_override"], "own");
    assert_eq!(a.link.view()["route_pref"], "auto", "this PC's own choice did not change");
    assert!(!a.link.p2p().relays_allowed(), "the only device uses no public relay, so none is bound");
    a.link.set_device_route(&b_node, Some("public")).await.unwrap();
    assert!(a.link.p2p().relays_allowed());
    a.link.set_device_route(&b_node, None).await.unwrap();
    assert_eq!(a.link.view()["devices"][0]["route_override"], Value::Null);
    assert!(a.link.set_device_route(&b_node, Some("nonsense")).await.is_err());
    assert!(a.link.set_device_route(&"00".repeat(32), Some("own")).await.is_err(), "not a paired device");
}

struct FakeGrant {
    minted: Mutex<Vec<(String, bool)>>,
    revoked: Mutex<Vec<String>>,
    url: String,
}

impl WebGrant for FakeGrant {
    fn mint(&self, node: &str, _name: &str, full: bool) -> Result<(String, String), String> {
        self.minted.lock().push((node.to_string(), full));
        Ok((self.url.clone(), "tok-1".into()))
    }
    fn revoke(&self, node: &str) {
        self.revoked.lock().push(node.to_string());
    }
}

#[derive(Default)]
struct FakeCall {
    seen: Mutex<Vec<(String, String, String)>>,
}

#[async_trait]
impl WebCall for FakeCall {
    async fn call(&self, base: &str, token: &str, method: &str, target: &str, _body: Vec<u8>) -> Result<(u16, Vec<u8>), String> {
        self.seen.lock().push((base.to_string(), token.to_string(), format!("{method} {target}")));
        if token == "tok-1" {
            Ok((200, br#"{"panes":[]}"#.to_vec()))
        } else {
            Ok((401, br#"{"error":"invalid_token"}"#.to_vec()))
        }
    }
}

struct Web {
    a: Instance,
    b: Instance,
    grant: Arc<FakeGrant>,
    call: Arc<FakeCall>,
    now: Arc<AtomicU64>,
}

async fn web_pair(url: &str) -> Web {
    let net = MemoryNet::new();
    let now = Arc::new(AtomicU64::new(10_000));
    let grant = Arc::new(FakeGrant { minted: Mutex::new(Vec::new()), revoked: Mutex::new(Vec::new()), url: url.to_string() });
    let call = Arc::new(FakeCall::default());
    let mut far = Options::memory();
    far.web_grant = grant.clone();
    far.web_address = Arc::new(|| Some("https://far.test/bridge".to_string()));
    let mut near = Options::memory();
    near.web_call = call.clone();
    let clock = |n: Arc<AtomicU64>| -> Arc<dyn Fn() -> u64 + Send + Sync> { Arc::new(move || n.load(Ordering::SeqCst)) };
    let b = instance_with("beta", net.factory(), false, Arc::new(SystemClock), clock(now.clone()), far);
    let a = instance_with("alpha", net.factory(), false, Arc::new(SystemClock), clock(now.clone()), near);
    pair(&b, &a).await;
    Web { a, b, grant, call, now }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn when_the_link_cannot_connect_the_devices_own_web_address_carries_the_request_and_the_chip_says_so() {
    let w = web_pair("https://far.test/bridge").await;
    let (a_node, b_node) = (w.a.node(), w.b.node());
    assert_eq!(w.b.link.view()["own_route_ready"], true, "this PC has a web address");
    // The far device allows it only after the run switch is on.
    assert!(w.b.link.set_web(&a_node, true).is_err());
    w.b.link.set_permission(&a_node, true, Some("full")).unwrap();
    assert_eq!(w.b.link.set_web(&a_node, true).unwrap()["devices"][0]["lets_web"], true);
    // A reaches B by the link; the hello also fetches the web address and token and keeps them.
    w.now.fetch_add(61, Ordering::SeqCst);
    w.a.link.probe_all().await;
    let d = w.a.link.view()["devices"][0].clone();
    assert_eq!((d["state"].as_str(), d["web_ready"].as_bool()), (Some("online"), Some(true)));
    assert_eq!(w.grant.minted.lock().as_slice(), &[(a_node.clone(), true)], "minted at the level the person set");
    assert_ne!(d["path"], "own", "the link works: the chip says Direct");

    // The link is gone for good (the far app is closed and cannot be dialed): the web address answers instead.
    w.b.link.shutdown();
    until("the link notices", || state_of(&w.a) == "closed").await;
    let (status, body) = w.a.link.request(&b_node, "GET", "/panes", None).await.unwrap();
    assert_eq!((status, body["panes"].as_array().map(Vec::len)), (200, Some(0)));
    assert_eq!(w.call.seen.lock().last().cloned(), Some(("https://far.test/bridge".into(), "tok-1".into(), "GET /panes".into())));
    let d = w.a.link.view()["devices"][0].clone();
    assert_eq!((d["state"].as_str(), d["path"].as_str()), (Some("online"), Some("own")), "{d}");

    // Public relay only never uses it.
    w.a.link.set_device_route(&b_node, Some("public")).await.unwrap();
    let before = w.call.seen.lock().len();
    assert!(w.a.link.request(&b_node, "GET", "/panes", None).await.is_err());
    assert_eq!(w.call.seen.lock().len(), before, "no web request was made");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_web_token_is_asked_for_only_when_allowed_and_is_forgotten_when_it_is_taken_away() {
    let w = web_pair("https://far.test/bridge").await;
    let (a_node, b_node) = (w.a.node(), w.b.node());
    w.b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    // Not allowed: nothing minted, nothing kept.
    w.a.link.probe_all().await;
    assert!(w.grant.minted.lock().is_empty());
    assert_eq!(w.a.link.view()["devices"][0]["web_ready"], false);
    // Allowed: after the minute that must pass between two asks, it is kept.
    w.b.link.set_web(&a_node, true).unwrap();
    w.now.fetch_add(61, Ordering::SeqCst);
    w.a.link.probe_all().await;
    assert_eq!(w.grant.minted.lock().as_slice(), &[(a_node.clone(), false)], "Watch and answer: the token has no more rights");
    assert_eq!(w.a.link.view()["devices"][0]["web_ready"], true);
    // Taken away: the far side revokes it, and the next ask forgets it here.
    w.b.link.set_web(&a_node, false).unwrap();
    assert!(w.grant.revoked.lock().contains(&a_node));
    w.now.fetch_add(61, Ordering::SeqCst);
    w.a.link.probe_all().await;
    assert_eq!(w.a.link.view()["devices"][0]["web_ready"], false);
    // Removing the device also revokes it.
    w.b.link.set_web(&a_node, true).unwrap();
    w.b.link.remove(&a_node).await.unwrap();
    assert!(w.grant.revoked.lock().iter().filter(|n| **n == a_node).count() >= 2);
    let _ = b_node;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_web_address_that_is_not_plain_https_is_never_kept() {
    let w = web_pair("http://far.test/bridge").await;
    let a_node = w.a.node();
    w.b.link.set_permission(&a_node, true, Some("full")).unwrap();
    w.b.link.set_web(&a_node, true).unwrap();
    w.a.link.probe_all().await;
    assert_eq!(w.a.link.view()["devices"][0]["web_ready"], false, "a token must never be sent in the clear");
    assert!(w.call.seen.lock().is_empty());
}

// ----- the live terminal -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_terminal_is_pushed_the_moment_it_changes_and_stops_when_asked() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    *b.bridge.screen.lock() = "first screen".into();
    let got: Arc<Mutex<Vec<(String, String, String)>>> = Arc::default();
    let sink = got.clone();
    a.link.set_screen_sink(Arc::new(move |n, p, c| sink.lock().push((n.to_string(), p.to_string(), c.to_string()))));
    a.link.screen_start(&b_node, "p1").unwrap();
    until("the first frame", || got.lock().iter().any(|(n, p, c)| *n == b_node && p == "p1" && c == "first screen")).await;
    // Only a change is sent, and it arrives without anybody asking again.
    *b.bridge.screen.lock() = "second screen".into();
    until("the change", || got.lock().iter().any(|(_, _, c)| c == "second screen")).await;
    let frames = got.lock().len();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(got.lock().len(), frames, "an unchanged screen sends nothing");
    assert!(b.bridge.calls.lock().iter().filter(|c| c.as_str() == "GET /panes/p1/snapshot").count() >= 2);
    // Stop: no more frames, and the far side stops reading.
    a.link.screen_stop(&b_node, "p1").unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let calls = b.bridge.calls.lock().len();
    *b.bridge.screen.lock() = "after stop".into();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!got.lock().iter().any(|(_, _, c)| c == "after stop"));
    assert!(b.bridge.calls.lock().len() <= calls + 2, "the far side stopped reading the screen");
    // A thing that is not a terminal is refused here, before anything is sent.
    assert!(a.link.screen_start(&b_node, "../settings").is_err());
    assert!(a.link.screen_start(&b_node, "").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_live_terminal_needs_the_right_to_watch_and_ends_when_the_pane_is_gone() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    let got: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = got.clone();
    a.link.set_screen_sink(Arc::new(move |_, _, c| sink.lock().push(c.to_string())));
    // The switch is off on B: not a single frame.
    a.link.screen_start(&b_node, "p1").unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(got.lock().is_empty());
    // On: frames start (the stream reconnects by itself), and a pane that does not exist ends the loop.
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    *b.bridge.screen.lock() = "hello".into();
    until("frame after switch on", || !got.lock().is_empty()).await;
    a.link.screen_stop(&b_node, "p1").unwrap();
    a.link.screen_start(&b_node, "nope").unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(!got.lock().iter().any(|c| c == "nope"));
    // The request helper still works on the same link (one link carries requests and the stream).
    assert!(ask_blocking(&a.link, &b_node, "GET", "/panes").is_some());
}
