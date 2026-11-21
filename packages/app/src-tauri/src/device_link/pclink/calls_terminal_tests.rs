//! P2.3: the terminal rows of `calls.rs`, the terminal frames of `events.rs`, and the rules in `terminal.rs`.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::terminal::{admit, Bucket, Take, BURST, MAX_SHELLS_PER_PC};
use super::tests::Fake;
use super::*;

const ROWS: [(&str, Level); 7] = [
    ("list_panes", Level::Full),
    ("spawn_pane", Level::Full),
    ("write_pane_input", Level::Full),
    ("resize_pane", Level::Full),
    ("kill_pane_cmd", Level::Full),
    ("read_pane_screen_replay", Level::Full),
    ("read_pane_raw_buffer", Level::Full),
];

fn call(level: Level, fake: &Fake, cmd: &str, body: &Value) -> (u16, Value) {
    let who = Caller { node: "aa", name: "Laptop", level: Some(level), marked: false, now_ms: 1_000 };
    handle(&who, fake, &Asks::new(), "POST", &format!("/pclink/call/{cmd}"), &serde_json::to_vec(body).unwrap())
}

#[test]
fn the_block_names_these_rows_at_these_levels_and_none_is_refused() {
    // Other phases add their own blocks to the table: this one is found by what it serves.
    let block: Vec<_> = calls::TABLE.iter().filter(|(c, _, _)| terminal::handles(c)).map(|(c, l, _)| (*c, *l)).collect();
    assert_eq!(block, ROWS);
    for (cmd, level) in ROWS {
        assert_eq!(calls::need(cmd), Some(level), "{cmd}");
        assert!(terminal::handles(cmd), "{cmd}");
        assert_eq!(calls::names_pane(cmd), !matches!(cmd, "list_panes" | "spawn_pane"), "{cmd}");
    }
    assert!(!terminal::handles("acp_chat_state") && !terminal::handles("kill_all_panes"));
    // The old plain-text routes are gone.
    assert_eq!(need("GET", &["sessions", "p1", "screen"]), None);
    assert_eq!(need("POST", &["sessions", "p1", "input"]), None);
}

#[test]
fn only_a_full_pc_gets_any_terminal_row() {
    let fake = Fake::default();
    for (cmd, level) in ROWS {
        let body = json!({ "paneId": "p1", "args": { "text": "ls" }, "cols": 80, "rows": 24, "cwd": "pabc" });
        assert_eq!(level, Level::Full, "S11: nothing that shows a terminal is below Full");
        for low in [Level::Watch, Level::Answer] {
            let (status, answer) = call(low, &fake, cmd, &body);
            assert_eq!((status, answer["code"].as_str()), (403, Some("DEVICE_NOT_ALLOWED")), "{cmd} at {low:?}");
        }
        assert_eq!(call(Level::Full, &fake, cmd, &body).0, 200, "{cmd} at Full");
    }
    // A row that names a pane needs it.
    assert_eq!(call(Level::Full, &fake, "write_pane_input", &json!({ "args": { "text": "x" } })).0, 400);
}

#[test]
fn a_terminal_the_person_shut_for_other_pcs_stays_shut_for_every_row_and_its_frames() {
    let fake = Fake::default();
    fake.locked.lock().unwrap().push("p1".into());
    for (cmd, level) in ROWS.into_iter().filter(|(c, _)| calls::names_pane(c)) {
        let (status, answer) = call(Level::Full, &fake, cmd, &json!({ "paneId": "p1", "args": { "text": "x" }, "cols": 80, "rows": 24 }));
        assert_eq!((status, answer["code"].as_str()), (403, Some("AGENT_LOCKED")), "{cmd} ({level:?})");
    }
    // The door asks the same question of a frame by its pane (`events::app_pane`).
    let frame = events::app_frame("terminal-data", &json!({ "pane_id": "p1", "b64": "aGk=" }));
    assert_eq!(events::app_pane(&frame).as_deref(), Some("p1"));
}

#[test]
fn a_pc_gets_a_shell_and_never_another_program() {
    use terminal::shell_agent;
    let login = shell_agent("shell").unwrap();
    assert!(["powershell", "bash", "cmd"].contains(&login));
    for kept in ["cmd", "powershell", "bash"] {
        assert_eq!(shell_agent(kept), Some(kept));
    }
    for refused in ["claude", "codex", "opencode_native", "", "bash -c x", "../bash", "SHELL"] {
        assert_eq!(shell_agent(refused), None, "{refused}");
    }
}

#[test]
fn one_pc_has_at_most_a_few_shells_and_a_closed_one_frees_its_place() {
    let mut shells = std::collections::HashMap::new();
    let mut alive: std::collections::HashSet<String> = std::collections::HashSet::new();
    for n in 0..MAX_SHELLS_PER_PC {
        assert!(admit(&mut shells, "aa", &alive, MAX_SHELLS_PER_PC), "shell {n}");
        shells.get_mut("aa").unwrap().insert(format!("p{n}"));
        alive.insert(format!("p{n}"));
    }
    assert!(!admit(&mut shells, "aa", &alive, MAX_SHELLS_PER_PC), "the next one is refused");
    assert!(admit(&mut shells, "bb", &alive, MAX_SHELLS_PER_PC), "another PC has its own count");
    alive.remove("p3");
    assert!(admit(&mut shells, "aa", &alive, MAX_SHELLS_PER_PC), "a closed shell frees a place");
}

