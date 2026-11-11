//! Tests for OpenCode 2.x's old-chat reader. Every database here is written by the test itself from made-up rows
//! (no person's data, no real OpenCode folder), in a temp folder that the injected `HistoryEnv` points at.
//! The 1.x fixture (`fixtures/history/opencode.db`) is copied in for the old-layout check.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::super::chat::map::map_messages;
use super::super::history::HISTORY;
use crate::session_chat::history::{HistoryEnv, ListLimits, ReadError, ReadLimits, ReadOutcome, SessionHistory};
use crate::session_chat::ChatItem;

/// The 1.x fixture the old-layout test reuses.
const LEGACY_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/tui/opencode/fixtures/history/opencode.db");

const CHAT_A: &str = "ses_fixture2000a1"; // the newest parent chat: a question, two tool calls, an answer
const CHAT_B: &str = "ses_fixture2000b2"; // an older parent chat with one question
const EMPTY: &str = "ses_fixture2000e5"; // a parent chat with no messages
const CORRUPT: &str = "ses_fixture2000d4"; // a parent chat whose rows are not JSON objects
const CHILD: &str = "ses_fixture2000c3"; // a sub-agent session under CHAT_A: never listed
const LEGACY: &str = "ses_fixture0000a1"; // a chat that exists only in the 1.x tables

/// The 2.x tables, with the columns the reader uses and the NOT NULL columns of OpenCode 2.2.7.
const V2_DDL: &str = "
CREATE TABLE project (
  id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
  sandboxes TEXT NOT NULL
);
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL,
  directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE TABLE session_message (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
";

/// The 1.x tables, as the older layout has them (used for the mixed-file case: the stale copy).
const V1_DDL: &str = "
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
  title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
";

/// The 2.x sessions: (id, parent, folder, title, updated ms).
const SESSIONS: [(&str, Option<&str>, &str, &str, i64); 5] = [
    (CHAT_A, None, r"C:\Users\you\demo-chat", "Made-up chat A", 1_788_000_600_000_i64),
    (CHAT_B, None, r"C:\Users\you\notes", "Made-up chat B", 1_787_000_100_000_i64),
    (EMPTY, None, r"C:\Users\you\empty", "Made-up empty chat", 1_786_000_000_000_i64),
    (CORRUPT, None, r"C:\Users\you\broken", "Made-up broken chat", 1_786_500_000_000_i64),
    (CHILD, Some(CHAT_A), r"C:\Users\you\demo-chat", "Made-up sub-agent", 1_788_000_400_000_i64),
];

/// The 2.x message rows: (id, session, type, seq, data). Written out of seq order on purpose.
fn message_rows() -> Vec<(&'static str, &'static str, &'static str, i64, String)> {
    vec![
        ("msg_fixture2_a2", CHAT_A, "assistant", 3, assistant_two()),
        ("msg_fixture2_u1", CHAT_A, "user", 1, user("Made-up question: what is in the sample folder?", 1_788_000_000_100_i64)),
        ("msg_fixture2_a1", CHAT_A, "assistant", 2, assistant_one()),
        ("msg_fixture2_s1", CHAT_A, "system", 4, json!({"text": "Made-up system text.", "time": {"created": 1_788_000_000_950_i64}}).to_string()),
        ("msg_fixture2_i1", CHAT_A, "idle", 5, json!({"time": {"created": 1_788_000_000_960_i64}}).to_string()),
        ("msg_fixture2_u2", CHAT_B, "user", 1, user("Made-up note: remember the blue folder.", 1_787_000_000_100_i64)),
        ("msg_fixture2_c1", CHILD, "user", 1, user("Made-up sub-agent text.", 1_788_000_000_400_i64)),
        ("msg_fixture2_x1", CORRUPT, "user", 1, "{not json".to_string()),
        ("msg_fixture2_x2", CORRUPT, "assistant", 2, "[1, 2, 3]".to_string()),
    ]
}

fn user(text: &str, created: i64) -> String {
    json!({"text": text, "time": {"created": created}}).to_string()
}

/// The first answer: a reasoning block (not shown), a glob call that completed, and a token count. Stops for tools.
fn assistant_one() -> String {
    json!({
        "agent": "build",
        "model": {"providerID": "demo", "id": "demo-model", "variant": ""},
        "content": [
            {"type": "reasoning", "text": "Made-up thinking.", "time": {"created": 1_788_000_000_210_i64}},
            {
                "type": "tool", "id": "call_fixture_1", "name": "glob",
                "state": {
                    "status": "completed",
                    "input": {"pattern": "*.txt", "path": r"C:\Users\you\demo-chat"},
                    "content": [{"type": "text", "text": "notes.txt\nlist.txt"}],
                    "metadata": {}
                },
                "time": {"created": 1_788_000_000_300_i64, "completed": 1_788_000_000_350_i64}
            }
        ],
        "finish": "tool-calls",
        "cost": 0,
        "tokens": {"input": 10, "output": 5, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "time": {"created": 1_788_000_000_200_i64, "completed": 1_788_000_000_400_i64}
    })
    .to_string()
}

/// The last answer: a bash call that failed, then the text, and the stop.
fn assistant_two() -> String {
    json!({
        "agent": "build",
        "model": {"providerID": "demo", "id": "demo-model", "variant": ""},
        "content": [
            {
                "type": "tool", "id": "call_fixture_2", "name": "bash",
                "state": {
                    "status": "error",
                    "input": {"command": "made-up-command"},
                    "error": {"type": "ToolError", "message": "Made-up failure."}
                },
                "time": {"created": 1_788_000_000_500_i64, "completed": 1_788_000_000_520_i64}
            },
            {"type": "text", "text": "Made-up answer: two text files are there."}
        ],
        "finish": "stop",
        "cost": 0,
        "tokens": {"input": 20, "output": 8, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "time": {"created": 1_788_000_000_500_i64, "completed": 1_788_000_000_900_i64}
    })
    .to_string()
}

/// A temp data folder (`<share>/opencode`) that holds `opencode.db`, and the env that reaches it through
/// `XDG_DATA_HOME`. The home folder is a made-up Windows one.
fn env_for(tag: &str, db_from: impl FnOnce(&Path)) -> (PathBuf, HistoryEnv) {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_nanos());
    let share = std::env::temp_dir().join(format!("pm-oc2-{tag}-{}-{nanos}", std::process::id()));
    let folder = share.join("opencode");
    fs::create_dir_all(&folder).expect("data folder");
    db_from(&folder.join("opencode.db"));
    let share_text = share.to_string_lossy().into_owned();
    let env = HistoryEnv::fixed(Some(PathBuf::from(r"C:\Users\you")), &[("XDG_DATA_HOME", share_text.as_str())]);
    (folder, env)
}

/// A 2.x database with the made-up rows above.
fn write_v2(path: &Path) {
    let conn = Connection::open(path).expect("database");
    conn.execute_batch(V2_DDL).expect("2.x tables");
    for (id, parent, folder, title, updated) in SESSIONS {
        conn.execute(
            "INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
             VALUES (?1, 'prj_fixture', ?2, 'made-up', ?3, ?4, '2.2.7', ?5, ?5)",
            params![id, parent, folder, title, updated],
        )
        .expect("session row");
    }
    for (id, session, kind, seq, data) in message_rows() {
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
            params![id, session, kind, seq, seq * 1000, data],
        )
        .expect("message row");
    }
}

/// The same file with the 1.x tables too, holding a stale copy of a chat the 2.x tables do not have.
fn write_v2_with_stale_v1(path: &Path) {
    write_v2(path);
    let conn = Connection::open(path).expect("database");
    conn.execute_batch(V1_DDL).expect("1.x tables");
    conn.execute(
        "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?1, 'prj_fixture', 'made-up', ?2, 'Made-up old copy', '1.19.0', 1, 1)",
        params![LEGACY, r"C:\Users\you\old"],
    )
    .expect("stale row");
}

/// Every chat item one read gives, and the read's own result.
fn read_all(env: &HistoryEnv, session: &str) -> (Vec<ChatItem>, Result<ReadOutcome, ReadError>) {
    let mut got = Vec::new();
    let outcome = HISTORY.read(env, session, &ReadLimits::default(), &mut |batch| {
        got.extend(batch);
        true
    });
    (got, outcome)
}

/// The kind of each item, in order: enough to check the order and the shape without comparing every field.
fn kinds(items: &[ChatItem]) -> Vec<&'static str> {
    items
        .iter()
        .map(|item| match item {
            ChatItem::User { .. } => "user",
            ChatItem::Assistant { .. } => "assistant",
            ChatItem::ToolCall { .. } => "call",
            ChatItem::ToolResult { .. } => "result",
            ChatItem::Usage { .. } => "usage",
            ChatItem::TurnEnd { .. } => "end",
            _ => "other",
        })
        .collect()
}

