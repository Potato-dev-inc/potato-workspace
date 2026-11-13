//! Chaos cases A30, A31, A32: a terminal agent that exits mid-turn, spews a one megabyte line, spews binary junk.
//!
//! Filled by branch `test/chaos-a` from SPEC-CHAOS-1113 section 2. Use only `puppet_master_app_lib::fake_tui::{Session, World}`.
//! Included from `fake_tui_e2e.rs` (one test binary, one World).

use puppet_master_app_lib::fake_tui::{Session, World};
use serde_json::{json, Value};

const STOPPED: &[&str] = &["completed", "failed", "cancelled", "needs_input"];

const EXITS: &str = r#"
agent = "claude"
boot_ms = 200
[[turn]]
steps = [{ do = "say", text = "Starting the work." }, { do = "exit", code = 3 }]
"#;

const SPEW_LINE: &str = r#"
agent = "claude"
boot_ms = 200
[[turn]]
steps = [{ do = "spew", bytes = 1048576, kind = "line" }, { do = "say", text = "Line done." }]
"#;

const SPEW_JUNK: &str = r#"
agent = "claude"
boot_ms = 200
[[turn]]
steps = [{ do = "spew", bytes = 65536, kind = "binary" }, { do = "say", text = "Junk done." }]
"#;

fn run(session: &Session) -> Value {
    let started = session.run("fake_claude", "say hello", json!({})).unwrap_or_else(|e| panic!("run_agent refused: {e}"));
    let handle = started["handle"].as_str().expect("handle").to_string();
    session.wait(&handle, STOPPED, 90_000).unwrap_or_else(|e| panic!("wait failed: {e}"))
}

// Person sees: the run is "failed" with "The agent's program closed before it finished."; the receipt does not claim success.
#[ignore = "chaos-finding A30: run shows 'the agent in this pane has exited and the terminal shows a shell prompt; the task was not typed into the shell. Start a new run'"]
#[test]
fn chaos_terminal_agent_exits_mid_turn() {
    let session = World::get().session("chaos-a-exits");
    session.script(EXITS);
    let done = run(&session);
    assert_eq!(done["status"], "failed", "{done}");
    assert_eq!(done["error"]["message"], "The agent's program closed before it finished.", "{done}");
    assert!(!done.to_string().contains("\"completed\""), "the receipt claims success: {done}");
}

// Person sees: the run completes; the pane screen is readable after the one megabyte line.
#[test]
fn chaos_terminal_one_megabyte_line() {
    let session = World::get().session("chaos-a-line");
    session.script(SPEW_LINE);
    let done = run(&session);
    assert_eq!(done["status"], "completed", "{done}");
    let pane = done["pane_id"].as_str().expect("a pane").to_string();
    let screen = session.screen(&pane);
    assert!(!screen.trim().is_empty(), "the pane screen is empty after the big line");
    assert!(screen.contains("Line done."), "the answer after the big line is not on screen");
}

// Person sees: the run completes; the summary has no junk characters.
#[test]
fn chaos_terminal_binary_junk() {
    let session = World::get().session("chaos-a-junk");
    session.script(SPEW_JUNK);
    let done = run(&session);
    assert_eq!(done["status"], "completed", "{done}");
    assert!(!done.to_string().contains('\u{FFFD}'), "junk characters in the run summary: {done}");
    let pane = done["pane_id"].as_str().expect("a pane").to_string();
    let screen = session.screen(&pane);
    assert!(!screen.contains('\u{FFFD}') && !screen.contains('\u{0}'), "junk characters on the pane screen");
}
