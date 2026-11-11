//! War Room (multiplayer step 2): `pr_opened`, `pushed` and `ci_failed` from recorded-shape `gh`
//! output (`fixtures/gh/`, no network), the dedupe of the instant and catch-up paths, and claims.

use super::config::{Member, TeamConfig};
use super::event::*;
use super::secure::Verified;
use super::service::build_push_event;
use super::sources::git_refs::RepoWatch;
use super::sources::github::{self, CiState, Fact, Gh, GhResponse, RepoPoll};
use super::store::{earliest_claim, ingest, CardState, CiClaim, Ingested, TeamStore};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::process::Command;

const NOW: u64 = 1_760_000_000_000;
const KEY: &str = "github.com/potato-workspace/app";
const RED: &str = "1111111111111111111111111111111111111111";
const HEAD: &str = "3333333333333333333333333333333333333333";

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/team/fixtures/gh").join(name);
    std::fs::read_to_string(path).unwrap().replace("\r\n", "\n")
}

fn body(name: &str) -> String {
    github::parse_include(&fixture(name)).unwrap().body
}

fn config() -> TeamConfig {
    TeamConfig {
        enabled: true,
        team: "acme".into(),
        folder: "unused".into(),
        me: Member { id: "me-id".into(), name: "Me".into() },
        device: "me-device".into(),
        root: "root".into(),
        ..TeamConfig::default()
    }
}

/// A teammate's event, as `secure::Session::open` would hand it over.
fn teammate(member: &str, kind: TeamEventKind, subject: Subject, at: u64) -> Verified {
    let display = member.trim_end_matches("-id");
    let mut name = display.to_string();
    name[..1].make_ascii_uppercase();
    Verified::for_test(TeamEvent {
        v: SCHEMA_VERSION,
        id: new_event_id(at),
        team: "acme".into(),
        project: ProjectRef { key: KEY.into(), name: "app".into() },
        actor: Actor { member: member.into(), device: format!("{member}-laptop"), display: name, agent: None },
        kind,
        at_ms: at,
        dedupe_key: String::new(),
        subject,
        note: None,
        to: Vec::new(),
        tier_hint: Tier::Ambient,
        expires_at_ms: at + DEFAULT_TTL_MS,
        source: EventSource::Pm,
    })
}

/// A fact my own `gh` found, made into its card event.
fn fact(fact: &Fact, at: u64) -> Verified {
    let mut event = github::fact_event(KEY, fact, None, at);
    event.team = "acme".into();
    Verified::local_fact(event).unwrap()
}

fn main_push(sha: &str) -> Subject {
    Subject { branch: Some("main".into()), commit: Some(sha.into()), commits: Some(2), ..Subject::default() }
}

/// Answers from the fixtures; `phase` 0 is the first look, 1 the next one.
struct ScriptedGh {
    phase: Mutex<u8>,
    calls: Mutex<Vec<String>>,
}

impl Gh for ScriptedGh {
    fn api(&self, path: &str, _etag: Option<&str>) -> Result<GhResponse, String> {
        self.calls.lock().push(path.to_string());
        let late = *self.phase.lock() > 0;
        let name = if path == "repos/potato-workspace/app" {
            "repo-app.txt"
        } else if path == "repos/potato-workspace/app/pulls/482" {
            "pull-482.txt"
        } else if path.contains("/pulls?") {
            if late { "pulls-app-1.txt" } else { "pulls-app-0.txt" }
        } else if path.contains("/check-runs") {
            "checks-passed.txt"
        } else if path.contains("/commits?sha=main") {
            if late { "commits-main-2.txt" } else { "commits-main-1.txt" }
        } else if path.contains("/actions/runs?branch=main") {
            if late { "runs-main-passed.txt" } else { "runs-main-failed.txt" }
        } else {
            return Err(format!("unexpected call {path}"));
        };
        Ok(github::parse_include(&fixture(name)).unwrap())
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        Err(format!("the poller only reads: {args:?}"))
    }
}

// --------------------------------------------------------------------- events from gh JSON

