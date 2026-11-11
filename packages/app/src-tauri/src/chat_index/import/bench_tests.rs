//! A headless bench for session files. Ignored by default; run it by hand:
//! `cargo test --lib perf_session_files -- --ignored --nocapture`. It builds a temp store of 2,000 chat files and prints
//! one `PERF` line with the time of a listing, 50 reads, and a browse page asked for twice. It only reads its own temp
//! folder and removes nothing.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use super::browse::BrowseQuery;
use super::fakes::{importer, memory_index};
use super::Source;
use crate::session_chat::history::{
    FileHistory, FileHistorySpec, HistoryEnv, ListLimits, ReadLimits, SessionHistory, SessionKey,
};
use crate::session_chat::{ChatItem, SessionFormat};

const FILES: usize = 2_000;
const FOLDERS: usize = 40;
const LINES: usize = 20;
const BIG_FILES: usize = 20;
const BIG_BYTES: usize = 5 * 1024 * 1024;

struct BenchFormat;

impl SessionFormat for BenchFormat {
    fn parse_line(&self, line: &str, offset: u64) -> Vec<ChatItem> {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { return Vec::new() };
        let text = value.pointer("/message/content").and_then(|text| text.as_str()).unwrap_or_default().to_string();
        let id = format!("{offset}:0");
        match value.get("type").and_then(|kind| kind.as_str()) {
            Some("user") if !text.is_empty() => vec![ChatItem::User { id, at: None, text, attachments: Vec::new() }],
            Some("assistant") if !text.is_empty() => {
                vec![ChatItem::Assistant { id, at: None, text, model: None, final_answer: false }]
            }
            _ => Vec::new(),
        }
    }
}

static FORMAT: BenchFormat = BenchFormat;

const SPEC: FileHistorySpec = FileHistorySpec {
    roots: &["{home}/store"],
    extra_roots_env: &[],
    glob: "*.jsonl",
    skip: &[],
    depth: 1,
    id: SessionKey::FileStem,
    cwd_pointer: Some("/cwd"),
    format: &FORMAT,
    resume: &[],
};

fn session_name(n: usize) -> String {
    format!("bench-session-{n:05}")
}

fn build_store() -> PathBuf {
    let home = std::env::temp_dir().join(format!("pm-perf-files-{}", uuid::Uuid::new_v4()));
    for folder in 0..FOLDERS {
        fs::create_dir_all(home.join("store").join(format!("project-{folder:02}"))).unwrap();
    }
    for n in 0..FILES {
        let path = home.join("store").join(format!("project-{:02}", n % FOLDERS)).join(format!("{}.jsonl", session_name(n)));
        let mut file = fs::File::create(path).unwrap();
        for line in 0..LINES {
            let kind = if line % 2 == 0 { "user" } else { "assistant" };
            let row = serde_json::json!({
                "type": kind,
                "cwd": format!("/work/project-{:02}", n % FOLDERS),
                "message": { "role": kind, "content": format!("line {line} of chat {n}") },
            });
            writeln!(file, "{row}").unwrap();
        }
        if n < BIG_FILES {
            let pad = "x".repeat(50_000);
            for _ in 0..(BIG_BYTES / pad.len()) {
                let row = serde_json::json!({ "type": "assistant", "message": { "role": "assistant", "content": pad } });
                writeln!(file, "{row}").unwrap();
            }
        }
    }
    home
}

fn ms(since: Instant) -> u128 {
    since.elapsed().as_millis()
}

#[test]
#[ignore]
fn perf_session_files() {
    let home = build_store();
    let env = HistoryEnv::fixed(Some(home.clone()), &[]);
    let history: &'static FileHistory = Box::leak(Box::new(FileHistory::new(SPEC)));

    let started = Instant::now();
    let listing = history.list(&env, &ListLimits::default());
    let list_ms = ms(started);
    assert_eq!(listing.chats.len(), FILES);

    let started = Instant::now();
    for chat in listing.chats.iter().take(50) {
        let limits = ReadLimits { max_items: 50_000, max_decompressed: 32 * 1024 * 1024, chunk: 500 };
        history.read(&env, &chat.session, &limits, &mut |_| true).expect("read");
    }
    let read_50_ms = ms(started);

    let (index, _switch) = memory_index();
    let source = Source { id: "bench".into(), label: "bench".into(), from_definition: false, history };
    let (importer, _seen) = importer(vec![source], &index);
    let query = BrowseQuery { agent: "bench".into(), from_ms: None, to_ms: None, offset: 0, limit: 10 };
    let started = Instant::now();
    let first = importer.browse(&env, &query).expect("browse");
    let browse_page_cold_ms = ms(started);
    let started = Instant::now();
    let second = importer.browse(&env, &query).expect("browse again");
    let browse_page_warm_ms = ms(started);
    assert_eq!(first.rows, second.rows);
    assert_eq!(first.rows.len(), 10);

    println!("PERF list_ms={list_ms} read_50_ms={read_50_ms} browse_page_cold_ms={browse_page_cold_ms} browse_page_warm_ms={browse_page_warm_ms}");
}
