//! Lend control items between two of my OWN PCs, over the device link instead of the team relay: no Team at all
//! (`TeamPort::session` always fails here). The link is a fake that hands each item to the other service, the way the
//! far bridge's `POST /lend/item` does, with the sender decided by the link and never by the body.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::{json, Value};

use super::link::LendNet;
use super::service::{Approval, AwakePort, Deps, Direction, GrantEnd, GrantState, Lend, LendAccount, LendProfile, LendRequest, LendWho, OwnItem, OwnPort, RefreshJob, RequestState, TeamPort};
use super::spec::ProxySpec;
use crate::keys::KeyStore as LinkKeys;
use crate::own_lend::Inbox;
use crate::p2p::memory::MemoryNet;
use crate::secrets::{MemoryBackend, SecretBackend};
use crate::team::secure::{Payload, Session};
use crate::team::tests_v1::temp_dir;

const A_HEX: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B_HEX: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LENDER_KEY: &str = "sk-lender-FAKE";

fn now() -> u64 {
    crate::team::transport::now_ms()
}

/// There is no team here: any use of it is a failure of the test.
struct NoTeam;

impl TeamPort for NoTeam {
    fn session(&self) -> Result<Session, String> {
        Err("no team".into())
    }
    fn send(&self, _payload: &Payload) -> Result<(), String> {
        Err("no team".into())
    }
}

struct Idle;

impl AwakePort for Idle {
    fn hold(&self) -> Result<(), String> {
        Ok(())
    }
    fn release(&self) {}
}

/// One end of the fake device link.
struct Wire {
    me: String,
    me_name: String,
    peer: String,
    peer_name: String,
    /// The service at the other end.
    other: Mutex<Option<Weak<Lend>>>,
    /// Whether the other PC has "Borrow my agent sign-ins" on for this one.
    allowed: AtomicBool,
    /// Every item that crossed, as text (the canary check reads it).
    log: Mutex<Vec<String>>,
}

impl Wire {
    fn new(me: &str, me_name: &str, peer: &str, peer_name: &str) -> Arc<Self> {
        Arc::new(Self {
            me: me.into(),
            me_name: me_name.into(),
            peer: peer.into(),
            peer_name: peer_name.into(),
            other: Mutex::new(None),
            allowed: AtomicBool::new(true),
            log: Mutex::new(Vec::new()),
        })
    }
}

impl OwnPort for Wire {
    fn send(&self, node: &str, item: &OwnItem) -> Result<(), String> {
        if node != self.peer {
            return Err("That PC is not one of yours.".into());
        }
        if !self.allowed.load(Ordering::SeqCst) {
            return Err("It does not let this PC borrow yet.".into());
        }
        let value = serde_json::to_value(item).unwrap();
        self.log.lock().unwrap().push(value.to_string());
        let other = self.other.lock().unwrap().as_ref().and_then(Weak::upgrade).ok_or("It did not answer.")?;
        // The far bridge route: the sender is the link's node, not anything in the body.
        other.deliver(&self.me, value).map(|_| ())
    }
    fn peers(&self) -> Vec<(String, String)> {
        vec![(self.peer.clone(), self.peer_name.clone())]
    }
    fn my_node(&self) -> Option<String> {
        Some(self.me.clone())
    }
    fn my_name(&self) -> String {
        self.me_name.clone()
    }
}

struct Pc {
    lend: Arc<Lend>,
    wire: Arc<Wire>,
}

fn pc(name: &str, mem: &MemoryNet, wire: Arc<Wire>) -> Pc {
    let backend: Arc<dyn SecretBackend> = Arc::new(MemoryBackend::new());
    let net = LendNet::new(LinkKeys::with_backend(backend.clone(), name), mem.factory()).unwrap();
    let dir = temp_dir(&format!("lend-own-{name}"));
    let team: Arc<dyn TeamPort> = Arc::new(NoTeam);
    let deps = Deps {
        awake: Arc::new(Idle),
        dir: dir.join("lend"),
        secrets: backend,
        team: team.clone(),
        net,
        accounts: crate::accounts::Store::at(&dir),
        specs: vec![ProxySpec::parse(include_str!("../tui/claude/lend_proxy.toml")).unwrap()],
        now: Arc::new(now),
        changed: Arc::new(|| {}),
        pinger: super::ping::Pinger::new(team, Arc::new(now)),
        spawn: Arc::new(|f| {
            tokio::spawn(f);
        }),
        refresh: Arc::new(|_job: RefreshJob| Box::pin(async { Err("no refresh in this test".to_string()) })),
        env_names: Arc::new(|| vec!["PATH".to_string()]),
        own: wire.clone(),
        test_upstream: None,
    };
    let lend = Lend::new(deps);
    lend.apply_settings(&json!({ "lend_enabled": true }));
    Pc { lend, wire }
}

