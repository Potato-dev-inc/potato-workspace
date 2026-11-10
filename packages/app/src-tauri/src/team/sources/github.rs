//! GitHub facts (COWORK-PLAN §2.2 source 2): pull requests opened, merged or closed, and CI going
//! red or green, learned by each member's own app from GitHub through their own `gh` login. Puppet
//! Master holds no GitHub secret, and a member sees only what their account can see.
//!
//! - **Conditional requests:** every poll sends `If-None-Match` with the last ETag. GitHub answers
//!   304 for "nothing changed", which does not count against the rate limit; `X-Poll-Interval` is
//!   honoured.
//! - **Facts never travel through the relay.** Every member learns them from GitHub; they become
//!   local cards (`secure::Verified::local_fact`) with the same card UI as a teammate's events, and
//!   a teammate's envelope that claims to be a GitHub fact is refused.
//! - **Baseline first:** the first look at a repository records its state and announces nothing.
//! - The mapping (`diff_pulls`, `ci_state`, `fact_event`) is pure and tested with recorded `gh`
//!   output (`team/fixtures/gh/`).
//! - **War Room catch-up:** the default branch (main/master) is watched too: new commits on it
//!   become `pushed`, and a failed Actions run on its newest commit becomes `ci_failed` (the Inbox
//!   banner). Unlike other facts, a red default branch is announced on the first look as well: it is
//!   a state, and a teammate who was offline must still see it. Failed polls back off
//!   ([`backoff_ms`]).
//! - TODO(war-room): GitHub webhooks to the team's Worker would make the catch-up path instant. Out
//!   of scope for now (the Worker can't read events, so it would need its own sealed fact format).

use crate::team::event::{self, Actor, CiRef, DiffStat, EventSource, PrRef, ProjectRef, Subject, TeamEvent, TeamEventKind, Tier};
use crate::team::roster::Roster;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::process::{Command, Stdio};

/// Default seconds between polls of one repository (GitHub may ask for more).
pub const DEFAULT_POLL_S: u64 = 60;

/// One `gh api --include` answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub poll_interval_s: Option<u64>,
    pub body: String,
}

/// Parse `gh api --include` output: the status line, headers, a blank line, the body. `gh` exits
/// non-zero on a 304, so the exit code is not used.
pub fn parse_include(output: &str) -> Option<GhResponse> {
    let text = output.replace("\r\n", "\n");
    let (head, body) = text.split_once("\n\n").unwrap_or((text.as_str(), ""));
    let mut lines = head.lines();
    let status_line = lines.next()?;
    let status: u16 = status_line.strip_prefix("HTTP/")?.split_whitespace().nth(1)?.parse().ok()?;
    let mut etag = None;
    let mut poll = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        match name.trim().to_ascii_lowercase().as_str() {
            "etag" => etag = Some(value.trim().to_string()),
            "x-poll-interval" => poll = value.trim().parse().ok(),
            _ => {}
        }
    }
    Some(GhResponse { status, etag, poll_interval_s: poll, body: body.to_string() })
}

/// Runs `gh` (a fake in tests). Every call is a read except `pr merge --auto`, which only the
/// person's confirmed click reaches (`merge_green`).
pub trait Gh: Send + Sync {
    /// `gh api --include [-H If-None-Match: etag] <path>`.
    fn api(&self, path: &str, etag: Option<&str>) -> Result<GhResponse, String>;
    /// Any other `gh` command; returns stdout, or stderr as the error.
    fn run(&self, args: &[&str]) -> Result<String, String>;
}

/// The real `gh` on PATH (`POTATO_WORKSPACE_GH` overrides it, for a demo fake).
pub struct GhCli;

pub(crate) fn gh_command() -> Command {
    let program = std::env::var("POTATO_WORKSPACE_GH").ok().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "gh".into());
    let mut cmd = crate::proc_util::hidden_command(program);
    cmd.env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

impl Gh for GhCli {
    fn api(&self, path: &str, etag: Option<&str>) -> Result<GhResponse, String> {
        let mut cmd = gh_command();
        cmd.args(["api", "--include"]);
        if let Some(etag) = etag {
            cmd.args(["-H", &format!("If-None-Match: {etag}")]);
        }
        cmd.arg(path);
        let out = cmd.output().map_err(|e| format!("gh isn't available: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        parse_include(&text).ok_or_else(|| {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if err.is_empty() { "gh gave no answer".into() } else { err }
        })
    }

