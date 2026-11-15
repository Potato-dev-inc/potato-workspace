//! Pass a task on a real team (Maya, Leo and Sam, each with an in-memory key store, over a shared folder): the sealed round
//! trip, accept / decline / withdraw states, hostile text, the limits, the lent-usage promise (words and numbers only), and
//! the repo hand-over end to end.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::model::*;
use super::service::{AcceptInput, Deps, Direct, LendInput, LendPort, PassInput, Port, RepoInput};
use super::wire::{self, Body, History, LendOffer, WireReject};
use crate::team::leakcheck::readable_in;
use crate::team::secure::{Opened, Payload, SeqTracker, Session};
use crate::team::tests_v1::{folder, temp_dir, world};
use crate::team::transport::{Inbound, TeamTransport};

pub(super) fn now() -> u64 {
    crate::team::transport::now_ms()
}

pub(super) struct TestPort {
    pub session: Session,
    pub transport: Arc<dyn TeamTransport>,
    pub seq: AtomicU64,
}

impl Port for TestPort {
    fn session(&self) -> Result<Session, String> {
        Ok(self.session.clone())
    }
    fn send(&self, payload: &Payload) -> Result<(), String> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let env = self.session.seal(payload, seq, now())?;
        self.transport.send(&env).map_err(|e| e.0)
    }
}

/// A stand-in for the lend feature: records the requests a receiver makes. Nothing but words and numbers reaches it.
#[derive(Default)]
pub(super) struct FakeLend {
    pub off: bool,
    pub requests: Mutex<Vec<(String, String, LendOffer, String, String)>>,
    pub fail_request: bool,
}

impl LendPort for FakeLend {
    fn enabled(&self) -> bool {
        !self.off
    }
    fn profile_for_task(&self, _member: &str, profile_id: &str, secs: u64) -> Result<(String, Vec<String>), String> {
        if profile_id == "lp_work" && secs <= 8 * 3600 {
            Ok(("Work account".into(), vec!["claude".into()]))
        } else {
            Err("That lend profile is gone.".into())
        }
    }
    fn request(&self, member: &str, device: &str, offer: &LendOffer, reason: &str, task_id: &str) -> Result<(), String> {
        if self.fail_request {
            return Err("The lender is not answering.".into());
        }
        self.requests.lock().unwrap().push((member.into(), device.into(), offer.clone(), reason.into(), task_id.into()));
        Ok(())
    }
}

pub(super) struct Side {
    pub direct: Arc<Direct>,
    pub session: Session,
    pub lend: Arc<FakeLend>,
    pub dir: std::path::PathBuf,
    transport: Arc<dyn TeamTransport>,
    rx: Mutex<Receiver<Inbound>>,
    tracker: Mutex<SeqTracker>,
}

impl Side {
    /// Delivers every envelope that arrived for this PC, through every check, to the service. Waits (the folder is rescanned
    /// every few seconds) for the first one, then takes what else is there.
    pub fn pump(&self) -> Vec<Result<(), WireReject>> {
        let rx = self.rx.lock().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        let mut out = Vec::new();
        loop {
            let wait = if out.is_empty() { deadline.saturating_duration_since(std::time::Instant::now()) } else { Duration::from_millis(400) };
            let Ok(inbound) = rx.recv_timeout(wait) else { break };
            if let Ok(Opened::Direct(cin)) = self.session.open(&inbound.envelope, &mut self.tracker.lock().unwrap(), now()) {
                out.push(self.direct.on_item(&cin));
            }
        }
        out
    }

    pub fn member(&self) -> String {
        self.session.my_member().unwrap()
    }

    /// Puts an envelope this test built by hand on the team relay (a sender that is not this build).
    pub fn direct_send_for_test(&self, env: &pm_relay_protocol::Envelope) {
        self.transport.send(env).unwrap();
    }

    pub fn device(&self) -> String {
        self.session.my_device().unwrap()
    }

    pub fn received(&self) -> Vec<RecvTask> {
        self.direct.view().received
    }

    pub fn sent(&self) -> Vec<SentTask> {
        self.direct.view().sent
    }
}

pub(super) struct Three {
    pub maya: Side,
    pub leo: Side,
    pub sam: Side,
    pub store: std::path::PathBuf,
}