#[test]
fn lists_parent_chats_newest_first_and_leaves_sub_agent_sessions_out() {
    let (_dir, env) = env_for("list", write_v2);
    let listing = HISTORY.list(&env, &ListLimits::default());
    let ids: Vec<&str> = listing.chats.iter().map(|chat| chat.session.as_str()).collect();
    assert_eq!(ids, [CHAT_A, CHAT_B, CORRUPT, EMPTY]);
    assert_eq!(listing.unreadable, 0);
    let first = &listing.chats[0];
    assert_eq!(first.updated_ms, 1_788_000_600_000_i64);
    assert!(first.bytes > 0);
    assert!(first.cwd.as_deref().is_some_and(|cwd| cwd.ends_with("demo-chat")), "{:?}", first.cwd);
    assert!(listing.chats.iter().find(|chat| chat.session == EMPTY).is_some_and(|chat| chat.bytes == 0));
}

#[test]
fn reads_the_chat_in_seq_order_with_tool_calls_results_and_no_reasoning() {
    let (_dir, env) = env_for("read", write_v2);
    let (items, outcome) = read_all(&env, CHAT_A);
    assert_eq!(outcome, Ok(ReadOutcome { items: items.len(), cut_short: false }));
    // The question, the glob call and its result, the token count, the failed bash call and its result, the answer,
    // its token count and the end of the turn. The reasoning, the system row and the idle row give nothing.
    assert_eq!(kinds(&items), ["user", "call", "result", "usage", "call", "result", "assistant", "usage", "end"]);

    match &items[0] {
        ChatItem::User { text, .. } => assert!(text.starts_with("Made-up question")),
        _ => panic!("first item is not the question"),
    }
    match &items[1] {
        ChatItem::ToolCall { name, call_id, .. } => {
            assert_eq!(name, "glob");
            assert_eq!(call_id, "call_fixture_1");
        }
        _ => panic!("second item is not the glob call"),
    }
    match &items[2] {
        ChatItem::ToolResult { ok, output, .. } => {
            assert!(ok);
            assert_eq!(output, "notes.txt\nlist.txt");
        }
        _ => panic!("third item is not the glob result"),
    }
    match &items[5] {
        ChatItem::ToolResult { ok, output, .. } => {
            assert!(!ok, "a failed call must read as failed");
            assert_eq!(output, "Made-up failure.");
        }
        _ => panic!("the failed bash result is not there"),
    }
    match &items[6] {
        ChatItem::Assistant { text, final_answer, .. } => {
            assert_eq!(text, "Made-up answer: two text files are there.");
            assert!(final_answer);
        }
        _ => panic!("the answer is not there"),
    }
}

