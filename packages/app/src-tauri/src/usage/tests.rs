//! The usage readers against SYNTHETIC fixtures (same structure as the real files, no real data), and the
//! rows `build` makes from them. The agent tables are the shipped `usage.toml` files.

use super::readers::{self, LineSpec, SignIn};
use super::source::{self, Reader, UsageSource};
use super::*;
use std::cell::RefCell;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CODEX_TOML: &str = include_str!("../tui/codex/usage.toml");
const CLAUDE_TOML: &str = include_str!("../tui/claude/usage.toml");
const CURSOR_TOML: &str = include_str!("../tui/cursor/usage.toml");
const ROLLOUT: &str = include_str!("../tui/codex/fixtures/usage/rollout-synthetic.jsonl");
const ROLLOUT_REACHED: &str = include_str!("../tui/codex/fixtures/usage/rollout-synthetic-free-reached.jsonl");

/// 2026-01-02 04:00 UTC: before the fixtures' reset times (2033).
fn early() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_767_326_400)
}

fn now_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-usage-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn codex() -> UsageSource {
    source::from_toml(CODEX_TOML).expect("codex usage.toml parses")
}

fn line_spec(source: &UsageSource) -> (String, Option<String>, Option<String>, Option<String>, Vec<source::WindowSpec>) {
    match &source.reader {
        Reader::JsonlRateLimits { object, observed_at, plan, reached, windows, .. } => {
            (object.clone(), observed_at.clone(), plan.clone(), reached.clone(), windows.clone())
        }
        other => panic!("not a jsonl reader: {other:?}"),
    }
}

fn read_text(source: &UsageSource, text: &str, now: SystemTime) -> Option<readers::Reading> {
    let (object, observed_at, plan, reached, windows) = line_spec(source);
    let spec = LineSpec {
        object: &object,
        observed_at: observed_at.as_deref(),
        plan: plan.as_deref(),
        reached: reached.as_deref(),
        windows: &windows,
    };
    readers::newest_in_text(text, &spec, now_ms(now))
}

#[test]
fn every_shipped_usage_table_parses() {
    assert!(matches!(codex().reader, Reader::JsonlRateLimits { .. }));
    assert!(matches!(source::from_toml(CLAUDE_TOML).unwrap().reader, Reader::OauthUsage { .. }));
    assert!(matches!(source::from_toml(CURSOR_TOML).unwrap().reader, Reader::StatusJson { .. }));
    // A wrong schema is refused.
    assert!(source::from_toml(&CLAUDE_TOML.replace("schema = 1", "schema = 2")).is_none());
}

#[test]
fn the_registered_profiles_declare_their_tables() {
    for id in ["claude", "codex", "cursor_agent", "opencode"] {
        assert!(crate::tui::profile_for(id).usage_source().is_some(), "{id} declares usage");
    }
    assert!(crate::tui::profile_for("cmd").usage_source().is_none());
}

#[test]
fn the_newest_rate_limit_line_wins_and_a_null_one_is_skipped() {
    let reading = read_text(&codex(), ROLLOUT, early()).expect("a reading");
    assert_eq!(reading.windows.len(), 2);
    assert_eq!(reading.windows[0].name, "5-hour");
    assert_eq!(reading.windows[0].used_percent, 87.0);
    assert_eq!(reading.windows[0].resets_at_ms, Some(2_000_000_000_000));
    assert_eq!(reading.windows[1].name, "Weekly");
    assert_eq!(reading.windows[1].used_percent, 31.0);
    assert_eq!(reading.plan.as_deref(), Some("plus"));
    assert!(!reading.reached);
    // 2026-01-02T03:02:00Z
    assert_eq!(reading.observed_at_ms, Some(1_767_322_920_000));
}

#[test]
fn a_reached_free_plan_has_one_monthly_window() {
    let reading = read_text(&codex(), ROLLOUT_REACHED, early()).expect("a reading");
    assert_eq!(reading.windows.len(), 1, "a null secondary window is skipped");
    assert_eq!(reading.windows[0].name, "Monthly");
    assert!(reading.reached);
    assert_eq!(reading.plan.as_deref(), Some("free"));
}