pub(super) fn side(name: &str, session: Session, transport: &Arc<dyn TeamTransport>, off: bool) -> Side {
    let dir = temp_dir(&format!("tasks-{name}"));
    let lend = Arc::new(FakeLend { off, ..Default::default() });
    let port = Arc::new(TestPort { session: session.clone(), transport: transport.clone(), seq: AtomicU64::new(0) });
    let direct = Direct::new(Deps {
        dir: dir.join("team-tasks"),
        port,
        lend: lend.clone(),
        now: Arc::new(now),
        changed: Arc::new(|| {}),
        spawn: Arc::new(|f| f()),
        pace_ms: 0,
    });
    let rx = Mutex::new(transport.subscribe(0).unwrap());
    Side { direct, session, lend, dir, transport: transport.clone(), rx, tracker: Mutex::new(SeqTracker::default()) }
}

/// The same PC after a restart, with its lend feature as the test says: reads the state the first one saved.
pub(super) fn rebuild(s: &Side, lend: Arc<FakeLend>) -> Arc<Direct> {
    let port = Arc::new(TestPort { session: s.session.clone(), transport: s.transport.clone(), seq: AtomicU64::new(1000) });
    Direct::new(Deps { dir: s.dir.join("team-tasks"), port, lend, now: Arc::new(now), changed: Arc::new(|| {}), spawn: Arc::new(|f| f()), pace_ms: 0 })
}

pub(super) fn three() -> Three {
    let store = temp_dir("tasks-team");
    let t = folder(&store);
    let w = world(&t, &["Leo", "Sam"], now());
    let maya_s = Session::new(w.roster.clone(), w.maya.clone());
    // Everyone has the latest roster (Sam joined after Leo).
    let leo_s = Session::new(maya_s.roster.clone(), w.others[0].1.clone());
    let sam_s = Session::new(maya_s.roster.clone(), w.others[1].1.clone());
    let (maya, leo, sam) = (side("maya", maya_s, &t, false), side("leo", leo_s, &t, false), side("sam", sam_s, &t, false));
    // Nothing old in the inboxes (the team's own setup traffic).
    for s in [&maya, &leo, &sam] {
        while s.rx.lock().unwrap().recv_timeout(Duration::from_millis(300)).is_ok() {}
    }
    Three { maya, leo, sam, store }
}

pub(super) fn input(to: &str, title: &str, text: &str) -> PassInput {
    PassInput { to_member: to.into(), title: title.into(), text: text.into(), summary: String::new(), repo: None, lend: None }
}

#[test]
fn a_task_goes_sealed_to_the_teammate_and_shows_as_plain_data() {
    let t = three();
    let secret_title = "Fix the stable link sheet";
    let secret_text = "The address is cut at 320 px. Please look at the sheet component.";
    let mut pass = input(&t.leo.member(), secret_title, secret_text);
    pass.summary = "We talked about the link sheet.".into();
    let sent = t.maya.direct.pass(pass).unwrap();
    assert_eq!(sent.state, SentState::Sent);
    assert_eq!(sent.to_name, "Leo");
    let arrived = t.leo.pump();
    assert_eq!(arrived, vec![Ok(())]);
    let got = &t.leo.received()[0];
    assert_eq!(got.id, sent.id);
    assert_eq!(got.title, secret_title);
    assert_eq!(got.text, secret_text);
    assert_eq!(got.summary, "We talked about the link sheet.");
    assert_eq!(got.from_name, "Maya");
    assert_eq!(got.state, RecvState::New);
    // The relay holds no readable word of it, in any layer.
    let mut stored = String::new();
    for entry in std::fs::read_dir(t.store.join("envelopes")).unwrap().flatten() {
        stored.push_str(&std::fs::read_to_string(entry.path()).unwrap_or_default());
    }
    assert!(!stored.is_empty());
    assert!(readable_in(&stored, &[secret_title, secret_text, "stable link", "320 px"]).is_empty());
    // Sam is on the team but the item is for Leo's PC: he cannot read it.
    let sam_got = t.sam.pump();
    assert!(sam_got.is_empty() || sam_got.iter().all(|r| *r == Err(WireReject::NotForMe)), "{sam_got:?}");
    assert!(t.sam.received().is_empty());
}