#[test]
fn default_branch_pushes_and_ci_from_gh_json() {
    assert_eq!(github::parse_default_branch(&body("repo-app.txt")).as_deref(), Some("main"));

    let first = github::parse_commits(&body("commits-main-1.txt"));
    let next = github::parse_commits(&body("commits-main-2.txt"));
    assert_eq!(first[0].subject, "Release 1.0.15", "the subject line only");
    assert_eq!(github::push_fact(None, "main", &next), None, "the first look is a baseline");
    assert_eq!(github::push_fact(Some(HEAD), "main", &next), None, "nothing new");
    let Some(Fact::Pushed(push)) = github::push_fact(Some(RED), "main", &next) else { panic!("a push") };
    assert_eq!((push.commits, push.head_sha.as_str(), push.author.as_str()), (2, HEAD, "kai-dev"));
    assert_eq!(push.first_commit, "Relay: keep the cursor across reconnects", "the oldest new commit");

    let (sha, state, ci) = github::runs_state(&body("runs-main-failed.txt")).unwrap();
    assert_eq!((sha.as_str(), state), (RED, CiState::Failed), "the newest commit's runs only");
    assert_eq!(ci.failed_jobs, vec!["CI".to_string()], "the workflow name");
    assert_eq!(ci.url, "https://github.com/potato-workspace/app/actions/runs/9001");
    let (sha, state, _) = github::runs_state(&body("runs-main-passed.txt")).unwrap();
    assert_eq!((sha.as_str(), state), (HEAD, CiState::Passed));

    // Red is announced on the first look (a returning teammate must see it), once per commit, and
    // green only after red.
    let mut red_sha = None;
    let red = github::default_ci_fact(&mut red_sha, "main", RED, CiState::Failed, ci.clone()).expect("red on the first look");
    assert!(github::default_ci_fact(&mut red_sha, "main", RED, CiState::Failed, ci.clone()).is_none(), "once per red commit");
    assert!(github::default_ci_fact(&mut red_sha, "main", HEAD, CiState::Pending, ci.clone()).is_none());
    assert!(matches!(github::default_ci_fact(&mut red_sha, "main", HEAD, CiState::Passed, ci.clone()), Some(Fact::DefaultCi { failed: false, .. })));
    assert!(github::default_ci_fact(&mut red_sha, "main", HEAD, CiState::Passed, ci.clone()).is_none(), "no green card without red");

    // As events: what the cards show, and they pass the inbound checks.
    let mut red_event = github::fact_event(KEY, &red, None, NOW);
    red_event.team = "acme".into();
    assert_eq!(red_event.kind, TeamEventKind::CiFailed);
    assert_eq!(red_event.subject.commit.as_deref(), Some(RED));
    assert_eq!(red_event.subject.ci.as_ref().unwrap().failed_jobs, vec!["CI".to_string()]);
    assert!(red_event.subject.pr.is_none(), "a default branch, not a PR: the banner");
    assert_eq!(war_room_id(&red_event).as_deref(), Some(&*format!("{KEY}:ci_failed:{RED}")));
    let mut push_event = github::fact_event(KEY, &Fact::Pushed(push), None, NOW);
    push_event.team = "acme".into();
    assert_eq!(push_event.subject.commits, Some(2));
    assert_eq!(push_event.actor.display, "kai-dev");
    assert!(validate_inbound(red_event, NOW).is_ok());
    assert!(validate_inbound(push_event, NOW).is_ok());
    assert_eq!(github::backoff_ms(0), 60_000);
    assert_eq!(github::backoff_ms(2), 240_000);
    assert_eq!(github::backoff_ms(30), 15 * 60 * 1000);
}

