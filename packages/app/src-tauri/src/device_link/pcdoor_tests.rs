//! The device door (`pcdoor.rs`): every way a request can be wrong, and the rights read at every request. No sockets here (the listener-level
//! tests are in `pwa_server/tunnel_listener.rs`); the door is the real `pclink::Door` in front of the PC link's fake services.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use ed25519_dalek::{Signer, SigningKey};
use serde_json::Value;

use super::pcdoor::*;
use super::pclink::tests::Fake;
use super::pclink::Asks;
use crate::p2p::capability;
use crate::p2p::endpoint::NodeId;
use crate::p2p::trust::{MemoryTrustStorage, TrustList, TrustSigner};

const HOST: &str = "k3x9q2.abc123.opentunnel.example";
const NOW: u64 = 1_800_000_000_000;

struct TestKey(SigningKey);

impl TestKey {
    fn new() -> Self {
        Self(SigningKey::generate(&mut rand::rngs::OsRng))
    }
    fn node(&self) -> NodeId {
        NodeId(self.0.verifying_key().to_bytes())
    }
}

impl NodeSigner for TestKey {
    fn node_id(&self) -> Option<NodeId> {
        Some(self.node())
    }
    fn sign(&self, message: &[u8]) -> Option<[u8; 64]> {
        Some(self.0.sign(message).to_bytes())
    }
}

impl TrustSigner for TestKey {
    fn device_pub(&self) -> Result<[u8; 32], String> {
        Ok(self.0.verifying_key().to_bytes())
    }
    fn sign(&self, message: &[u8]) -> Result<[u8; 64], String> {
        Ok(self.0.sign(message).to_bytes())
    }
}

struct Rig {
    door: PcDoor,
    trust: Arc<TrustList>,
    fake: Arc<Fake>,
    host: Arc<TestKey>,
    caller: TestKey,
    now: Arc<AtomicU64>,
    devices_on: Arc<AtomicBool>,
    labs_on: Arc<AtomicBool>,
}

/// A door with one paired caller: run switch on at `level` (watch | answer | full), the web-address switch on, both Labs switches on.
fn rig(level: &str) -> Rig {
    let host = Arc::new(TestKey::new());
    let trust = TrustList::open(MemoryTrustStorage::new(), Arc::new(TestKey::new()));
    let caller = TestKey::new();
    trust.add(caller.node(), [7; 32], "Laptop", 1).unwrap();
    trust.set_permission(&caller.node(), capability::AGENTS_REMOTE, true).unwrap();
    if level == "answer" || level == "full" {
        trust.set_permission(&caller.node(), capability::AGENTS_REMOTE_ANSWER, true).unwrap();
    }
    if level == "full" {
        trust.set_permission(&caller.node(), capability::AGENTS_REMOTE_FULL, true).unwrap();
    }
    trust.set_permission(&caller.node(), capability::AGENTS_REMOTE_PCDOOR, true).unwrap();
    let (devices_on, labs_on) = (Arc::new(AtomicBool::new(true)), Arc::new(AtomicBool::new(true)));
    let fake = Arc::new(Fake::default());
    let now = Arc::new(AtomicU64::new(NOW));
    let clock = {
        let now = now.clone();
        Arc::new(move || now.load(Ordering::SeqCst)) as Arc<dyn Fn() -> u64 + Send + Sync>
    };
    let door = build_door(fake.clone(), Arc::new(Asks::new()), trust.clone(), devices_on.clone(), labs_on.clone(), clock.clone());
    let door = PcDoor {
        trust: trust.clone(),
        devices_on: devices_on.clone(),
        labs_on: labs_on.clone(),
        door: Some(door),
        signer: host.clone(),
        now_ms: clock,
        nonces: NonceStore::default(),
        throttle: Throttle::default(),
    };
    Rig { door, trust, fake, host, caller, now, devices_on, labs_on }
}

fn peer(last: u8) -> Option<IpAddr> {
    Some(IpAddr::from([203, 0, 113, last]))
}

impl Rig {
    fn request(&self, method: &str, target: &str) -> Prepared {
        build_request(&self.caller, &self.host.node(), HOST, method, target, b"", self.now.load(Ordering::SeqCst)).unwrap()
    }

    async fn send(&self, body: &[u8], host: &str, from: u8) -> (u16, Vec<u8>) {
        self.door.handle(Hit { host, peer: peer(from), method: "POST", target: PATH, body }).await
    }