#[test]
fn an_item_re_addressed_or_replayed_is_refused() {
    let t = three();
    let to = t.leo.device();
    let (payload, msg_id) = wire::seal(&t.maya.session, &to, Body::Withdrawn { id: "tk_1".into() }, now()).unwrap();
    let env = t.maya.session.seal(&payload, 1, now()).unwrap();
    let Ok(Opened::Direct(cin)) = t.leo.session.open(&env, &mut SeqTracker::default(), now()) else { panic!("not direct") };
    // Re-addressed to Sam: the sealed info binds the receiver.
    let mut moved = cin.clone();
    moved.to = t.sam.device();
    assert_eq!(wire::open(&t.sam.session, &t.sam.session.keys.device_kem().unwrap(), &moved, now()), Err(WireReject::Undecryptable));
    // Impersonation: the envelope says Sam signed it, the item says Maya.
    let mut liar = cin.clone();
    liar.member = t.sam.member();
    assert_eq!(wire::open(&t.leo.session, &t.leo.session.keys.device_kem().unwrap(), &liar, now()), Err(WireReject::Impersonation));
    // A replay of the same msg id is refused by the guard.
    let mut guard = wire::Guard::default();
    assert!(guard.fresh(&msg_id, now()).is_ok());
    assert_eq!(guard.fresh(&msg_id, now()), Err(WireReject::Replay));
    // Dated ten minutes ahead.
    let (ahead, _) = wire::seal(&t.maya.session, &to, Body::Withdrawn { id: "tk_2".into() }, now() + 11 * 60_000).unwrap();
    let env = t.maya.session.seal(&ahead, 2, now()).unwrap();
    let Ok(Opened::Direct(cin)) = t.leo.session.open(&env, &mut SeqTracker::default(), now()) else { panic!("not direct") };
    assert_eq!(wire::open(&t.leo.session, &t.leo.session.keys.device_kem().unwrap(), &cin, now()), Err(WireReject::Future));
}

#[test]
fn accept_decline_and_the_states_the_sender_sees() {
    let t = three();
    let a = t.maya.direct.pass(input(&t.leo.member(), "One", "Do the first thing")).unwrap();
    let b = t.maya.direct.pass(input(&t.leo.member(), "Two", "Do the second thing")).unwrap();
    t.leo.pump();
    // Looking at it tells Maya "Seen"; it is sent once.
    t.leo.direct.seen(&a.id).unwrap();
    t.maya.pump();
    assert_eq!(t.maya.sent().iter().find(|s| s.id == a.id).unwrap().state, SentState::Seen);
    t.leo.direct.seen(&a.id).unwrap();
    // Accept: Maya sees Accepted. A second answer is refused.
    let accepted = t.leo.direct.accept(&a.id, AcceptInput::default()).unwrap();
    assert_eq!(accepted.state, RecvState::Accepted);
    assert!(t.leo.direct.accept(&a.id, AcceptInput::default()).is_err());
    assert!(t.leo.direct.decline(&a.id).is_err());
    // Decline the other.
    t.leo.direct.decline(&b.id).unwrap();
    t.maya.pump();
    let view = t.maya.sent();
    assert_eq!(view.iter().find(|s| s.id == a.id).unwrap().state, SentState::Accepted);
    assert_eq!(view.iter().find(|s| s.id == b.id).unwrap().state, SentState::Declined);
    // Started, then done with the person's own note (cleaned, cut).
    t.leo.direct.started(&a.id).unwrap();
    t.leo.direct.done(&a.id, "All good.\u{1b}[31m Check the PR.").unwrap();
    t.maya.pump();
    let done = t.maya.sent().into_iter().find(|s| s.id == a.id).unwrap();
    assert_eq!(done.state, SentState::Done);
    assert_eq!(done.note, "All good.[31m Check the PR.");
    // Too late to take it back.
    assert!(t.maya.direct.withdraw(&a.id).is_err());
}

