//! My PCs from the account (Connect > My PCs), on the in-memory net with a local fake account server.
//!
//! The fake server keeps the rules of `account/server` that matter here: every call after sign-in is signed by the device's key
//! and used once, a PC may only change its own row, a statement must verify against the key the server holds for that device,
//! a signed-out device is not served. Two or three app instances (each with its own keys, trust list and account session)
//! stand for two or three PCs. Nothing here touches the real account, a real relay or a real window.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};

use super::account_dir::{binding_text, usable, AccountDir, AccountPort, Door};
use super::tests::{instance_with, real_now, until, Instance};
use super::tests_far::{both_sheets, id_of, pending};
use super::Options;
use crate::account::directory::{Book, PcRow};
use crate::account::service::{AccountService, Parts};
use crate::account::statement::{device_statement_with_node, sha256_hex, DEVICE_PREFIX, REQUEST_PREFIX, REVOKE_PREFIX};
use crate::account::store::{SessionStore, StoredSession};
use crate::keys::crypto::{b64, new_signing_key, unb64, SigningKey};
use crate::keys::KeyStore;
use crate::p2p::endpoint::PeerAddr;
use crate::p2p::identity::DeviceIdentity;
use crate::p2p::memory::MemoryNet;
use super::route::MemoryPrefs;
use crate::p2p::pairing::{AccountClaim, AccountExpect, AccountIntro, Clock, ManualClock, PairError, SystemClock};
use crate::secrets::MemoryBackend;

const ACCOUNT: &str = "0b4f5c1e-2b3a-4a76-9c52-0d3f4a5b6c7d";

// ---------- a fake account server that checks what the real one checks ----------

struct Dev {
    id: String,
    account: String,
    device_pub: String,
    name: String,
    statement: String,
    sig: String,
    node_binding: Option<String>,
    home_relay: Option<String>,
    created_at: u64,
    last_seen_at: u64,
    revoked_at: Option<u64>,
    token: String,
}

#[derive(Default)]
struct St {
    devs: Vec<Dev>,
    nonces: HashSet<String>,
    tamper: Vec<Arc<dyn Fn(&mut Vec<Value>) + Send + Sync>>,
    calls: Vec<String>,
}

struct FakeAccount {
    base: String,
    st: Arc<Mutex<St>>,
}

fn dev_view(d: &Dev, self_id: &str, now: u64) -> Value {
    let node = serde_json::from_str::<Value>(&d.statement).ok().and_then(|s| s.get("node_id").and_then(Value::as_str).map(str::to_string));
    json!({
        "id": d.id, "kind": "pc", "name": d.name, "device_pub": d.device_pub, "node_id": node, "node_binding": d.node_binding,
        "home_relay": d.home_relay, "phone_address": null, "created_at": d.created_at, "last_seen_at": d.last_seen_at,
        "online": d.revoked_at.is_none() && now.saturating_sub(d.last_seen_at) < 120,
        "revoked_at": d.revoked_at, "not_me": false, "self": d.id == self_id, "statement": d.statement, "statement_sig": d.sig,
    })
}

fn verify_with(device_pub: &str, prefix: &str, text: &str, sig: &str) -> bool {
    let (Some(p), Some(s)) = (unb64(device_pub), unb64(sig)) else { return false };
    let (Ok(p), Ok(s)) = (<[u8; 32]>::try_from(p.as_slice()), <[u8; 64]>::try_from(s.as_slice())) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&p) else { return false };
    vk.verify([prefix.as_bytes(), text.as_bytes()].concat().as_slice(), &Signature::from_bytes(&s)).is_ok()
}

fn clean(v: &Value, max: usize) -> Option<String> {
    v.as_str().filter(|s| s.len() <= max && !s.chars().any(|c| c.is_control())).map(str::to_string)
}

fn serve(mut sock: TcpStream, st: Arc<Mutex<St>>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let (head_end, len) = loop {
        let Ok(got) = sock.read(&mut chunk) else { return };
        if got == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..got]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
            let len = head.lines().find_map(|l| l.strip_prefix("content-length: ")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
            if buf.len() >= pos + 4 + len {
                break (pos + 4, len);
            }
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let body = buf[head_end..head_end + len].to_vec();
    let mut lines = head.lines();
    let first = lines.next().unwrap_or_default().to_string();
    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(": ").map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))).collect();
    let (method, path) = {
        let mut p = first.split(' ');
        (p.next().unwrap_or("").to_string(), p.next().unwrap_or("").to_string())
    };
    let now = real_now();
    let (status, reply) = {
        let mut st = st.lock().unwrap();
        st.calls.push(format!("{method} {path}"));
        route(&mut st, &method, &path, &headers, &body, now)
    };
    let text = if reply.is_null() { String::new() } else { reply.to_string() };
    let word = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Unauthorized",
    };
    let resp = format!("HTTP/1.1 {status} {word}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
    let _ = sock.write_all(resp.as_bytes());
}

fn route(st: &mut St, method: &str, path: &str, h: &HashMap<String, String>, body: &[u8], now: u64) -> (u16, Value) {
    let unauthorized = (401, json!({ "error": "unauthorized" }));
    let Some(dev_id) = h.get("x-device-id").map(|s| s.to_lowercase()) else { return unauthorized };
    let (Some(ts), Some(nonce), Some(sig)) = (h.get("x-timestamp"), h.get("x-nonce"), h.get("x-signature")) else { return unauthorized };
    let Some(ix) = st.devs.iter().position(|d| d.id == dev_id && d.revoked_at.is_none()) else { return unauthorized };
    let text = format!("{REQUEST_PREFIX}{method}\n{path}\n{ts}\n{nonce}\n{}", sha256_hex(body));
    let ok = h.get("authorization").map(String::as_str) == Some(format!("Bearer {}", st.devs[ix].token).as_str())
        && verify_with(&st.devs[ix].device_pub, "", &text, sig)
        && st.nonces.insert(nonce.clone());
    if !ok {
        return unauthorized;
    }
    st.devs[ix].last_seen_at = now;
    let b: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    match (method, path) {
        ("GET", "/v1/devices") => {
            let account = st.devs[ix].account.clone();
            let mut rows: Vec<Value> = st.devs.iter().filter(|d| d.account == account).map(|d| dev_view(d, &dev_id, now)).collect();
            for t in &st.tamper {
                t(&mut rows);
            }
            (200, json!({ "devices": rows }))
        }
        ("PATCH", "/v1/devices/self") => {
            let d = &mut st.devs[ix];
            if let (Some(stmt), Some(sg)) = (b["statement"].as_str(), b["signature"].as_str()) {
                let parsed: Value = serde_json::from_str(stmt).unwrap_or(Value::Null);
                let fits = verify_with(&d.device_pub, DEVICE_PREFIX, stmt, sg)
                    && parsed["account_id"] == d.account.as_str()
                    && parsed["device_id"] == d.id.as_str()
                    && parsed["device_pub"] == d.device_pub.as_str()
                    && parsed["kind"] == "pc";
                if !fits {
                    return (400, json!({ "error": "invalid_statement" }));
                }
                d.name = parsed["name"].as_str().unwrap_or("").to_string();
                d.statement = stmt.to_string();
                d.sig = sg.to_string();
            }
            if let Some(nb) = b.get("node_binding") {
                match clean(nb, 4096) {
                    Some(v) => d.node_binding = Some(v),
                    None => return (400, json!({ "error": "bad_request" })),
                }
            }
            if let Some(r) = b.get("home_relay") {
                d.home_relay = if r.is_null() {
                    None
                } else {
                    match clean(r, 300) {
                        Some(v) => Some(v),
                        None => return (400, json!({ "error": "bad_request" })),
                    }
                };
            }
            (200, dev_view(d, &dev_id, now))
        }
        ("DELETE", "/v1/session") => (204, Value::Null),
        ("POST", p) if p.starts_with("/v1/devices/") && p.ends_with("/sign-out") => {
            let target = p.trim_start_matches("/v1/devices/").trim_end_matches("/sign-out").to_lowercase();
            let (Some(stmt), Some(sg)) = (b["statement"].as_str(), b["signature"].as_str()) else { return (400, json!({ "error": "invalid_statement" })) };
            let parsed: Value = serde_json::from_str(stmt).unwrap_or(Value::Null);
            let good = verify_with(&st.devs[ix].device_pub, REVOKE_PREFIX, stmt, sg) && parsed["action"] == "sign_out" && parsed["target_device_id"] == target.as_str() && parsed["by_device_id"] == dev_id.as_str();
            if !good {
                return (400, json!({ "error": "invalid_statement" }));
            }
            let account = st.devs[ix].account.clone();
            match st.devs.iter_mut().find(|d| d.id == target && d.account == account) {
                Some(t) => {
                    t.revoked_at = Some(now);
                    (200, json!({ "ok": true }))
                }
                None => (404, json!({ "error": "not_found" })),
            }
        }
        _ => (404, json!({ "error": "not_found" })),
    }
}