    /// One signed request on the right host from address `.9`.
    async fn call(&self, method: &str, target: &str) -> (u16, Value) {
        let prepared = self.request(method, target);
        let (status, bytes) = self.send(&prepared.body, HOST, 9).await;
        assert_eq!(status != 401 && status != 429, true, "a good request was refused: {status} {}", String::from_utf8_lossy(&bytes));
        let (inner, body) = prepared.verify_answer(&bytes).expect("a signed answer");
        assert_eq!(inner, status, "the signed status is the HTTP status");
        (inner, serde_json::from_slice(&body).unwrap())
    }

    fn assert_flat(&self, reply: &(u16, Vec<u8>)) {
        assert_eq!((reply.0, reply.1.as_slice()), (401, FLAT_401), "{}", String::from_utf8_lossy(&reply.1));
    }
}

fn envelope(prepared: &Prepared) -> Value {
    serde_json::from_slice(&prepared.body).unwrap()
}

fn bytes(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}

#[tokio::test]
async fn a_watch_call_is_served_and_the_answer_is_signed_by_this_pc() {
    let r = rig("watch");
    let (status, body) = r.call("GET", "/pclink/sessions").await;
    assert_eq!(status, 200);
    assert!(body["sessions"].is_array());
    assert_eq!(r.fake.calls(), ["sessions"]);
    let (status, me) = r.call("GET", "/pclink/me").await;
    assert_eq!((status, me["level"].as_str()), (200, Some("watch")));
    for target in ["/pclink/sessions/p1/transcript?since=3", "/pclink/projects", "/pclink/agents", "/pclink/usage", "/pclink/questions"] {
        assert_eq!(r.call("GET", target).await.0, 200, "{target}");
    }
}

#[tokio::test]
async fn a_full_device_is_still_held_at_watch_on_this_door() {
    let r = rig("full");
    assert_eq!(r.call("GET", "/pclink/me").await.1["level"], "watch");
    r.call("GET", "/pclink/questions").await;
    assert!(r.fake.calls().contains(&"questions full=false".to_string()), "{:?}", r.fake.calls());
}

#[tokio::test]
async fn anything_above_watch_or_outside_the_slice_is_a_signed_403_and_nothing_runs() {
    for level in ["watch", "answer", "full"] {
        let r = rig(level);
        for (method, target) in [
            ("POST", "/pclink/sessions/p1/messages"),
            ("GET", "/pclink/sessions/p1/messages"),
            ("POST", "/pclink/sessions/p1/interrupt"),
            ("POST", "/pclink/questions/q1/answer"),
            ("POST", "/pclink/agents/start"),
            ("POST", "/pclink/agents/warm"),
            ("POST", "/pclink/sessions/p1/input"),
            ("DELETE", "/pclink/sessions/p1"),
            ("GET", "/pclink/browse"),
            ("GET", "/pclink/sessions/p1/screen"),
            ("GET", "/pclink/sessions/p1/picture?path=a.png"),
            ("GET", "/pclink/sessions/p1/transcript/earlier?before=i1"),
            ("POST", "/pclink/full-request"),
            ("POST", "/pclink/move-work"),
            ("POST", "/pclink/projects/open"),
            ("GET", "/pclink/no-such-route"),
        ] {
            let (status, body) = r.call(method, target).await;
            assert_eq!(status, 403, "{level} {method} {target}: {body}");
        }
        assert!(r.fake.calls().is_empty(), "{level}: a refused call reached the services: {:?}", r.fake.calls());
    }
}

#[tokio::test]
async fn the_slice_table_and_the_levels_agree() {
    use super::pclink::{need, Level};
    for (method, target) in [("GET", "/pclink/me"), ("GET", "/pclink/sessions"), ("GET", "/pclink/sessions/x/transcript?since=1"), ("GET", "/pclink/projects"), ("GET", "/pclink/agents"), ("GET", "/pclink/usage"), ("GET", "/pclink/questions")] {
        assert!(slice1_ok(method, target), "{target}");
        let segs: Vec<&str> = target.split('?').next().unwrap().split('/').filter(|s| !s.is_empty()).collect();
        assert_eq!(need(method, &segs[1..]), Some(Level::Watch));
    }
    for (method, target) in [("POST", "/pclink/me"), ("GET", "/panes"), ("GET", "/pclink"), ("GET", "/phone/chats"), ("GET", "/pclink/sessions/x/screen")] {
        assert!(!slice1_ok(method, target), "{method} {target}");
    }
}