#[test]
fn a_task_taken_back_before_it_starts_is_withdrawn_on_their_side() {
    let t = three();
    let a = t.maya.direct.pass(input(&t.leo.member(), "One", "Do the first thing")).unwrap();
    t.leo.pump();
    assert_eq!(t.leo.received()[0].state, RecvState::New);
    t.maya.direct.withdraw(&a.id).unwrap();
    t.leo.pump();
    assert_eq!(t.leo.received()[0].state, RecvState::Withdrawn);
    assert!(t.leo.direct.accept(&a.id, AcceptInput::default()).is_err());
    assert_eq!(t.maya.sent()[0].state, SentState::Withdrawn);
}

#[test]
fn text_from_a_teammate_is_cleaned_and_never_trusted() {
    let t = three();
    // A sender that is not this build: it seals its own item with control characters, a long title and a risky line.
    let hostile_text = "<img src=x onerror=alert(1)>\u{1b}[2J\u{7}\nrm -rf ~\n**bold**";
    let (payload, _) = wire::seal(
        &t.maya.session,
        &t.leo.device(),
        Body::Task { id: "tk_h1".into(), title: "A\u{0}B\nC".repeat(20), text: hostile_text.into(), summary: "s\u{1b}x".into(), repo: None, lend: None },
        now(),
    )
    .unwrap();
    let env = t.maya.session.seal(&payload, 1, now()).unwrap();
    t.maya.direct_send_for_test(&env);
    t.leo.pump();
    let got = &t.leo.received()[0];
    assert!(!got.text.contains('\u{1b}') && !got.text.contains('\u{7}'));
    assert!(got.text.contains("<img src=x onerror=alert(1)>"), "kept as plain text, not removed: {}", got.text);
    assert!(!got.title.contains('\n') && !got.title.contains('\u{0}'));
    assert!(got.title.chars().count() <= wire::MAX_TITLE_CHARS);
    assert!(!got.summary.contains('\u{1b}'));
    assert!(got.risk.is_some(), "a planted rm -rf line is flagged: {:?}", got.risk);
    // Accepting only records the answer: nothing is started, nothing is run.
    let accepted = t.leo.direct.accept("tk_h1", AcceptInput::default()).unwrap();
    assert_eq!(accepted.state, RecvState::Accepted);
}

#[test]
fn an_item_over_a_limit_is_a_bad_item() {
    let t = three();
    let kem = t.leo.session.keys.device_kem().unwrap();
    let too_big = |body: Body| {
        let (payload, _) = wire::seal(&t.maya.session, &t.leo.device(), body, now()).unwrap();
        let env = t.maya.session.seal(&payload, 1, now()).unwrap();
        let Ok(Opened::Direct(cin)) = t.leo.session.open(&env, &mut SeqTracker::default(), now()) else { panic!("not direct") };
        wire::open(&t.leo.session, &kem, &cin, now())
    };
    let task = |text: String, summary: String| Body::Task { id: "tk_1".into(), title: "t".into(), text, summary, repo: None, lend: None };
    assert!(too_big(task("x".repeat(wire::MAX_TEXT_BYTES), String::new())).is_ok());
    assert_eq!(too_big(task("x".repeat(wire::MAX_TEXT_BYTES + 1), String::new())).unwrap_err(), WireReject::BadItem);
    assert_eq!(too_big(task("x".into(), "y".repeat(wire::MAX_SUMMARY_BYTES + 1))).unwrap_err(), WireReject::BadItem);
    // A task id that could name a file elsewhere.
    assert_eq!(too_big(Body::Withdrawn { id: "..\\..\\x".into() }).unwrap_err(), WireReject::BadItem);
    // A repo offer over the cap, and one with a ref outside the two allowed places.
    let offer = |bytes: u64, git_ref: &str| wire::RepoOffer { name: "r".into(), branch: "main".into(), git_ref: git_ref.into(), history: History::Latest, bytes, sha256: "ab".repeat(32), chunks: super::bundle::chunk_count(bytes) };
    let with_repo = |r| Body::Task { id: "tk_2".into(), title: "t".into(), text: "x".into(), summary: String::new(), repo: Some(r), lend: None };
    assert!(too_big(with_repo(offer(1000, "refs/heads/main"))).is_ok());
    assert_eq!(too_big(with_repo(offer(wire::BUNDLE_CAP_BYTES + 1, "refs/heads/main"))).unwrap_err(), WireReject::BadItem);
    assert_eq!(too_big(with_repo(offer(1000, "refs/remotes/origin/main"))).unwrap_err(), WireReject::BadItem);
    assert_eq!(too_big(with_repo(offer(1000, "refs/heads/../../x"))).unwrap_err(), WireReject::BadItem);
}