/// A is the lender, B the borrower.
fn two() -> (Pc, Pc, MemoryNet) {
    let mem = MemoryNet::new();
    let wa = Wire::new(A_HEX, "Desk PC", B_HEX, "Work laptop");
    let wb = Wire::new(B_HEX, "Work laptop", A_HEX, "Desk PC");
    let a = pc("a", &mem, wa);
    let b = pc("b", &mem, wb);
    *a.wire.other.lock().unwrap() = Some(Arc::downgrade(&b.lend));
    *b.wire.other.lock().unwrap() = Some(Arc::downgrade(&a.lend));
    (a, b, mem)
}

fn my_pcs_profile(lend: &Lend) -> String {
    let p = lend
        .profile_save(LendProfile {
            id: String::new(),
            name: "Work Claude".into(),
            agent_ids: vec!["claude".into()],
            account: LendAccount::Main,
            who: LendWho::MyPcs,
            member_ids: vec![],
            default_secs: 3600,
            max_secs: 7 * 24 * 3600,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: None,
            max_tokens: None,
            keep_awake: false,
            has_key: false,
            show_usage: false,
        })
        .unwrap();
    lend.key_set(&p.id, LENDER_KEY).unwrap();
    p.id
}

async fn borrowed_up(b: &Pc, grant: &str) {
    for _ in 0..100 {
        if b.lend.borrowed_launch_env("claude", grant).is_ok() {
            return;
        }
        pause(30).await;
    }
    panic!("the borrower's shim did not start");
}