#[tokio::test]
async fn a_bad_signature_a_wrong_key_and_a_stranger_get_the_same_flat_401() {
    let r = rig("watch");
    // A flipped signature.
    let good = r.request("GET", "/pclink/me");
    let mut env = envelope(&good);
    let sig = env["sig"].as_str().unwrap().to_string();
    env["sig"] = Value::String(format!("{}{}", if sig.starts_with('0') { "1" } else { "0" }, &sig[1..]));
    let bad_sig = r.send(&bytes(&env), HOST, 9).await;
    r.assert_flat(&bad_sig);
    // The right node id, signed with another key.
    let impostor = TestKey::new();
    let mut env = envelope(&build_request(&impostor, &r.host.node(), HOST, "GET", "/pclink/me", b"", NOW).unwrap());
    env["from"] = Value::String(r.caller.node().to_hex());
    r.assert_flat(&r.send(&bytes(&env), HOST, 9).await);
    // A stranger with a valid signature of its own, not in the trust list.
    let stranger = build_request(&impostor, &r.host.node(), HOST, "GET", "/pclink/me", b"", NOW).unwrap();
    r.assert_flat(&r.send(&stranger.body, HOST, 9).await);
    assert!(r.fake.calls().is_empty());
}

#[tokio::test]
async fn a_replayed_request_is_refused_and_a_new_nonce_is_fine() {
    let r = rig("watch");
    let first = r.request("GET", "/pclink/me");
    assert_eq!(r.send(&first.body, HOST, 9).await.0, 200);
    r.assert_flat(&r.send(&first.body, HOST, 9).await);
    // Still refused at the very end of its window (the entry lives one millisecond past the last moment the stamp passes).
    r.now.store(NOW + WINDOW_MS, Ordering::SeqCst);
    r.assert_flat(&r.send(&first.body, HOST, 8).await);
    // Later the stamp is stale anyway.
    r.now.store(NOW + WINDOW_MS + 1, Ordering::SeqCst);
    r.assert_flat(&r.send(&first.body, HOST, 7).await);
    r.now.store(NOW, Ordering::SeqCst);
    assert_eq!(r.send(&r.request("GET", "/pclink/me").body, HOST, 9).await.0, 200);
}

#[tokio::test]
async fn a_stale_and_a_future_timestamp_are_refused_and_the_window_edge_is_kept() {
    let r = rig("watch");
    for ts in [NOW - WINDOW_MS - 1, NOW + WINDOW_MS + 1, NOW - 10 * 60_000, 0] {
        let p = build_request(&r.caller, &r.host.node(), HOST, "GET", "/pclink/me", b"", ts).unwrap();
        r.assert_flat(&r.send(&p.body, HOST, 9).await);
    }
    for ts in [NOW - WINDOW_MS, NOW + WINDOW_MS, NOW] {
        let p = build_request(&r.caller, &r.host.node(), HOST, "GET", "/pclink/me", b"", ts).unwrap();
        assert_eq!(r.send(&p.body, HOST, 9).await.0, 200, "{ts}");
    }
}

#[tokio::test]
async fn a_request_for_another_node_or_another_host_is_refused() {
    let r = rig("watch");
    let other = TestKey::new();
    let p = build_request(&r.caller, &other.node(), HOST, "GET", "/pclink/me", b"", NOW).unwrap();
    r.assert_flat(&r.send(&p.body, HOST, 9).await);
    // Signed for another tunnel name, served on this one.
    let p = build_request(&r.caller, &r.host.node(), "old.name.opentunnel.example", "GET", "/pclink/me", b"", NOW).unwrap();
    r.assert_flat(&r.send(&p.body, HOST, 9).await);
    // Signed for this host, arriving on the listener of another one.
    let p = r.request("GET", "/pclink/me");
    r.assert_flat(&r.send(&p.body, "old.name.opentunnel.example", 9).await);
    // The envelope's host is edited to match the listener, but the signature covered the old one.
    let p = build_request(&r.caller, &r.host.node(), "old.name.opentunnel.example", "GET", "/pclink/me", b"", NOW).unwrap();
    let mut env = envelope(&p);
    env["host"] = Value::String(HOST.into());
    r.assert_flat(&r.send(&bytes(&env), HOST, 9).await);
    // The host compare ignores case (the signed form is lowercase).
    let p = r.request("GET", "/pclink/me");
    assert_eq!(r.send(&p.body, &HOST.to_ascii_uppercase(), 9).await.0, 200);
}