#[test]
fn too_long_a_task_and_too_many_open_ones_are_refused_on_the_sender() {
    let t = three();
    let err = t.maya.direct.pass(input(&t.leo.member(), "x", &"y".repeat(wire::MAX_TEXT_BYTES + 1))).unwrap_err();
    assert!(err.contains("too long"), "{err}");
    assert!(t.maya.direct.pass(input(&t.maya.member(), "me", "to myself")).unwrap_err().contains("That is you"));
    assert!(t.maya.direct.pass(input(&t.leo.member(), "empty", "   ")).is_err());
    for n in 0..super::service::MAX_OPEN_PER_PERSON {
        t.maya.direct.pass(input(&t.leo.member(), &format!("t{n}"), "do it")).unwrap();
    }
    let err = t.maya.direct.pass(input(&t.leo.member(), "one too many", "do it")).unwrap_err();
    assert!(err.contains("open tasks"), "{err}");
    // Sam is another pair: not limited by Leo's.
    t.maya.direct.pass(input(&t.sam.member(), "for sam", "do it")).unwrap();
}

#[test]
fn a_flood_from_one_person_is_cut_off_on_the_receiver() {
    let t = three();
    for n in 0..25 {
        let id = format!("tk_f{n}");
        let (payload, _) = wire::seal(&t.maya.session, &t.leo.device(), Body::Task { id, title: "t".into(), text: "x".into(), summary: String::new(), repo: None, lend: None }, now()).unwrap();
        let env = t.maya.session.seal(&payload, n + 1, now()).unwrap();
        t.maya.direct_send_for_test(&env);
    }
    for _ in 0..4 {
        t.leo.pump();
    }
    assert_eq!(t.leo.received().len(), 20);
}

// ------------------------------------------------------------------------------------------------- lent usage

#[test]
fn the_lend_offer_is_words_and_numbers_only_and_the_request_names_the_task() {
    let t = three();
    let mut pass = input(&t.leo.member(), "Use my Claude", "Please check the build");
    pass.lend = Some(LendInput { profile_id: "lp_work".into(), secs: 3600 });
    let sent = t.maya.direct.pass(pass).unwrap();
    let offer = sent.lend.clone().unwrap();
    assert_eq!((offer.profile_name.as_str(), offer.agent_id.as_str(), offer.secs), ("Work account", "claude", 3600));
    // Whatever is in a lend offer, it has these four fields and nothing else.
    let json = serde_json::to_value(&offer).unwrap();
    let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["agentId", "profileId", "profileName", "secs"]);
    // No variant of any item has a place for a login: every field name is checked.
    for body in [
        serde_json::to_value(Body::Task { id: "a".into(), title: "t".into(), text: "x".into(), summary: String::new(), repo: None, lend: Some(offer.clone()) }).unwrap(),
        serde_json::to_value(Body::Reply { id: "a".into(), state: wire::ReplyState::Accepted, want_repo: true, note: String::new() }).unwrap(),
        serde_json::to_value(Body::Withdrawn { id: "a".into() }).unwrap(),
        serde_json::to_value(Body::Chunk { id: "a".into(), idx: 0, data: String::new() }).unwrap(),
    ] {
        let text = body.to_string().to_lowercase();
        for word in ["token", "secret", "password", "cookie", "credential", "apikey", "api_key", "auth", "login"] {
            assert!(!text.contains(word), "{word} in {text}");
        }
    }
    // The receiver says yes with their usage: the normal lend request goes to Maya's PC, naming the task.
    t.leo.pump();
    let accepted = t.leo.direct.accept(&sent.id, AcceptInput { usage: Usage::Lent, ..Default::default() }).unwrap();
    assert_eq!(accepted.usage, Usage::Lent);
    let calls = t.leo.lend.requests.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!((calls[0].0.as_str(), calls[0].1.as_str(), calls[0].4.as_str()), (t.maya.member().as_str(), t.maya.device().as_str(), sent.id.as_str()));
    assert_eq!(calls[0].2, offer);
    assert!(calls[0].3.starts_with("For a task:"));
}