#[test]
fn the_catch_up_poll_finds_a_red_main_a_new_pr_and_a_push() {
    let gh = ScriptedGh { phase: Mutex::new(0), calls: Mutex::new(Vec::new()) };
    let mut state = RepoPoll::default();
    let first = github::poll_repo(&gh, "potato-workspace/app", &mut state, NOW).unwrap();
    assert!(matches!(&first[..], [Fact::DefaultCi { failed: true, sha, .. }] if sha == RED), "{first:?}");

    *gh.phase.lock() = 1;
    let next = github::poll_repo(&gh, "potato-workspace/app", &mut state, NOW + 60_000).unwrap();
    let Some(Fact::PrOpened(pr)) = next.iter().find(|f| matches!(f, Fact::PrOpened(_))) else { panic!("{next:?}") };
    assert_eq!(pr.stats, Some(DiffStat { files: 14, additions: 612, deletions: 88 }), "from GET pulls/482");
    assert_eq!(pr.ci.as_ref().unwrap().conclusion, "success");
    let opened = github::fact_event(KEY, &Fact::PrOpened(pr.clone()), None, NOW);
    let card_pr = opened.subject.pr.as_ref().unwrap();
    assert_eq!((card_pr.files, card_pr.additions, card_pr.deletions), (Some(14), Some(612), Some(88)));
    assert_eq!((opened.subject.branch.as_deref(), opened.subject.base.as_deref()), (Some("feat/relay-rooms"), Some("main")));
    assert!(next.iter().any(|f| matches!(f, Fact::Pushed(p) if p.head_sha == HEAD && p.commits == 2)));
    assert!(next.iter().any(|f| matches!(f, Fact::DefaultCi { failed: false, .. })), "main is green again");
    let calls = gh.calls.lock().clone();
    assert_eq!(calls.iter().filter(|c| *c == "repos/potato-workspace/app").count(), 1, "the default branch is read once");
}

// ------------------------------------------------------------------------------------ dedupe

#[test]
fn the_instant_and_catch_up_paths_make_one_card() {
    let config = config();
    let push = Fact::Pushed(github::DefaultPush {
        branch: "main".into(),
        head_sha: HEAD.into(),
        commits: 2,
        first_commit: "Relay: keep the cursor across reconnects".into(),
        author: "kai-dev".into(),
    });

    // Kai's app told the team first; my poll then sees the same push on GitHub.
    let mut store = TeamStore::default();
    assert!(matches!(ingest(&mut store, &config, teammate("kai-id", TeamEventKind::Pushed, main_push(HEAD), NOW), NOW), Ingested::Card(_)));
    assert!(matches!(ingest(&mut store, &config, fact(&push, NOW + 1), NOW + 1), Ingested::Card(_)), "GitHub's fact lands on the same card");
    assert_eq!(store.cards.len(), 1);
    // The same push again (a second envelope, a later poll): nothing new.
    let again = ingest(&mut store, &config, teammate("kai-id", TeamEventKind::Pushed, main_push(HEAD), NOW + 2), NOW + 2);
    assert_eq!(again, Ingested::Ignored("already shown"));
    assert_eq!(ingest(&mut store, &config, fact(&push, NOW + 3), NOW + 3), Ingested::Ignored("already shown"));
    assert_eq!(store.cards.len(), 1);

    // The other order: my poll first, Kai's envelope after.
    let mut store = TeamStore::default();
    assert!(matches!(ingest(&mut store, &config, fact(&push, NOW), NOW), Ingested::Card(_)));
    assert_eq!(ingest(&mut store, &config, teammate("kai-id", TeamEventKind::Pushed, main_push(HEAD), NOW + 1), NOW + 1), Ingested::Ignored("already shown"));
    assert_eq!(store.cards.len(), 1);

    // A PR: Kai's intent, then GitHub's fact, then a duplicate envelope.
    let pr = PrRef { number: 482, title: "Relay rooms".into(), url: String::new(), state: "open".into(), draft: false, files: None, additions: None, deletions: None };
    let subject = Subject { branch: Some("feat/relay-rooms".into()), pr: Some(pr), ..Subject::default() };
    let mut store = TeamStore::default();
    assert!(matches!(ingest(&mut store, &config, teammate("kai-id", TeamEventKind::PrOpened, subject.clone(), NOW), NOW), Ingested::Card(_)));
    assert_eq!(ingest(&mut store, &config, teammate("kai-id", TeamEventKind::PrOpened, subject, NOW + 1), NOW + 1), Ingested::Ignored("already shown"));
    assert_eq!(store.cards.len(), 1);
}

#[test]
fn the_same_war_room_event_is_sent_once() {
    let mut store = TeamStore::default();
    let event = |sha: &str| teammate("me-id", TeamEventKind::Pushed, main_push(sha), NOW).into_event();
    assert!(store.mark_sent(&event(HEAD), NOW));
    assert!(!store.mark_sent(&event(HEAD), NOW + 5), "same repo, kind and commit");
    assert!(store.mark_sent(&event(RED), NOW + 5), "another commit");
    let note = Subject { branch: Some("main".into()), ..Subject::default() };
    let other = teammate("me-id", TeamEventKind::Note, note, NOW).into_event();
    assert!(store.mark_sent(&other, NOW) && store.mark_sent(&other, NOW), "not a War Room event: no dedupe");
    assert!(store.mark_sent(&event(HEAD), NOW + DEFAULT_TTL_MS + 1), "forgotten once the event expired");
}