#[test]
fn an_empty_chat_and_a_corrupt_chat_read_nothing_and_do_not_crash() {
    let (_dir, env) = env_for("empty", write_v2);
    assert_eq!(read_all(&env, EMPTY), (Vec::new(), Ok(ReadOutcome { items: 0, cut_short: false })));
    // Rows that are not JSON objects give no items; the read still succeeds.
    assert_eq!(read_all(&env, CORRUPT), (Vec::new(), Ok(ReadOutcome { items: 0, cut_short: false })));
}

#[test]
fn an_unknown_chat_is_missing_for_a_read() {
    let (_dir, env) = env_for("missing", write_v2);
    assert_eq!(read_all(&env, "ses_nothere000000").1, Err(ReadError::Missing));
}

#[test]
fn a_file_with_both_layouts_is_read_as_2x_and_the_stale_1x_copy_is_not_listed() {
    let (_dir, env) = env_for("both", write_v2_with_stale_v1);
    let listing = HISTORY.list(&env, &ListLimits::default());
    assert!(listing.chats.iter().all(|chat| chat.session != LEGACY), "the stale copy is listed");
    assert!(listing.chats.iter().any(|chat| chat.session == CHAT_A));
    assert_eq!(read_all(&env, LEGACY).1, Err(ReadError::Missing));
    assert_eq!(read_all(&env, CHAT_A).1.map(|outcome| outcome.items), Ok(9));
}

#[test]
fn a_1x_database_still_lists_and_reads_its_old_layout() {
    let (_dir, env) = env_for("legacy", |path| {
        fs::copy(LEGACY_FIXTURE, path).expect("copy of the 1.x fixture");
    });
    let listing = HISTORY.list(&env, &ListLimits::default());
    assert!(listing.chats.iter().any(|chat| chat.session == LEGACY), "{:?}", listing.chats);
    let (items, outcome) = read_all(&env, LEGACY);
    assert!(outcome.is_ok());
    assert!(!items.is_empty());
}

#[test]
fn a_2x_database_missing_a_column_the_reader_needs_is_format_for_a_read() {
    let (_dir, env) = env_for("no-seq", |path| {
        let conn = Connection::open(path).expect("database");
        conn.execute_batch(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
               directory TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
             CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
               VALUES ('ses_fixture2000a1', 'prj', 'made-up', 'C:/Users/you/x', '2.2.7', 1, 1);",
        )
        .expect("layout without seq");
    });
    assert_eq!(read_all(&env, CHAT_A).1, Err(ReadError::Format));
}

#[test]
fn reading_never_changes_the_database_file() {
    let (folder, env) = env_for("untouched", write_v2);
    let path = folder.join("opencode.db");
    let before = fs::read(&path).expect("bytes");
    let _ = HISTORY.list(&env, &ListLimits::default());
    let _ = read_all(&env, CHAT_A);
    assert_eq!(fs::read(&path).expect("bytes"), before);
    let names: Vec<String> = fs::read_dir(&folder).expect("folder").filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["opencode.db".to_string()], "a read left files behind: {names:?}");
}

#[test]
fn the_message_rows_turn_into_the_shape_the_mapper_reads() {
    let mut picked: Vec<(&str, &str, &str, i64, String)> = message_rows().into_iter().filter(|row| row.1 == CHAT_A).collect();
    picked.sort_by_key(|row| row.3);
    let rows: Vec<(String, String, String)> = picked.into_iter().map(|(id, _, kind, _, data)| (id.to_string(), kind.to_string(), data)).collect();
    let messages: Vec<Value> = super::to_messages(&rows, CHAT_A);
    let items = map_messages(&messages, &|_, _| None);
    assert_eq!(kinds(&items), ["user", "call", "result", "usage", "call", "result", "assistant", "usage", "end"]);
}