impl FakeAccount {
    fn start() -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let st = Arc::new(Mutex::new(St::default()));
        let shared = st.clone();
        std::thread::spawn(move || {
            for sock in listener.incoming().flatten() {
                let st = shared.clone();
                std::thread::spawn(move || serve(sock, st));
            }
        });
        Arc::new(Self { base, st })
    }

    /// The account holder signs a device in: its row, with a plain statement (no link id yet), and a session token.
    fn sign_in(&self, key: &SigningKey, id: &str, name: &str) -> String {
        let s = device_statement_with_node(key, ACCOUNT, id, "pc", name, None);
        let token = format!("tok-{id}");
        let now = real_now();
        self.st.lock().unwrap().devs.push(Dev {
            id: id.to_string(),
            account: ACCOUNT.to_string(),
            device_pub: b64(key.verifying_key().as_bytes()),
            name: name.to_string(),
            statement: s.statement,
            sig: s.signature,
            node_binding: None,
            home_relay: None,
            created_at: now,
            last_seen_at: now,
            revoked_at: None,
            token: token.clone(),
        });
        token
    }

    fn node_of(&self, id: &str) -> Option<String> {
        let st = self.st.lock().unwrap();
        let d = st.devs.iter().find(|d| d.id == id)?;
        serde_json::from_str::<Value>(&d.statement).ok()?.get("node_id")?.as_str().filter(|n| n.len() == 64).map(str::to_string)
    }

    fn binding_of(&self, id: &str) -> Option<String> {
        self.st.lock().unwrap().devs.iter().find(|d| d.id == id).and_then(|d| d.node_binding.clone())
    }

    fn relay_of(&self, id: &str) -> Option<String> {
        self.st.lock().unwrap().devs.iter().find(|d| d.id == id).and_then(|d| d.home_relay.clone())
    }

    fn revoked(&self, id: &str) -> bool {
        self.st.lock().unwrap().devs.iter().find(|d| d.id == id).is_some_and(|d| d.revoked_at.is_some())
    }

    fn tamper(&self, f: impl Fn(&mut Vec<Value>) + Send + Sync + 'static) {
        self.st.lock().unwrap().tamper.push(Arc::new(f));
    }

    fn untamper(&self) {
        self.st.lock().unwrap().tamper.clear();
    }

    fn calls(&self) -> Vec<String> {
        self.st.lock().unwrap().calls.clone()
    }
}

// ---------- PCs ----------

struct Pc {
    inst: Instance,
    svc: Arc<AccountService>,
    id: String,
}

fn account_service(server: &Arc<FakeAccount>, name: &str, id: &str, key: SigningKey, signed_in: bool) -> Arc<AccountService> {
    let store = SessionStore::with_backend(Arc::new(MemoryBackend::new()), name);
    let base = server.base.clone();
    if signed_in {
        let token = server.sign_in(&key, id, name);
        store
            .save(&StoredSession { token, device_id: id.to_string(), account_id: ACCOUNT.to_string(), display_name: "Test Person".into(), provider: "password".into(), server: base.clone() })
            .unwrap();
    }
    let display = name.to_string();
    Arc::new(AccountService::new(Parts {
        store,
        key: Box::new(move || Ok(key.clone())),
        base: Box::new(move || Some(base.clone())),
        name: Box::new(move || display.clone()),
        open: Box::new(|_| Ok(())),
    }))
}

/// A PC of the person's account (or, with `signed_in` false, one that never signed in).
fn pc(name: &str, id: &str, net: &MemoryNet, server: &Arc<FakeAccount>, tick: bool, signed_in: bool) -> Pc {
    pc_with(name, id, net, server, tick, signed_in, Arc::new(SystemClock), MemoryPrefs::new())
}

/// The same with the pairing clock and the file the account route's lockouts are kept in (a restart is a new PC over the same file).
#[allow(clippy::too_many_arguments)]
fn pc_with(name: &str, id: &str, net: &MemoryNet, server: &Arc<FakeAccount>, tick: bool, signed_in: bool, clock: Arc<dyn Clock>, lock_file: Arc<MemoryPrefs>) -> Pc {
    let svc = account_service(server, name, id, new_signing_key(), signed_in);
    let mut options = Options::memory();
    options.account = Some(svc.clone());
    options.account_lock = lock_file;
    let inst = instance_with(name, net.factory(), false, clock, Arc::new(real_now), options);
    inst.link.apply_settings(&json!({ "devices_enabled": true }));
    // The tick is not a setting: the person's own switch, set through the service.
    inst.link.set_open_from_account(tick).unwrap();
    Pc { inst, svc, id: id.to_string() }
}

const A_ID: &str = "11111111-1111-4111-8111-111111111111";
const B_ID: &str = "22222222-2222-4222-8222-222222222222";
const T_ID: &str = "33333333-3333-4333-8333-333333333333";

/// What this PC would send when it knocks: its own account statement naming its link id.
fn claim_of(p: &Pc) -> AccountClaim {
    let (statement, signature) = p.svc.introduction(&p.inst.node()).unwrap().expect("signed in");
    AccountClaim { statement, signature }
}

async fn start(pcs: &[&Pc]) {
    for p in pcs {
        p.inst.link.start().await.unwrap();
    }
}

async fn list(p: &Pc) -> Value {
    // The page reuses what it read a few seconds ago; a test wants what the server says now.
    p.inst.link.acct.as_ref().unwrap().forget();
    let link = p.inst.link.clone();
    tokio::task::spawn_blocking(move || link.account_pcs().unwrap()).await.unwrap()
}

fn row<'a>(listed: &'a Value, name: &str) -> Option<&'a Value> {
    listed["pcs"].as_array().unwrap().iter().find(|p| p["name"] == name)
}

