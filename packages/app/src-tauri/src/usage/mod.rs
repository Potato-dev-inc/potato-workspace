//! "Used": how much of its plan each agent you are signed in to has used, for the strip at the bottom of the
//! sidebar. One row per sign-in (the main login and each account, `crate::accounts`).
//!
//! - `source`: the `[usage]` table a profile declares (`TuiProfile::usage_source`, `tui/<agent>/usage.toml`).
//! - `readers`: the small parsers the tables name (`jsonl_rate_limits`, `status_json`).
//! - this file: the rows, the limits the app saw on screen (`plans_report::limit_log`), and a cache that
//!   refreshes every few minutes and on demand (`usage_snapshot`, event `usage://changed`).
//!
//! Generic: agents are only ids and labels from the registry; no code here names one.
//! Private: numbers, times and plan names only. No token, email or chat text is read into a row or logged.
//! Never calls a provider endpoint and never runs a login or logout; a status command runs hidden.

pub mod oauth;
pub mod readers;
pub mod source;
#[cfg(test)]
mod oauth_tests;
#[cfg(test)]
mod tests;

use crate::accounts::{Account, Store};
use crate::plans_report::limit_log::{self, Entry};
use crate::tui::AccountScheme;
use parking_lot::Mutex;
use readers::{LineSpec, Reading, SignIn, Window};
use serde::Serialize;
use source::{Reader, UsageSource};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The event the strip listens to (`lib/usage.ts`).
pub const EVENT: &str = "usage://changed";
/// A snapshot younger than this is answered from the cache.
const FRESH: Duration = Duration::from_secs(120);
/// How often the background refresh runs (only once the strip asked at least once).
const EVERY: Duration = Duration::from_secs(180);
/// A limit the screen showed with no reset time counts for this long.
const LIMIT_WITHOUT_RESET_MS: u64 = 5 * 60 * 60 * 1000;
/// A status command that has not answered by then is stopped.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// One sign-in's usage.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageRow {
    pub agent_id: String,
    pub label: String,
    /// `None` = the agent's main login.
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    /// `ok` (numbers), `limited`, `expired` (sign-in no longer works) or `unknown` (no numbers; see `reason`).
    pub state: &'static str,
    pub reason: Option<String>,
    pub windows: Vec<Window>,
    pub plan: Option<String>,
    /// When the agent itself reported these numbers.
    pub observed_at_ms: Option<u64>,
    /// While `limited`: when the agent said it can continue, if it said.
    pub limited_until_ms: Option<u64>,
    /// The agent's own usage page.
    pub page: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageSnapshot {
    pub rows: Vec<UsageRow>,
    pub refreshed_at_ms: u64,
}

/// An agent that declares a usage source.
#[derive(Debug, Clone)]
pub struct AgentUsage {
    pub id: String,
    pub label: String,
    pub source: UsageSource,
    pub scheme: Option<AccountScheme>,
}

/// Runs a status command. The live one is hidden and time-limited; tests answer from text.
pub trait Probe {
    fn run(&self, program: &str, args: &[String], env: &[(String, String)]) -> Option<String>;
}

/// Everything a build reads besides the agents.
pub struct Inputs<'a> {
    pub accounts: &'a [Account],
    pub limits: &'a [Entry],
    pub probe: &'a dyn Probe,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub home: Option<PathBuf>,
    pub now: SystemTime,
    /// Login-based reads (`oauth_usage`): the client, whether they are allowed at all (Settings), whether a
    /// read may happen now (app focused or just opened), whether the person pressed refresh, and the state
    /// kept between snapshots (last numbers, backoff).
    pub http: &'a dyn oauth::UsageHttp,
    pub login_reads: bool,
    pub may_fetch: bool,
    pub force: bool,
    pub oauth_state: &'a Mutex<std::collections::HashMap<String, OauthState>>,
}

/// What is kept per sign-in between login-based reads. Numbers and times only, never the token.
#[derive(Debug, Clone, Default)]
pub struct OauthState {
    pub last: Option<(u64, Reading)>,
    pub next_ms: u64,
    pub fails: u32,
    /// What the last failed read said (cleared by a good one).
    pub last_failure: Option<LastFailure>,
    pub expired: bool,
}

/// How often a login-based read runs at most (founder: about every 15 minutes while the app is in use).
const LOGIN_READ_EVERY_MS: u64 = 15 * 60 * 1000;

/// The last failed read, for the row's reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastFailure {
    RateLimited,
    Unauthorized,
    Other(oauth::Failure),
}