// ------------------------------------------------------------------------------------ claims

fn red_card(store: &mut TeamStore, config: &TeamConfig) -> String {
    let ci = CiRef { conclusion: "failure".into(), failed_jobs: vec!["CI".into()], url: String::new() };
    let red = Fact::DefaultCi { failed: true, branch: "main".into(), sha: RED.into(), ci };
    match ingest(store, config, fact(&red, NOW), NOW) {
        Ingested::Card(id) => id,
        other => panic!("{other:?}"),
    }
}

fn claim() -> Subject {
    Subject { branch: Some("main".into()), commit: Some(RED.into()), ..Subject::default() }
}

#[test]
fn the_earliest_claim_wins_whatever_order_it_arrives_in() {
    let kai = CiClaim { member: "kai-id".into(), display: "Kai".into(), at_ms: NOW + 10, mine: false };
    let leo = CiClaim { member: "leo-id".into(), display: "Leo".into(), at_ms: NOW + 5, mine: false };
    assert_eq!(earliest_claim(Some(&kai), leo.clone()), leo);
    assert_eq!(earliest_claim(Some(&leo), kai.clone()), leo);
    let tie = CiClaim { at_ms: NOW + 5, ..kai.clone() };
    assert_eq!(earliest_claim(Some(&tie), leo.clone()).member, "kai-id", "a tie goes to the smaller member id");
    assert_eq!(earliest_claim(Some(&leo), tie).member, "kai-id");

    let config = config();
    let mut store = TeamStore::default();
    let card = red_card(&mut store, &config);
    // Kai's envelope arrives first, but Leo clicked earlier.
    let kai_claim = teammate("kai-id", TeamEventKind::CiClaimed, claim(), NOW + 10);
    assert_eq!(ingest(&mut store, &config, kai_claim, NOW + 20), Ingested::Card(card.clone()));
    assert_eq!(store.card(&card).unwrap().claim.as_ref().unwrap().display, "Kai");
    let leo_claim = teammate("leo-id", TeamEventKind::CiClaimed, claim(), NOW + 5);
    assert_eq!(ingest(&mut store, &config, leo_claim, NOW + 21), Ingested::Card(card.clone()));
    let held = store.card(&card).unwrap().claim.clone().unwrap();
    assert_eq!((held.display.as_str(), held.mine), ("Leo", false));

    // Only the claimant releases.
    let kai_release = teammate("kai-id", TeamEventKind::CiReleased, claim(), NOW + 30);
    assert_eq!(ingest(&mut store, &config, kai_release, NOW + 30), Ingested::Ignored("no red card to claim"));
    assert!(store.card(&card).unwrap().claim.is_some());
    let leo_release = teammate("leo-id", TeamEventKind::CiReleased, claim(), NOW + 31);
    assert_eq!(ingest(&mut store, &config, leo_release, NOW + 31), Ingested::Card(card.clone()));
    assert!(store.card(&card).unwrap().claim.is_none());

    // My other computer's claim is mine.
    let mine = teammate("me-id", TeamEventKind::CiClaimed, claim(), NOW + 40);
    assert!(matches!(ingest(&mut store, &config, mine, NOW + 40), Ingested::Card(_)));
    assert!(store.card(&card).unwrap().claim.as_ref().unwrap().mine);
}

