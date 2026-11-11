//! End to end, two team members on one test machine: Maya lends, Leo borrows (Sam is a third member for the
//! wrong-device checks). Control items go over the team transport the team tests use (a shared folder, every
//! envelope sealed, signed and opened by `team::secure`); model traffic goes over the p2p memory transport
//! (`p2p/memory.rs`) to a fake Messages API on 127.0.0.1. Fake credentials only.
//!
//! request -> accept -> borrower shim -> lender -> fake upstream; usage; Revoke; expiry; wrong node / wrong MAC;
//! revoke from the wrong device; a replayed grant.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::link::{ConnectError, LendNet};
use super::proxy_tests::{http, sse_script, Script, Upstream, SSE_TEXT};
use super::service::{Approval, Deps, Direction, GrantEnd, GrantState, Lend, LendAccount, LendProfile, LendWho, RefreshJob, TeamPort, SIGNIN_PROBLEM};
use super::spec::ProxySpec;
use super::wire::{self, Body, NodeHint};
use crate::keys::KeyStore as LinkKeys;
use crate::p2p::memory::MemoryNet;
use crate::secrets::{MemoryBackend, SecretBackend};
use crate::team::secure::{Opened, Payload, SeqTracker, Session};
use crate::team::tests_v1::{folder, temp_dir, world};
use crate::team::transport::{Inbound, TeamTransport};

const LENDER_KEY: &str = "sk-lender-FAKE";

fn now() -> u64 {
    crate::team::transport::now_ms()
}

struct TestTeam {
    session: Session,
    transport: Arc<dyn TeamTransport>,
    seq: AtomicU64,
}

impl TeamPort for TestTeam {
    fn session(&self) -> Result<Session, String> {
        Ok(self.session.clone())
    }
    fn send(&self, payload: &Payload) -> Result<(), String> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let env = self.session.seal(payload, seq, now())?;
        self.transport.send(&env).map_err(|e| e.0)
    }
}

/// A stand-in for the agent's CLI renewing its token: records the jobs and does what a test says.
#[derive(Default)]
struct FakeRefresh {
    jobs: Mutex<Vec<RefreshJob>>,
    action: Mutex<Option<Box<dyn Fn() -> Result<(), String> + Send>>>,
}

impl FakeRefresh {
    fn calls(&self) -> usize {
        self.jobs.lock().unwrap().len()
    }
}

struct Side {
    dir: std::path::PathBuf,
    refresh: Arc<FakeRefresh>,
    lend: Arc<Lend>,
    team: Arc<TestTeam>,
    secrets: Arc<MemoryBackend>,
    rx: Mutex<Receiver<Inbound>>,
    tracker: Mutex<SeqTracker>,
}

impl Side {
    /// Delivers every envelope that arrived for this PC, through every check, to the lend service.
    /// Waits (the folder is rescanned every few seconds) until at least one item for this device was handled, then
    /// takes whatever else is already there.
    fn pump(&self) {
        let rx = self.rx.lock().unwrap();
        let me = self.device();
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        let mut mine = 0;
        loop {
            let wait = if mine > 0 { Duration::from_millis(300) } else { deadline.saturating_duration_since(std::time::Instant::now()) };
            let Ok(inbound) = rx.recv_timeout(wait) else { break };
            let opened = self.team.session.open(&inbound.envelope, &mut self.tracker.lock().unwrap(), now());
            if let Ok(Opened::Capacity(cin)) = opened {
                if cin.to == me {
                    mine += 1;
                }
                let _ = self.lend.on_item(&cin);
            }
        }
    }

    fn member(&self) -> String {
        self.team.session.my_member().unwrap()
    }

    fn device(&self) -> String {
        self.team.session.my_device().unwrap()
    }
}

struct World2 {
    maya: Side,
    leo: Side,
    sam: Side,
    up: Upstream,
    _mem: MemoryNet,
}