#[tokio::test]
async fn a_tampered_target_method_or_body_is_refused() {
    let r = rig("watch");
    let p = r.request("GET", "/pclink/me");
    let mut env = envelope(&p);
    env["target"] = Value::String("/pclink/usage".into());
    r.assert_flat(&r.send(&bytes(&env), HOST, 9).await);
    let mut env = envelope(&r.request("GET", "/pclink/me"));
    env["method"] = Value::String("POST".into());
    r.assert_flat(&r.send(&bytes(&env), HOST, 9).await);
    let mut env = envelope(&r.request("GET", "/pclink/me"));
    env["body"] = Value::String("{\"x\":1}".into());
    r.assert_flat(&r.send(&bytes(&env), HOST, 9).await);
    // A body that was signed is checked against its hash, and a GET with a body is refused after the signature checks out.
    let p = build_request(&r.caller, &r.host.node(), HOST, "GET", "/pclink/me", b"{}", NOW).unwrap();
    let (status, reply) = r.send(&p.body, HOST, 9).await;
    assert_eq!(status, 403);
    assert_eq!(p.verify_answer(&reply).unwrap().0, 403);
    assert!(r.fake.calls().is_empty());
}

#[tokio::test]
async fn every_failure_to_prove_who_asks_is_the_same_bytes() {
    let r = rig("watch");
    let good = r.request("GET", "/pclink/me");
    let good_env = envelope(&good);
    let mut cases: Vec<(&str, Vec<u8>, &str, &str)> = vec![
        ("empty", Vec::new(), "POST", PATH),
        ("garbage", b"not json".to_vec(), "POST", PATH),
        ("json null", b"null".to_vec(), "POST", PATH),
        ("wrong method", good.body.clone(), "GET", PATH),
        ("a query on the path", good.body.clone(), "POST", "/bridge/pcdoor?x=1"),
        ("another path", good.body.clone(), "POST", "/bridge/pcdoor/"),
        ("oversized", vec![b'a'; ENVELOPE_MAX + 1], "POST", PATH),
    ];
    let mut with = |label: &'static str, key: &str, value: Value| {
        let mut e = good_env.clone();
        e[key] = value;
        cases.push((label, bytes(&e), "POST", PATH));
    };
    with("version", "v", Value::from(2));
    with("short nonce", "nonce", Value::String("00".into()));
    with("short sig", "sig", Value::String("00".into()));
    with("not hex", "from", Value::String("zz".repeat(32)));
    with("a phone route", "target", Value::String("/panes".into()));
    with("a path off /pclink", "target", Value::String("/phone/chats".into()));
    with("dot dot", "target", Value::String("/pclink/../panes".into()));
    with("an unknown field", "extra", Value::Bool(true));
    let mut seen = Vec::new();
    for (i, (label, body, method, target)) in cases.iter().enumerate() {
        let reply = r.door.handle(Hit { host: HOST, peer: peer(100 + i as u8), method, target, body }).await;
        assert_eq!((reply.0, reply.1.as_slice()), (401, FLAT_401), "{label}");
        seen.push(reply);
    }
    assert!(seen.windows(2).all(|w| w[0] == w[1]), "the failures differ");
    // The shut states answer the same bytes too (and never touch the services).
    r.labs_on.store(false, Ordering::SeqCst);
    r.assert_flat(&r.send(&good.body, HOST, 9).await);
    r.labs_on.store(true, Ordering::SeqCst);
    r.devices_on.store(false, Ordering::SeqCst);
    r.assert_flat(&r.send(&good.body, HOST, 9).await);
    assert!(r.fake.calls().is_empty());
    assert_eq!(r.door.nonces.len(), 0, "a stranger's request leaves nothing in the nonce store");
}

#[tokio::test]
async fn the_throttle_slows_one_address_after_failed_tries_and_not_the_others() {
    let r = rig("watch");
    for _ in 0..FAILS_PER_WINDOW {
        r.assert_flat(&r.send(b"junk", HOST, 66).await);
    }
    // That address is slowed now, even for a good request; another address is not.
    let good = r.request("GET", "/pclink/me");
    assert_eq!(r.send(&good.body, HOST, 66).await.0, 429);
    let good = r.request("GET", "/pclink/me");
    assert_eq!(r.send(&good.body, HOST, 9).await.0, 200);
    // The window passes: the slow address is let back in.
    r.now.store(NOW + WINDOW_MS + 1, Ordering::SeqCst);
    let again = r.request("GET", "/pclink/me");
    assert_eq!(r.send(&again.body, HOST, 66).await.0, 200);
}