fn state_of(r: &LendRequest) -> RequestState {
    r.state
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn my_pcs_lend_request_grant_revoke_with_no_team() {
    let (a, b, _mem) = two();
    let profile = my_pcs_profile(&a.lend);
    let req = b.lend.request_own(A_HEX, "claude", 3600, "fix the build", None, None).unwrap();
    assert_eq!(req.direction, Direction::Out);
    assert_eq!(req.device_name, "Desk PC");
    assert!(!req.for_other_person);
    let incoming = a.lend.state(true).requests_in;
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0].device_name, "Work laptop", "the name comes from the device list");
    assert!(!incoming[0].for_other_person);
    let grant = a.lend.answer(&req.id, true, Some(&profile), None).await.unwrap().unwrap();
    borrowed_up(&b, &grant.id).await;
    assert!(b.lend.state(true).requests_out.iter().all(|r| state_of(r) == RequestState::Accepted));
    a.lend.revoke(&grant.id).unwrap();
    let borrowed = b.lend.state(true).grants.into_iter().find(|g| g.id == grant.id).unwrap();
    assert_eq!(borrowed.state, GrantState::Ended);
    assert_eq!(borrowed.end_reason, Some(GrantEnd::Revoked));
    let lent = a.lend.state(true).grants.into_iter().find(|g| g.id == grant.id).unwrap();
    assert_eq!(lent.end_reason, Some(GrantEnd::Revoked));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn my_pcs_decline_and_give_back() {
    let (a, b, _mem) = two();
    let profile = my_pcs_profile(&a.lend);
    let no = b.lend.request_own(A_HEX, "claude", 3600, "", None, None).unwrap();
    assert!(a.lend.answer(&no.id, false, None, None).await.unwrap().is_none());
    assert!(b.lend.state(true).requests_out.iter().all(|r| state_of(r) == RequestState::Declined));
    let yes = b.lend.request_own(A_HEX, "claude", 3600, "", None, None).unwrap();
    let grant = a.lend.answer(&yes.id, true, Some(&profile), None).await.unwrap().unwrap();
    borrowed_up(&b, &grant.id).await;
    b.lend.give_back(&grant.id).unwrap();
    let lent = a.lend.state(true).grants.into_iter().find(|g| g.id == grant.id).unwrap();
    assert_eq!(lent.end_reason, Some(GrantEnd::Returned));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_switch_off_or_unpaired_pc_is_refused_and_leaves_no_request_behind() {
    let (_a, b, _mem) = two();
    b.wire.allowed.store(false, Ordering::SeqCst);
    let err = b.lend.request_own(A_HEX, "claude", 3600, "", None, None).unwrap_err();
    assert!(err.contains("does not let this PC borrow"), "{err}");
    assert!(b.lend.state(true).requests_out.is_empty(), "a refused ask is not kept");
    let other = "cc".repeat(32);
    assert_eq!(b.lend.request_own(&other, "claude", 3600, "", None, None).unwrap_err(), "That PC is not one of yours.");
    assert!(b.lend.request_own("not-hex", "claude", 3600, "", None, None).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_sender_comes_from_the_link_and_an_unknown_node_is_refused() {
    let (a, b, _mem) = two();
    let profile = my_pcs_profile(&a.lend);
    let req = b.lend.request_own(A_HEX, "claude", 3600, "", None, None).unwrap();
    let grant = a.lend.answer(&req.id, true, Some(&profile), None).await.unwrap().unwrap();
    borrowed_up(&b, &grant.id).await;
    // A third PC (not on the device list) cannot revoke: the link names it, and it is not a peer.
    let rogue = "cc".repeat(32);
    let item = json!({ "msg_id": "m-rogue", "sent_ms": now(), "body": { "kind": "revoke", "grant_id": grant.id, "reason": "" } });
    assert_eq!(b.lend.deliver(&rogue, item.clone()).unwrap_err(), "That PC is not one of yours.");
    assert_eq!(b.lend.state(true).grants.iter().find(|g| g.id == grant.id).unwrap().state, GrantState::Active);
    // Nothing in the body can name the sender: extra fields change nothing, and the real peer's revoke works once.
    let mut with_claim = item.clone();
    with_claim["from_device"] = json!("node:cccc");
    with_claim["from_member"] = json!("someone");
    assert!(b.lend.deliver(A_HEX, with_claim.clone()).is_ok());
    assert_eq!(b.lend.state(true).grants.iter().find(|g| g.id == grant.id).unwrap().state, GrantState::Ended);
    // The same message again is a replay.
    assert_eq!(b.lend.deliver(A_HEX, with_claim).unwrap_err(), "That item was already received.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_revoke_from_the_borrowers_side_does_not_end_a_lend() {
    // A revoke is only taken from the device that issued the grant. B (the borrower) sends one to A, who lent it: refused.
    let (a, b, _mem) = two();
    let profile = my_pcs_profile(&a.lend);
    let req = b.lend.request_own(A_HEX, "claude", 3600, "", None, None).unwrap();
    let grant = a.lend.answer(&req.id, true, Some(&profile), None).await.unwrap().unwrap();
    borrowed_up(&b, &grant.id).await;
    let item = json!({ "msg_id": "m-wrong-way", "sent_ms": now(), "body": { "kind": "revoke", "grant_id": grant.id, "reason": "" } });
    assert!(a.lend.deliver(B_HEX, item).is_err());
    assert_eq!(a.lend.state(true).grants.iter().find(|g| g.id == grant.id).unwrap().state, GrantState::Active);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_the_grants_own_words_cross_and_no_login_does() {
    let (a, b, _mem) = two();
    let profile = my_pcs_profile(&a.lend);
    let req = b.lend.request_own(A_HEX, "claude", 3600, "reason words", None, None).unwrap();
    let _ = a.lend.answer(&req.id, true, Some(&profile), None).await.unwrap().unwrap();
    for log in [&a.wire.log, &b.wire.log] {
        for line in log.lock().unwrap().iter() {
            assert!(!line.contains(LENDER_KEY), "the lender's key never crosses: {line}");
            assert!(!line.contains("sk-"), "{line}");
            let v: Value = serde_json::from_str(line).unwrap();
            let kind = v["body"]["kind"].as_str().unwrap();
            assert!(["request", "grant", "ack"].contains(&kind), "unexpected item {kind}");
        }
    }
    // The only secret that travels is the grant's link secret, as it does on the team path.
    let grants = a.wire.log.lock().unwrap().iter().filter(|l| l.contains("\"kind\":\"grant\"")).count();
    assert_eq!(grants, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_item_that_is_not_a_lend_item_or_is_dated_far_ahead_is_refused() {
    let (_a, b, _mem) = two();
    assert!(b.lend.deliver(A_HEX, json!({ "hello": 1 })).is_err());
    let future = json!({ "msg_id": "m-future", "sent_ms": now() + 3_600_000, "body": { "kind": "decline", "request_id": "x" } });
    assert_eq!(b.lend.deliver(A_HEX, future).unwrap_err(), "That item was refused.");
}

/// The one bare wait of the lend tests: the other side has no event to wait for.
pub(super) async fn pause(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}
