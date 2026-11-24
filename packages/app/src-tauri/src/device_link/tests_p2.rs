//! Devices phase 2 on the in-memory net: the clear states, the activity log on both sides, far-away pairing with a
//! single-use link, the route choices (per device too) with the web address as the own route, and the live terminal.
//! No sockets, no relay and no real web request: the web route's two ends are fakes that write down what they were asked.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::tests::{instance, instance_with, memory, pair, until, real_now, Instance};
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
async fn the_web_route_between_pcs_is_off_no_pc_is_ever_handed_a_phone_token() {
    let w = web_pair("https://far.test/bridge").await;
    let (a_node, b_node) = (w.a.node(), w.b.node());
    // The person cannot turn it on, whatever the level.
    w.b.link.set_permission(&a_node, true, Some("full")).unwrap();
    let err = w.b.link.set_web(&a_node, true).unwrap_err();
    assert!(err.contains("not available yet"), "{err}");
    assert_eq!(w.b.link.view()["devices"][0]["lets_web"], false);
    // Even a stored old "web" right (from an older version) hands out nothing: asking for the address is refused, nothing is minted or kept.
    w.b.link.mgr.set_permission(&crate::device_link::node_of(&a_node).unwrap(), crate::p2p::capability::AGENTS_REMOTE_WEB, true).unwrap();
    w.now.fetch_add(61, Ordering::SeqCst);
    w.a.link.probe_all().await;
    assert!(w.grant.minted.lock().is_empty(), "no token was minted");
    assert_eq!(w.a.link.view()["devices"][0]["web_ready"], false);
    assert!(w.call.seen.lock().is_empty());
    // The link going away does not fall back to a web address.
    w.b.link.shutdown();
    until("the link notices", || state_of(&w.a) == "closed").await;
    assert!(w.a.link.request(&b_node, "GET", "/pclink/sessions", None).await.is_err());
    assert!(w.call.seen.lock().is_empty(), "no web request was made");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tokens_an_older_version_gave_a_pc_are_revoked_at_every_level_change() {
    let w = web_pair("https://far.test/bridge").await;
    let a_node = w.a.node();
    w.b.link.set_permission(&a_node, true, Some("full")).unwrap();
    assert!(w.grant.revoked.lock().contains(&a_node), "revoked when the right was set");
    w.grant.revoked.lock().clear();
    w.b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    assert!(w.grant.revoked.lock().contains(&a_node), "revoked when Full was lowered to Watch");
}

// ----- agents sending work to another device -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn agents_may_send_work_is_off_by_default_per_device_and_forgotten_on_remove() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let b_node = b.node();
    assert_eq!(a.link.view()["devices"][0]["agents_may_send"], false, "off after pairing");
    assert!(!a.link.agents_may_send(&b_node));
    assert_eq!(a.link.resolve_device("nobody").unwrap_err(), "No paired device is called \"nobody\".");
    let after = a.link.set_agents_send(&b_node, true).unwrap();
    assert_eq!(after["devices"][0]["agents_may_send"], true);
    assert!(a.link.agents_may_send(&b_node));
    let name = after["devices"][0]["name"].as_str().unwrap().to_string();
    assert_eq!(a.link.resolve_device(&name.to_uppercase()).unwrap().0, b_node);
    assert_eq!(a.link.resolve_device(&b_node[..8]).unwrap().0, b_node);
    assert!(a.link.set_agents_send(&"0".repeat(64), true).is_err(), "an unpaired device cannot be switched on");
    a.link.remove(&b_node).await.unwrap();
    assert!(!a.link.agents_may_send(&b_node));
}

// ----- lending between my own devices -----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_lend_switch_is_off_by_default_and_grants_the_lend_right_alone() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let b_node = b.node();
    assert_eq!(a.link.view()["devices"][0]["lets_lend"], false, "off after pairing");
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["lend", "item"], "POST").is_err(), "no right before the switch");
    let after = a.link.set_lend(&b_node, true).unwrap();
    assert_eq!(after["devices"][0]["lets_lend"], true);
    assert_eq!(after["devices"][0]["lets_run"], false, "borrowing does not let it run agents");
    // The right is exactly `lend`: the item route, and nothing a run switch would give.
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["lend", "item"], "POST").is_ok());
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["panes", "p1", "chat"], "GET").is_err());
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["agents", "run"], "POST").is_err());
    assert!(a.link.set_lend(&"0".repeat(64), true).is_err(), "an unpaired device cannot be switched on");
    // Turning it off takes the right away at once.
    a.link.set_lend(&b_node, false).unwrap();
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["lend", "item"], "POST").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_linked_pc_reaches_the_lend_door_and_the_lend_switch_stands_alone() {
    let (_net, a, b) = memory();
    pair(&b, &a).await;
    let b_node = b.node();
    a.link.set_permission(&b_node, true, Some("full")).unwrap();
    // A linked PC may reach the lend door; the door itself (lend_item_allowed) asks for the per-PC right or an own-account PC.
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["lend", "item"], "POST").is_ok(), "a linked PC reaches the lend door");
    a.link.set_lend(&b_node, true).unwrap();
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["lend", "item"], "POST").is_ok());
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["agents", "run"], "POST").is_ok());
    a.link.set_permission(&b_node, false, None).unwrap();
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["lend", "item"], "POST").is_ok(), "the lend switch stands alone");
    assert!(crate::mobile_pairing::authorize_link(&b_node, &["agents", "run"], "POST").is_err());
}

#[test]
fn a_phone_never_has_the_lend_right() {
    use crate::mobile_pairing::{route_need, Cap, Caps, Need};
    assert!(!Caps::all().has(Cap::Lend));
    assert!(Caps::parse_names(&["lend"]).is_err(), "a pairing cannot be asked for it");
    assert_eq!(route_need("POST", &["lend", "item"]), Need::Cap(Cap::Lend));
    assert!(!Caps::all().satisfies(route_need("POST", &["lend", "item"])));
    assert!(Caps::all().with(Cap::Lend, true).satisfies(route_need("POST", &["lend", "item"])));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_paired_pc_tells_its_room_left_in_hello_and_only_numbers_and_labels_arrive() {
    let net = MemoryNet::new();
    let mut opts = Options::memory();
    // B's usage as the app would hand it over, plus a token-shaped extra that must never be forwarded by the client.
    opts.room = Arc::new(|| json!([{ "agent_id": "claude", "agent_label": "Claude", "account_label": "Work", "percent_left": 62, "resets_at_ms": 1_800_000_000_000u64, "observed_at_ms": 5, "token": "sk-secret" }]));
    let a = instance("alpha", net.factory(), false);
    let b = instance_with("beta", net.factory(), false, Arc::new(SystemClock), Arc::new(real_now), opts);
    pair(&b, &a).await;
    b.link.set_permission(&a.node(), true, Some("watch")).unwrap();
    a.link.probe_all().await;
    until("the room arrives", || !a.link.view()["devices"][0]["room"].as_array().unwrap().is_empty()).await;
    let device = &a.link.view()["devices"][0];
    let row = device["room"][0].as_object().unwrap();
    let mut keys: Vec<&str> = row.keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(keys, ["account_label", "agent_id", "agent_label", "observed_at_ms", "percent_left", "resets_at_ms"]);
    assert_eq!(row["percent_left"], 62);
    assert!(device["room_at"].as_u64().is_some());
    assert!(!device.to_string().contains("sk-secret"));
}