#[tokio::test]
async fn the_throttle_never_touches_pairing() {
    // The door has no way to reach the pairing manager: it is not in its fields, and this file's code does not name it.
    let code = code_of(include_str!("pcdoor.rs"));
    for word in ["PairManager", "pairing", "strike", "LOCKOUT"] {
        assert!(!code.contains(word), "{word}");
    }
}

#[tokio::test]
async fn the_answer_signature_binds_the_node_the_request_the_status_and_the_body() {
    let r = rig("watch");
    let p = build_request_with(&r.caller, &r.host.node(), HOST, "GET", "/pclink/me", b"", NOW, [5; 16]).unwrap();
    let (_, reply) = r.send(&p.body, HOST, 9).await;
    let (status, body) = p.verify_answer(&reply).unwrap();
    assert_eq!(status, 200);
    // A changed body, a changed status, an unsigned error body, and garbage.
    let mut env: Value = serde_json::from_slice(&reply).unwrap();
    let original = env.clone();
    env["body"] = Value::String("{\"level\":\"full\"}".into());
    assert_eq!(p.verify_answer(&bytes(&env)), Err(AnswerError::NotTheNode));
    let mut env = original.clone();
    env["status"] = Value::from(201);
    assert_eq!(p.verify_answer(&bytes(&env)), Err(AnswerError::NotTheNode));
    assert_eq!(p.verify_answer(FLAT_401), Err(AnswerError::Malformed));
    assert_eq!(p.verify_answer(b"x"), Err(AnswerError::Malformed));
    // An answer that another key made (a stranger on a stale address).
    let stranger = TestKey::new();
    let me = r.host.node();
    let text = String::from_utf8(body.clone()).unwrap();
    let forged_sig = NodeSigner::sign(&stranger, &answer_message(&me, &r.caller.node(), HOST, NOW, &[5; 16], 200, text.as_bytes())).unwrap();
    let mut env = original.clone();
    env["sig"] = Value::String(forged_sig.iter().map(|b| format!("{b:02x}")).collect());
    assert_eq!(p.verify_answer(&bytes(&env)), Err(AnswerError::NotTheNode));
    // The same good answer given to ANOTHER request (another nonce) does not verify: no answer can be replayed to a later asker.
    let second = r.request("GET", "/pclink/me");
    assert_eq!(second.verify_answer(&reply), Err(AnswerError::NotTheNode));
}

#[tokio::test]
async fn a_removed_device_is_refused_at_once() {
    let r = rig("watch");
    assert_eq!(r.call("GET", "/pclink/me").await.0, 200);
    r.trust.remove(&r.caller.node()).unwrap();
    r.assert_flat(&r.send(&r.request("GET", "/pclink/me").body, HOST, 9).await);
}

#[tokio::test]
async fn lowering_a_level_or_a_switch_takes_effect_at_the_next_request() {
    let r = rig("answer");
    assert_eq!(r.call("GET", "/pclink/me").await.0, 200);
    // The web-address switch off: refused, signed 403 (the caller is still a paired PC).
    r.trust.set_permission(&r.caller.node(), capability::AGENTS_REMOTE_PCDOOR, false).unwrap();
    assert_eq!(r.call("GET", "/pclink/me").await.0, 403);
    r.trust.set_permission(&r.caller.node(), capability::AGENTS_REMOTE_PCDOOR, true).unwrap();
    assert_eq!(r.call("GET", "/pclink/me").await.0, 200);
    // The run switch off takes the web-address switch with it, and it does not come back by itself.
    r.trust.set_permission(&r.caller.node(), capability::AGENTS_REMOTE, false).unwrap();
    assert_eq!(r.call("GET", "/pclink/me").await.0, 403);
    r.trust.set_permission(&r.caller.node(), capability::AGENTS_REMOTE, true).unwrap();
    assert_eq!(r.call("GET", "/pclink/me").await.0, 403);
    assert!(!r.trust.pcdoor_allowed(&r.caller.node()));
}