#[test]
fn the_banner_clears_on_a_later_push_or_green_ci() {
    let config = config();
    let mut store = TeamStore::default();
    let card = red_card(&mut store, &config);
    let kai_claim = teammate("kai-id", TeamEventKind::CiClaimed, claim(), NOW + 1);
    ingest(&mut store, &config, kai_claim, NOW + 1);

    // An older push of the red commit itself doesn't clear it; a later push does.
    ingest(&mut store, &config, teammate("leo-id", TeamEventKind::Pushed, main_push(RED), NOW - 1), NOW + 2);
    assert_eq!(store.card(&card).unwrap().state, CardState::New);
    ingest(&mut store, &config, teammate("kai-id", TeamEventKind::Pushed, main_push(HEAD), NOW + 3), NOW + 3);
    let red = store.card(&card).unwrap();
    assert_eq!(red.state, CardState::Dismissed);
    assert!(red.claim.is_none());

    // Green after red: the same card, now "checks passed", with nobody on it.
    let mut store = TeamStore::default();
    let card = red_card(&mut store, &config);
    ingest(&mut store, &config, teammate("kai-id", TeamEventKind::CiClaimed, claim(), NOW + 1), NOW + 1);
    let ci = CiRef { conclusion: "success".into(), failed_jobs: Vec::new(), url: String::new() };
    let green = Fact::DefaultCi { failed: false, branch: "main".into(), sha: HEAD.into(), ci };
    assert!(matches!(ingest(&mut store, &config, fact(&green, NOW + 5), NOW + 5), Ingested::Card(_)));
    assert_eq!(store.cards.len(), 1);
    let now_green = &store.cards[0];
    assert_ne!(now_green.id, card, "updated in place under a new id");
    assert_eq!(now_green.event.kind, TeamEventKind::CiPassed);
    assert!(now_green.claim.is_none());

    // A claim never comes from GitHub, and a teammate can't send GitHub's red.
    let spoof = teammate("kai-id", TeamEventKind::CiFailed, main_push(RED), NOW + 6);
    assert!(spoof.event().kind.is_github_fact(), "secure::Session::open refuses it before ingest");
}

#[test]
fn reserved_capacity_names_parse_and_are_never_shown() {
    for name in ["capacity.request", "capacity.offer", "capacity.grant", "capacity.revoke", "session.transfer"] {
        let kind: TeamEventKind = serde_json::from_value(serde_json::json!(name)).unwrap();
        assert_ne!(kind, TeamEventKind::Unknown, "{name} is reserved");
        assert_eq!(kind.as_str(), name);
        assert!(!kind.shown_as_card());
    }
    let claimed: TeamEventKind = serde_json::from_value(serde_json::json!("ci_claimed")).unwrap();
    assert_eq!(claimed, TeamEventKind::CiClaimed);
}

// ------------------------------------------------------------------------------ instant path

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn my_push_to_main_carries_its_commits_and_a_feature_push_does_not() {
    let root = std::env::temp_dir().join(format!("pmwar-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::create_dir_all(&root).unwrap();
    let origin = root.join("origin.git");
    git(&root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    let me = root.join("me");
    git(&root, &["clone", "-q", origin.to_str().unwrap(), me.to_str().unwrap()]);
    for (k, v) in [("user.name", "Me"), ("user.email", "me@example.com"), ("commit.gpgsign", "false")] {
        git(&me, &["config", k, v]);
    }
    git(&me, &["checkout", "-q", "-b", "main"]);
    let commit = |msg: &str| {
        std::fs::write(me.join("f.txt"), msg).unwrap();
        git(&me, &["add", "-A"]);
        git(&me, &["commit", "-q", "-m", msg]);
    };
    commit("first");
    git(&me, &["push", "-q", "-u", "origin", "main"]);
    git(&me, &["remote", "set-head", "origin", "main"]);

    let mut watch = RepoWatch::open(&me).unwrap();
    commit("Relay: keep the cursor");
    commit("Relay: retry the socket");
    git(&me, &["push", "-q", "origin", "main"]);
    let pushes = watch.poll();
    assert_eq!(pushes.len(), 1);
    let push = &pushes[0];
    assert!(push.default_branch);
    assert_eq!(push.commits, Some(2));
    assert_eq!(push.first_commit.as_deref(), Some("Relay: keep the cursor"));
    let event = build_push_event(&config(), KEY, push, None, NOW);
    assert_eq!((event.subject.commits, event.subject.first_commit.as_deref()), (Some(2), Some("Relay: keep the cursor")));
    assert!(war_room_id(&event).is_some());

    git(&me, &["checkout", "-q", "-b", "feat/x"]);
    commit("feature work");
    git(&me, &["push", "-q", "origin", "feat/x"]);
    let pushes = watch.poll();
    assert_eq!(pushes.len(), 1);
    assert!(!pushes[0].default_branch, "a feature branch stays a Tell the team? draft");
    assert_eq!(pushes[0].commits, None);
    let _ = std::fs::remove_dir_all(&root);
}