#[test]
fn lent_usage_needs_the_lend_feature_on_both_sides_and_a_real_offer() {
    let t = three();
    // Lend is off on the sender: a lend offer is refused.
    let off = rebuild(&t.maya, Arc::new(FakeLend { off: true, ..Default::default() }));
    let mut pass = input(&t.leo.member(), "x", "y");
    pass.lend = Some(LendInput { profile_id: "lp_work".into(), secs: 3600 });
    assert!(off.pass(pass.clone()).unwrap_err().contains("off"));
    // A profile that is gone, or longer than the profile allows.
    pass.lend = Some(LendInput { profile_id: "lp_nope".into(), secs: 3600 });
    assert!(t.maya.direct.pass(pass.clone()).is_err());
    pass.lend = Some(LendInput { profile_id: "lp_work".into(), secs: 9 * 3600 });
    assert!(t.maya.direct.pass(pass).is_err());
    // A task without a lend offer cannot be accepted "with lent usage".
    let sent = t.maya.direct.pass(input(&t.leo.member(), "plain", "no lend")).unwrap();
    t.leo.pump();
    assert!(t.leo.direct.accept(&sent.id, AcceptInput { usage: Usage::Lent, ..Default::default() }).unwrap_err().contains("lent usage"));
    // Lend off on the receiver: the answer is refused before anything is sent.
    let mut with_lend = input(&t.leo.member(), "with lend", "x");
    with_lend.lend = Some(LendInput { profile_id: "lp_work".into(), secs: 600 });
    let sent = t.maya.direct.pass(with_lend).unwrap();
    t.leo.pump();
    let leo_off = rebuild(&t.leo, Arc::new(FakeLend { off: true, ..Default::default() }));
    assert!(leo_off.accept(&sent.id, AcceptInput { usage: Usage::Lent, ..Default::default() }).unwrap_err().contains("off"));
}

#[test]
fn a_failed_lend_request_leaves_the_task_accepted_with_a_plain_sentence() {
    let t = three();
    let mut pass = input(&t.leo.member(), "x", "y");
    pass.lend = Some(LendInput { profile_id: "lp_work".into(), secs: 600 });
    let sent = t.maya.direct.pass(pass).unwrap();
    t.leo.pump();
    let leo2 = rebuild(&t.leo, Arc::new(FakeLend { fail_request: true, ..Default::default() }));
    let got = leo2.accept(&sent.id, AcceptInput { usage: Usage::Lent, ..Default::default() }).unwrap();
    assert_eq!(got.state, RecvState::Accepted);
    assert!(got.lend_error.contains("not answering"));
    // "Use my own agent instead" works once, on the same task.
    let own = leo2.accept(&sent.id, AcceptInput::default()).unwrap();
    assert_eq!((own.usage, own.lend_error.as_str(), own.state), (Usage::Theirs, "", RecvState::Accepted));
    assert!(leo2.accept(&sent.id, AcceptInput::default()).is_err());
}

// ------------------------------------------------------------------------------------------------- repo hand-over

fn git(dir: &std::path::Path, args: &[&str]) {
    let out = crate::team::git::raw(dir, args).unwrap();
    assert!(out.ok, "git {args:?}: {}", out.stderr);
}

/// A small repo with one branch and a few files (some bigger than one piece).
pub(super) fn small_repo(name: &str, big_bytes: usize) -> std::path::PathBuf {
    let dir = temp_dir(name).join("potato-site");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Maya"]);
    git(&dir, &["config", "user.email", "maya@example.invalid"]);
    std::fs::write(dir.join("README.md"), "# site\n").unwrap();
    if big_bytes > 0 {
        // Not compressible: the copy really is this big.
        let mut x = 0x9E37_79B9u32;
        let bytes: Vec<u8> = (0..big_bytes)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        std::fs::write(dir.join("data.bin"), bytes).unwrap();
    }
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "first"]);
    std::fs::write(dir.join("two.txt"), "second\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "second"]);
    dir
}