#[tokio::test]
async fn the_door_is_shut_while_either_labs_switch_is_off_or_the_switch_was_never_turned_on() {
    let r = rig("watch");
    let good = r.request("GET", "/pclink/me");
    r.labs_on.store(false, Ordering::SeqCst);
    r.assert_flat(&r.send(&good.body, HOST, 9).await);
    r.labs_on.store(true, Ordering::SeqCst);
    assert_eq!(r.call("GET", "/pclink/me").await.0, 200);
    // A device that was paired and never given the web-address switch.
    let fresh = TestKey::new();
    r.trust.add(fresh.node(), [8; 32], "Other", 2).unwrap();
    r.trust.set_permission(&fresh.node(), capability::AGENTS_REMOTE, true).unwrap();
    let p = build_request(&fresh, &r.host.node(), HOST, "GET", "/pclink/me", b"", NOW).unwrap();
    let (status, reply) = r.send(&p.body, HOST, 9).await;
    assert_eq!(status, 403);
    assert_eq!(p.verify_answer(&reply).unwrap().0, 403);
    // The switch cannot be set without the run switch.
    let third = TestKey::new();
    r.trust.add(third.node(), [9; 32], "Third", 3).unwrap();
    assert!(r.trust.set_permission(&third.node(), capability::AGENTS_REMOTE_PCDOOR, true).is_err());
}

#[tokio::test]
async fn this_door_never_names_the_phone_routes_or_the_nodes_header_door() {
    // The code (not the comments) of the door must not reach the phone's rights check, route table, or the thread-local node of the old door.
    let code = code_of(include_str!("pcdoor.rs"));
    for word in [" authorize(", "::authorize", "authorize_link", "authorize_caller", "link_call", "mobile_pairing", "current_node", "bridge::", "route_authorized", "legacy: Arc::new(legacy"] {
        assert!(!code.contains(word), "pcdoor.rs names {word}");
    }
    // The door it builds has no legacy routes: the two older routes and every phone route are not found, and the old door has nothing.
    let r = rig("full");
    for target in ["/pclink/../panes", "/panes", "/phone/chats", "/agents/run", "/lend/item", "/pclink"] {
        let p = build_request(&r.caller, &r.host.node(), HOST, "POST", target, b"{}", NOW).unwrap();
        r.assert_flat(&r.send(&p.body, HOST, 9).await);
    }
    assert!(r.fake.calls().is_empty());
}