#[test]
fn a_window_whose_reset_has_passed_reads_as_started_again() {
    let after = UNIX_EPOCH + Duration::from_secs(2_000_100_000);
    let reading = read_text(&codex(), ROLLOUT, after).unwrap();
    assert!(reading.windows[0].reset_since);
    assert_eq!(reading.windows[0].used_percent, 0.0);
    assert_eq!(reading.windows[0].resets_at_ms, None);
    assert!(!reading.windows[1].reset_since, "the weekly window resets later");
}

#[test]
fn window_names_come_from_the_length() {
    assert_eq!(readers::window_name(Some(300), "primary"), "5-hour");
    assert_eq!(readers::window_name(Some(10080), "x"), "Weekly");
    assert_eq!(readers::window_name(Some(43200), "x"), "Monthly");
    assert_eq!(readers::window_name(Some(1440), "x"), "Daily");
    assert_eq!(readers::window_name(Some(2880), "x"), "2-day");
    assert_eq!(readers::window_name(Some(120), "x"), "2-hour");
    assert_eq!(readers::window_name(Some(45), "x"), "45-minute");
    assert_eq!(readers::window_name(None, "secondary"), "secondary");
}

#[test]
fn status_json_reads_only_the_booleans() {
    let on = r#"{"status":"x","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true,"message":"x"}"#;
    let expired = r#"banner line
{"status":"x","isAuthenticated":false,"hasAccessToken":false,"hasRefreshToken":true,"message":"x"}"#;
    let out = r#"{"isAuthenticated":false,"hasRefreshToken":false}"#;
    assert_eq!(readers::parse_status(on, "/isAuthenticated", Some("/hasRefreshToken")), Some(SignIn::SignedIn));
    assert_eq!(readers::parse_status(expired, "/isAuthenticated", Some("/hasRefreshToken")), Some(SignIn::Expired));
    assert_eq!(readers::parse_status(out, "/isAuthenticated", Some("/hasRefreshToken")), Some(SignIn::SignedOut));
    assert_eq!(readers::parse_status("not json", "/isAuthenticated", None), None);
    assert_eq!(readers::parse_status(r#"{"isAuthenticated":"yes"}"#, "/isAuthenticated", None), None);
}

#[test]
fn newest_files_skips_old_and_foreign_files() {
    let dir = temp("files");
    let day = dir.join("2026").join("01").join("02");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(day.join("rollout-a.jsonl"), ROLLOUT).unwrap();
    std::fs::write(day.join("notes.jsonl"), ROLLOUT).unwrap();
    std::fs::write(day.join("rollout-b.txt"), ROLLOUT).unwrap();
    let files = readers::newest_files(&dir, Some("rollout-"), Duration::from_secs(86_400), SystemTime::now());
    assert_eq!(files.len(), 1);
    assert!(files[0].ends_with("rollout-a.jsonl"));
    let none = readers::newest_files(&dir, Some("rollout-"), Duration::from_secs(86_400), SystemTime::now() + Duration::from_secs(3 * 86_400));
    assert!(none.is_empty(), "files older than max_age are skipped");
    let _ = std::fs::remove_dir_all(dir);
}

struct FakeProbe {
    answer: Option<&'static str>,
    calls: RefCell<Vec<Vec<(String, String)>>>,
}

impl Probe for FakeProbe {
    fn run(&self, _program: &str, _args: &[String], env: &[(String, String)]) -> Option<String> {
        self.calls.borrow_mut().push(env.to_vec());
        self.answer.map(str::to_string)
    }
}

fn probe(answer: Option<&'static str>) -> FakeProbe {
    FakeProbe { answer, calls: RefCell::new(Vec::new()) }
}

fn scheme(home_env: &str, file: &str) -> crate::tui::AccountScheme {
    crate::tui::AccountScheme { home_env: home_env.into(), extra_env: Vec::new(), login_hint: String::new(), credential_files: vec![file.into()] }
}

fn agent(id: &str, label: &str, toml: &str, scheme: Option<crate::tui::AccountScheme>) -> AgentUsage {
    AgentUsage { id: id.into(), label: label.into(), source: source::from_toml(toml).unwrap(), scheme }
}

/// No network in these tests.
struct NoHttp;
impl oauth::UsageHttp for NoHttp {
    fn get(&self, _url: &str, _token: &oauth::Secret, _headers: &[(String, String)]) -> oauth::Fetch {
        oauth::Fetch::Failed(oauth::Failure::Network)
    }
}

fn run_build(agents: &[AgentUsage], accounts: &[Account], limits: &[Entry], probe: &dyn Probe, home: &Path, now: SystemTime) -> UsageSnapshot {
    let env = |_: &str| None;
    let state = Mutex::new(Default::default());
    let inputs = Inputs {
        accounts,
        limits,
        probe,
        env: &env,
        home: Some(home.to_path_buf()),
        now,
        http: &NoHttp,
        login_reads: false,
        may_fetch: false,
        force: false,
        oauth_state: &state,
    };
    build(agents, &inputs)
}

/// `<user>/.codex` signed in with the fixture, and an account folder signed in with the reached fixture.
fn codex_homes() -> (PathBuf, Account) {
    let user = temp("user");
    let main = user.join(".codex");
    let day = main.join("sessions").join("2026").join("01").join("02");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(main.join("auth.json"), "{}").unwrap();
    std::fs::write(day.join("rollout-2026-01-02T03-00-00-synthetic.jsonl"), ROLLOUT).unwrap();
    let account_home = user.join("acct");
    let day = account_home.join("sessions").join("2026").join("01").join("03");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(account_home.join("auth.json"), "{}").unwrap();
    std::fs::write(day.join("rollout-2026-01-03-synthetic.jsonl"), ROLLOUT_REACHED).unwrap();
    let account = Account { id: "acc_1".into(), agent_id: "codex".into(), label: "Work".into(), home: account_home.to_string_lossy().into_owned(), lend_only: false };
    (user, account)
}

#[test]
fn one_row_per_sign_in_with_its_own_numbers() {
    let (user, account) = codex_homes();
    let codex = agent("codex", "Codex", CODEX_TOML, Some(scheme("CODEX_HOME", "auth.json")));
    let snap = run_build(&[codex], std::slice::from_ref(&account), &[], &probe(None), &user, early());
    assert_eq!(snap.rows.len(), 2);
    let main = &snap.rows[0];
    assert_eq!(main.account_id, None);
    assert_eq!(main.state, "ok");
    assert_eq!(main.windows[0].used_percent, 87.0);
    assert_eq!(main.page.as_deref(), Some("https://chatgpt.com/codex/settings/usage"));
    let work = &snap.rows[1];
    assert_eq!(work.account_label.as_deref(), Some("Work"));
    assert_eq!(work.state, "limited");
    assert_eq!(work.limited_until_ms, Some(2_000_000_000_000));
    // Nothing from the chat lines ends up in the snapshot.
    let json = serde_json::to_string(&snap).unwrap();
    assert!(!json.contains("SYNTHETIC"), "{json}");
    let _ = std::fs::remove_dir_all(user);
}

#[test]
fn a_sign_in_without_its_login_file_is_hidden() {
    let (user, mut account) = codex_homes();
    std::fs::remove_file(user.join(".codex").join("auth.json")).unwrap();
    let empty = user.join("never-logged-in");
    std::fs::create_dir_all(&empty).unwrap();
    account.home = empty.to_string_lossy().into_owned();
    let codex = agent("codex", "Codex", CODEX_TOML, Some(scheme("CODEX_HOME", "auth.json")));
    let snap = run_build(&[codex], &[account], &[], &probe(None), &user, early());
    // The main folder has other files (sessions), so its login cannot be told from it: it still shows,
    // because it has numbers. The empty account folder never logged in: hidden.
    assert_eq!(snap.rows.len(), 1);
    assert_eq!(snap.rows[0].account_id, None);
    let _ = std::fs::remove_dir_all(user);
}

#[test]
fn a_signed_in_agent_without_numbers_is_unknown_with_a_reason_and_a_screen_limit_marks_it_limited() {
    let user = temp("claude");
    std::fs::create_dir_all(user.join(".claude")).unwrap();
    std::fs::write(user.join(".claude").join(".credentials.json"), "{}").unwrap();
    let claude = agent("claude", "Claude", CLAUDE_TOML, Some(scheme("CLAUDE_CONFIG_DIR", ".credentials.json")));
    let snap = run_build(std::slice::from_ref(&claude), &[], &[], &probe(None), &user, early());
    assert_eq!(snap.rows.len(), 1);
    assert_eq!(snap.rows[0].state, "unknown");
    assert!(snap.rows[0].reason.as_deref().unwrap().contains("off in Settings"));

    let now = now_ms(early());
    let limits = vec![Entry::Start { at_ms: now - 60_000, pane: "p1".into(), agent: "claude".into(), account: None, reset_at_ms: Some(now + 3_600_000) }];
    let snap = run_build(std::slice::from_ref(&claude), &[], &limits, &probe(None), &user, early());
    assert_eq!(snap.rows[0].state, "limited");
    assert_eq!(snap.rows[0].limited_until_ms, Some(now + 3_600_000));

    // No login file at all: hidden.
    std::fs::remove_dir_all(user.join(".claude")).unwrap();
    assert!(run_build(&[claude], &[], &[], &probe(None), &user, early()).rows.is_empty());
    let _ = std::fs::remove_dir_all(user);
}

#[test]
fn a_status_command_says_signed_in_expired_or_out() {
    let user = temp("status");
    let mut cursor = agent("cursor_agent", "Cursor Agent", CURSOR_TOML, None);
    cursor.source.command = Some(("agent".into(), vec!["status".into()]));
    let on = probe(Some(r#"{"isAuthenticated":true,"hasRefreshToken":true}"#));
    let snap = run_build(std::slice::from_ref(&cursor), &[], &[], &on, &user, early());
    assert_eq!(snap.rows[0].state, "unknown");
    assert!(snap.rows[0].reason.as_deref().unwrap().contains("usage"));
    assert_eq!(on.calls.borrow().len(), 1);

    let expired = probe(Some(r#"{"isAuthenticated":false,"hasRefreshToken":true}"#));
    assert_eq!(run_build(std::slice::from_ref(&cursor), &[], &[], &expired, &user, early()).rows[0].state, "expired");

    let out = probe(Some(r#"{"isAuthenticated":false,"hasRefreshToken":false}"#));
    assert!(run_build(std::slice::from_ref(&cursor), &[], &[], &out, &user, early()).rows.is_empty());

    // The CLI is not installed (no command): nothing is run, and nothing is shown.
    cursor.source.command = None;
    let never = probe(Some("{}"));
    assert!(run_build(&[cursor], &[], &[], &never, &user, early()).rows.is_empty());
    assert!(never.calls.borrow().is_empty());
    let _ = std::fs::remove_dir_all(user);
}

#[test]
fn the_screen_limit_log_ends_with_an_end_line_or_the_reset() {
    let now = 10_000_000_000u64;
    let start = |pane: &str, at: u64, reset: Option<u64>| Entry::Start { at_ms: at, pane: pane.into(), agent: "codex".into(), account: Some("a".into()), reset_at_ms: reset };
    let ended = vec![start("p", now - 1000, Some(now + 1000)), Entry::End { at_ms: now - 500, pane: "p".into() }];
    assert_eq!(limited_by_log(&ended, "codex", Some("a"), now), None);
    let open = vec![start("p", now - 1000, Some(now + 1000))];
    assert_eq!(limited_by_log(&open, "codex", Some("a"), now), Some(Some(now + 1000)));
    assert_eq!(limited_by_log(&open, "codex", None, now), None, "another sign-in");
    let passed = vec![start("p", now - 2000, Some(now - 1000))];
    assert_eq!(limited_by_log(&passed, "codex", Some("a"), now), None);
    let no_reset = vec![start("p", now - 1000, None)];
    assert_eq!(limited_by_log(&no_reset, "codex", Some("a"), now), Some(None));
    let old = vec![start("p", now - LIMIT_WITHOUT_RESET_MS - 1, None)];
    assert_eq!(limited_by_log(&old, "codex", Some("a"), now), None);
}

#[test]
fn the_snapshot_serialises_the_fields_the_strip_reads() {
    let (user, account) = codex_homes();
    let codex = agent("codex", "Codex", CODEX_TOML, Some(scheme("CODEX_HOME", "auth.json")));
    let snap = run_build(&[codex], &[account], &[], &probe(None), &user, early());
    let json = serde_json::to_value(&snap).unwrap();
    let row = &json["rows"][0];
    for key in ["agent_id", "label", "account_id", "account_label", "state", "reason", "windows", "plan", "observed_at_ms", "limited_until_ms", "page"] {
        assert!(row.get(key).is_some(), "row has {key}");
    }
    let window = &row["windows"][0];
    for key in ["name", "used_percent", "minutes", "resets_at_ms", "reset_since"] {
        assert!(window.get(key).is_some(), "window has {key}");
    }
    assert!(json["refreshed_at_ms"].as_u64().unwrap() > 0);
    let _ = std::fs::remove_dir_all(user);
}