/// The reason a row shows for a failed read: what was said and when the next try is.
pub fn failure_text(failure: LastFailure, provider: &str, next_in_ms: u64) -> String {
    let when = if next_in_ms == 0 { "trying again now".to_string() } else { format!("trying again in {}", minutes_text(next_in_ms)) };
    match failure {
        LastFailure::RateLimited => format!("{provider} said slow down (429); {when}."),
        LastFailure::Unauthorized => "The sign-in has expired. Open the agent and sign in again.".into(),
        LastFailure::Other(oauth::Failure::Status(code)) => format!("{provider} answered {code}; {when}."),
        LastFailure::Other(oauth::Failure::Network) => format!("Could not reach {provider}; {when}."),
        LastFailure::Other(oauth::Failure::BadAnswer) => format!("{provider}'s answer could not be read; {when}."),
        LastFailure::Other(oauth::Failure::Refused) => "The usage address is not HTTPS, so it is never asked.".into(),
    }
}

fn minutes_text(ms: u64) -> String {
    let mins = ms.div_ceil(60_000).max(1);
    if mins >= 60 {
        let (h, m) = (mins / 60, mins % 60);
        if m == 0 { format!("{h} h") } else { format!("{h} h {m} min") }
    } else {
        format!("{mins} min")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LoginNote {
    None,
    Expired,
    Off,
    /// The reason, already worded.
    Failing(String),
}

fn read_login(agent: &AgentUsage, home: Option<&Path>, inputs: &Inputs<'_>) -> (Option<Reading>, LoginNote) {
    let Reader::OauthUsage { credentials_file, token, expires_at, url, headers, used, resets_at, windows, .. } = &agent.source.reader else {
        return (None, LoginNote::None);
    };
    if !inputs.login_reads {
        return (None, LoginNote::Off);
    }
    let Some(home) = home else { return (None, LoginNote::None) };
    let now = ms(inputs.now);
    let mut all = inputs.oauth_state.lock();
    let state = all.entry(home.to_string_lossy().into_owned()).or_default();
    match oauth::read_token(home, credentials_file, token, expires_at.as_deref(), now) {
        oauth::Token::Missing => {}
        oauth::Token::Expired => state.expired = true,
        oauth::Token::Valid(secret) => {
            if now >= state.next_ms && (inputs.force || inputs.may_fetch) {
                match inputs.http.get(url, &secret, headers) {
                    oauth::Fetch::Ok(answer) => {
                        state.last = Some((now, oauth::parse(&answer, windows, used, resets_at, now)));
                        state.fails = 0;
                        state.last_failure = None;
                        state.expired = false;
                        state.next_ms = now + LOGIN_READ_EVERY_MS;
                    }
                    oauth::Fetch::Unauthorized => {
                        state.expired = true;
                        state.last_failure = Some(LastFailure::Unauthorized);
                        state.fails += 1;
                        state.next_ms = now + oauth::backoff_ms(state.fails, None);
                    }
                    oauth::Fetch::RateLimited { retry_after_ms } => {
                        state.last_failure = Some(LastFailure::RateLimited);
                        state.fails += 1;
                        state.next_ms = now + oauth::backoff_ms(state.fails, retry_after_ms);
                    }
                    oauth::Fetch::Failed(why) => {
                        state.last_failure = Some(LastFailure::Other(why));
                        state.fails += 1;
                        state.next_ms = now + oauth::backoff_ms(state.fails, None);
                    }
                }
            } else if state.expired && state.fails == 0 {
                // The file said expired before, and the agent has since renewed its own login.
                state.expired = false;
            }
            drop(secret);
        }
    }
    let reading = state.last.as_ref().map(|(at, reading)| {
        let mut reading = reading.clone();
        reading.observed_at_ms = Some(*at);
        // A window whose reset passed since the read started again.
        for w in &mut reading.windows {
            if w.resets_at_ms.is_some_and(|r| r <= now) {
                w.used_percent = 0.0;
                w.resets_at_ms = None;
                w.reset_since = true;
            }
        }
        reading
    });
    let note = if state.expired {
        LoginNote::Expired
    } else if let (true, Some(failure)) = (state.fails > 0, state.last_failure) {
        let provider = match &agent.source.reader {
            Reader::OauthUsage { provider: Some(p), .. } => p.clone(),
            _ => "The agent's server".into(),
        };
        LoginNote::Failing(failure_text(failure, &provider, state.next_ms.saturating_sub(now)))
    } else {
        LoginNote::None
    };
    (reading, note)
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Login {
    account: Option<Account>,
    home: Option<PathBuf>,
    env: Vec<(String, String)>,
}

fn expand(path: &str, home: Option<&Path>) -> PathBuf {
    match (path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ if path == "~" => home.map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(path)),
        _ => PathBuf::from(path),
    }
}

fn logins(agent: &AgentUsage, inputs: &Inputs<'_>) -> Vec<Login> {
    let env_home = agent.scheme.as_ref().and_then(|s| (inputs.env)(&s.home_env)).filter(|v| !v.trim().is_empty());
    let main_home = env_home
        .map(PathBuf::from)
        .or_else(|| agent.source.main_home.as_deref().map(|h| expand(h, inputs.home.as_deref())));
    let mut out = vec![Login { account: None, home: main_home, env: Vec::new() }];
    if let Some(scheme) = &agent.scheme {
        for account in inputs.accounts.iter().filter(|a| a.agent_id.eq_ignore_ascii_case(&agent.id)) {
            out.push(Login {
                account: Some(account.clone()),
                home: Some(PathBuf::from(&account.home)),
                env: crate::accounts::env_for(scheme, account).set,
            });
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signed {
    In,
    Expired,
    Out,
    Unknown,
}

fn sign_in(agent: &AgentUsage, login: &Login, probe: &dyn Probe) -> Signed {
    if let Reader::StatusJson { signed_in, had_login, .. } = &agent.source.reader {
        let Some((program, args)) = &agent.source.command else { return Signed::Unknown };
        return match probe.run(program, args, &login.env).and_then(|out| readers::parse_status(&out, signed_in, had_login.as_deref())) {
            Some(SignIn::SignedIn) => Signed::In,
            Some(SignIn::Expired) => Signed::Expired,
            Some(SignIn::SignedOut) => Signed::Out,
            None => Signed::Unknown,
        };
    }
    let (Some(scheme), Some(home)) = (&agent.scheme, &login.home) else { return Signed::Unknown };
    let probe_account = Account {
        id: String::new(),
        agent_id: agent.id.clone(),
        label: String::new(),
        home: home.to_string_lossy().into_owned(),
        lend_only: false,
    };
    match crate::accounts::login_state(scheme, &probe_account) {
        "signed_in" => Signed::In,
        "signed_out" => Signed::Out,
        _ => Signed::Unknown,
    }
}

fn read(source: &UsageSource, home: Option<&Path>, now: SystemTime) -> Option<Reading> {
    let Reader::JsonlRateLimits { dir, file_prefix, max_age_days, object, observed_at, plan, reached, windows } = &source.reader else {
        return None;
    };
    let spec = LineSpec {
        object,
        observed_at: observed_at.as_deref(),
        plan: plan.as_deref(),
        reached: reached.as_deref(),
        windows,
    };
    readers::read_jsonl(&home?.join(dir), file_prefix.as_deref(), *max_age_days, &spec, now)
}

/// The limit the app last saw on this sign-in's screen, if it still holds: `Some(reset)`.
pub fn limited_by_log(entries: &[Entry], agent: &str, account: Option<&str>, now_ms: u64) -> Option<Option<u64>> {
    let mut open: std::collections::BTreeMap<&str, (u64, Option<u64>)> = std::collections::BTreeMap::new();
    for entry in entries {
        match entry {
            Entry::Start { at_ms, pane, agent: a, account: acc, reset_at_ms } if a.eq_ignore_ascii_case(agent) && acc.as_deref() == account => {
                open.insert(pane.as_str(), (*at_ms, *reset_at_ms));
            }
            Entry::End { pane, .. } => {
                open.remove(pane.as_str());
            }
            _ => {}
        }
    }
    open.into_values()
        .filter(|(start, reset)| match reset {
            Some(reset) => *reset > now_ms,
            None => now_ms.saturating_sub(*start) < LIMIT_WITHOUT_RESET_MS,
        })
        .max_by_key(|(start, _)| *start)
        .map(|(_, reset)| reset)
}

fn row_for(agent: &AgentUsage, login: &Login, inputs: &Inputs<'_>) -> Option<UsageRow> {
    let now_ms = ms(inputs.now);
    let signed = sign_in(agent, login, inputs.probe);
    let (reading, note) = if signed == Signed::Out || signed == Signed::Expired {
        (None, LoginNote::None)
    } else if matches!(agent.source.reader, Reader::OauthUsage { .. }) {
        read_login(agent, login.home.as_deref(), inputs)
    } else {
        (read(&agent.source, login.home.as_deref(), inputs.now), LoginNote::None)
    };
    // No sign-in: hidden. A sign-in that cannot be read from the folder still shows once it has numbers.
    match signed {
        Signed::Out => return None,
        Signed::Unknown if reading.is_none() && !matches!(agent.source.reader, Reader::None { .. } | Reader::OauthUsage { .. }) => return None,
        _ => {}
    }
    let account_id = login.account.as_ref().map(|a| a.id.clone());
    let mut row = UsageRow {
        agent_id: agent.id.clone(),
        label: agent.label.clone(),
        account_id: account_id.clone(),
        account_label: login.account.as_ref().map(|a| a.label.clone()),
        state: "unknown",
        reason: None,
        windows: Vec::new(),
        plan: None,
        observed_at_ms: None,
        limited_until_ms: None,
        page: agent.source.page.clone(),
    };
    if signed == Signed::Expired || (note == LoginNote::Expired && reading.is_none()) {
        row.state = "expired";
        row.reason = Some("The sign-in has expired. Open the agent and sign in again.".into());
        return Some(row);
    }
    if let Some(reading) = reading {
        let over = reading.windows.iter().any(|w| !w.reset_since && w.used_percent >= 100.0);
        row.state = if reading.reached || over { "limited" } else { "ok" };
        if row.state == "limited" {
            row.limited_until_ms = reading
                .windows
                .iter()
                .filter(|w| w.used_percent >= 100.0 || reading.reached)
                .filter_map(|w| w.resets_at_ms)
                .max();
        }
        row.windows = reading.windows;
        row.plan = reading.plan.filter(|p| !p.is_empty());
        row.observed_at_ms = reading.observed_at_ms;
        if row.windows.is_empty() {
            row.state = "unknown";
            row.reason = Some("The agent reported no limit windows.".into());
        }
        match note {
            LoginNote::Expired => row.reason = Some("The sign-in has expired; these are the last numbers read.".into()),
            LoginNote::Failing(why) => row.reason = Some(format!("Showing the last numbers read. {why}")),
            _ => {}
        }
    } else {
        row.reason = Some(match (&agent.source.reader, &note) {
            (Reader::None { reason } | Reader::StatusJson { reason, .. }, _) => reason.clone(),
            (Reader::OauthUsage { .. }, LoginNote::Off) => "Reading usage with your login is off in Settings.".into(),
            (Reader::OauthUsage { .. }, LoginNote::Failing(why)) => why.clone(),
            (Reader::OauthUsage { reason, .. }, _) => reason.clone(),
            (Reader::JsonlRateLimits { .. }, _) => "No recent session under this sign-in reported its limits yet.".into(),
        });
    }
    if row.state != "limited" {
        if let Some(reset) = limited_by_log(inputs.limits, &agent.id, account_id.as_deref(), now_ms) {
            row.state = "limited";
            row.limited_until_ms = reset;
        }
    }
    Some(row)
}

/// Every row, agents in registry order, the main login before the accounts.
pub fn build(agents: &[AgentUsage], inputs: &Inputs<'_>) -> UsageSnapshot {
    let rows = agents
        .iter()
        .flat_map(|agent| logins(agent, inputs).into_iter().filter_map(move |login| row_for(agent, &login, inputs)))
        .collect();
    UsageSnapshot { rows, refreshed_at_ms: ms(inputs.now) }
}

/// The registered agents that declare a usage source.
pub fn live_agents() -> Vec<AgentUsage> {
    crate::tui::registry::snapshot()
        .iter()
        .filter_map(|profile| {
            let source = profile.usage_source()?;
            let label = crate::tui::descriptor_for(profile.id()).map(|d| d.label).unwrap_or_else(|| profile.id().to_string());
            Some(AgentUsage { id: profile.id().to_string(), label, source, scheme: profile.account_scheme() })
        })
        .collect()
}

/// The live status-command runner: hidden, no stdin, stderr dropped, stopped after `PROBE_TIMEOUT`.
/// An answer is reused for `PROBE_REUSE` unless `reuse` is false (the person pressed refresh), so the
/// background refresh does not start a process every few minutes.
pub struct HiddenProbe {
    pub reuse: bool,
}

const PROBE_REUSE: Duration = Duration::from_secs(15 * 60);
type Answers = std::collections::HashMap<String, (std::time::Instant, String)>;
static PROBE_ANSWERS: Mutex<Option<Answers>> = Mutex::new(None);

impl Probe for HiddenProbe {
    fn run(&self, program: &str, args: &[String], env: &[(String, String)]) -> Option<String> {
        let key = format!("{program}|{}|{env:?}", args.join("|"));
        if self.reuse {
            if let Some((at, text)) = PROBE_ANSWERS.lock().as_ref().and_then(|m| m.get(&key)) {
                if at.elapsed() < PROBE_REUSE {
                    return Some(text.clone());
                }
            }
        }
        let text = run_hidden(program, args, env)?;
        PROBE_ANSWERS.lock().get_or_insert_with(Default::default).insert(key, (std::time::Instant::now(), text.clone()));
        Some(text)
    }
}

fn run_hidden(program: &str, args: &[String], env: &[(String, String)]) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut command = crate::proc_util::hidden_command(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                // Only the child this call started.
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok()
}

/// Whether login-based reads are allowed (Settings > General, on by default). The strip passes it on every call.
static LOGIN_READS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static OAUTH_STATE: Mutex<Option<std::collections::HashMap<String, OauthState>>> = Mutex::new(None);

/// Set the Settings switch; returns whether it changed.
pub fn set_login_reads(on: bool) -> bool {
    LOGIN_READS.swap(on, std::sync::atomic::Ordering::Relaxed) != on
}

/// A fresh snapshot from the live registry, accounts and limit log.
pub fn compute(when: Refresh, focused: bool) -> UsageSnapshot {
    let accounts = Store::default_location().list();
    let limits = limit_log::read(&limit_log::default_path());
    let env = |key: &str| std::env::var(key).ok();
    let probe = HiddenProbe { reuse: when != Refresh::Now };
    let state = Mutex::new(OAUTH_STATE.lock().take().unwrap_or_default());
    let inputs = Inputs {
        accounts: &accounts,
        limits: &limits,
        probe: &probe,
        env: &env,
        home: crate::project_path::home_dir(),
        now: SystemTime::now(),
        http: &oauth::LiveHttp,
        login_reads: LOGIN_READS.load(std::sync::atomic::Ordering::Relaxed),
        // The strip asked (the app is open and in use), or the background tick while a window has focus.
        may_fetch: when != Refresh::Timer || focused,
        force: when == Refresh::Now,
        oauth_state: &state,
    };
    let snap = build(&live_agents(), &inputs);
    *OAUTH_STATE.lock() = Some(state.into_inner());
    snap
}

/// When a snapshot is read again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refresh {
    /// From the cache unless it is older than `FRESH`.
    IfStale,
    /// The background tick: read again, reusing recent status-command answers; login reads only while focused.
    Timer,
    /// The person pressed refresh: everything again (backoff after a 429 still holds).
    Now,
}

static CACHE: Mutex<Option<(std::time::Instant, UsageSnapshot)>> = Mutex::new(None);
/// One refresh at a time; a second caller waits and then reads the cache.
static REFRESH: Mutex<()> = Mutex::new(());

/// The cached snapshot, refreshed as `when` says. Returns whether the rows changed.
pub fn snapshot(when: Refresh, focused: bool) -> (UsageSnapshot, bool) {
    let _one = REFRESH.lock();
    if when == Refresh::IfStale {
        if let Some((at, snap)) = CACHE.lock().as_ref() {
            if at.elapsed() < FRESH {
                return (snap.clone(), false);
            }
        }
    }
    let next = compute(when, focused);
    let mut cache = CACHE.lock();
    let changed = cache.as_ref().map(|(_, old)| old.rows != next.rows).unwrap_or(true);
    *cache = Some((std::time::Instant::now(), next.clone()));
    (next, changed)
}

/// Drop the cached snapshot so the next call reads again (a setting changed).
pub fn invalidate() {
    *CACHE.lock() = None;
}

static STARTED: std::sync::Once = std::sync::Once::new();

/// Start the background refresh (once). It runs only after the strip first asked, so a hidden strip costs nothing.
pub fn start_refresher(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    STARTED.call_once(move || {
        let spawned = std::thread::Builder::new().name("usage-refresh".into()).spawn(move || loop {
            std::thread::sleep(EVERY);
            let focused = app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
            let (snap, changed) = snapshot(Refresh::Timer, focused);
            if changed {
                let _ = app.emit(EVENT, &snap);
            }
        });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "usage: could not start the refresh thread");
        }
    });
}