#[test]
fn a_repo_goes_over_the_relay_in_pieces_and_unpacks_into_a_new_folder() {
    let t = three();
    let repo = small_repo("tasks-repo", 40_000);
    t.maya.direct.set_handover(true);
    t.leo.direct.set_handover(true);
    let mut pass = input(&t.leo.member(), "Look at the site", "See the repo");
    pass.repo = Some(RepoInput { path: repo.to_string_lossy().to_string(), history: History::Latest, understood: true });
    let sent = t.maya.direct.pass(pass).unwrap();
    let offer = sent.repo.clone().unwrap();
    assert!(offer.chunks >= 5, "more than one piece: {}", offer.chunks);
    assert_eq!(sent.repo_state, SendRepo::Waiting);
    t.leo.pump();
    let got = &t.leo.received()[0];
    assert_eq!(got.repo_state, RecvRepo::Offered);
    // No piece moves until they say yes.
    assert_eq!(t.maya.sent()[0].repo_sent, 0);
    // They say yes: the pieces stream (inline in tests), the receiver puts them together and checks them.
    t.leo.direct.accept(&sent.id, AcceptInput { want_repo: true, understood: true, ..Default::default() }).unwrap();
    t.maya.pump();
    assert_eq!(t.maya.sent()[0].repo_state, SendRepo::Sent);
    for _ in 0..3 {
        t.leo.pump();
        if t.leo.received()[0].repo_state == RecvRepo::Ready {
            break;
        }
    }
    let got = t.leo.received()[0].clone();
    assert_eq!(got.repo_state, RecvRepo::Ready, "{}", got.repo_error);
    assert_eq!(got.repo_got, offer.chunks);
    // The person picks a place; the copy lands in a NEW folder, files in place, only the latest commit.
    let parent = temp_dir("tasks-unpack");
    let folder_path = t.leo.direct.unpack(&sent.id, &parent).unwrap();
    let folder_path = std::path::PathBuf::from(folder_path);
    assert_eq!(folder_path, parent.join("potato-site"));
    assert_eq!(std::fs::read_to_string(folder_path.join("README.md")).unwrap(), "# site\n");
    assert_eq!(std::fs::read(folder_path.join("data.bin")).unwrap().len(), 40_000);
    let log = crate::team::git::run(&folder_path, &["log", "--oneline"]).unwrap();
    assert_eq!(log.lines().count(), 1, "only the latest files: {log}");
    assert_eq!(t.leo.received()[0].repo_state, RecvRepo::Unpacked);
    // The source repo was only read: still on main, no leftover temporary ref.
    assert_eq!(crate::team::git::current_branch(&repo).as_deref(), Some("main"));
    assert!(crate::team::git::run(&repo, &["for-each-ref", "refs/potato-handover"]).unwrap().is_empty());
    // The screen never sees where the bundle sits.
    let shown = serde_json::to_string(&t.leo.direct.view()).unwrap();
    assert!(!shown.contains(".bundle") && !shown.contains(".part"));
}

#[test]
fn the_repo_needs_the_switch_the_warning_and_a_yes_on_both_sides() {
    let t = three();
    let repo = small_repo("tasks-repo-gates", 0);
    let mut pass = input(&t.leo.member(), "x", "y");
    pass.repo = Some(RepoInput { path: repo.to_string_lossy().to_string(), history: History::Latest, understood: true });
    assert!(t.maya.direct.pass(pass.clone()).unwrap_err().contains("hand-over"), "switch off");
    t.maya.direct.set_handover(true);
    pass.repo.as_mut().unwrap().understood = false;
    assert!(t.maya.direct.pass(pass.clone()).unwrap_err().contains("understand"));
    pass.repo.as_mut().unwrap().understood = true;
    let sent = t.maya.direct.pass(pass).unwrap();
    t.leo.pump();
    // The receiver: switch off, no warning ticked.
    let no_switch = t.leo.direct.accept(&sent.id, AcceptInput { want_repo: true, understood: true, ..Default::default() }).unwrap_err();
    assert!(no_switch.contains("hand-over"), "{no_switch}");
    t.leo.direct.set_handover(true);
    let no_tick = t.leo.direct.accept(&sent.id, AcceptInput { want_repo: true, understood: false, ..Default::default() }).unwrap_err();
    assert!(no_tick.contains("understand"), "{no_tick}");
    // Without the repo, the words still work.
    let ok = t.leo.direct.accept(&sent.id, AcceptInput::default()).unwrap();
    assert_eq!(ok.repo_state, RecvRepo::Offered);
    t.maya.pump();
    assert_eq!(t.maya.sent()[0].repo_state, SendRepo::Waiting, "no piece without a yes");
}