fn side(name: &str, session: Session, transport: &Arc<dyn TeamTransport>, mem: &MemoryNet, upstream: Option<String>) -> Side {
    let secrets = Arc::new(MemoryBackend::new());
    let backend: Arc<dyn SecretBackend> = secrets.clone();
    let net = LendNet::new(LinkKeys::with_backend(backend.clone(), name), mem.factory()).unwrap();
    let dir = temp_dir(&format!("lend-{name}"));
    let team = Arc::new(TestTeam { session, transport: transport.clone(), seq: AtomicU64::new(0) });
    let refresh = Arc::new(FakeRefresh::default());
    let fake = refresh.clone();
    let deps = Deps {
        dir: dir.join("lend"),
        secrets: backend,
        team: team.clone(),
        net,
        accounts: crate::accounts::Store::at(&dir),
        specs: vec![ProxySpec::parse(include_str!("../tui/claude/lend_proxy.toml")).unwrap()],
        now: Arc::new(now),
        changed: Arc::new(|| {}),
        spawn: Arc::new(|f| {
            tokio::spawn(f);
        }),
        refresh: Arc::new(move |job| {
            let fake = fake.clone();
            Box::pin(async move {
                fake.jobs.lock().unwrap().push(job);
                match &*fake.action.lock().unwrap() {
                    Some(action) => action(),
                    None => Err("no refresh in this test".to_string()),
                }
            })
        }),
        env_names: Arc::new(|| vec!["ANTHROPIC_API_KEY".to_string(), "PATH".to_string()]),
        test_upstream: upstream,
    };
    let lend = Lend::new(deps);
    lend.apply_settings(&json!({ "lend_enabled": true }));
    let rx = Mutex::new(transport.subscribe(0).unwrap());
    Side { dir, refresh, lend, team, secrets, rx, tracker: Mutex::new(SeqTracker::default()) }
}

async fn world2(script: Script) -> World2 {
    let up = Upstream::start(script).await;
    let dir = temp_dir("lend-e2e");
    let t = folder(&dir);
    let w = world(&t, &["Leo", "Sam"], now());
    let roster = w.roster.clone();
    let mem = MemoryNet::new();
    let maya = side("maya", Session::new(roster.clone(), w.maya.clone()), &t, &mem, Some(format!("http://127.0.0.1:{}", up.port)));
    let leo = side("leo", Session::new(roster.clone(), w.others[0].1.clone()), &t, &mem, None);
    let sam = side("sam", Session::new(roster, w.others[1].1.clone()), &t, &mem, None);
    // Nothing old in the inboxes (the team's own setup traffic).
    for s in [&maya, &leo, &sam] {
        while s.rx.lock().unwrap().recv_timeout(Duration::from_millis(300)).is_ok() {}
    }
    World2 { maya, leo, sam, up, _mem: mem }
}

fn profile(w: &World2) -> String {
    let p = w
        .maya
        .lend
        .profile_save(LendProfile {
            id: String::new(),
            name: "Work Claude".into(),
            agent_ids: vec!["claude".into()],
            account: LendAccount::Main,
            who: LendWho::Teammates,
            member_ids: vec![w.leo.member()],
            default_secs: 3600,
            max_secs: 7 * 24 * 3600,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: None,
            max_tokens: None,
            has_key: false,
        })
        .unwrap();
    w.maya.lend.key_set(&p.id, LENDER_KEY).unwrap();
    p.id
}

/// Leo asks, Maya says yes; returns the grant id once Leo's shim is up, and its base URL.
async fn lend_one(w: &World2, secs: u64) -> (String, String) {
    let profile_id = profile(w);
    lend_one_with(w, secs, &profile_id).await
}