#[test]
fn output_over_the_rate_becomes_one_redraw_note_not_a_flood() {
    let t0 = Instant::now();
    let mut bucket = Bucket::new(t0);
    let chunk = 64 * 1024;
    let mut sent = 0;
    while bucket.take(t0, chunk) == Take::Send {
        sent += chunk;
    }
    assert!(sent as f64 <= BURST && sent as f64 > BURST - chunk as f64, "the burst is spent: {sent}");
    // The first chunk over the rate says "redraw"; the ones right after say nothing.
    assert_eq!(bucket.take(t0, chunk), Take::Drop, "the viewer was just told");
    assert_eq!(bucket.take(t0 + Duration::from_millis(100), chunk), Take::Drop);
    // Later it is told again (a dropped tail is never left stale), and a quiet second refills the bucket.
    assert_eq!(bucket.take(t0 + Duration::from_millis(600), 10 * chunk), Take::Lag);
    assert_eq!(bucket.take(t0 + Duration::from_secs(10), chunk), Take::Send);
}

#[test]
fn terminal_output_and_size_reach_a_pc_as_app_frames_about_one_pane() {
    let data = "event: terminal\ndata: {\"pane_id\":\"p9\",\"b64\":\"aGk=\",\"offset\":42}\n\n";
    for low in [Level::Watch, Level::Answer] {
        assert!(events::view(low, data).is_none(), "no output frame at {low:?}");
        assert!(events::view(low, "event: pane-resize
data: {\"pane_id\":\"p9\",\"cols\":1,\"rows\":1}

").is_none());
        assert!(events::view(low, &events::app_frame("terminal-data", &json!({ "pane_id": "p9", "b64": "aGk=" }))).is_none());
    }
    let seen = events::view(Level::Full, data).unwrap().into_owned();
    let (_, json) = seen.split_once("data: ").unwrap();
    let frame: Value = serde_json::from_str(json.trim()).unwrap();
    assert_eq!(frame, json!({ "event": "terminal-data", "payload": { "pane_id": "p9", "b64": "aGk=", "offset": 42 } }));
    assert_eq!(events::app_pane(&seen).as_deref(), Some("p9"), "the pane's own rule can shut the frame");
    let size = events::view(Level::Full, "event: pane-resize\ndata: {\"pane_id\":\"p9\",\"cols\":100,\"rows\":30,\"offset\":7}\n\n").unwrap().into_owned();
    assert!(size.contains("\"event\":\"pty://resized\"") && size.contains("\"cols\":100"), "{size}");
    assert_eq!(events::app_pane(&size).as_deref(), Some("p9"));
    // No offset is no field (never null).
    let none = events::view(Level::Full, "event: terminal
data: {\"pane_id\":\"p9\",\"b64\":\"aGk=\",\"offset\":null}

").unwrap().into_owned();
    assert!(!none.contains("offset"), "{none}");
    // A frame without bytes or a pane is nothing.
    assert!(events::view(Level::Full, "event: terminal\ndata: {\"pane_id\":\"p9\"}\n\n").is_none());
    assert!(events::view(Level::Full, "event: terminal\ndata: {\"b64\":\"aGk=\"}\n\n").is_none());
}

#[test]
fn the_door_meters_one_pcs_terminal_output_and_lets_every_other_frame_pass() {
    let plain = events::app_frame("acp-chat-state", &json!({ "paneId": "p1" }));
    assert_eq!(terminal::throttle("meter-node-a", plain.clone()), Some(plain));
    for node in ["meter-node-b", "meter-node-c"] {
        terminal::watch(node, "p1");
    }
    let big = "A".repeat(2 * 1024 * 1024);
    let flood = events::app_frame("terminal-data", &json!({ "pane_id": "p1", "b64": big }));
    let first = terminal::throttle("meter-node-b", flood.clone());
    assert!(first.as_deref().is_some_and(|f| f.contains("\"terminal-lag\"")), "a chunk over the burst becomes a redraw note: {first:?}");
    assert_eq!(terminal::throttle("meter-node-b", flood), None, "and the next is dropped");
    let small = events::app_frame("terminal-data", &json!({ "pane_id": "p1", "b64": "aGk=" }));
    assert_eq!(terminal::throttle("meter-node-c", small.clone()), Some(small), "another PC is not slowed");
}

#[test]
fn a_pc_is_sent_only_the_terminals_it_looked_at() {
    let data = events::app_frame("terminal-data", &json!({ "pane_id": "p5", "b64": "aGk=" }));
    let size = events::app_frame("pty://resized", &json!({ "pane_id": "p5", "cols": 80, "rows": 24 }));
    assert_eq!(terminal::throttle("watch-node-a", data.clone()), None, "never read: nothing");
    assert_eq!(terminal::throttle("watch-node-a", size.clone()), None);
    terminal::watch("watch-node-a", "p5");
    assert_eq!(terminal::throttle("watch-node-a", data.clone()), Some(data.clone()));
    assert_eq!(terminal::throttle("watch-node-a", size.clone()), Some(size));
    assert_eq!(terminal::throttle("watch-node-b", data), None, "another PC did not look");
    // A hidden helper's terminal is never sent, looked at or not.
    crate::pty::hidden::hide("p6-hidden");
    terminal::watch("watch-node-a", "p6-hidden");
    let hidden = events::app_frame("terminal-data", &json!({ "pane_id": "p6-hidden", "b64": "aGk=" }));
    assert_eq!(terminal::throttle("watch-node-a", hidden), None);
}
