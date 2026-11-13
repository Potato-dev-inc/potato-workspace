//! The `sqlite_totals` reader against a SYNTHETIC database built here (same structure as OpenCode's, made-up rows).

use super::source::{self, Reader};
use super::sqlite::{read_totals, Spec};
use rusqlite::Connection;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const OPENCODE_TOML: &str = include_str!("../tui/opencode/usage.toml");

/// 2026-11-13 12:00 UTC.
fn now() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_794_484_800)
}

fn now_ms() -> i64 {
    1_794_484_800_000
}

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-usage-sqlite-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("opencode")).unwrap();
    dir
}

fn message(role: &str, model: &str, cost: f64, input: u64, output: u64, cache_read: u64) -> String {
    format!(
        r#"{{"role":"{role}","modelID":"{model}","cost":{cost},"tokens":{{"total":0,"input":{input},"output":{output},"reasoning":0,"cache":{{"write":0,"read":{cache_read}}}}}}}"#
    )
}

fn database(dir: &PathBuf, rows: &[(i64, String)]) -> PathBuf {
    let path = dir.join("opencode/opencode.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE message (id integer PRIMARY KEY, time_created integer NOT NULL, data text NOT NULL); CREATE TABLE other (x text);").unwrap();
    for (at, data) in rows {
        conn.execute("INSERT INTO message (time_created, data) VALUES (?1, ?2)", rusqlite::params![at, data]).unwrap();
    }
    path
}

fn read(path: &PathBuf) -> Option<super::readers::Reading> {
    let source = source::from_toml(OPENCODE_TOML).expect("opencode usage.toml parses");
    let Reader::SqliteTotals { table, time_column, data_column, only, model, cost, tokens, .. } = &source.reader else {
        panic!("not a sqlite_totals reader")
    };
    read_totals(path, &Spec { table, time_column, data_column, only: only.as_ref(), model, cost, tokens }, now())
}

#[test]
fn opencode_usage_sums_today_and_week() {
    let dir = folder("sums");
    let hour = 3_600_000;
    let path = database(
        &dir,
        &[
            (now_ms() - hour, message("assistant", "model-a", 0.50, 1000, 200, 90_000)),
            (now_ms() - 2 * hour, message("assistant", "model-b", 0.25, 500, 100, 0)),
            // Three days ago: in the week, not today.
            (now_ms() - 3 * 24 * hour, message("assistant", "model-a", 1.0, 2000, 300, 0)),
            // Ten days ago: outside.
            (now_ms() - 10 * 24 * hour, message("assistant", "model-a", 50.0, 9_000_000, 0, 0)),
        ],
    );
    let totals = read(&path).expect("a reading").totals.expect("totals");
    // 2 h before noon UTC can fall on the previous local day in far time zones; the cutoff is local midnight,
    // so assert on the week exactly and on today within what the two recent rows allow.
    assert!((totals.week.cost - 1.75).abs() < 1e-9);
    assert_eq!(totals.week.tokens, 1000 + 200 + 500 + 100 + 2000 + 300);
    assert!(totals.today.cost <= 0.75 + 1e-9 && totals.today.cost >= 0.0);
    assert!(totals.today.tokens <= 1800);
    assert_eq!(totals.models.len(), 2);
    assert_eq!(totals.models[0].model, "model-a", "biggest cost first");
    assert!((totals.models[0].cost - 1.5).abs() < 1e-9);
    assert_eq!(totals.models[1].model, "model-b");
}

#[test]
fn opencode_usage_ignores_other_files() {
    let dir = folder("others");
    let hour = 3_600_000;
    let path = database(
        &dir,
        &[
            (now_ms() - hour, message("assistant", "model-a", 0.5, 100, 10, 0)),
            // A user message and rubbish are not counted.
            (now_ms() - hour, message("user", "model-a", 9.0, 7777, 7777, 0)),
            (now_ms() - hour, "not json".into()),
        ],
    );
    std::fs::write(dir.join("opencode/auth.json"), "{}").unwrap();
    std::fs::write(dir.join("opencode/opencode-dev.db"), b"not a database").unwrap();
    let totals = read(&path).and_then(|r| r.totals).expect("totals");
    assert!((totals.week.cost - 0.5).abs() < 1e-9);
    assert_eq!(totals.week.tokens, 110);
    // A file that is not a database reads as nothing.
    assert!(read(&dir.join("opencode/opencode-dev.db")).is_none());
}

#[test]
fn opencode_usage_missing_folder_is_not_shared() {
    let missing = std::env::temp_dir().join(format!("pm-usage-sqlite-none-{}", uuid::Uuid::new_v4())).join("opencode/opencode.db");
    assert!(read(&missing).is_none());
    // An empty database (nothing in the last 7 days) is not shared either.
    let dir = folder("empty");
    let path = database(&dir, &[(now_ms() - 30 * 24 * 3_600_000, message("assistant", "m", 1.0, 1, 1, 0))]);
    assert!(read(&path).is_none());
}

#[test]
fn opencode_row_has_totals_and_is_ok() {
    // Through `build`: a signed-in main login with the database gives an ok row with totals and no windows.
    let dir = folder("row");
    database(&dir, &[(now_ms() - 3_600_000, message("assistant", "model-a", 0.5, 100, 10, 0))]);
    std::fs::write(dir.join("opencode/auth.json"), "{}").unwrap();
    let source = source::from_toml(OPENCODE_TOML).unwrap();
    let agent = super::AgentUsage { id: "opencode".into(), label: "OpenCode".into(), source, scheme: crate::tui::profile_for("opencode").account_scheme() };
    struct NoProbe;
    impl super::Probe for NoProbe {
        fn run(&self, _: &str, _: &[String], _: &[(String, String)]) -> Option<String> {
            None
        }
    }
    let env_home = dir.to_string_lossy().into_owned();
    let env = move |key: &str| (key == "XDG_DATA_HOME").then(|| env_home.clone());
    let state = parking_lot::Mutex::new(Default::default());
    let inputs = super::Inputs {
        accounts: &[],
        limits: &[],
        probe: &NoProbe,
        env: &env,
        home: None,
        now: now(),
        http: &super::oauth::LiveHttp,
        login_reads: false,
        may_fetch: false,
        force: false,
        oauth_state: &state,
    };
    let snap = super::build(&[agent], &inputs);
    assert_eq!(snap.rows.len(), 1);
    let row = &snap.rows[0];
    assert_eq!(row.state, "ok");
    assert!(row.windows.is_empty());
    assert!(row.totals.is_some());
}