    fn run(&self, args: &[&str]) -> Result<String, String> {
        let out = gh_command().args(args).output().map_err(|e| format!("gh isn't available: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
}

// ----------------------------------------------------------------------------- pull requests

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct ApiUser {
    login: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct ApiRef {
    #[serde(rename = "ref")]
    name: String,
    #[serde(default)]
    sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct ApiPull {
    number: u64,
    state: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    merged_at: Option<String>,
    user: Option<ApiUser>,
    head: ApiRef,
    base: ApiRef,
}

/// What the app remembers about one pull request between polls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrSnapshot {
    pub number: u64,
    pub open: bool,
    pub merged: bool,
    pub draft: bool,
    pub title: String,
    pub url: String,
    pub author: String,
    pub head: String,
    pub head_sha: String,
    pub base: String,
    /// Files changed and lines added/removed (`GET .../pulls/{n}`; the list doesn't carry them).
    pub stats: Option<DiffStat>,
    /// Checks on the head commit when the PR was seen opening.
    pub ci: Option<CiRef>,
}

/// `GET /repos/{o}/{r}/pulls/{n}`: files changed and lines added/removed.
pub fn parse_pull_stats(json: &str) -> Option<DiffStat> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let n = |key: &str| v.get(key).and_then(|x| x.as_u64()).map(|n| n.min(u64::from(u32::MAX)) as u32);
    Some(DiffStat { files: n("changed_files")?, additions: n("additions")?, deletions: n("deletions")? })
}

/// `GET /repos/{o}/{r}/pulls?state=all` → snapshots. Malformed entries are skipped.
pub fn parse_pulls(json: &str) -> Vec<PrSnapshot> {
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(json) else { return Vec::new() };
    list.into_iter()
        .filter_map(|v| serde_json::from_value::<ApiPull>(v).ok())
        .filter(|p| p.number > 0 && event::is_valid_branch(&p.head.name) && event::is_valid_branch(&p.base.name))
        .map(|p| PrSnapshot {
            number: p.number,
            open: p.state == "open",
            merged: p.merged_at.is_some(),
            draft: p.draft,
            title: p.title,
            url: if p.html_url.starts_with("https://") { p.html_url } else { String::new() },
            author: p.user.map(|u| u.login).unwrap_or_default(),
            head_sha: if event::is_valid_commit(&p.head.sha) { p.head.sha } else { String::new() },
            head: p.head.name,
            base: p.base.name,
            stats: None,
            ci: None,
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fact {
    PrOpened(PrSnapshot),
    PrMerged(PrSnapshot),
    PrClosed(PrSnapshot),
    CiFailed { branch: String, pr: Option<PrSnapshot>, ci: CiRef },
    CiPassed { branch: String, pr: Option<PrSnapshot>, ci: CiRef },
    /// New commits on the default branch (from any machine, with or without this app).
    Pushed(DefaultPush),
    /// The default branch's newest commit went red (`failed`), or green again after red.
    DefaultCi { failed: bool, branch: String, sha: String, ci: CiRef },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultPush {
    pub branch: String,
    pub head_sha: String,
    /// New commits since the last look (at most one page, 20).
    pub commits: u32,
    /// Subject line of the oldest new commit.
    pub first_commit: String,
    /// GitHub login of the head commit's author ("" when GitHub doesn't know it).
    pub author: String,
}

// ----------------------------------------------------------------------- the default branch

/// `GET /repos/{o}/{r}`: `default_branch`.
pub fn parse_default_branch(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("default_branch")?.as_str().filter(|b| event::is_valid_branch(b)).map(str::to_string)
}

/// One commit of `GET /repos/{o}/{r}/commits?sha=<branch>` (newest first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInfo {
    pub sha: String,
    pub subject: String,
    pub author: String,
}

pub fn parse_commits(json: &str) -> Vec<CommitInfo> {
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(json) else { return Vec::new() };
    list.iter()
        .filter_map(|c| {
            let sha = c.get("sha")?.as_str().filter(|s| event::is_full_commit(s))?.to_string();
            let message = c.pointer("/commit/message").and_then(|m| m.as_str()).unwrap_or("");
            let subject = event::clean_text(message.lines().next().unwrap_or(""), 120);
            let author = c.pointer("/author/login").and_then(|a| a.as_str()).unwrap_or("").to_string();
            Some(CommitInfo { sha, subject, author })
        })
        .collect()
}

/// New commits on the default branch since `prev_head`. The first look (`None`) is a baseline.
pub fn push_fact(prev_head: Option<&str>, branch: &str, commits: &[CommitInfo]) -> Option<Fact> {
    let prev = prev_head?;
    let head = commits.first()?;
    if head.sha == prev {
        return None;
    }
    // A force-push that dropped the old head: everything on the page counts.
    let count = commits.iter().position(|c| c.sha == prev).unwrap_or(commits.len());
    let first = &commits[count.saturating_sub(1)];
    Some(Fact::Pushed(DefaultPush {
        branch: branch.into(),
        head_sha: head.sha.clone(),
        commits: count as u32,
        first_commit: first.subject.clone(),
        author: head.author.clone(),
    }))
}

/// `GET /repos/{o}/{r}/actions/runs?branch=<b>`: the newest commit, its state, and the workflows
/// that failed on it (the newest run of each workflow counts, so a re-run that passed wins).
pub fn runs_state(json: &str) -> Option<(String, CiState, CiRef)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let runs = v.get("workflow_runs")?.as_array()?;
    let sha = runs.first()?.get("head_sha")?.as_str().filter(|s| event::is_full_commit(s))?.to_string();
    let mut seen = std::collections::BTreeSet::new();
    let (mut failed, mut pending, mut url) = (Vec::new(), false, String::new());
    for run in runs.iter().filter(|r| r.get("head_sha").and_then(|s| s.as_str()) == Some(sha.as_str())) {
        let name = event::clean_text(run.get("name").and_then(|n| n.as_str()).unwrap_or("CI"), 80);
        if !seen.insert(name.clone()) {
            continue; // an older run of the same workflow
        }
        let conclusion = run.get("conclusion").and_then(|c| c.as_str());
        if matches!(conclusion, Some("failure" | "timed_out" | "startup_failure")) {
            if url.is_empty() {
                url = run.get("html_url").and_then(|u| u.as_str()).filter(|u| u.starts_with("https://")).unwrap_or("").to_string();
            }
            failed.push(name);
        } else if run.get("status").and_then(|s| s.as_str()) != Some("completed") {
            pending = true;
        }
    }
    let state = if !failed.is_empty() { CiState::Failed } else if pending { CiState::Pending } else { CiState::Passed };
    let conclusion = match state {
        CiState::Failed => "failure",
        CiState::Pending => "pending",
        _ => "success",
    };
    failed.truncate(10);
    Some((sha, state, CiRef { conclusion: conclusion.into(), failed_jobs: failed, url }))
}

/// A fact when the default branch's CI changes: red on a commit not yet announced red (on the first
/// look too), green after red. `red_sha` is the commit last announced red, and is kept up to date.
pub fn default_ci_fact(red_sha: &mut Option<String>, branch: &str, sha: &str, now: CiState, ci: CiRef) -> Option<Fact> {
    match now {
        CiState::Failed if red_sha.as_deref() != Some(sha) => {
            *red_sha = Some(sha.to_string());
            Some(Fact::DefaultCi { failed: true, branch: branch.into(), sha: sha.into(), ci })
        }
        CiState::Passed if red_sha.is_some() => {
            *red_sha = None;
            Some(Fact::DefaultCi { failed: false, branch: branch.into(), sha: sha.into(), ci })
        }
        _ => None,
    }
}

/// How long to wait after `failures` polls in a row failed: 60 s, 120 s, 240 s ... at most 15 minutes.
pub fn backoff_ms(failures: u32) -> u64 {
    (DEFAULT_POLL_S * 1000).saturating_mul(1u64 << failures.min(4)).min(15 * 60 * 1000)
}

/// What changed between two looks at the pull request list. The first look (`prev` = `None`) is
/// the baseline and yields nothing.
pub fn diff_pulls(prev: Option<&BTreeMap<u64, PrSnapshot>>, now: &[PrSnapshot]) -> Vec<Fact> {
    let Some(prev) = prev else { return Vec::new() };
    let mut facts = Vec::new();
    for pr in now {
        match prev.get(&pr.number) {
            None if pr.open => facts.push(Fact::PrOpened(pr.clone())),
            // Opened and merged between two polls.
            None if pr.merged => facts.push(Fact::PrMerged(pr.clone())),
            None => {}
            Some(before) if before.open && !pr.open && pr.merged => facts.push(Fact::PrMerged(pr.clone())),
            Some(before) if before.open && !pr.open => facts.push(Fact::PrClosed(pr.clone())),
            Some(before) if !before.open && pr.open => facts.push(Fact::PrOpened(pr.clone())), // reopened
            Some(_) => {}
        }
    }
    facts
}

// ------------------------------------------------------------------------------------------ CI

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CiState {
    /// No checks at all.
    None,
    Pending,
    Passed,
    Failed,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiRun {
    name: String,
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    html_url: String,
}

/// `GET /repos/{o}/{r}/commits/{sha}/check-runs` → the overall state and the failed job names.
pub fn ci_state(json: &str) -> (CiState, CiRef) {
    #[derive(Deserialize)]
    struct Runs {
        #[serde(default)]
        check_runs: Vec<ApiRun>,
    }
    let runs = serde_json::from_str::<Runs>(json).map(|r| r.check_runs).unwrap_or_default();
    let failed: Vec<&ApiRun> = runs
        .iter()
        .filter(|r| matches!(r.conclusion.as_deref(), Some("failure" | "timed_out" | "cancelled" | "action_required" | "startup_failure")))
        .collect();
    let state = if runs.is_empty() {
        CiState::None
    } else if !failed.is_empty() {
        CiState::Failed
    } else if runs.iter().any(|r| r.status != "completed") {
        CiState::Pending
    } else {
        CiState::Passed
    };
    let mut names: Vec<String> = failed.iter().map(|r| event::clean_text(&r.name, 80)).collect();
    names.dedup();
    names.truncate(10);
    let url = failed.first().map(|r| r.html_url.clone()).filter(|u| u.starts_with("https://")).unwrap_or_default();
    let conclusion = match state {
        CiState::Failed => "failure",
        CiState::Passed => "success",
        CiState::Pending => "pending",
        CiState::None => "none",
    };
    (state, CiRef { conclusion: conclusion.into(), failed_jobs: names, url })
}

/// A CI fact for a change of state (red after anything else; green after red or pending).
pub fn ci_fact(before: Option<CiState>, now: CiState, branch: &str, pr: Option<PrSnapshot>, ci: CiRef) -> Option<Fact> {
    let before = before?; // baseline
    match (before, now) {
        (b, CiState::Failed) if b != CiState::Failed => Some(Fact::CiFailed { branch: branch.into(), pr, ci }),
        (CiState::Failed | CiState::Pending, CiState::Passed) => Some(Fact::CiPassed { branch: branch.into(), pr, ci }),
        _ => None,
    }
}

// --------------------------------------------------------------------------- facts → events

fn pr_ref(pr: &PrSnapshot, state: &str) -> PrRef {
    PrRef {
        number: pr.number,
        title: pr.title.clone(),
        url: pr.url.clone(),
        state: state.into(),
        draft: pr.draft,
        files: pr.stats.map(|s| s.files),
        additions: pr.stats.map(|s| s.additions),
        deletions: pr.stats.map(|s| s.deletions),
    }
}

/// The card event for a fact. The actor is the teammate whose GitHub login it is (from the
/// roster), or the plain login for someone not on the team (they still count, plan Q6).
pub fn fact_event(project_key: &str, fact: &Fact, roster: Option<&Roster>, now_ms: u64) -> TeamEvent {
    let (kind, author, subject, tier) = match fact {
        Fact::PrOpened(pr) => (
            TeamEventKind::PrOpened,
            pr.author.clone(),
            Subject {
                branch: Some(pr.head.clone()),
                base: Some(pr.base.clone()),
                pr: Some(pr_ref(pr, "open")),
                ci: pr.ci.clone(),
                ..Subject::default()
            },
            Tier::Ambient,
        ),
        Fact::PrMerged(pr) => (
            TeamEventKind::PrMerged,
            pr.author.clone(),
            Subject { branch: Some(pr.head.clone()), base: Some(pr.base.clone()), pr: Some(pr_ref(pr, "merged")), ..Subject::default() },
            Tier::Ambient,
        ),
        Fact::PrClosed(pr) => (
            TeamEventKind::PrClosed,
            pr.author.clone(),
            Subject { branch: Some(pr.head.clone()), base: Some(pr.base.clone()), pr: Some(pr_ref(pr, "closed")), ..Subject::default() },
            Tier::Digest,
        ),
        Fact::CiFailed { branch, pr, ci } | Fact::CiPassed { branch, pr, ci } => {
            let failed = matches!(fact, Fact::CiFailed { .. });
            (
                if failed { TeamEventKind::CiFailed } else { TeamEventKind::CiPassed },
                pr.as_ref().map(|p| p.author.clone()).unwrap_or_default(),
                Subject {
                    branch: Some(branch.clone()),
                    pr: pr.as_ref().map(|p| pr_ref(p, "open")),
                    ci: Some(ci.clone()),
                    ..Subject::default()
                },
                if failed { Tier::Interrupt } else { Tier::Digest },
            )
        }
        Fact::Pushed(push) => (
            TeamEventKind::Pushed,
            push.author.clone(),
            Subject {
                branch: Some(push.branch.clone()),
                commit: Some(push.head_sha.clone()),
                commits: Some(push.commits),
                first_commit: Some(push.first_commit.clone()).filter(|s| !s.is_empty()),
                ..Subject::default()
            },
            Tier::Ambient,
        ),
        Fact::DefaultCi { failed, branch, sha, ci } => (
            if *failed { TeamEventKind::CiFailed } else { TeamEventKind::CiPassed },
            String::new(),
            Subject {
                branch: Some(branch.clone()),
                // Only the red one names its commit (the banner's dedupe); a green card has nothing to pull.
                commit: failed.then(|| sha.clone()),
                ci: Some(ci.clone()),
                ..Subject::default()
            },
            if *failed { Tier::Interrupt } else { Tier::Digest },
        ),
    };
    let member = roster.and_then(|r| r.by_github(&author));
    let actor = Actor {
        member: member.map(|m| m.id.clone()).unwrap_or_else(|| format!("github:{author}")),
        device: String::new(),
        display: member.map(|m| m.display.clone()).unwrap_or_else(|| if author.is_empty() { "GitHub".into() } else { author.clone() }),
        agent: None,
    };
    TeamEvent {
        v: event::SCHEMA_VERSION,
        id: event::new_event_id(now_ms),
        team: roster.map(|r| r.team.clone()).unwrap_or_default(),
        project: ProjectRef { key: project_key.into(), name: crate::team::project_key::display_name(project_key) },
        actor,
        kind,
        at_ms: now_ms,
        dedupe_key: event::dedupe_key(project_key, kind, &subject),
        subject,
        note: None,
        to: Vec::new(),
        tier_hint: tier,
        expires_at_ms: now_ms + event::DEFAULT_TTL_MS,
        source: EventSource::Github,
    }
}

/// `github.com/acme/billing` → `acme/billing`.
pub fn owner_repo(project_key: &str) -> Option<String> {
    let rest = project_key.strip_prefix("github.com/")?;
    let mut parts = rest.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    (ok(owner) && ok(repo) && parts.next().is_none() && !repo.starts_with('.')).then(|| format!("{owner}/{repo}"))
}

// ------------------------------------------------------------------------------- the poller

/// Per-repository memory of the poller (in memory only; a restart takes a new baseline).
#[derive(Debug, Default)]
pub struct RepoPoll {
    pub pulls_etag: Option<String>,
    pub pulls: Option<BTreeMap<u64, PrSnapshot>>,
    /// head sha → (etag, last state)
    pub checks: BTreeMap<String, (Option<String>, CiState)>,
    pub next_at_ms: u64,
    /// Polls in a row that failed (for [`backoff_ms`]).
    pub failures: u32,
    /// The default branch, read once (`None` until GitHub answered).
    pub default_branch: Option<String>,
    pub commits_etag: Option<String>,
    /// Newest commit seen on the default branch.
    pub head: Option<String>,
    pub runs_etag: Option<String>,
    /// The default branch's commit last announced red.
    pub red_sha: Option<String>,
}

/// One poll of one repository: the pull request list, then CI of the open pull requests' heads.
pub fn poll_repo(gh: &dyn Gh, owner_repo: &str, state: &mut RepoPoll, now_ms: u64) -> Result<Vec<Fact>, String> {
    let path = format!("repos/{owner_repo}/pulls?state=all&sort=updated&direction=desc&per_page=30");
    let response = gh.api(&path, state.pulls_etag.as_deref())?;
    let interval = response.poll_interval_s.unwrap_or(DEFAULT_POLL_S).max(DEFAULT_POLL_S);
    state.next_at_ms = now_ms + interval * 1000;
    let mut facts = Vec::new();
    let mut open_prs: Vec<PrSnapshot> = Vec::new();
    match response.status {
        200 => {
            let now = parse_pulls(&response.body);
            facts.extend(diff_pulls(state.pulls.as_ref(), &now));
            let mut map = state.pulls.take().unwrap_or_default();
            for pr in now {
                map.insert(pr.number, pr);
            }
            state.pulls = Some(map);
            state.pulls_etag = response.etag;
        }
        304 => {}
        code => return Err(format!("GitHub answered {code}")),
    }
    if let Some(map) = &state.pulls {
        open_prs = map.values().filter(|p| p.open && !p.head_sha.is_empty()).cloned().collect();
    }
    open_prs.truncate(10);
    for pr in open_prs {
        let (etag, before) = state.checks.get(&pr.head_sha).cloned().map(|(e, s)| (e, Some(s))).unwrap_or((None, None));
        let response = gh.api(&format!("repos/{owner_repo}/commits/{}/check-runs?per_page=50", pr.head_sha), etag.as_deref())?;
        if response.status == 304 {
            continue;
        }
        if response.status != 200 {
            continue;
        }
        let (now_state, ci) = ci_state(&response.body);
        if let Some(fact) = ci_fact(before, now_state, &pr.head, Some(pr.clone()), ci) {
            facts.push(fact);
        }
        state.checks.insert(pr.head_sha.clone(), (response.etag, now_state));
    }
    // A newly opened PR's card says how big it is and how its checks stand.
    for fact in facts.iter_mut() {
        if let Fact::PrOpened(pr) = fact {
            if let Ok(r) = gh.api(&format!("repos/{owner_repo}/pulls/{}", pr.number), None) {
                pr.stats = if r.status == 200 { parse_pull_stats(&r.body) } else { None };
            }
            pr.ci = state.checks.get(&pr.head_sha).map(|(_, s)| CiRef {
                conclusion: match s {
                    CiState::Failed => "failure",
                    CiState::Passed => "success",
                    CiState::Pending => "pending",
                    CiState::None => "none",
                }
                .into(),
                failed_jobs: Vec::new(),
                url: String::new(),
            });
        }
    }
    poll_default_branch(gh, owner_repo, state, &mut facts);
    Ok(facts)
}

/// Pushes to and CI on the default branch. Best effort: a failure here leaves the PR facts alone.
fn poll_default_branch(gh: &dyn Gh, owner_repo: &str, state: &mut RepoPoll, facts: &mut Vec<Fact>) {
    if state.default_branch.is_none() {
        state.default_branch = gh
            .api(&format!("repos/{owner_repo}"), None)
            .ok()
            .filter(|r| r.status == 200)
            .and_then(|r| parse_default_branch(&r.body));
    }
    let Some(branch) = state.default_branch.clone() else { return };
    let query = branch.replace('+', "%2B");
    if let Ok(r) = gh.api(&format!("repos/{owner_repo}/commits?sha={query}&per_page=20"), state.commits_etag.as_deref()) {
        if r.status == 200 {
            let commits = parse_commits(&r.body);
            facts.extend(push_fact(state.head.as_deref(), &branch, &commits));
            if let Some(head) = commits.first() {
                state.head = Some(head.sha.clone());
            }
            state.commits_etag = r.etag;
        }
    }
    if let Ok(r) = gh.api(&format!("repos/{owner_repo}/actions/runs?branch={query}&per_page=20"), state.runs_etag.as_deref()) {
        if r.status == 200 {
            if let Some((sha, now, ci)) = runs_state(&r.body) {
                facts.extend(default_ci_fact(&mut state.red_sha, &branch, &sha, now, ci));
            }
            state.runs_etag = r.etag;
        }
    }
}