#[test]
fn a_piece_nobody_asked_for_or_from_the_wrong_person_is_dropped() {
    let t = three();
    let sent = t.maya.direct.pass(input(&t.leo.member(), "plain", "no repo")).unwrap();
    t.leo.pump();
    let piece = |from: &Side, id: &str, idx: u32, seq: u64| {
        let (payload, _) = wire::seal(&from.session, &t.leo.device(), Body::Chunk { id: id.into(), idx, data: crate::secure_core::crypto::b64(&[1u8; 16]) }, now()).unwrap();
        let env = from.session.seal(&payload, seq, now()).unwrap();
        from.direct_send_for_test(&env);
    };
    piece(&t.maya, &sent.id, 0, 50);
    piece(&t.sam, &sent.id, 0, 51);
    piece(&t.maya, "tk_unknown", 0, 52);
    let results = t.leo.pump();
    assert!(!results.is_empty() && results.iter().all(|r| *r == Err(WireReject::BadItem)), "{results:?}");
    assert_eq!(t.leo.received()[0].repo_state, RecvRepo::None);
}

#[test]
fn a_tampered_copy_is_refused_when_it_does_not_match_its_checksum() {
    let t = three();
    let repo = small_repo("tasks-repo-bad", 20_000);
    t.maya.direct.set_handover(true);
    t.leo.direct.set_handover(true);
    let mut pass = input(&t.leo.member(), "x", "y");
    pass.repo = Some(RepoInput { path: repo.to_string_lossy().to_string(), history: History::Latest, understood: true });
    let sent = t.maya.direct.pass(pass).unwrap();
    // Flip a byte in the bundle on Maya's PC after the offer was made: the pieces then do not match the checksum.
    let bundle = t.maya.dir.join("team-tasks").join("out").join(format!("{}.bundle", sent.id));
    let mut bytes = std::fs::read(&bundle).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xFF;
    std::fs::write(&bundle, bytes).unwrap();
    t.leo.pump();
    t.leo.direct.accept(&sent.id, AcceptInput { want_repo: true, understood: true, ..Default::default() }).unwrap();
    t.maya.pump();
    for _ in 0..3 {
        t.leo.pump();
        if t.leo.received()[0].repo_state == RecvRepo::Failed {
            break;
        }
    }
    let got = &t.leo.received()[0];
    assert_eq!(got.repo_state, RecvRepo::Failed);
    assert!(got.repo_error.contains("whole"), "{}", got.repo_error);
    assert!(t.leo.direct.unpack(&sent.id, &temp_dir("tasks-unpack-bad")).is_err());
}

#[test]
fn taking_a_task_back_stops_the_pieces_and_removes_the_copy() {
    let t = three();
    let repo = small_repo("tasks-repo-back", 0);
    t.maya.direct.set_handover(true);
    let mut pass = input(&t.leo.member(), "x", "y");
    pass.repo = Some(RepoInput { path: repo.to_string_lossy().to_string(), history: History::Full, understood: true });
    let sent = t.maya.direct.pass(pass).unwrap();
    let bundle = t.maya.dir.join("team-tasks").join("out").join(format!("{}.bundle", sent.id));
    assert!(bundle.exists());
    t.maya.direct.withdraw(&sent.id).unwrap();
    assert!(!bundle.exists(), "the copy is not kept after the task is taken back");
    assert_eq!(t.maya.sent()[0].repo_state, SendRepo::Failed);
}

// ------------------------------------------------------------------------------------------------- the risk words

#[test]
fn a_planted_risky_line_is_flagged_and_plain_words_are_not() {
    assert!(super::service::risk_words("Please run:\n$ rm -rf ~\nthen tell me").is_some());
    assert!(super::service::risk_words("The address is cut at 320 px on the link sheet.").is_none());
}
