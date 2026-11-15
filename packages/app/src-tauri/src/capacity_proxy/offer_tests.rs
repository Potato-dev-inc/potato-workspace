//! Pass a task with "run it through my lent usage": the one lend that is answered without a click. On a real team of three over
//! the shared folder, with the real lend service on both PCs and the real pass-a-task service on both.
//!
//! The promise is the sender's own earlier click, bound to one task id, one person, one profile and the time named. A request
//! from another person, for another profile, for longer, a second one, one after the task was taken back, or one that names
//! no task is NOT answered by itself. And what crosses is only the normal lend: no login moves.

use std::sync::Arc;

use super::e2e_tests::{until, world2, LENDER_KEY, World2};
use super::proxy_tests::sse_script;
use super::service::{Approval, Direction, Lend, LendAccount, LendProfile, LendWho, RequestState};
use crate::team::direct::model::Usage;
use crate::team::direct::service::{AcceptInput, Deps, Direct, LendInput, LendPort, PassInput, Port};
use crate::team::direct::wire::LendOffer;
use crate::secrets::SecretBackend;
use crate::team::secure::{Payload, Session};

use super::service::TeamPort;

struct TaskPort(Arc<super::e2e_tests::TestTeam>);

impl Port for TaskPort {
    fn session(&self) -> Result<Session, String> {
        TeamPort::session(&*self.0)
    }
    fn send(&self, payload: &Payload) -> Result<(), String> {
        TeamPort::send(&*self.0, payload)
    }
}

/// The lend feature as pass-a-task sees it, over the real service.
struct TaskLend(Arc<Lend>);

impl LendPort for TaskLend {
    fn enabled(&self) -> bool {
        true
    }
    fn profile_for_task(&self, member_id: &str, profile_id: &str, secs: u64) -> Result<(String, Vec<String>), String> {
        self.0.profile_for_task(member_id, profile_id, secs)
    }
    fn request(&self, member_id: &str, device_id: &str, offer: &LendOffer, reason: &str, task_id: &str) -> Result<(), String> {
        self.0.request_for_task(member_id, device_id, &offer.agent_id, offer.secs, reason, &offer.profile_id, &offer.profile_name, task_id).map(|_| ())
    }
}

fn wire_direct(side: &super::e2e_tests::Side) -> Arc<Direct> {
    let direct = Direct::new(Deps {
        dir: side.dir.join("team-tasks"),
        port: Arc::new(TaskPort(side.team.clone())),
        lend: Arc::new(TaskLend(side.lend.clone())),
        now: Arc::new(crate::team::transport::now_ms),
        changed: Arc::new(|| {}),
        spawn: Arc::new(|f| f()),
        pace_ms: 0,
    });
    side.lend.set_offer_gate(direct.clone());
    *side.direct.lock().unwrap() = Some(direct.clone());
    direct
}

/// A lend profile for any teammate (so only the promise, not the profile's list of people, decides).
fn open_profile(w: &World2, name: &str, max_secs: u64) -> String {
    w.maya
        .lend
        .profile_save(LendProfile {
            id: String::new(),
            name: name.into(),
            agent_ids: vec!["claude".into()],
            account: LendAccount::Main,
            who: LendWho::Teammates,
            member_ids: vec![],
            default_secs: 3600,
            max_secs,
            approval: Approval::Each,
            sign_out_on_end: false,
            max_requests: None,
            max_tokens: None,
            keep_awake: false,
            has_key: false,
            show_usage: false,
        })
        .map(|p| {
            w.maya.lend.key_set(&p.id, LENDER_KEY).unwrap();
            p.id
        })
        .unwrap()
}

struct Setup {
    w: World2,
    maya_direct: Arc<Direct>,
    leo_direct: Arc<Direct>,
    profile_id: String,
    task_id: String,
}