async fn lend_one_with(w: &World2, secs: u64, profile_id: &str) -> (String, String) {
    let req = w.leo.lend.request(&w.maya.member(), None, "claude", secs, "fix the build").unwrap();
    assert_eq!(req.direction, Direction::Out);
    w.maya.pump();
    let incoming = w.maya.lend.state(true).requests_in;
    assert_eq!(incoming.len(), 1, "the request arrived");
    assert_eq!(incoming[0].reason, "fix the build");
    assert!(incoming[0].for_other_person);
    let grant = w.maya.lend.answer(&req.id, true, Some(profile_id), None).await.unwrap().unwrap();
    w.leo.pump();
    for _ in 0..100 {
        if let Ok(env) = w.leo.lend.borrowed_launch_env("claude", &grant.id) {
            let base = env.set.iter().find(|(k, _)| k == "ANTHROPIC_BASE_URL").unwrap().1.clone();
            assert!(env.set.contains(&("ANTHROPIC_AUTH_TOKEN".into(), "pm-lend".into())));
            assert!(env.remove.iter().any(|r| r == "ANTHROPIC_API_KEY"));
            return (grant.id, base);
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    panic!("the borrower's shim did not start");
}

/// POST to the shim at `base` + `path`, as Claude would (with the placeholder token).
async fn post(base: &str, path: &str) -> super::proxy_tests::Reply {
    let rest = base.strip_prefix("http://127.0.0.1:").unwrap();
    let (port, secret) = rest.split_once('/').unwrap();
    http(
        port.parse().unwrap(),
        "POST",
        &format!("/{secret}{path}"),
        &[("content-type", "application/json"), ("authorization", "Bearer pm-lend"), ("x-api-key", "borrower-own-FAKE")],
        br#"{"model":"claude-test","max_tokens":10,"stream":true,"messages":[]}"#,
    )
    .await
}

const ENDED_BODY: &str = r#"{"error":{"type":"lend_ended","message":"This lend ended"}}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_accept_shim_upstream_usage_then_revoke() {
    let w = world2(sse_script()).await;
    let (grant_id, base) = lend_one(&w, 3600).await;

    // The borrower's agent talks to its shim; the lender's key reaches the provider, the borrower's never does.
    let reply = post(&base, "/v1/messages?beta=true").await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert!(reply.complete);
    assert_eq!(reply.body, SSE_TEXT.as_bytes(), "the SSE stream is byte-identical");
    let seen = w.up.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/v1/messages?beta=true");
    assert_eq!(seen[0].header("x-api-key"), Some(LENDER_KEY));
    assert!(seen[0].header("authorization").is_none());
    assert!(!seen[0].headers.iter().any(|(_, v)| v.contains("pm-lend") || v.contains("borrower-own")));

    // Usage is counted on the lender.
    let usage = w.maya.lend.usage(&grant_id).unwrap();
    assert_eq!((usage.requests, usage.input_tokens, usage.output_tokens), (1, 25, 42));
    let lent = w.maya.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((lent.requests, lent.input_tokens, lent.output_tokens), (1, 25, 42));

    // Other paths never leave the lender.
    let refused = post(&base, "/v1/models").await;
    assert_eq!(refused.status, 403);
    assert_eq!(w.up.requests().len(), 1);

    // The borrowed grant is one more sign-in for the pickers.
    let rows = w.leo.lend.borrowed_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(format!("lend:{grant_id}")));
    assert_eq!(rows[0]["label"], json!("Maya's PC (lent)"));

    // Revoke: the next request is refused at once, before the revoke item even arrives.
    w.maya.lend.revoke(&grant_id).unwrap();
    let after = post(&base, "/v1/messages").await;
    assert_eq!(after.status, 403);
    assert_eq!(after.text(), ENDED_BODY);
    assert_eq!(w.up.requests().len(), 1);
    w.leo.pump();
    let borrowed = w.leo.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(borrowed.state, GrantState::Ended);
    assert_eq!(borrowed.end_reason, Some(GrantEnd::Revoked));
    // A new pane can't start on it; one still running keeps getting "This lend ended" from the shim.
    assert_eq!(w.leo.lend.borrowed_launch_env("claude", &grant_id).unwrap_err(), "This lend ended");
    assert_eq!(post(&base, "/v1/messages").await.text(), ENDED_BODY);
    assert!(w.leo.lend.borrowed_rows().is_empty());
    let lent = w.maya.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(lent.end_reason, Some(GrantEnd::Revoked));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revoke_cuts_a_live_stream_at_once() {
    let w = world2(Script::Endless).await;
    let (grant_id, base) = lend_one(&w, 3600).await;
    let b = base.clone();
    let live = tokio::spawn(async move { post(&b, "/v1/messages").await });
    tokio::time::sleep(Duration::from_millis(400)).await;
    let t0 = std::time::Instant::now();
    w.maya.lend.revoke(&grant_id).unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(3), live).await.expect("the stream was cut").unwrap();
    assert!(t0.elapsed() < Duration::from_secs(2), "cut took {:?}", t0.elapsed());
    assert_eq!(reply.status, 200);
    assert!(!reply.complete, "a cut stream has no final chunk");
    assert!(!reply.body.is_empty());
    assert_eq!(post(&base, "/v1/messages").await.text(), ENDED_BODY);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_deadline_cuts_a_live_stream_and_ends_the_lend_on_both_pcs() {
    let w = world2(Script::Endless).await;
    let (grant_id, base) = lend_one(&w, 2).await;
    let reply = tokio::time::timeout(Duration::from_secs(6), post(&base, "/v1/messages")).await.expect("cut at the deadline");
    assert_eq!(reply.status, 200);
    assert!(!reply.complete);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(post(&base, "/v1/messages").await.text(), ENDED_BODY);
    let lent = w.maya.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((lent.state, lent.end_reason), (GrantState::Ended, Some(GrantEnd::Expired)));
    let borrowed = w.leo.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((borrowed.state, borrowed.end_reason), (GrantState::Ended, Some(GrantEnd::Expired)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn give_back_ends_it_on_the_lender() {
    let w = world2(sse_script()).await;
    let (grant_id, base) = lend_one(&w, 3600).await;
    w.leo.lend.give_back(&grant_id).unwrap();
    assert_eq!(post(&base, "/v1/messages").await.text(), ENDED_BODY);
    w.maya.pump();
    let lent = w.maya.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(lent.end_reason, Some(GrantEnd::Returned));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wrong_node_or_a_wrong_mac_is_refused_on_the_link() {
    let w = world2(sse_script()).await;
    let (grant_id, _base) = lend_one(&w, 3600).await;
    let hint: NodeHint = w.maya.lend.net().start().await.unwrap();
    let secret = crate::secure_core::crypto::unb64(&w.maya.secrets.get(&format!("lend:link:{grant_id}")).unwrap().unwrap()).unwrap();
    // Sam has the grant id and the secret (a stolen grant) but not Leo's node key: the link layer refuses him.
    let sam = w.sam.lend.net().connect(&hint, &grant_id, &secret).await;
    assert!(matches!(sam, Err(ConnectError::Unreachable(_)) | Err(ConnectError::Refused)), "{:?}", sam.err());
    // Leo's own node with a wrong secret: the handshake MAC fails.
    let wrong = w.leo.lend.net().connect(&hint, &grant_id, &[7u8; 32]).await;
    assert_eq!(wrong.err(), Some(ConnectError::Refused));
    // Leo's node, right secret, another grant id: refused too.
    let other = w.leo.lend.net().connect(&hint, "lg_other", &secret).await;
    assert_eq!(other.err(), Some(ConnectError::Refused));
    // And the real one still works.
    assert!(w.leo.lend.net().connect(&hint, &grant_id, &secret).await.is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_revoke_from_the_wrong_device_and_a_replayed_grant_are_refused() {
    let w = world2(sse_script()).await;
    let (grant_id, base) = lend_one(&w, 3600).await;
    // Sam (another member, another device) tries to revoke Leo's borrowed grant.
    let (payload, _) = wire::seal(&w.sam.team.session, &w.leo.device(), Body::Revoke { grant_id: grant_id.clone(), reason: String::new() }, now()).unwrap();
    w.sam.team.send(&payload).unwrap();
    w.leo.pump();
    let borrowed = w.leo.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(borrowed.state, GrantState::Active, "a revoke from the wrong device is ignored");
    assert_eq!(post(&base, "/v1/messages").await.status, 200);

    // Maya sends the same grant again (new msg id): the request is no longer open and the grant id was used.
    let req_id = w.leo.lend.state(true).requests_out[0].id.clone();
    let body = Body::Grant {
        request_id: req_id,
        grant_id: grant_id.clone(),
        agent_id: "claude".into(),
        mode: "proxy".into(),
        duration_ms: 3_600_000,
        not_after_ms: now() + 3_600_000,
        limits: Default::default(),
        node: NodeHint { id: "11".repeat(32), relay: String::new(), lan: vec![] },
        link_secret: crate::secure_core::crypto::b64(&[5u8; 32]),
        device_name: String::new(),
    };
    let (payload, _) = wire::seal(&w.maya.team.session, &w.leo.device(), body, now()).unwrap();
    let cin = match w.leo.team.session.open(&w.maya.team.session.seal(&payload, 999, now()).unwrap(), &mut SeqTracker::default(), now()) {
        Ok(Opened::Capacity(c)) => c,
        other => panic!("{other:?}"),
    };
    assert!(w.leo.lend.on_item(&cin).is_err());
    assert_eq!(w.leo.lend.state(true).grants.iter().filter(|g| g.id == grant_id).count(), 1);
    // The same item delivered twice is a replay.
    assert_eq!(w.leo.lend.on_item(&cin), Err(wire::WireReject::Replay));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_profile_needs_a_credential_and_a_cap_holds_for_another_person() {
    let w = world2(sse_script()).await;
    // Another person can ask for 24 hours at most.
    assert!(w.leo.lend.request(&w.maya.member(), None, "claude", 25 * 3600, "").is_err());
    // An agent with no proxy spec can't be asked for.
    assert!(w.leo.lend.request(&w.maya.member(), None, "codex", 3600, "").is_err());
    // A profile on the main login with no pasted key can't lend: the main login is never read.
    let p = w
        .maya
        .lend
        .profile_save(LendProfile {
            id: String::new(),
            name: "No key".into(),
            agent_ids: vec!["claude".into()],
            account: LendAccount::Main,
            who: LendWho::Teammates,
            member_ids: vec![],
            default_secs: 3600,
            max_secs: 3600,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: None,
            max_tokens: None,
            has_key: false,
        })
        .unwrap();
    let req = w.leo.lend.request(&w.maya.member(), None, "claude", 3600, "").unwrap();
    w.maya.pump();
    let err = w.maya.lend.answer(&req.id, true, Some(&p.id), None).await.unwrap_err();
    assert!(err.contains("lend sign-in or paste an API key"), "{err}");
    // A regular (not lend-only) account can't be used for a profile either.
    let acc = crate::accounts::Store::at(&temp_dir("lend-acc")).add("claude", "Work", None).unwrap();
    let mut bad = p.clone();
    bad.account = LendAccount::Account { id: acc.id };
    assert!(w.maya.lend.profile_save(bad).is_err());
}

/// A borrowed grant is one more sign-in: both the terminal lane (`accounts::Store::launch_env`) and the chat lane
/// (`acp::account::launch_env`) hand `lend:<grant>` to the lend service, never to a home folder. (The app's switch
/// is off in unit tests, so the service answers that it is off.)
#[test]
fn a_borrowed_sign_in_goes_to_the_lend_service_on_both_lanes() {
    let store = crate::accounts::Store::at(&temp_dir("lend-lanes"));
    let terminal = store.launch_env("claude", "lend:lg_x").unwrap_err();
    assert_eq!(terminal, super::OFF);
    let chat = crate::acp::account::launch_env(&store, "claude", "lend:lg_x").unwrap_err();
    assert_eq!(chat.code, "ACCOUNT_NOT_FOUND");
    assert!(chat.message.contains(super::OFF), "{}", chat.message);
    // Nothing was created for it.
    assert!(store.list().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_profile_request_limit_holds_end_to_end() {
    let w = world2(sse_script()).await;
    let p = w
        .maya
        .lend
        .profile_save(LendProfile {
            id: String::new(),
            name: "One call".into(),
            agent_ids: vec!["claude".into()],
            account: LendAccount::Main,
            who: LendWho::Teammates,
            member_ids: vec![],
            default_secs: 3600,
            max_secs: 3600,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: Some(1),
            max_tokens: None,
            has_key: false,
        })
        .unwrap();
    w.maya.lend.key_set(&p.id, LENDER_KEY).unwrap();
    let req = w.leo.lend.request(&w.maya.member(), None, "claude", 3600, "").unwrap();
    w.maya.pump();
    let grant = w.maya.lend.answer(&req.id, true, Some(&p.id), None).await.unwrap().unwrap();
    w.leo.pump();
    let mut base = None;
    for _ in 0..100 {
        if let Ok(env) = w.leo.lend.borrowed_launch_env("claude", &grant.id) {
            base = env.set.iter().find(|(k, _)| k == "ANTHROPIC_BASE_URL").map(|(_, v)| v.clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let base = base.expect("shim up");
    assert_eq!(post(&base, "/v1/messages").await.status, 200);
    let second = post(&base, "/v1/messages").await;
    assert_eq!(second.status, 429);
    assert!(second.text().contains("lend_limit"));
    assert_eq!(w.up.requests().len(), 1);
}

// ---------------------------------------------------------------- a lend sign-in that expires

/// Maya's lend sign-in with a token file that expires at `expires_ms`; returns a profile id that lends it.
fn sign_in_profile(w: &World2, expires_ms: u64) -> (String, String) {
    let acc = crate::accounts::Store::at(&w.maya.dir).add_lend("claude", "Lend sign-in").unwrap();
    write_creds(&acc.home, "tok-one-FAKE", expires_ms);
    let p = w
        .maya
        .lend
        .profile_save(LendProfile {
            id: String::new(),
            name: "Sign-in".into(),
            agent_ids: vec!["claude".into()],
            account: LendAccount::Account { id: acc.id.clone() },
            who: LendWho::Teammates,
            member_ids: vec![w.leo.member()],
            default_secs: 3600,
            max_secs: 3600,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: None,
            max_tokens: None,
            has_key: false,
        })
        .unwrap();
    (p.id, acc.home)
}

fn write_creds(home: &str, token: &str, expires_ms: u64) {
    std::fs::create_dir_all(home).unwrap();
    let json = format!(r#"{{"claudeAiOauth":{{"accessToken":"{token}","refreshToken":"r-FAKE","expiresAt":{expires_ms}}}}}"#);
    std::fs::write(std::path::Path::new(home).join(".credentials.json"), json).unwrap();
}

fn problem_of(side: &Side, grant_id: &str) -> Option<String> {
    side.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap().problem
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..100 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never happened: {what}");
}

fn hour_from_now() -> u64 {
    now() + 3_600_000
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_token_is_read_again_for_each_request_through_the_whole_path() {
    let w = world2(sse_script()).await;
    let (profile_id, home) = sign_in_profile(&w, hour_from_now());
    let (_grant, base) = lend_one_with(&w, 3600, &profile_id).await;
    assert_eq!(post(&base, "/v1/messages").await.status, 200);
    write_creds(&home, "tok-two-FAKE", hour_from_now());
    assert_eq!(post(&base, "/v1/messages").await.status, 200);
    let seen = w.up.requests();
    assert_eq!(seen[0].header("authorization"), Some("Bearer tok-one-FAKE"));
    assert_eq!(seen[1].header("authorization"), Some("Bearer tok-two-FAKE"));
    assert_eq!(w.maya.refresh.calls(), 0, "a token far from its end is not refreshed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_expired_sign_in_shows_a_problem_on_both_pcs_and_clears_when_fixed() {
    let w = world2(sse_script()).await;
    let (profile_id, home) = sign_in_profile(&w, 1_000);
    let (grant, base) = lend_one_with(&w, 3600, &profile_id).await;
    let reply = post(&base, "/v1/messages").await;
    assert_eq!(reply.status, 401);
    assert!(reply.text().contains("lend_signin_expired"));
    assert_eq!(reply.header("x-pm-lend"), Some("signin_expired"));
    assert!(w.up.requests().is_empty(), "the provider was not called");
    assert_eq!(problem_of(&w.maya, &grant).as_deref(), Some(SIGNIN_PROBLEM));
    assert_eq!(problem_of(&w.leo, &grant).as_deref(), Some(SIGNIN_PROBLEM));
    // The lender signs in again.
    write_creds(&home, "tok-new-FAKE", hour_from_now());
    assert_eq!(post(&base, "/v1/messages").await.status, 200);
    assert_eq!(problem_of(&w.leo, &grant), None, "a good reply clears the borrower's problem");
    until("the lender's problem clears", || problem_of(&w.maya, &grant).is_none()).await;
    assert_eq!(w.up.requests()[0].header("authorization"), Some("Bearer tok-new-FAKE"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_token_close_to_its_end_is_refreshed_once_and_the_problem_clears() {
    let w = world2(sse_script()).await;
    let (profile_id, home) = sign_in_profile(&w, 1_000);
    let h = home.clone();
    *w.maya.refresh.action.lock().unwrap() = Some(Box::new(move || {
        write_creds(&h, "tok-renewed-FAKE", hour_from_now());
        Ok(())
    }));
    let (grant, base) = lend_one_with(&w, 3600, &profile_id).await;
    until("the refresh ran", || w.maya.refresh.calls() == 1).await;
    until("the problem is gone", || problem_of(&w.maya, &grant).is_none()).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(w.maya.refresh.calls(), 1, "a fresh token is not refreshed again");
    let job = w.maya.refresh.jobs.lock().unwrap()[0].clone();
    let spec = crate::capacity_proxy::spec::for_agent("claude").unwrap();
    let refresh = spec.auth.account.unwrap().refresh.unwrap();
    assert_eq!((job.agent_id.as_str(), job.args, job.timeout_secs), ("claude", refresh.args, 120));
    assert!(job.account_id.starts_with("acc_"));
    assert_eq!(post(&base, "/v1/messages").await.status, 200);
    assert_eq!(w.up.requests()[0].header("authorization"), Some("Bearer tok-renewed-FAKE"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_refresh_leaves_the_problem_on_the_grant() {
    let w = world2(sse_script()).await;
    let (profile_id, _home) = sign_in_profile(&w, 1_000);
    *w.maya.refresh.action.lock().unwrap() = Some(Box::new(|| Err("the agent could not be started".to_string())));
    let (grant, _base) = lend_one_with(&w, 3600, &profile_id).await;
    until("a refresh was tried", || w.maya.refresh.calls() >= 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(problem_of(&w.maya, &grant).as_deref(), Some(SIGNIN_PROBLEM));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_token_inside_the_window_but_not_expired_is_refreshed_without_a_problem() {
    let w = world2(sse_script()).await;
    // 60 seconds left: inside the 15 minute window, not expired.
    let (profile_id, home) = sign_in_profile(&w, now() + 60_000);
    let h = home.clone();
    *w.maya.refresh.action.lock().unwrap() = Some(Box::new(move || {
        write_creds(&h, "tok-renewed-FAKE", hour_from_now());
        Ok(())
    }));
    let (grant, _base) = lend_one_with(&w, 3600, &profile_id).await;
    until("the refresh ran", || w.maya.refresh.calls() == 1).await;
    assert_eq!(problem_of(&w.maya, &grant), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pasted_key_is_never_refreshed() {
    let w = world2(sse_script()).await;
    let (grant, base) = lend_one(&w, 3600).await;
    assert_eq!(post(&base, "/v1/messages").await.status, 200);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(w.maya.refresh.calls(), 0);
    assert_eq!(problem_of(&w.maya, &grant), None);
}

/// The joined layer the screens use: a profile that holds a pasted key says so (never the key), a lend sign-in added
/// with `add_lend` can be lent, a borrowed pane started any way is listed once on its grant, the pickers' row carries
/// what the countdown needs, and Revoke closes the new-pane path and clears the row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_screens_see_a_key_profile_a_lend_sign_in_a_borrowed_pane_and_the_row_until_revoke() {
    let w = world2(sse_script()).await;
    let profile_id = profile(&w);
    let shown = w.maya.lend.state(true).profiles.into_iter().find(|p| p.id == profile_id).unwrap();
    assert!(shown.has_key, "the screen is told a key is kept");
    assert!(!serde_json::to_string(&shown).unwrap().contains(LENDER_KEY), "the key itself never goes to the screen");
    // Saving again never stores the flag, and an empty key clears it.
    w.maya.lend.key_set(&profile_id, "").unwrap();
    assert!(!w.maya.lend.state(true).profiles[0].has_key);
    w.maya.lend.key_set(&profile_id, LENDER_KEY).unwrap();

    // "Add a lend sign-in": an app-managed folder marked lend-only, which a profile may name.
    let added = crate::accounts::Store::at(&w.maya.dir).add_lend("claude", "Lend Claude").unwrap();
    assert!(added.lend_only);
    let saved = w
        .maya
        .lend
        .profile_save(LendProfile {
            id: String::new(),
            name: "Signed in".into(),
            agent_ids: vec!["claude".into()],
            account: LendAccount::Account { id: added.id.clone() },
            who: LendWho::MyPcs,
            member_ids: vec![],
            default_secs: 3600,
            max_secs: 3600,
            approval: Approval::Each,
            sign_out_on_end: true,
            max_requests: Some(5),
            max_tokens: Some(1000),
            has_key: true,
        })
        .unwrap();
    assert!(!saved.has_key, "a flag sent back from the screen is not stored");
    assert_eq!((saved.max_requests, saved.max_tokens), (Some(5), Some(1000)));

    let (grant_id, base) = lend_one_with(&w, 3600, &profile_id).await;
    let row = &w.leo.lend.borrowed_rows()[0];
    assert_eq!(row["agent_id"], json!("claude"));
    assert_eq!(row["grant_id"], json!(grant_id));
    assert!(row["ends_ms"].as_u64().unwrap() > now());

    // A pane started by `new_pane` with the `lend:` sign-in is noted by the spawn path: twice is still once.
    w.leo.lend.note_pane(&grant_id, "pane-1");
    w.leo.lend.note_pane(&grant_id, "pane-1");
    let grant = w.leo.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(grant.pane_ids, vec!["pane-1".to_string()]);
    assert_eq!(grant.problem, None);

    let reply = post(&base, "/v1/messages").await;
    assert_eq!(reply.status, 200);
    let lent = w.maya.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!((lent.requests, lent.input_tokens, lent.output_tokens), (1, 25, 42));

    w.maya.lend.revoke(&grant_id).unwrap();
    w.leo.pump();
    assert!(w.leo.lend.borrowed_rows().is_empty());
    assert!(w.leo.lend.borrowed_launch_env("claude", &grant_id).is_err());
    assert_eq!(post(&base, "/v1/messages").await.text(), ENDED_BODY);
}

/// The chat lane (the ACP adapter) on `lend:<grant>`: the adapter is started with the proxy env and nothing of the
/// borrower's own provider login, through the same `with_account_env` the chat start uses, and a chat pane is listed
/// on its grant (`note_pane`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chat_on_a_borrowed_sign_in_gets_the_proxy_env_and_is_listed_on_the_grant() {
    use crate::acp::config::{build_env, find_builtin, with_account_env, HostEnv};
    use std::ffi::OsString;
    struct Host;
    impl HostEnv for Host {
        fn var(&self, name: &str) -> Option<OsString> {
            // The borrower's own login and provider variables are in the app's environment.
            ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"].contains(&name).then(|| OsString::from("borrower-own-FAKE"))
        }
        fn which(&self, _program: &str) -> Option<std::path::PathBuf> {
            None
        }
        fn adapters_dir(&self) -> std::path::PathBuf {
            "adapters".into()
        }
        fn homes_dir(&self) -> std::path::PathBuf {
            "homes".into()
        }
    }
    let lookup = |env: &[(OsString, OsString)], name: &str| env.iter().find(|(n, _)| n.to_string_lossy().eq_ignore_ascii_case(name)).map(|(_, v)| v.to_string_lossy().into_owned());

    let w = world2(sse_script()).await;
    let (grant_id, base) = lend_one(&w, 3600).await;
    let launch = w.leo.lend.borrowed_launch_env("claude", &grant_id).unwrap();
    let mut cfg = find_builtin("claude").expect("claude has a chat adapter");
    // Without the account the borrower's own values pass through (what the lend must replace).
    assert_eq!(lookup(&build_env(&cfg, &Host, None), "CLAUDE_CONFIG_DIR").as_deref(), Some("borrower-own-FAKE"));
    with_account_env(&mut cfg, &launch);
    let env = build_env(&cfg, &Host, None);
    assert_eq!(lookup(&env, "ANTHROPIC_BASE_URL"), Some(base.clone()), "the adapter talks to the local shim");
    assert_eq!(lookup(&env, "ANTHROPIC_AUTH_TOKEN").as_deref(), Some("pm-lend"), "a placeholder, never a real token");
    assert_eq!(lookup(&env, "ANTHROPIC_API_KEY"), None, "the borrower's own key does not reach the adapter");
    assert_eq!(lookup(&env, "CLAUDE_CONFIG_DIR"), None, "nor the borrower's own login folder");

    // The adapter's request goes through the shim like a terminal's, and the borrower counts it too.
    let reply = post(&base, "/v1/messages").await;
    assert_eq!(reply.status, 200);
    w.leo.lend.note_pane(&grant_id, "chat-pane-1");
    let mine = w.leo.lend.state(true).grants.into_iter().find(|g| g.id == grant_id).unwrap();
    assert_eq!(mine.pane_ids, vec!["chat-pane-1".to_string()]);
    assert_eq!((mine.requests, mine.input_tokens, mine.output_tokens), (1, 25, 42), "the borrower's own count matches the lender's");
}