/// The non-comment lines of the part of a source file before its tests.
fn code_of(source: &str) -> String {
    source.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

#[test]
fn the_nonce_store_is_bounded_and_frees_what_expired() {
    let store = NonceStore::default();
    let node = NodeId([1; 32]);
    for i in 0..NONCE_PER_NODE {
        let mut n = [0u8; 16];
        n[..8].copy_from_slice(&(i as u64).to_be_bytes());
        assert_eq!(store.take(node, n, NOW, NOW), Ok(()));
    }
    assert_eq!(store.take(node, [0xff; 16], NOW, NOW), Err(NonceError::Full), "one device cannot fill the store");
    // Another device still gets in, up to the overall cap.
    let mut taken = NONCE_PER_NODE;
    let mut dev = 2u8;
    while taken < NONCE_MAX {
        for i in 0..NONCE_PER_NODE.min(NONCE_MAX - taken) {
            let mut n = [0u8; 16];
            n[0] = i as u8;
            n[1] = (i >> 8) as u8;
            assert_eq!(store.take(NodeId([dev; 32]), n, NOW, NOW), Ok(()));
            taken += 1;
        }
        dev += 1;
    }
    assert_eq!(store.len(), NONCE_MAX);
    assert_eq!(store.take(NodeId([200; 32]), [9; 16], NOW, NOW), Err(NonceError::Full), "never more than the cap");
    assert!(store.len() <= NONCE_MAX);
    // A replay inside the window is a replay, not "full".
    assert_eq!(store.take(node, [0u8; 16], NOW, NOW + 1), Err(NonceError::Replay));
    // Once every request that carried them is stale, the store empties itself.
    assert_eq!(store.take(NodeId([200; 32]), [9; 16], NOW + WINDOW_MS + 5, NOW + WINDOW_MS + 5), Ok(()));
    assert_eq!(store.len(), 1);
}

#[test]
fn the_signed_layouts_are_fixed_length_prefixed_and_domain_separated() {
    let (to, from) = (NodeId([2; 32]), NodeId([3; 32]));
    let req = request_message("GET", "/pclink/me", b"", &to, &from, "A.example", 5, &[4; 16]);
    assert!(req.starts_with(b"pm/pcdoor/request/v1"));
    // prefix + 8 fields, each with a 4-byte length: method 3, target 10, hash 32, to 32, from 32, host 9 (lowercased), ts 8, nonce 16.
    assert_eq!(req.len(), 20 + 8 * 4 + 3 + 10 + 32 + 32 + 32 + 9 + 8 + 16);
    assert!(req.windows(9).any(|w| w == b"a.example"));
    let ans = answer_message(&to, &from, "a.example", 5, &[4; 16], 200, b"{}");
    assert!(ans.starts_with(b"pm/pcdoor/answer/v1"));
    assert_eq!(ans.len(), 19 + 7 * 4 + 32 + 32 + 9 + 8 + 16 + 4 + 32);
    // Moving a byte between two fields changes the message (the length prefix), so "/a"+"b" is not "/"+"ab".
    assert_ne!(request_message("GET", "/a", b"b", &to, &from, "h", 1, &[0; 16]), request_message("GET", "/", b"ab", &to, &from, "h", 1, &[0; 16]));
}

#[test]
fn the_throttle_is_bounded() {
    let t = Throttle::default();
    for i in 0..(2 * 1024u32) {
        let ip = IpAddr::from([10, (i >> 8) as u8, i as u8, 1]);
        assert!(t.allow(Some(ip), NOW));
    }
    assert!(t.tracked() <= 1024);
}

#[tokio::test]
async fn a_request_signed_before_this_run_started_is_refused_and_one_after_it_is_served() {
    let mut r = rig("watch");
    // This run started at NOW. The nonces of the run before are gone, so anything stamped at or before NOW may be a replay of a capture.
    r.door.nonces = NonceStore::booted(NOW);
    r.now.store(NOW + 5_000, Ordering::SeqCst);
    for ts in [NOW - 1, NOW] {
        let before = build_request(&r.caller, &r.host.node(), HOST, "GET", "/pclink/me", b"", ts).unwrap();
        r.assert_flat(&r.send(&before.body, HOST, 9).await);
    }
    let after = build_request(&r.caller, &r.host.node(), HOST, "GET", "/pclink/me", b"", NOW + 1).unwrap();
    assert_eq!(r.send(&after.body, HOST, 9).await.0, 200);
}

#[test]
fn a_nonce_that_was_forgotten_cannot_come_back_when_the_clock_goes_back() {
    let store = NonceStore::default();
    let node = NodeId([1; 32]);
    assert_eq!(store.take(node, [1; 16], NOW, NOW), Ok(()));
    // The clock runs on past its window (the entry is forgotten), then jumps back: the old stamp would pass the +-60 s check again.
    assert_eq!(store.take(node, [2; 16], NOW + 2 * WINDOW_MS, NOW + 2 * WINDOW_MS), Ok(()));
    assert_eq!(store.take(node, [1; 16], NOW, NOW + 10), Err(NonceError::Replay));
    // A fresh stamp from the new time is fine.
    assert_eq!(store.take(node, [3; 16], NOW + 2 * WINDOW_MS + 1, NOW + 10), Ok(()));
}


async fn junk_sequence(r: &Rig) -> Vec<(u16, Vec<u8>)> {
    let mut out = Vec::new();
    for _ in 0..12 {
        out.push(r.door.handle(Hit { host: HOST, peer: peer(31), method: "POST", target: PATH, body: b"junk" }).await);
    }
    out
}

#[tokio::test]
async fn the_replies_come_in_the_same_order_whether_the_door_is_on_or_off() {
    let on = rig("watch");
    let off = rig("watch");
    off.labs_on.store(false, Ordering::SeqCst);
    let (a, b) = (junk_sequence(&on).await, junk_sequence(&off).await);
    assert_eq!(a, b, "the door's state shows in the order of replies");
    assert_eq!(a.iter().filter(|r| r.0 == 429).count(), 12 - FAILS_PER_WINDOW);
    // The same while the service is not built at all (an address no other test uses; the throttle there is shared).
    let ip = Some(IpAddr::from([198, 51, 100, 77]));
    let unbuilt: Vec<_> = (0..12).map(|_| handle_unbuilt(ip)).collect();
    assert_eq!(unbuilt, a);
}

#[test]
fn the_dummy_key_a_stranger_is_checked_against_is_a_real_public_key() {
    assert!(ed25519_dalek::VerifyingKey::from_bytes(&DUMMY_NODE.0).is_ok());
}

#[test]
fn a_locked_out_address_is_never_evicted_to_make_room() {
    let ip = |i: u32| IpAddr::from([10, (i >> 8) as u8, i as u8, 1]);
    let t = Throttle::default();
    // Fill the table: address 0 stays clean, all others are locked out.
    for i in 0..1024u32 {
        assert!(t.allow(Some(ip(i)), NOW));
        if i > 0 {
            for _ in 0..FAILS_PER_WINDOW {
                t.fail(Some(ip(i)), NOW);
            }
        }
    }
    // A new address takes the clean one's place; every locked address keeps its counter.
    assert!(t.allow(Some(ip(5000)), NOW + 1));
    assert!(t.tracked() <= 1024);
    for i in 1..1024u32 {
        assert!(!t.allow(Some(ip(i)), NOW + 2), "address {i} was let back in by an eviction");
    }
    // Now every tracked address is locked: a NEW address is let through untracked rather than evicting one of them.
    for _ in 0..FAILS_PER_WINDOW {
        t.fail(Some(ip(5000)), NOW + 3);
    }
    assert!(t.allow(Some(ip(6000)), NOW + 4));
    assert!(t.tracked() <= 1024);
    assert!(!t.allow(Some(ip(7)), NOW + 4));
    assert!(t.tracked() <= 1024);
    // The window passes: room again.
    assert!(t.allow(Some(ip(6000)), NOW + WINDOW_MS + 10));
}

#[tokio::test]
async fn a_hit_with_no_visitor_address_is_refused_flat_before_anything_is_verified() {
    let r = rig("watch");
    for _ in 0..20 {
        r.assert_flat(&r.door.handle(Hit { host: HOST, peer: None, method: "POST", target: PATH, body: b"junk" }).await);
    }
    // Even a valid signed request is refused, and it was never verified: its nonce was not taken.
    let good = r.request("GET", "/pclink/me");
    r.assert_flat(&r.door.handle(Hit { host: HOST, peer: None, method: "POST", target: PATH, body: &good.body }).await);
    assert_eq!(r.door.nonces.len(), 0);
    assert!(r.fake.calls().is_empty());
    assert_eq!(handle_unbuilt(None), (401, FLAT_401.to_vec()));
    // The paired PC from a real address is not affected.
    assert_eq!(r.send(&good.body, HOST, 9).await.0, 200);
}

#[tokio::test]
async fn when_the_throttle_is_full_of_locked_addresses_a_new_one_still_faces_only_the_signature_checks() {
    let r = rig("watch");
    let ip = |i: u32| IpAddr::from([10, (i >> 8) as u8, i as u8, 1]);
    for i in 0..1024u32 {
        assert!(r.door.throttle.allow(Some(ip(i)), NOW));
        for _ in 0..FAILS_PER_WINDOW {
            r.door.throttle.fail(Some(ip(i)), NOW);
        }
    }
    // The owner's other PC on an address never seen: served. Junk from another new address: the flat 401, not 429.
    assert_eq!(r.send(&r.request("GET", "/pclink/me").body, HOST, 9).await.0, 200);
    r.assert_flat(&r.send(b"junk", HOST, 10).await);
    assert!(r.door.throttle.tracked() <= 1024);
}

#[test]
fn ipv6_addresses_in_one_slash_64_share_one_bucket() {
    let t = Throttle::default();
    let v6 = |low: u16| IpAddr::from([0x2001, 0xdb8, 1, 2, 0, 0, 0, low]);
    for i in 0..FAILS_PER_WINDOW as u16 {
        assert!(t.allow(Some(v6(i + 1)), NOW));
        t.fail(Some(v6(i + 1)), NOW);
    }
    assert_eq!(t.tracked(), 1);
    assert!(!t.allow(Some(v6(999)), NOW), "a new address in the same /64 is already locked");
    assert!(t.allow(Some(IpAddr::from([0x2001, 0xdb8, 1, 3, 0, 0, 0, 1])), NOW), "another /64 is not");
}

#[tokio::test]
async fn the_dummy_key_is_never_trusted_and_a_request_from_it_is_refused() {
    let r = rig("watch");
    assert!(!r.trust.is_trusted(&DUMMY_NODE));
    let mut env = envelope(&r.request("GET", "/pclink/me"));
    env["from"] = Value::String(DUMMY_NODE.to_hex());
    r.assert_flat(&r.send(&bytes(&env), HOST, 9).await);
    assert!(r.fake.calls().is_empty());
}