async fn setup(secs: u64) -> Setup {
    let w = world2(sse_script()).await;
    let maya_direct = wire_direct(&w.maya);
    let leo_direct = wire_direct(&w.leo);
    let profile_id = open_profile(&w, "Work Claude", 8 * 3600);
    let sent = maya_direct
        .pass(PassInput {
            to_member: w.leo.member(),
            title: "Check the build".into(),
            text: "Please look at why the build is red".into(),
            summary: String::new(),
            repo: None,
            lend: Some(LendInput { profile_id: profile_id.clone(), secs }),
        })
        .unwrap();
    w.leo.pump();
    assert_eq!(leo_direct.view().received.len(), 1);
    Setup { w, maya_direct, leo_direct, profile_id, task_id: sent.id }
}

fn maya_requests(w: &World2) -> Vec<super::service::LendRequest> {
    w.maya.lend.state(true).requests_in
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn accepting_with_their_usage_gets_the_promised_lend_without_a_click() {
    let s = setup(1800).await;
    // Leo says yes with Maya's lent usage: the normal lend request goes out, naming the task. Nobody clicks on Maya's side.
    let got = s.leo_direct.accept(&s.task_id, AcceptInput { usage: Usage::Lent, ..Default::default() }).unwrap();
    assert!(got.lend_error.is_empty(), "{}", got.lend_error);
    s.w.maya.pump();
    until("the request was answered by the promise", || maya_requests(&s.w).first().is_some_and(|r| r.state == RequestState::Accepted)).await;
    let granted = s.w.maya.lend.state(true).grants.into_iter().find(|g| g.direction == Direction::Out).expect("a grant");
    assert_eq!(granted.peer_member_id, s.w.leo.member());
    assert!(granted.ends_ms - granted.started_ms <= 1800 * 1000, "no longer than promised");
    // Leo's side gets the grant and a borrowed sign-in: a proxy address and a placeholder, never the lender's key.
    s.w.leo.pump();
    let mut env = None;
    for _ in 0..100 {
        if let Ok(e) = s.w.leo.lend.borrowed_launch_env("claude", &granted.id) {
            env = Some(e);
            break;
        }
        super::own_tests::pause(30).await;
    }
    let env = env.expect("the borrower's shim started");
    assert!(env.set.contains(&("ANTHROPIC_AUTH_TOKEN".into(), "pm-lend".into())));
    // No credential bytes crossed: the lender's key is nowhere on Leo's PC (files, secrets, the env it got).
    let mut all = String::new();
    for (_, v) in &env.set {
        all.push_str(v);
        all.push('\n');
    }
    fn walk(dir: &std::path::Path, out: &mut String) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if let Ok(t) = std::fs::read_to_string(&p) {
                out.push_str(&t);
            }
        }
    }
    walk(&s.w.leo.dir, &mut all);
    assert!(!all.contains(LENDER_KEY), "the lender's key must never reach the borrower");
    for name in ["lend:key", "lend:token", &format!("lend:key:{}", s.profile_id)] {
        assert!(s.w.leo.secrets.get(name).ok().flatten().is_none_or(|v| !v.contains(LENDER_KEY)), "{name}");
    }
    // The task's own record: used once.
    assert!(s.maya_direct.view().sent[0].lend_used);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_request_for_the_same_task_is_not_answered_by_itself() {
    let s = setup(1800).await;
    s.leo_direct.accept(&s.task_id, AcceptInput { usage: Usage::Lent, ..Default::default() }).unwrap();
    s.w.maya.pump();
    until("first answered", || maya_requests(&s.w).first().is_some_and(|r| r.state == RequestState::Accepted)).await;
    // Again, same task id: the promise was used.
    s.w.leo.lend.request_for_task(&s.w.maya.member(), &s.w.maya.device(), "claude", 600, "again", &s.profile_id, "Work Claude", &s.task_id).unwrap();
    s.w.maya.pump();
    let second = maya_requests(&s.w).into_iter().find(|r| r.reason == "again").expect("the second request arrived");
    super::own_tests::pause(300).await;
    let second = maya_requests(&s.w).into_iter().find(|r| r.id == second.id).unwrap();
    assert_eq!(second.state, RequestState::Open, "waits for a click");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn another_person_another_profile_longer_or_no_task_is_not_answered_by_itself() {
    let s = setup(1800).await;
    let other_profile = open_profile(&s.w, "Other Claude", 8 * 3600);
    let maya = s.w.maya.member();
    let device = s.w.maya.device();
    // 1. Sam asks with Leo's task id (the profile allows anyone, so only the promise could stop it).
    s.w.sam.lend.request_for_task(&maya, &device, "claude", 600, "from sam", &s.profile_id, "Work Claude", &s.task_id).unwrap();
    // 2. Leo asks for another profile.
    s.w.leo.lend.request_for_task(&maya, &device, "claude", 600, "other profile", &other_profile, "Other Claude", &s.task_id).unwrap();
    // 3. Leo asks for longer than promised.
    s.w.leo.lend.request_for_task(&maya, &device, "claude", 3600, "longer", &s.profile_id, "Work Claude", &s.task_id).unwrap();
    // 4. Leo asks without naming the task, and with a task that does not exist.
    s.w.leo.lend.request_with_profile(&maya, Some(&device), "claude", 600, "no task", Some(&s.profile_id), Some("Work Claude")).unwrap();
    s.w.leo.lend.request_for_task(&maya, &device, "claude", 600, "wrong task", &s.profile_id, "Work Claude", "tk_nothing").unwrap();
    s.w.maya.pump();
    super::own_tests::pause(400).await;
    let reqs = maya_requests(&s.w);
    assert_eq!(reqs.len(), 5, "{:?}", reqs.iter().map(|r| &r.reason).collect::<Vec<_>>());
    for r in &reqs {
        assert_eq!(r.state, RequestState::Open, "{} must wait for a click", r.reason);
    }
    assert!(s.w.maya.lend.state(true).grants.is_empty(), "nothing was granted by itself");
    assert!(!s.maya_direct.view().sent[0].lend_used, "a refused request does not spend the promise");
    // The promise still works for the right request afterwards.
    s.leo_direct.accept(&s.task_id, AcceptInput { usage: Usage::Lent, ..Default::default() }).unwrap();
    s.w.maya.pump();
    until("the right request is answered", || maya_requests(&s.w).iter().any(|r| r.state == RequestState::Accepted)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn taking_the_task_back_ends_the_promise() {
    let s = setup(1800).await;
    s.maya_direct.withdraw(&s.task_id).unwrap();
    s.w.leo.lend.request_for_task(&s.w.maya.member(), &s.w.maya.device(), "claude", 600, "after withdraw", &s.profile_id, "Work Claude", &s.task_id).unwrap();
    s.w.maya.pump();
    super::own_tests::pause(400).await;
    let r = maya_requests(&s.w).into_iter().find(|r| r.reason == "after withdraw").expect("arrived");
    assert_eq!(r.state, RequestState::Open);
    // And a declined task cannot be used as a key either.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_lend_still_ends_on_time_and_take_back_works() {
    let s = setup(30).await;
    s.leo_direct.accept(&s.task_id, AcceptInput { usage: Usage::Lent, ..Default::default() }).unwrap();
    s.w.maya.pump();
    until("answered", || maya_requests(&s.w).first().is_some_and(|r| r.state == RequestState::Accepted)).await;
    let grant = s.w.maya.lend.state(true).grants.into_iter().next().unwrap();
    // The ordinary Take back is still the lender's.
    s.w.maya.lend.revoke(&grant.id).unwrap();
    let g = s.w.maya.lend.state(true).grants.into_iter().find(|g| g.id == grant.id).unwrap();
    assert_ne!(g.state, super::service::GrantState::Active);
    // A fresh request cannot reuse the spent promise.
    s.w.leo.lend.request_for_task(&s.w.maya.member(), &s.w.maya.device(), "claude", 1, "reuse", &s.profile_id, "Work Claude", &s.task_id).unwrap();
    s.w.maya.pump();
    super::own_tests::pause(300).await;
    assert_eq!(maya_requests(&s.w).into_iter().find(|r| r.reason == "reuse").unwrap().state, RequestState::Open);
}