fn trusted(p: &Pc) -> usize {
    p.inst.link.view()["devices"].as_array().unwrap().len()
}

/// B presses Open on A, and the two sheets show up.
async fn knock(b: &Pc, a: &Pc) -> tokio::task::JoinHandle<Result<Value, String>> {
    let (link, id) = (b.inst.link.clone(), a.id.clone());
    let task = tokio::spawn(async move { link.open_account_pc(&id).await });
    until("both sheets (or the knock ended)", || (!pending(&a.inst).is_null() && !pending(&b.inst).is_null()) || task.is_finished()).await;
    if task.is_finished() {
        let seen = list(b).await;
        panic!("the knock ended before both sheets showed: {:?} rows: {seen}", task.await.unwrap());
    }
    task
}

// ---------- tests ----------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_the_tick_off_nothing_is_published_the_door_is_shut_and_the_row_says_allow_there_first() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, false, true);
    let b = pc("Laptop", B_ID, &net, &server, true, true);
    start(&[&a, &b]).await;
    assert!(server.node_of(A_ID).is_none(), "a PC without the tick tells the account no link id");
    assert!(server.relay_of(A_ID).is_none());
    // B has the tick on, so it published itself; A did not.
    until("B published", || server.node_of(B_ID).is_some()).await;
    let seen = list(&b).await;
    let r = row(&seen, "Desk PC").expect("the other PC is listed");
    assert_eq!(r["status"], "allow_there");
    assert!(r["node"].is_null());
    // Pressing Open anyway is refused with a plain sentence, and nothing was knocked.
    let err = b.inst.link.open_account_pc(A_ID).await.unwrap_err();
    assert!(err.contains("Let my other PCs open this PC"), "{err}");
    assert!(pending(&a.inst).is_null() && pending(&b.inst).is_null());
    // The door itself: even a knock that skips the page is turned away before any sheet.
    let node = crate::device_link::node_of(&a.inst.node()).unwrap();
    let expect = AccountExpect { claim: claim_of(&b), name: "Desk PC".into(), device_id: "x".into(), first_seen: 0, device_pub: [0; 32] };
    let res = b.inst.link.mgr.join_account(PeerAddr::new(node), expect).await;
    assert!(matches!(res, Err(PairError::NotReachable)), "{res:?}");
    assert!(pending(&a.inst).is_null());
    assert_eq!((trusted(&a), trusted(&b)), (0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_the_tick_on_the_pc_is_listed_online_and_nothing_is_trusted_until_the_number_check() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    let published = server.node_of(A_ID).expect("A told the account its link id");
    assert_eq!(published, a.inst.node());
    let seen = list(&b).await;
    let r = row(&seen, "Desk PC").unwrap();
    assert_eq!((r["status"].as_str(), r["online"].as_bool()), (Some("new"), Some(true)));
    assert_eq!(r["node"], published.as_str());
    assert!(seen["pcs"].as_array().unwrap().iter().all(|p| p["name"] != "Laptop"), "this PC is not listed to itself");
    // Listed is not trusted: nobody trusts anybody yet.
    assert_eq!((trusted(&a), trusted(&b)), (0, 0));
    assert!(a.inst.link.view()["pending"].is_null());
}

/// The six digits the PC pressing Open shows (its sheet has them; the PC being opened shows none).
fn shown_digits(b: &Pc) -> String {
    pending(&b.inst)["number"].as_str().expect("the PC pressing Open shows the digits").to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn open_pairs_when_the_person_types_the_six_digits_the_other_pc_shows_and_grants_nothing() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    let task = knock(&b, &a).await;
    // The PC being opened shows NO number and no choices: its person has to type what the other PC shows.
    let pa = pending(&a.inst);
    assert_eq!((pa["mode"].as_str(), pa["role"].as_str()), (Some("type"), Some("host")));
    assert!(pa["choices"].is_null() && pa["number"].is_null(), "nothing to pick from, nothing to read off this screen");
    assert_eq!(pa["name"], "Laptop");
    assert!(pa["account"]["first_seen"].as_u64().is_some());
    assert!(pa["fingerprint"].as_str().unwrap().len() >= 9, "the key's fingerprint is on the sheet");
    // The PC pressing Open shows the six digits.
    let pb = pending(&b.inst);
    assert_eq!((pb["mode"].as_str(), pb["name"].as_str()), (Some("show"), Some("Desk PC")));
    assert!(pb["choices"].is_null());
    let digits = shown_digits(&b);
    assert_eq!(digits.len(), 6);
    assert_eq!((trusted(&a), trusted(&b)), (0, 0), "still nobody trusted while the sheets are open");
    // A plain Yes does not skip the typing.
    assert!(a.inst.link.pair_answer(id_of(&a.inst), true).unwrap_err().contains("Pick the number"));
    // Typed with a space in the middle, the way it is read off a screen.
    a.inst.link.pair_pick(id_of(&a.inst), &format!("{} {}", &digits[..3], &digits[3..])).unwrap();
    b.inst.link.pair_answer(id_of(&b.inst), true).unwrap();
    let done = task.await.unwrap().expect("opened");
    assert_eq!(done["paired"], true);
    assert_eq!(done["node"], a.inst.node());
    // Both trust each other with every right off: no run-agents right by default.
    for (me, other) in [(&a, &b), (&b, &a)] {
        let v = me.inst.link.view();
        assert_eq!(v["devices"].as_array().unwrap().len(), 1);
        assert_eq!(v["devices"][0]["node"], other.inst.node());
        assert_eq!(v["devices"][0]["lets_run"], false);
    }
    assert_eq!(done["state"], "not_allowed", "A has not let B run agents, and B is told so plainly rather than shown as online");
    assert_eq!(row(&list(&b).await, "Desk PC").unwrap()["status"], "not_allowed");
    // The second Open is just a check that it answers: no sheet, no number.
    let again = b.inst.link.open_account_pc(A_ID).await;
    assert!(pending(&a.inst).is_null() && pending(&b.inst).is_null());
    assert!(again.is_ok(), "{again:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_account_route_never_grants_a_right_and_its_sheet_has_no_way_to_ask_for_one() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    let task = knock(&b, &a).await;
    // The sheet's view has nothing but the digits box and the answers: no field that could carry a right.
    let sheet = pending(&a.inst);
    let keys: Vec<&str> = sheet.as_object().unwrap().keys().map(String::as_str).collect();
    assert!(keys.iter().all(|k| !k.contains("grant") && !k.contains("run") && !k.contains("rights")), "{keys:?}");
    a.inst.link.pair_pick(id_of(&a.inst), &shown_digits(&b)).unwrap();
    b.inst.link.pair_answer(id_of(&b.inst), true).unwrap();
    task.await.unwrap().expect("opened");
    // Both trust each other with every right off, on both sides, and B is told so plainly.
    let on_a = a.inst.link.view()["devices"][0].clone();
    assert_eq!((on_a["lets_run"].clone(), on_a["lets_web"].clone(), on_a["lets_files"].clone(), on_a["lets_lend"].clone()), (json!(false), json!(false), json!(false), json!(false)));
    assert_eq!(b.inst.link.view()["devices"][0]["lets_run"], false);
    assert_eq!(row(&list(&b).await, "Desk PC").unwrap()["status"], "not_allowed");
    // The source of the account route never turns a right on: no permission call in the pairing module, and the service hook only syncs.
    let pairing = include_str!("../p2p/pairing/account.rs");
    assert!(!pairing.contains("set_permission") && !pairing.contains("AGENTS_REMOTE"));
    let service = include_str!("mod.rs");
    let hook = &service[service.find("set_on_account_paired(Arc::new(").unwrap()..];
    let hook = &hook[..hook.find("me.live.set_on_change").unwrap()];
    assert!(!hook.contains("set_permission"), "the hook must not grant anything: {hook}");
}

/// One knock from `b` on `a` that the person at `a` answers with `typed` (the wrong digits, or `None` for No).
async fn wrong_knock(b: &Pc, a: &Pc, typed: Option<&str>) {
    let task = knock(b, a).await;
    match typed {
        Some(t) => a.inst.link.pair_pick(id_of(&a.inst), t).unwrap(),
        None => a.inst.link.pair_answer(id_of(&a.inst), false).unwrap(),
    };
    let _ = b.inst.link.pair_answer(id_of(&b.inst), true);
    assert!(task.await.unwrap().is_err());
    until("sheets gone", || pending(&a.inst).is_null() && pending(&b.inst).is_null()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_strikes_lock_the_route_for_everybody_it_escalates_it_survives_a_restart_and_lifts_with_the_clock() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let clock = ManualClock::new(real_now() * 1000);
    let lock_file = MemoryPrefs::new();
    let a = pc_with("Desk PC", A_ID, &net, &server, true, true, clock.clone(), lock_file.clone());
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    let c = pc("Third", T_ID, &net, &server, false, true);
    start(&[&a, &b, &c]).await;
    // A wrong number, then a No: two strikes against B.
    wrong_knock(&b, &a, Some("000000")).await;
    assert!(a.inst.link.view()["account_locked_until"].is_null(), "one strike does not lock");
    wrong_knock(&b, &a, None).await;
    until("two strikes lock the route", || !a.inst.link.view()["account_locked_until"].is_null()).await;
    let first = a.inst.link.view()["account_locked_until"].as_u64().unwrap();
    assert_eq!(first, clock.now_ms() + 10 * 60_000, "first lock: 10 minutes");
    assert_eq!((trusted(&a), trusted(&b)), (0, 0));
    // A knock from a FRESH third device is locked out too, and no sheet appears.
    let err = c.inst.link.open_account_pc(A_ID).await.unwrap_err();
    assert_eq!(err, format!("{}{first}", crate::device_link::ACCOUNT_LOCKED_MARK), "the refusal says it is a lock and until when");
    assert!(pending(&a.inst).is_null(), "a locked route shows nothing");
    // The same knock from B is refused the same way.
    assert_eq!(b.inst.link.open_account_pc(A_ID).await.unwrap_err(), format!("{}{first}", crate::device_link::ACCOUNT_LOCKED_MARK));
    // The lock is on disk: a restart (a new service over the same file) is still locked, without any strike.
    // (Not signed in again: it is the same device, so the account gets no second entry; only the lock file matters here.)
    let reborn = pc_with("Desk PC", A_ID, &net, &server, true, false, clock.clone(), lock_file.clone());
    assert_eq!(reborn.inst.link.view()["account_locked_until"].as_u64(), Some(first), "the lock survives a restart");
    // It lifts when the time has passed.
    clock.advance(10 * 60_000 + 1);
    assert!(a.inst.link.view()["account_locked_until"].is_null());
    // Two more strikes: the second lock is longer (1 hour), then the third is 24 hours, and it stays there.
    wrong_knock(&b, &a, Some("000000")).await;
    wrong_knock(&b, &a, None).await;
    until("second lock", || !a.inst.link.view()["account_locked_until"].is_null()).await;
    assert_eq!(a.inst.link.view()["account_locked_until"].as_u64(), Some(clock.now_ms() + 60 * 60_000), "second lock: 1 hour");
    clock.advance(60 * 60_000 + 1);
    wrong_knock(&b, &a, Some("000000")).await;
    wrong_knock(&b, &a, None).await;
    until("third lock", || !a.inst.link.view()["account_locked_until"].is_null()).await;
    assert_eq!(a.inst.link.view()["account_locked_until"].as_u64(), Some(clock.now_ms() + 24 * 60 * 60_000), "third lock: 24 hours");
    clock.advance(24 * 60 * 60_000 + 1);
    // A good pairing clears it for good.
    let task = knock(&b, &a).await;
    a.inst.link.pair_pick(id_of(&a.inst), &shown_digits(&b)).unwrap();
    b.inst.link.pair_answer(id_of(&b.inst), true).unwrap();
    assert!(task.await.unwrap().is_ok());
    assert!(a.inst.link.view()["account_locked_until"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sheet_nobody_answers_counts_nothing_against_the_pc_that_knocked() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    let task = knock(&b, &a).await;
    // B cancels (No on the PC pressing Open). A's person, who has not heard yet, types the right digits: it ends as "they declined",
    // which counts nothing against anybody, however often it happens.
    let digits = shown_digits(&b);
    b.inst.link.pair_answer(id_of(&b.inst), false).unwrap();
    a.inst.link.pair_pick(id_of(&a.inst), &digits).unwrap();
    assert!(task.await.unwrap().is_err());
    until("sheets gone", || pending(&a.inst).is_null() && pending(&b.inst).is_null()).await;
    for _ in 0..3 {
        let again = knock(&b, &a).await;
        let d = shown_digits(&b);
        b.inst.link.pair_answer(id_of(&b.inst), false).unwrap();
        a.inst.link.pair_pick(id_of(&a.inst), &d).unwrap();
        assert!(again.await.unwrap().is_err());
        until("sheets gone", || pending(&a.inst).is_null() && pending(&b.inst).is_null()).await;
    }
    assert!(a.inst.link.view()["account_locked_until"].is_null());
    assert_eq!((trusted(&a), trusted(&b)), (0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pc_that_is_not_on_the_account_gets_no_sheet_on_the_pc_it_knocks_on() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    // A stranger: never signed in with this account, but runs the same app and knows A's link id (it was published).
    let stranger = pc("Stranger", T_ID, &net, &server, false, false);
    start(&[&a, &stranger]).await;
    let node = crate::device_link::node_of(&a.inst.node()).unwrap();
    // 1. It claims to be a device of the account with a statement it signed with a key of its own: not a device on the list.
    let own_key = new_signing_key();
    let s = device_statement_with_node(&own_key, ACCOUNT, T_ID, "pc", "Stranger", Some(&stranger.inst.node()));
    let expect = AccountExpect { claim: AccountClaim { statement: s.statement, signature: s.signature }, name: "Desk PC".into(), device_id: "x".into(), first_seen: 0, device_pub: [0; 32] };
    let res = stranger.inst.link.mgr.join_account(PeerAddr::new(node), expect).await;
    assert!(matches!(res, Err(PairError::NotYours)), "{res:?}");
    // 2. It sends no claim worth reading.
    let expect = AccountExpect { claim: AccountClaim { statement: "{}".into(), signature: "x".into() }, name: "Desk PC".into(), device_id: "x".into(), first_seen: 0, device_pub: [0; 32] };
    let res = stranger.inst.link.mgr.join_account(PeerAddr::new(node), expect).await;
    assert!(matches!(res, Err(PairError::NotYours)), "{res:?}");
    assert!(pending(&a.inst).is_null(), "nothing shows on A: no sheet, no sound, no time of the person");
    assert_eq!((trusted(&a), trusted(&stranger)), (0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_knock_with_no_good_statement_neither_takes_the_busy_flag_nor_knocks_more_than_a_few_times() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    let stranger = pc("Stranger", T_ID, &net, &server, false, false);
    start(&[&a, &b, &stranger]).await;
    let node = crate::device_link::node_of(&a.inst.node()).unwrap();
    let junk = || AccountExpect { claim: AccountClaim { statement: "{}".into(), signature: "x".into() }, name: "Desk PC".into(), device_id: "x".into(), first_seen: 0, device_pub: [0; 32] };
    // A real knock is waiting on A's person (A is busy with it).
    let task = knock(&b, &a).await;
    // A stranger's knock is still answered "not yours" at once: it never needed the busy flag, so it is not "busy" either.
    let res = stranger.inst.link.mgr.join_account(PeerAddr::new(node), junk()).await;
    assert!(matches!(res, Err(PairError::NotYours)), "{res:?}");
    a.inst.link.pair_answer(id_of(&a.inst), false).unwrap();
    let _ = b.inst.link.pair_answer(id_of(&b.inst), true);
    let _ = task.await;
    until("sheets gone", || pending(&a.inst).is_null() && pending(&b.inst).is_null()).await;
    // From one node, only a few knocks a while get through the cheap checks; the rest are turned away as busy.
    let mut last = None;
    for _ in 0..8 {
        last = Some(stranger.inst.link.mgr.join_account(PeerAddr::new(node), junk()).await);
    }
    assert!(matches!(last, Some(Err(PairError::Refused))), "{last:?}");
    assert!(pending(&a.inst).is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn somebody_who_got_into_the_account_can_knock_but_nothing_is_trusted_until_a_person_types_the_digits() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, true, true);
    // The thief has the Discord login: a valid, signed row on the account, with a link id and everything.
    let t = pc("Studio", T_ID, &net, &server, true, true);
    start(&[&a, &b, &t]).await;
    until("all published", || server.node_of(A_ID).is_some() && server.node_of(B_ID).is_some() && server.node_of(T_ID).is_some()).await;
    // The thief's row is listed, flagged as new on the account. It is only a suggestion.
    let seen = list(&a).await;
    assert!(row(&seen, "Studio").unwrap()["recent"] == true);
    // The thief knocks on A. A's sheet appears; the thief cannot type anything on A and the digits are on ITS screen only.
    let (tl, aid) = (t.inst.link.clone(), A_ID.to_string());
    let task = tokio::spawn(async move { tl.open_account_pc(&aid).await });
    both_sheets(&a.inst, &t.inst).await;
    assert!(pending(&a.inst)["account"]["first_seen"].as_u64().is_some());
    assert!(pending(&a.inst)["number"].is_null(), "A's screen holds nothing a person could copy blind");
    assert_eq!(trusted(&a), 0, "a sheet is not trust");
    // The person at A does not know this: No. The thief's own screen shows the digits; saying "typed it" there changes nothing.
    a.inst.link.pair_answer(id_of(&a.inst), false).unwrap();
    t.inst.link.pair_answer(id_of(&t.inst), true).unwrap();
    assert!(task.await.unwrap().is_err());
    until("sheets gone", || pending(&a.inst).is_null() && pending(&t.inst).is_null()).await;
    assert_eq!((trusted(&a), trusted(&t)), (0, 0));
    // A blind guess at the digits is a No as well (one chance in a million).
    let (tl, aid) = (t.inst.link.clone(), A_ID.to_string());
    let task = tokio::spawn(async move { tl.open_account_pc(&aid).await });
    both_sheets(&a.inst, &t.inst).await;
    let guess = if shown_digits(&t) == "123456" { "654321" } else { "123456" };
    a.inst.link.pair_pick(id_of(&a.inst), guess).unwrap();
    t.inst.link.pair_answer(id_of(&t.inst), true).unwrap();
    assert!(task.await.unwrap().is_err());
    assert_eq!((trusted(&a), trusted(&t)), (0, 0));
    assert!(row(&list(&a).await, "Studio").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_account_server_cannot_inject_a_pc_or_swap_a_key_and_a_row_that_does_not_check_out_is_never_listed() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    let evil = pc("Evil", T_ID, &net, &server, true, true);
    start(&[&a, &b, &evil]).await;
    until("published", || server.node_of(A_ID).is_some() && server.node_of(T_ID).is_some()).await;
    let a_node = server.node_of(A_ID).unwrap();
    let evil_node = server.node_of(T_ID).unwrap();
    let evil_record = binding_text(&identity("somebody-else").binding());

    // 1. The server rewrites A's signed statement to name the attacker's node: it no longer verifies. A is not listed
    //    (dropped, not "repaired"), so there is nothing to press Open on.
    let (swapped, evil_n) = (a_node.clone(), evil_node.clone());
    server.tamper(move |rows| {
        for r in rows.iter_mut().filter(|r| r["name"] == "Desk PC") {
            r["statement"] = json!(r["statement"].as_str().unwrap().replace(&swapped, &evil_n));
        }
    });
    assert!(row(&list(&b).await, "Desk PC").is_none());
    server.untamper();

    // 2. The server keeps A's signed statement but swaps in a node record made for another node: listed, but not openable,
    //    and Open is refused with the same plain sentence as a PC that never ticked.
    server.tamper(move |rows| {
        for r in rows.iter_mut().filter(|r| r["name"] == "Desk PC") {
            r["node_binding"] = json!(evil_record);
        }
    });
    let seen = list(&b).await;
    assert_eq!(row(&seen, "Desk PC").unwrap()["status"], "allow_there", "the record does not match the node the PC signed");
    assert!(b.inst.link.open_account_pc(A_ID).await.unwrap_err().contains("tick"));
    server.untamper();

    // 3. The server invents a row: a made-up key, a made-up signature. Dropped. A row signed by a real key but for ANOTHER account
    //    (the server mixing accounts up) is dropped too, and so is a row whose signature belongs to a different key.
    let invented = |id: &str, name: &str, key: &SigningKey, claim: &SigningKey, account: &str| {
        let s = device_statement_with_node(claim, account, id, "pc", name, Some(&evil_node));
        json!({ "id": id, "kind": "pc", "name": name, "device_pub": b64(key.verifying_key().as_bytes()), "node_id": evil_node, "node_binding": "{}",
            "home_relay": null, "created_at": 1, "last_seen_at": real_now(), "online": true, "revoked_at": null, "not_me": false, "self": false,
            "statement": s.statement, "statement_sig": s.signature })
    };
    let (k1, k2) = (new_signing_key(), new_signing_key());
    let extra = vec![
        // a statement signed by key 1 under key 2's name
        invented("44444444-4444-4444-8444-444444444444", "Wrong key", &k2, &k1, ACCOUNT),
        // a good statement for another account
        invented("55555555-5555-4555-8555-555555555555", "Other account", &k1, &k1, "99999999-9999-4999-8999-999999999999"),
        // a good statement and key, but the row's id is not the id the statement names
        invented("66666666-6666-4666-8666-666666666666", "Wrong id", &k1, &k1, ACCOUNT),
    ];
    let mut extra = extra;
    extra[2]["id"] = json!("77777777-7777-4777-8777-777777777777");
    server.tamper(move |rows| rows.extend(extra.clone()));
    let seen = list(&b).await;
    for name in ["Wrong key", "Other account", "Wrong id"] {
        assert!(row(&seen, name).is_none(), "{name} must not be listed");
    }
    assert!(row(&seen, "Desk PC").is_some(), "the real PC is still there");
    server.untamper();

    // 4. A signed-out PC and a PC not seen for a month are not listed.
    server.tamper(|rows| {
        for r in rows.iter_mut().filter(|r| r["name"] == "Evil") {
            r["revoked_at"] = json!(5);
        }
        for r in rows.iter_mut().filter(|r| r["name"] == "Desk PC") {
            r["last_seen_at"] = json!(1);
        }
    });
    let seen = list(&b).await;
    assert!(row(&seen, "Evil").is_none() && row(&seen, "Desk PC").is_none(), "removed and stale PCs disappear");
    server.untamper();
    assert_eq!((trusted(&a), trusted(&b), trusted(&evil)), (0, 0, 0), "no listing, true or false, made anybody trusted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_copied_public_record_cannot_borrow_a_pcs_name_and_neither_entry_is_offered() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    // Somebody who is signed in on the account (but is not A) names A's link id and copies A's public node record into an entry of its own.
    let thief = pc("Not the Desk PC", T_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    until("A published", || server.node_of(A_ID).is_some()).await;
    let (node, binding) = (server.node_of(A_ID).unwrap(), server.binding_of(A_ID).unwrap());
    let svc = thief.svc.clone();
    tokio::task::spawn_blocking(move || svc.publish_pc(&node, &binding, None)).await.unwrap().unwrap();
    let seen = list(&b).await;
    for name in ["Desk PC", "Not the Desk PC"] {
        let r = row(&seen, name).unwrap_or_else(|| panic!("{name} is listed"));
        assert_eq!(r["status"], "conflict", "{name}");
        assert!(r["node"].is_null(), "neither entry is offered");
    }
    let err = b.inst.link.open_account_pc(A_ID).await.unwrap_err();
    assert!(err.contains("Two entries"), "{err}");
    assert!(pending(&a.inst).is_null() && pending(&b.inst).is_null());
    assert_eq!((trusted(&a), trusted(&b)), (0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unticking_withdraws_the_listing_and_shuts_the_door_at_once() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    assert!(server.node_of(A_ID).is_some());
    a.inst.link.set_open_from_account(false).unwrap();
    until("withdrawn", || server.node_of(A_ID).is_none()).await;
    assert_eq!(row(&list(&b).await, "Desk PC").unwrap()["status"], "allow_there");
    let node = crate::device_link::node_of(&a.inst.node()).unwrap();
    let expect = AccountExpect { claim: claim_of(&b), name: "Desk PC".into(), device_id: "x".into(), first_seen: 0, device_pub: [0; 32] };
    assert!(b.inst.link.mgr.join_account(PeerAddr::new(node), expect).await.is_err());
    assert!(pending(&a.inst).is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn signing_out_shuts_the_door_and_stops_listening_until_the_person_signs_in_again() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, true, true);
    start(&[&a, &b]).await;
    until("both published", || server.node_of(A_ID).is_some() && server.node_of(B_ID).is_some()).await;
    let svc = b.svc.clone();
    tokio::task::spawn_blocking(move || svc.sign_out_here()).await.unwrap();
    // What the app does right after the command: the door follows the sign-out.
    b.inst.link.sync_account().await;
    let node = crate::device_link::node_of(&b.inst.node()).unwrap();
    let expect = AccountExpect { claim: claim_of(&a), name: "Laptop".into(), device_id: "x".into(), first_seen: 0, device_pub: [0; 32] };
    let res = a.inst.link.mgr.join_account(PeerAddr::new(node), expect).await;
    assert!(matches!(res, Err(PairError::NotReachable)), "the door is shut, not merely unattended: {res:?}");
    assert!(pending(&b.inst).is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn signing_out_removes_this_pc_from_the_other_lists_and_from_the_door() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, true, true);
    start(&[&a, &b]).await;
    until("both published", || server.node_of(A_ID).is_some() && server.node_of(B_ID).is_some()).await;
    assert!(row(&list(&b).await, "Desk PC").is_some());
    // A statement this PC signed while it was signed in: the best a thief of that statement (or the signed-out PC itself) can do.
    let old_claim = claim_of(&a);
    let svc = a.svc.clone();
    let out = tokio::task::spawn_blocking(move || svc.sign_out_here()).await.unwrap();
    assert!(!out.signed_in);
    assert!(server.revoked(A_ID), "the account marks the device signed out");
    assert!(server.node_of(A_ID).is_none(), "and it no longer names a link id");
    let seen = list(&b).await;
    assert!(row(&seen, "Desk PC").is_none(), "gone from the other PC's list");
    // A knock from the signed-out PC is turned away at B's door.
    let node = crate::device_link::node_of(&b.inst.node()).unwrap();
    let expect = AccountExpect { claim: old_claim, name: "Laptop".into(), device_id: "x".into(), first_seen: 0, device_pub: [0; 32] };
    let res = a.inst.link.mgr.join_account(PeerAddr::new(node), expect).await;
    assert!(matches!(res, Err(PairError::NotYours)), "{res:?}");
    assert!(pending(&b.inst).is_null());
}

/// A and B pair through the account (A's person types B's digits).
async fn pair_through_the_account(a: &Pc, b: &Pc) {
    let task = knock(b, a).await;
    a.inst.link.pair_pick(id_of(&a.inst), &shown_digits(b)).unwrap();
    b.inst.link.pair_answer(id_of(&b.inst), true).unwrap();
    task.await.unwrap().expect("opened");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_signed_out_of_the_account_takes_this_pcs_pairing_with_it() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    pair_through_the_account(&a, &b).await;
    assert_eq!((trusted(&a), trusted(&b)), (1, 1));
    // "Not me" / "Sign out" from this PC: the app command ends the device on the account, then calls this.
    let svc = a.svc.clone();
    tokio::task::spawn_blocking(move || svc.revoke(B_ID, "sign_out").unwrap()).await.unwrap();
    a.inst.link.forget_account_device(B_ID).await;
    assert_eq!(trusted(&a), 0, "A no longer trusts the device that was signed out");
    assert!(a.inst.link.links.all().is_empty());
    assert_eq!(trusted(&b), 1, "B is another PC's business (it is told when it next looks)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_signed_out_on_another_pc_is_dropped_when_this_pc_next_reads_the_account() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    pair_through_the_account(&a, &b).await;
    assert_eq!(trusted(&a), 1);
    // The device signs itself out (or somebody does it from a third PC).
    let svc = b.svc.clone();
    tokio::task::spawn_blocking(move || svc.sign_out_here()).await.unwrap();
    let _ = list(&a).await;
    until("A drops the pairing", || trusted(&a) == 0).await;
    // Not silently: the account's word is unsigned, so the person is told, and the PC stays under a note until they dismiss it.
    until("the note", || a.inst.link.removed.all().len() == 1).await;
    let seen = list(&a).await;
    assert_eq!(seen["removed"][0]["name"], "Laptop");
    let id = seen["removed"][0]["id"].as_str().unwrap().to_string();
    a.inst.link.dismiss_removed(&id);
    assert!(list(&a).await["removed"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_pcs_with_names_that_look_the_same_are_both_flagged_and_neither_is_offered_or_let_in() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    // Cyrillic "а" (U+0430) and "е" (U+0435) in place of the Latin letters, and a right-to-left override in front.
    let twin = pc("D\u{0435}sk P\u{0421}", B_ID, &net, &server, true, true);
    start(&[&a, &twin]).await;
    until("both published", || server.node_of(A_ID).is_some() && server.node_of(B_ID).is_some()).await;
    let seen = list(&a).await;
    let rows = seen["pcs"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["status"], "lookalike", "{rows:?}");
    assert!(rows[0]["node"].is_null());
    assert!(a.inst.link.open_account_pc(B_ID).await.unwrap_err().contains("looks the same"));
    // The other way too: the door refuses a knock from a PC whose name cannot be told from another's.
    let res = twin.inst.link.open_account_pc(A_ID).await;
    assert!(res.is_err());
    assert!(pending(&a.inst).is_null() && pending(&twin.inst).is_null());
    assert_eq!((trusted(&a), trusted(&twin)), (0, 0));
}

#[test]
fn invisible_and_direction_characters_are_stripped_from_names_and_look_alikes_have_one_skeleton() {
    use crate::account::directory::{clean_name, skeleton};
    assert_eq!(clean_name("\u{202E}Desk\u{200B} PC\u{202C}").as_deref(), Some("Desk PC"));
    assert_eq!(crate::p2p::trust::clean_name("\u{202E}Desk\u{200B} PC\u{2066}"), "Desk PC");
    assert!(clean_name("\u{200B}\u{202E}").is_none());
    assert_eq!(clean_name(&"x".repeat(41)), None, "the length limit stays");
    assert_eq!(skeleton("Desk PC"), skeleton("D\u{0435}sk P\u{0421}"));
    assert_eq!(skeleton("Laptop"), skeleton("l\u{0430}pt\u{043e}p"));
    assert_ne!(skeleton("Desk PC"), skeleton("Desk PC 2"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pc_that_is_not_signed_in_lists_nothing_and_publishes_nothing() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, false);
    start(&[&a]).await;
    let seen = list(&a).await;
    assert_eq!(seen["signed_in"], false);
    assert_eq!(seen["pcs"].as_array().unwrap().len(), 0);
    assert!(server.calls().is_empty(), "no request left this PC: {:?}", server.calls());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_device_key_signing_for_many_nodes_is_limited_by_the_device_and_unanswered_sheets_count() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    let others: Vec<Pc> = (0..5).map(|i| pc(&format!("Node {i}"), &format!("44444444-4444-4444-8444-44444444444{i}"), &net, &server, false, false)).collect();
    start(&[&a, &b]).await;
    for o in &others {
        start(&[o]).await;
    }
    // Nobody is at the screen: a sheet runs out after a moment (the real one waits two minutes).
    a.inst.link.mgr.set_confirm_timeout(Duration::from_millis(1500));
    for o in &others {
        o.inst.link.mgr.set_confirm_timeout(Duration::from_millis(2500));
    }
    let a_node = crate::device_link::node_of(&a.inst.node()).unwrap();
    let a_pub = DeviceIdentity::load(&a.inst.link.keys).unwrap().binding().device_pub;
    // The Laptop's account key signs "this node is mine" for node after node, each one a different PC (an attacker's own machines).
    let knock_as_laptop = |o: &Pc| {
        let (statement, signature) = b.svc.introduction(&o.inst.node()).unwrap().unwrap();
        let expect = AccountExpect { claim: AccountClaim { statement, signature }, name: "Desk PC".into(), device_id: B_ID.into(), first_seen: 0, device_pub: a_pub };
        let mgr = o.inst.link.mgr.clone();
        async move { mgr.join_account(PeerAddr::new(a_node), expect).await }
    };
    for o in &others[..3] {
        let task = tokio::spawn(knock_as_laptop(o));
        until("a sheet shows or the knock ended", || !pending(&a.inst).is_null() || task.is_finished()).await;
        if task.is_finished() {
            panic!("the knock ended before any sheet: {:?}", task.await.unwrap());
        }
        assert!(task.await.unwrap().is_err());
        until("the sheet ran out", || pending(&a.inst).is_null()).await;
    }
    // Three unanswered sheets from ONE device, through three different nodes: that device is paused, whatever node it signs for next.
    let res = knock_as_laptop(&others[3]).await;
    assert!(matches!(res, Err(PairError::AccountLocked(_))), "{res:?}");
    assert!(pending(&a.inst).is_null(), "no fourth sheet");
    // Only that device is paused: nobody else is locked out, and nothing was trusted.
    assert!(a.inst.link.view()["account_locked_until"].is_null());
    assert_eq!(trusted(&a), 0);
}

/// A knock from `knocker` at `host` with the knocker's own statement, as the app sends it.
async fn knock_with_claim(knocker: &Pc, host: &Pc) -> Result<(), PairError> {
    let host_node = crate::device_link::node_of(&host.inst.node()).unwrap();
    let host_pub = DeviceIdentity::load(&host.inst.link.keys).unwrap().binding().device_pub;
    let expect = AccountExpect { claim: claim_of(knocker), name: "Desk PC".into(), device_id: knocker.id.clone(), first_seen: 0, device_pub: host_pub };
    knocker.inst.link.mgr.join_account(PeerAddr::new(host_node), expect).await.map(|_| ())
}

/// A knock that gets the challenge and then never signs (the knocker expects another device key, so it walks away): the host held the busy flag
/// for it, so each one costs a sheet slot, and the device is told "locked" with a time once its slots are gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_knocker_that_never_signs_after_the_challenge_hits_the_sheet_cap() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    let host_node = crate::device_link::node_of(&a.inst.node()).unwrap();
    let wrong_key = || AccountExpect { claim: claim_of(&b), name: "Desk PC".into(), device_id: B_ID.into(), first_seen: 0, device_pub: [7; 32] };
    for i in 0..4 {
        let res = b.inst.link.mgr.join_account(PeerAddr::new(host_node), wrong_key()).await;
        assert!(matches!(res, Err(PairError::BadIdentity)), "knock {i}: {res:?}");
        assert!(pending(&a.inst).is_null(), "no sheet for a knock that never signed");
    }
    let res = b.inst.link.mgr.join_account(PeerAddr::new(host_node), wrong_key()).await;
    assert!(matches!(res, Err(PairError::AccountLocked(Some(until))) if until > real_now() * 1000), "{res:?}");
    assert!(pending(&a.inst).is_null());
    assert_eq!(trusted(&a), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn three_devices_each_under_their_own_limit_still_pause_the_whole_account_route_together() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    let c = pc("Third", T_ID, &net, &server, false, true);
    let d = pc("Fourth", "55555555-5555-4555-8555-555555555555", &net, &server, false, true);
    start(&[&a, &b, &c, &d]).await;
    a.inst.link.mgr.set_confirm_timeout(Duration::from_millis(1500));
    for p in [&b, &c, &d] {
        p.inst.link.mgr.set_confirm_timeout(Duration::from_millis(2500));
    }
    // A thief who adds devices to the account: five unanswered sheets, never more than two from one device (each device's own limit is three).
    for p in [&b, &c, &d, &b, &c] {
        let res = knock_with_claim(p, &a).await;
        assert!(res.is_err() && !matches!(res, Err(PairError::AccountLocked(_))), "{res:?}");
        until("the sheet ran out", || pending(&a.inst).is_null()).await;
    }
    until("the whole route is paused", || !a.inst.link.view()["account_locked_until"].is_null()).await;
    // Everybody is refused now, including the device that has knocked only once and one that never has.
    // The refusal says it is a lock and until when: the same time the host shows for itself.
    let until = a.inst.link.view()["account_locked_until"].as_u64().unwrap();
    for p in [&d, &b] {
        let res = knock_with_claim(p, &a).await;
        assert!(matches!(res, Err(PairError::AccountLocked(Some(u))) if u == until), "{res:?}");
    }
    assert!(pending(&a.inst).is_null());
    assert_eq!(trusted(&a), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sheet_the_knocking_pc_walks_away_from_counts_as_unanswered() {
    let (net, server) = (MemoryNet::new(), FakeAccount::start());
    let a = pc("Desk PC", A_ID, &net, &server, true, true);
    let b = pc("Laptop", B_ID, &net, &server, false, true);
    start(&[&a, &b]).await;
    // A's sheet waits the full two minutes; the knocking PC gives up (is closed) after the sheet showed.
    for _ in 0..3 {
        let b2 = b.inst.link.clone();
        let host_node = crate::device_link::node_of(&a.inst.node()).unwrap();
        let host_pub = DeviceIdentity::load(&a.inst.link.keys).unwrap().binding().device_pub;
        let expect = AccountExpect { claim: claim_of(&b), name: "Desk PC".into(), device_id: B_ID.into(), first_seen: 0, device_pub: host_pub };
        let mgr = b2.mgr.clone();
        let task = tokio::spawn(async move { mgr.join_account(PeerAddr::new(host_node), expect).await });
        until("the sheet shows", || !pending(&a.inst).is_null()).await;
        task.abort();
        let _ = task.await;
        until("the abandoned sheet is gone", || pending(&a.inst).is_null()).await;
    }
    // Three abandoned sheets: that device is paused (the same as three that nobody answered).
    let res = knock_with_claim(&b, &a).await;
    assert!(matches!(res, Err(PairError::AccountLocked(_))), "{res:?}");
    assert!(pending(&a.inst).is_null());
}

// ---------- the door, alone ----------

struct Fixed(Vec<PcRow>);

impl AccountPort for Fixed {
    fn pcs(&self) -> Result<Option<Book>, String> {
        Ok(Some(Book { rows: self.0.clone(), revoked: Vec::new() }))
    }
    fn signed_in(&self) -> bool {
        true
    }
    fn publish(&self, _: &str, _: &str, _: Option<&str>) -> Result<(), String> {
        Ok(())
    }
    fn unpublish(&self) -> Result<(), String> {
        Ok(())
    }
    fn introduce(&self, _: &str) -> Result<Option<AccountClaim>, String> {
        Ok(None)
    }
}

fn identity(name: &str) -> DeviceIdentity {
    DeviceIdentity::load(&KeyStore::with_backend(Arc::new(MemoryBackend::new()), name)).unwrap()
}

fn row_for(id: &DeviceIdentity, name: &str, this: bool) -> PcRow {
    row_with(id, name, this, &new_signing_key(), "11111111-1111-4111-8111-111111111111")
}

/// A row of the book for a PC whose account key is `key` and whose link id is `id`'s.
fn row_with(id: &DeviceIdentity, name: &str, this: bool, key: &SigningKey, device_id: &str) -> PcRow {
    PcRow {
        id: device_id.into(),
        name: name.into(),
        account_pub: b64(key.verifying_key().as_bytes()),
        node: Some(id.id().to_hex()),
        binding: Some(binding_text(&id.binding())),
        relay: None,
        created_at: 10,
        last_seen_at: 20,
        online: true,
        is_this: this,
    }
}

fn claim_for(key: &SigningKey, device_id: &str, node: &DeviceIdentity) -> AccountClaim {
    let s = device_statement_with_node(key, ACCOUNT, device_id, "pc", "Whoever", Some(&node.id().to_hex()));
    AccountClaim { statement: s.statement, signature: s.signature }
}

#[test]
fn the_door_lets_in_only_a_device_of_the_account_that_signs_its_own_node_and_nothing_else() {
    let (visitor, intruder) = (identity("visitor"), identity("intruder"));
    let (key, other_key) = (new_signing_key(), new_signing_key());
    let id = "11111111-1111-4111-8111-111111111111";
    let dir = AccountDir::new(Arc::new(Fixed(vec![row_with(&visitor, "Laptop", false, &key, id)])), Arc::new(real_now));
    let door = Door(dir.clone());
    let good = claim_for(&key, id, &visitor);
    // Tick off: nobody.
    assert!(door.who(&visitor.id(), &good).is_none());
    dir.set_open(true);
    let got = door.who(&visitor.id(), &good).expect("a device of the account, signing its own node");
    assert_eq!((got.name.as_str(), got.first_seen), ("Laptop", 10));
    // The same statement from another node: no (the statement names the node it is for).
    assert!(door.who(&intruder.id(), &good).is_none());
    // A statement signed by a key the account does not hold for that device: no.
    assert!(door.who(&visitor.id(), &claim_for(&other_key, id, &visitor)).is_none());
    // A statement for a device id the account does not list: no.
    assert!(door.who(&visitor.id(), &claim_for(&key, "99999999-9999-4999-8999-999999999999", &visitor)).is_none());
    // A statement whose text was changed after it was signed: no.
    let mut forged = good.clone();
    forged.statement = forged.statement.replace("Whoever", "Somebody");
    assert!(door.who(&visitor.id(), &forged).is_none());
    // A signature that is not one: no.
    assert!(door.who(&visitor.id(), &AccountClaim { statement: good.statement.clone(), signature: "x".into() }).is_none());
    // This PC's own row is never a visitor.
    let own = AccountDir::new(Arc::new(Fixed(vec![row_with(&visitor, "Me", true, &key, id)])), Arc::new(real_now));
    own.set_open(true);
    assert!(Door(own).who(&visitor.id(), &good).is_none());
}

#[test]
fn a_row_whose_node_record_is_for_another_node_or_is_not_signed_is_not_usable() {
    let (a, b) = (identity("a"), identity("b"));
    let mut mismatch = row_for(&a, "Desk PC", false);
    mismatch.binding = Some(binding_text(&b.binding()));
    assert!(usable(&mismatch).is_none(), "a record for another node");
    let mut forged = row_for(&a, "Desk PC", false);
    let mut v: Value = serde_json::from_str(forged.binding.as_ref().unwrap()).unwrap();
    v["sig"] = json!("00".repeat(64));
    forged.binding = Some(v.to_string());
    assert!(usable(&forged).is_none(), "a record whose signature does not hold");
    let mut junk = row_for(&a, "Desk PC", false);
    junk.binding = Some("off".into());
    assert!(usable(&junk).is_none());
    assert!(usable(&row_for(&a, "Desk PC", false)).is_some());
    let _ = (&a.id(), &b.id());
}

#[test]
fn a_recent_row_is_flagged_and_an_old_one_is_not() {
    let a = identity("a");
    let mut r = row_for(&a, "Desk PC", false);
    r.created_at = 1_000_000 - 3600;
    assert_eq!(super::account_dir::row_json(&r, 1_000_000, None, None)["recent"], true);
    r.created_at = 1_000_000 - 3 * 24 * 3600;
    assert_eq!(super::account_dir::row_json(&r, 1_000_000, None, None)["recent"], false);
}
