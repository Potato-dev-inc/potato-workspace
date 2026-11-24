//! Link checks and pings, with the p2p memory network and the team's shared folder (no real network): Test link on
//! both sides and every answer it gives, the shim's plain error for an unavailable lender, a slow path (connect
//! timeout and its one retry, no pile-up of redials), the team page ping, and a lender that restarted telling its
//! borrower.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::json;

use super::link::{ConnectError, LendNet, LinkOpener, Timeouts};
use super::proxy_tests::{sse_script, Script};
use super::service::{AwakePort, Deps, GrantEnd, GrantState, Lend, TeamPort};
use super::shim::{OpenError, Opener};
use super::spec::ProxySpec;
use super::wire::NodeHint;
use crate::keys::KeyStore as LinkKeys;
use crate::p2p::endpoint::{Link, NodeId, P2pError, PathKind, PeerAddr, Transport, TransportFactory};
use crate::secrets::SecretBackend;
use crate::team::secure::{Payload, Session};

use super::e2e_tests::{lend_one, post, world2, Side, World2};

fn now() -> u64 {
    crate::team::transport::now_ms()
}

// ----------------------------------------------------------------------------------------------- Test link

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_link_answers_ok_with_the_round_trip_and_the_path() {
    let w = world2(sse_script()).await;
    let (grant_id, base) = lend_one(&w, 3600).await;

    let ok = w.leo.lend.test_link(&grant_id).await.unwrap();
    assert!(ok.ok, "{ok:?}");
    assert_eq!(ok.via.as_deref(), Some("direct"));
    assert!(ok.ms.is_some());
    assert!(ok.message.starts_with("OK"), "{}", ok.message);

    // The same check over a relayed path says so.
    let (maya, leo) = (w.maya.lend.net().my_node().unwrap(), w.leo.lend.net().my_node().unwrap());
    w.mem().set_path(maya, leo, PathKind::Relayed);
    let relayed = w.leo.lend.test_link(&grant_id).await.unwrap();
    assert!(relayed.ok, "{relayed:?}");
    assert_eq!(relayed.via.as_deref(), Some("relay"));
    assert!(relayed.message.contains("via relay"), "{}", relayed.message);

    // Testing is only a handshake: the lend still works afterwards.
    assert_eq!(post(&base, "/v1/messages").await.status, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_link_says_when_the_lenders_pc_is_not_answering() {
    let w = world2(sse_script()).await;
    let (grant_id, _base) = lend_one(&w, 3600).await;
    // The lender's app is closed: nothing listens on its lend node.
    let node = w.maya.lend.net().my_node().unwrap();
    w.maya.lend.net().stop().await;
    // The endpoint closes in the background: wait until it is really gone.
    for _ in 0..200 {
        if w.mem().spec_of(&node).is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let r = w.leo.lend.test_link(&grant_id).await.unwrap();
    assert!(!r.ok);
    assert_eq!(r.message, "The lender's PC isn't answering (is the app open?)");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_link_says_when_the_lender_no_longer_has_the_lend() {
    let w = world2(sse_script()).await;
    let (grant_id, _base) = lend_one(&w, 3600).await;
    // The lender dropped the lend, but the borrower has not heard (no revoke delivered), and the PC link is up.
    w.maya.lend.revoke(&grant_id).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    w.maya.lend.net().start().await.unwrap();
    let r = w.leo.lend.test_link(&grant_id).await.unwrap();
    assert!(!r.ok);
    assert_eq!(r.message, "The lender's PC no longer has this lend; ask again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_link_on_the_lenders_side_checks_this_pc_and_pings_the_borrower() {
    let w = world2(sse_script()).await;
    let (grant_id, _base) = lend_one(&w, 3600).await;

    // Leo's app is open and answers: the lender's check reports the relay round trip.
    w.maya.pinger.set_timeout(Duration::from_secs(20));
    let lend = w.maya.lend.clone();
    let id = grant_id.clone();
    let test = tokio::spawn(async move { lend.test_link(&id).await });
    tokio::task::block_in_place(|| w.leo.pump());
    tokio::task::block_in_place(|| w.maya.pump());
    let ok = test.await.unwrap().unwrap();
    assert!(ok.ok, "{ok:?}");
    assert_eq!(ok.via.as_deref(), Some("mailbox"));
    assert!(ok.message.contains("borrower's PC answers"), "{}", ok.message);

    // Nobody answers on the borrower's side.
    w.maya.pinger.set_timeout(Duration::from_millis(400));
    let gone = w.maya.lend.test_link(&grant_id).await.unwrap();
    assert!(!gone.ok);
    assert_eq!(gone.message, "The borrower's PC isn't answering (is the app open?)");

    // A lend that is not being served here any more.
    w.maya.lend.revoke(&grant_id).unwrap();
    let ended = w.maya.lend.test_link(&grant_id).await.unwrap();
    assert!(!ended.ok);
    assert_eq!(ended.message, "This lend ended");
}

#[test]
fn the_plain_messages() {
    assert_eq!(ConnectError::Refused.plain(true), "The lender's PC no longer has this lend; ask again");
    assert_eq!(ConnectError::Unreachable("x".into()).plain(true), "The lender's PC isn't answering (is the app open?)");
    assert_eq!(ConnectError::Timeout.plain(true), "Network timeout via relay");
    assert_eq!(ConnectError::Timeout.plain(false), "Network timeout");
    assert_eq!(ConnectError::Ended.plain(false), "This lend ended");
}

// ----------------------------------------------------------------------------------------------- the shim's words

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_shim_answers_an_unavailable_lender_with_a_clear_error_not_a_timeout() {
    let w = world2(sse_script()).await;
    let (_grant_id, base) = lend_one(&w, 3600).await;
    w.maya.lend.net().stop().await;
    let t0 = Instant::now();
    let reply = post(&base, "/v1/messages").await;
    assert_eq!(reply.status, 502);
    let body: serde_json::Value = serde_json::from_str(&reply.text()).unwrap();
    assert_eq!(body["error"]["type"], json!("lend_unavailable"));
    assert_eq!(body["error"]["message"], json!("The lender's PC isn't answering (is the app open?)"));
    // The next request right after does not dial all over again.
    let again_at = Instant::now();
    let again = post(&base, "/v1/messages").await;
    assert_eq!(again.status, 502);
    assert_eq!(again.text(), reply.text());
    assert!(again_at.elapsed() < Duration::from_millis(400), "{:?} (first took {:?})", again_at.elapsed(), t0.elapsed());
}

// ----------------------------------------------------------------------------------------------- a slow path

/// A network whose first `hang` dials never finish (a relay path that is too slow), the rest go through.
struct SlowNet {
    inner: Arc<dyn TransportFactory>,
    hang: usize,
    dials: Arc<AtomicUsize>,
}

#[async_trait]
impl TransportFactory for SlowNet {
    async fn bind(&self, identity: &crate::p2p::identity::DeviceIdentity, spec: &crate::p2p::endpoint::BindSpec) -> Result<Arc<dyn Transport>, P2pError> {
        let inner = self.inner.bind(identity, spec).await?;
        Ok(Arc::new(SlowTransport { inner, hang: self.hang, dials: self.dials.clone() }))
    }
}

struct SlowTransport {
    inner: Arc<dyn Transport>,
    hang: usize,
    dials: Arc<AtomicUsize>,
}

#[async_trait]
impl Transport for SlowTransport {
    fn id(&self) -> NodeId {
        self.inner.id()
    }
    async fn set_alpns(&self, alpns: Vec<Vec<u8>>) {
        self.inner.set_alpns(alpns).await
    }
    async fn dial(&self, peer: &PeerAddr, alpn: &[u8]) -> Result<Arc<dyn Link>, P2pError> {
        if self.dials.fetch_add(1, Ordering::SeqCst) < self.hang {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
        self.inner.dial(peer, alpn).await
    }
    async fn accept(&self) -> Option<Arc<dyn Link>> {
        self.inner.accept().await
    }
    async fn close(&self) {
        self.inner.close().await
    }
}

const FAST: Timeouts = Timeouts {
    connect: Duration::from_millis(150),
    hello: Duration::from_millis(500),
    pause: Duration::from_millis(20),
    open: Duration::from_millis(900),
    fail_memory: Duration::from_millis(500),
};

/// Leo's node with a slow network, and the lender's hint, secret and grant id.
async fn slow_borrower(w: &World2, hang: usize) -> (Arc<LendNet>, Arc<AtomicUsize>, NodeHint, Vec<u8>, String) {
    let (grant_id, _base) = lend_one(w, 3600).await;
    let hint = w.maya.lend.net().start().await.unwrap();
    let secret = crate::secure_core::crypto::unb64(&w.maya.secrets.get(&format!("lend:link:{grant_id}")).unwrap().unwrap()).unwrap();
    let dials = Arc::new(AtomicUsize::new(0));
    let backend: Arc<dyn SecretBackend> = w.leo.secrets.clone();
    // Leo's own lend identity (same key store and name), on a network that is slow to dial.
    let net = LendNet::new(LinkKeys::with_backend(backend, "leo"), Arc::new(SlowNet { inner: w.mem().factory(), hang, dials: dials.clone() })).unwrap();
    net.apply_settings(&json!({ "lend_enabled": true }));
    net.set_timeouts(FAST);
    (net, dials, hint, secret, grant_id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_first_dial_gets_one_retry() {
    let w = world2(sse_script()).await;
    let (net, dials, hint, secret, grant_id) = slow_borrower(&w, 1).await;
    let link = net.connect(&hint, &grant_id, &secret).await;
    assert!(link.is_ok(), "{:?}", link.err());
    assert_eq!(dials.load(Ordering::SeqCst), 2, "one dial that hung, one retry");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_path_that_stays_slow_ends_in_a_timeout_after_the_retry() {
    let w = world2(sse_script()).await;
    let (net, dials, hint, secret, grant_id) = slow_borrower(&w, 99).await;
    let t0 = Instant::now();
    let err = net.connect(&hint, &grant_id, &secret).await.err();
    assert_eq!(err, Some(ConnectError::Timeout));
    assert_eq!(dials.load(Ordering::SeqCst), 2);
    assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
    // And Test link's probe gives the same answer.
    assert_eq!(net.probe(&hint, &grant_id, &secret).await.err(), Some(ConnectError::Timeout));
}

struct FakeGrant {
    hint: NodeHint,
    secret: Vec<u8>,
    id: String,
}

impl super::link::BorrowerGrant for FakeGrant {
    fn ended(&self) -> bool {
        false
    }
    fn lender_ended(&self) {}
    fn hint(&self) -> NodeHint {
        self.hint.clone()
    }
    fn grant_id(&self) -> String {
        self.id.clone()
    }
    fn secret(&self) -> Vec<u8> {
        self.secret.clone()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_never_waits_for_reconnects_without_end() {
    let w = world2(sse_script()).await;
    let (net, dials, mut hint, secret, grant_id) = slow_borrower(&w, 99).await;
    hint.relay = "https://relay.example".into();
    let opener = LinkOpener::new(net, Arc::new(FakeGrant { hint, secret, id: grant_id }));

    // The first request is cut at the limit, with words (the relay is named: that is where a slow path lives).
    let t0 = Instant::now();
    let first = opener.open().await;
    let Err(OpenError::Unavailable(why)) = first else { panic!("expected unavailable") };
    assert_eq!(why, "Network timeout via relay");
    assert!(t0.elapsed() < Duration::from_millis(1500), "{:?}", t0.elapsed());
    let dialed = dials.load(Ordering::SeqCst);

    // Requests right behind it fail at once with the same words and dial nothing.
    let t1 = Instant::now();
    let second = opener.open().await;
    let Err(OpenError::Unavailable(again)) = second else { panic!("expected unavailable") };
    assert_eq!(again, why);
    assert!(t1.elapsed() < Duration::from_millis(100), "{:?}", t1.elapsed());
    assert_eq!(dials.load(Ordering::SeqCst), dialed);
}

// ----------------------------------------------------------------------------------------------- team page pings

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ping_is_timed_through_the_relay_and_answered_without_lend() {
    let w = world2(sse_script()).await;
    let maya_device = w.maya.device();
    w.leo.pinger.set_timeout(Duration::from_secs(20));
    let pinger = w.leo.pinger.clone();
    let task = tokio::spawn(async move { pinger.ping_device(&maya_device).await });
    // Maya's app answers (her lend service is not involved), then Leo's receives the pong.
    tokio::task::block_in_place(|| w.maya.pump());
    tokio::task::block_in_place(|| w.leo.pump());
    let r = task.await.unwrap();
    assert!(r.ok, "{r:?}");
    assert_eq!(r.via.as_deref(), Some("mailbox"));
    assert!(r.ms.is_some());
    assert_eq!(r.member_id, w.maya.member());
    // Nothing was written into the lend state for it.
    assert!(w.maya.lend.state(true).requests_in.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_computer_that_does_not_answer_is_not_reachable() {
    let w = world2(sse_script()).await;
    w.leo.pinger.set_timeout(Duration::from_millis(500));
    let r = w.leo.pinger.ping_device(&w.sam.device()).await;
    assert!(!r.ok);
    assert_eq!(r.message.as_deref(), Some("Not reachable"));
    assert_eq!(r.ms, None);
    // A device that is not on the team.
    let unknown = w.leo.pinger.ping_device("not-a-device").await;
    assert!(!unknown.ok);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ping_all_lists_every_other_computer_and_never_this_one() {
    let w = world2(sse_script()).await;
    w.leo.pinger.set_timeout(Duration::from_millis(300));
    let all = w.leo.pinger.ping_all().await.unwrap();
    let mut ids: Vec<String> = all.iter().map(|p| p.device_id.clone()).collect();
    ids.sort();
    let mut want = vec![w.maya.device(), w.sam.device()];
    want.sort();
    assert_eq!(ids, want);
}

// ----------------------------------------------------------------------------------------------- a lender restart

/// A team connection that can be down (just after launch, the relay is not connected yet).
struct FlakyTeam {
    inner: Arc<dyn TeamPort>,
    up: AtomicBool,
}

impl TeamPort for FlakyTeam {
    fn session(&self) -> Result<Session, String> {
        if self.up.load(Ordering::SeqCst) {
            self.inner.session()
        } else {
            Err("Team is off. Turn it on in Settings first.".into())
        }
    }
    fn send(&self, payload: &Payload) -> Result<(), String> {
        if self.up.load(Ordering::SeqCst) {
            self.inner.send(payload)
        } else {
            Err("Team is off. Turn it on in Settings first.".into())
        }
    }
}

struct NoAwake;

impl AwakePort for NoAwake {
    fn hold(&self) -> Result<(), String> {
        Ok(())
    }
    fn release(&self) {}
}

fn pending(w: &World2) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(w.maya.dir.join("lend").join("state.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    v["pending_revokes"].as_array().cloned().unwrap_or_default()
}

/// "The app was closed and opened again": a new service over the same saved state, key store and credential store.
fn restart(w: &World2, side: &Side, name: &str, team: Arc<dyn TeamPort>) -> Arc<Lend> {
    let backend: Arc<dyn SecretBackend> = side.secrets.clone();
    let net = LendNet::new(LinkKeys::with_backend(backend.clone(), name), w.mem().factory()).unwrap();
    let pinger = super::ping::Pinger::new(team.clone(), Arc::new(now));
    let deps = Deps {
        awake: Arc::new(NoAwake),
        dir: side.dir.join("lend"),
        secrets: backend,
        team,
        net,
        accounts: crate::accounts::Store::at(&side.dir),
        specs: vec![ProxySpec::parse(include_str!("../../crates/pm-core/src/tui/claude/lend_proxy.toml")).unwrap()],
        now: Arc::new(now),
        changed: Arc::new(|| {}),
        pinger,
        spawn: Arc::new(|f| {
            tokio::spawn(f);
        }),
        refresh: Arc::new(|_job| Box::pin(async { Err("no refresh in this test".to_string()) })),
        env_names: Arc::new(|| vec!["PATH".to_string()]),
        own: Arc::new(super::service::NoOwn),
        test_upstream: None,
    };
    let lend = Lend::new(deps);
    lend.apply_settings(&json!({ "lend_enabled": true }));
    lend
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lender_that_restarted_tells_the_borrower_and_keeps_no_secret_on_disk() {
    let w = world2(sse_script()).await;
    let (grant_id, base) = lend_one(&w, 3600).await;
    let secret_b64 = w.maya.secrets.get(&format!("lend:link:{grant_id}")).unwrap().unwrap();
    assert_eq!(post(&base, "/v1/messages").await.status, 200);

    // Maya's app restarts: the old service is gone, a new one reads the saved state.
    let after = restart(&w, &w.maya, "maya", w.maya.team.clone());
    after.resume();

    // Her side no longer lends it and holds nothing secret about it.
    let lent = after.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((lent.state, lent.end_reason), (GrantState::Ended, Some(GrantEnd::Revoked)));
    assert!(w.maya.secrets.get(&format!("lend:link:{grant_id}")).unwrap().is_none());

    // Leo hears it, instead of keeping a dead lend: the next request says so.
    w.leo.pump();
    let borrowed = w.leo.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((borrowed.state, borrowed.end_reason), (GrantState::Ended, Some(GrantEnd::Revoked)));
    assert_eq!(post(&base, "/v1/messages").await.status, 403);
    assert!(w.leo.lend.borrowed_rows().is_empty());

    // The disk has ids only: the grant id may be there, the link secret never.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let saved = std::fs::read_to_string(w.maya.dir.join("lend").join("state.json")).unwrap();
    assert!(!saved.contains(&secret_b64));
    assert!(pending(&w).is_empty(), "{saved}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_revoke_waits_for_the_team_when_the_app_starts_before_it_connects() {
    let w = world2(sse_script()).await;
    let (grant_id, _base) = lend_one(&w, 3600).await;

    let flaky = Arc::new(FlakyTeam { inner: w.maya.team.clone(), up: AtomicBool::new(false) });
    let after = restart(&w, &w.maya, "maya", flaky.clone());
    after.resume();
    tokio::time::sleep(Duration::from_millis(400)).await;
    // Still queued, as ids: nothing went out, nothing is lost by closing the app again right now.
    let queued = pending(&w);
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0]["grant_id"], json!(grant_id));
    assert_eq!(queued[0].as_object().unwrap().len(), 2, "ids only");

    // The team connects: the revoke goes out by itself.
    flaky.up.store(true, Ordering::SeqCst);
    w.leo.pump();
    let borrowed = w.leo.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(borrowed.state, GrantState::Ended);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(pending(&w).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lend_that_ran_out_is_not_announced_as_revoked() {
    let w = world2(Script::Endless).await;
    let (grant_id, _base) = lend_one(&w, 1).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let after = restart(&w, &w.maya, "maya", w.maya.team.clone());
    after.resume();
    assert!(pending(&w).is_empty());
    let lent = after.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(lent.state, GrantState::Ended);
}

#[tokio::test]
async fn one_missed_ping_on_the_lenders_check_is_not_a_not_answering() {
    use super::ping::DevicePing;
    use super::service::{ping_until_answered, PING_TRIES};
    let calls = AtomicUsize::new(0);
    let ping = |ok: bool| DevicePing { member_id: "m".into(), device_id: "d".into(), device_name: "Leo".into(), ok, ms: ok.then_some(40), via: None, message: None };
    // The first ping is lost, the second is answered: the check says it answers.
    let r = ping_until_answered(PING_TRIES, || {
        let n = calls.fetch_add(1, Ordering::SeqCst);
        std::future::ready(ping(n >= 1))
    })
    .await;
    assert!(r.ok);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    // Every try lost: still not answering, and it asks no more than PING_TRIES times.
    calls.store(0, Ordering::SeqCst);
    let r = ping_until_answered(PING_TRIES, || {
        calls.fetch_add(1, Ordering::SeqCst);
        std::future::ready(ping(false))
    })
    .await;
    assert!(!r.ok);
    assert_eq!(calls.load(Ordering::SeqCst), PING_TRIES as usize);
}

// --------------------------------------------------------------------------- lender and borrower must agree

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_saved_lend_nothing_serves_is_ended_with_the_restart_note_and_the_borrower_told() {
    let w = world2(sse_script()).await;
    let (grant_id, _base) = lend_one(&w, 3600).await;
    // A lend this service serves is never touched.
    assert_eq!(w.maya.lend.end_orphans(), 0);
    assert_eq!(w.maya.lend.state(true).grants[0].state, GrantState::Active);

    // The app starts again (resume not run yet): the saved lend is one this PC cannot honour.
    let after = restart(&w, &w.maya, "maya", w.maya.team.clone());
    assert_eq!(after.end_orphans(), 1);
    assert_eq!(after.end_orphans(), 0, "once");
    let lent = after.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(lent.state, GrantState::Ended);
    assert_eq!(lent.end_note.as_deref(), Some(super::service::RESTARTED));
    assert!(w.maya.secrets.get(&format!("lend:link:{grant_id}")).unwrap().is_none());
    w.leo.pump();
    assert_eq!(w.leo.lend.state(true).grants[0].state, GrantState::Ended);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_lender_drops_a_lend_its_borrower_no_longer_holds_and_keeps_one_it_holds() {
    let w = world2(sse_script()).await;
    let (grant_id, _base) = lend_one(&w, 3600).await;

    // Leo still holds it: nothing comes back, the lend stays.
    assert_eq!(w.maya.lend.recheck_lent(), 1);
    w.leo.pump();
    assert_eq!(w.maya.lend.state(true).grants[0].state, GrantState::Active);

    // Leo restarts and holds nothing now; its own return cannot go out yet (the team is not connected), so only the check tells.
    let down = Arc::new(FlakyTeam { inner: w.leo.team.clone(), up: AtomicBool::new(false) });
    let leo2 = restart(&w, &w.leo, "leo", down.clone());
    leo2.resume();
    assert_eq!(leo2.state(true).grants[0].state, GrantState::Ended);

    down.up.store(true, Ordering::SeqCst);
    // Maya's Lending tab opens: she asks, Leo says "not held", the lend ends with that note.
    assert_eq!(w.maya.lend.recheck_lent(), 1);
    w.leo.pump_into(&leo2);
    w.maya.pump();
    let lent = w.maya.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(lent.state, GrantState::Ended);
    // Either word is right (Leo's own give-back may beat the check); both end it with a note of mine.
    assert!(matches!(lent.end_note.as_deref(), Some(super::service::NOT_HELD) | Some(super::service::BORROWER_RESTARTED)), "{:?}", lent.end_note);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_borrower_that_restarted_ends_the_lend_tells_the_lender_and_lists_nothing() {
    let w = world2(sse_script()).await;
    let (grant_id, base) = lend_one(&w, 3600).await;
    assert_eq!(post(&base, "/v1/messages").await.status, 200);
    assert_eq!(w.leo.lend.borrowed_rows().len(), 1);

    let leo2 = restart(&w, &w.leo, "leo", w.leo.team.clone());
    leo2.resume();
    let mine = leo2.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(mine.state, GrantState::Ended);
    assert_eq!(mine.end_note.as_deref(), Some(super::service::BORROWER_RESTARTED));
    assert!(leo2.borrowed_rows().is_empty());
    assert!(w.leo.secrets.get(&format!("lend:link:{grant_id}")).unwrap().is_none());

    // The lender hears a give-back with the reason and ends the lend with that note.
    tokio::time::sleep(Duration::from_millis(300)).await;
    w.maya.pump();
    let lent = w.maya.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(lent.state, GrantState::Ended);
    assert_eq!(lent.end_note.as_deref(), Some(super::service::BORROWER_RESTARTED));
}
