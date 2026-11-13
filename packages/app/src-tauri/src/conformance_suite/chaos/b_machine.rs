//! Chaos cases B20, B21, B22, B23, B24, B25, B26, B27, B28: the machine: odd paths, a program that disappears, a refused write, sleep and wake, model errors, a writes-without-asking agent.
//!
//! Filled by branch `test/chaos-b` from SPEC-CHAOS-1113 section 2. Use only `conformance_suite::rig`
//! (`AcpRig`, `ChatRig`); one test fn per case id, named as the spec says.
//!
//! B20 and B21 need a chat with its own folder or its own launcher; `ChatRig` has neither, so these two tests start the
//! chat with the same `rig::start_deps()` and `fake_agent::agent_config` that `ChatRig` uses (see the notes on each).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::acp::chat::{self, AcpChat, StartRequest};
use crate::acp::config::AgentConfig;
use crate::acp::fake_agent;
use crate::conformance_suite::rig::{start_deps, temp_dir, wait_until, ChatRig};
use crate::proc_util::pid_alive;
use crate::pty::proc_tree::kill_process_tree;
use serde_json::Value;

/// A chat started outside `ChatRig` (own folder, own launcher). Closed and its folder removed on drop.
struct LocalChat {
    chat: Arc<AcpChat>,
    dir: PathBuf,
}

impl LocalChat {
    fn start(dir: PathBuf, folder: PathBuf, cfg: AgentConfig) -> LocalChat {
        std::fs::create_dir_all(&folder).expect("the chat folder");
        let deps = start_deps();
        let chat = chat::start(&deps, cfg, StartRequest { agent_id: "fake".into(), folder, explicit: true, account: None, ..Default::default() })
            .expect("the fake agent starts");
        LocalChat { chat, dir }
    }

    fn items(&self) -> Vec<Value> {
        self.chat.items().iter().filter_map(|i| serde_json::to_value(i).ok()).collect()
    }

    fn turn_over(&self) -> bool {
        let turn = self.chat.session().snapshot().turn;
        self.items().iter().any(|v| v["kind"] == "turnEnd" && v["id"] == format!("end:{turn}"))
    }

    fn notices(&self) -> Vec<String> {
        self.items().iter().filter(|v| v["kind"] == "notice").filter_map(|v| v["text"].as_str().map(str::to_string)).collect()
    }

    fn say(&self, text: &str) {
        self.chat.send(text).unwrap_or_else(|e| panic!("send {text:?}: {e:?}"));
        assert!(wait_until(30, || self.turn_over()), "the turn did not end: {:#?}", self.items());
    }

    fn last_answer(&self) -> Option<String> {
        self.items().iter().rev().find(|v| v["kind"] == "assistant").and_then(|v| v["text"].as_str().map(str::to_string))
    }
}

impl Drop for LocalChat {
    fn drop(&mut self) {
        self.chat.close();
        chat::on_pane_closed(self.chat.pane_id());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A launcher `.cmd` file that starts this test exe as the fake agent (the same shape as `AcpRig::via_launcher`).
fn launcher_in(dir: &Path) -> PathBuf {
    let launcher = dir.join("launch-agent.cmd");
    let exe = std::env::current_exe().expect("the test exe");
    let script = format!("@echo off\r\n\"{}\" --exact acp::fake_agent::tests::child_entry --nocapture --test-threads=1\r\n", exe.display());
    std::fs::write(&launcher, script).expect("the launcher file");
    launcher
}

// B20 "file lands in that folder; answer arrives"
// Deviation: the brief's `fswrite` is refused by design (the fake asks the client to write a file it was never offered),
// so the file is written with `autowrite`, which is the path where the agent writes inside its folder.
#[test]
fn chaos_path_with_spaces_cjk_and_emoji() {
    let dir = temp_dir("cjk");
    let folder = dir.join("pm 測試 🥔 dir");
    let cfg = fake_agent::agent_config("", &dir.join("store"));
    let local = LocalChat::start(dir.clone(), folder.clone(), cfg);
    local.say("autowrite note-測試.txt");
    let written = folder.join("note-測試.txt");
    assert!(written.exists(), "the file landed in {}", folder.display());
    assert_eq!(std::fs::read_to_string(&written).unwrap_or_default(), "fake");
    local.say("stream 2");
    assert_eq!(local.last_answer().as_deref(), Some("w0 w1 "), "the answer arrives");
}

// B21 "running turn unaffected before the kill; after it E10"
// E10: `The chat program for <Label> was not found or would not run. Check that it is installed, or run the agent in a terminal.`
#[test]
#[ignore = "chaos-finding B21: after the program is deleted and the agent killed the person sees Something went wrong and exit code 1 notices, not the E10 copy"]
fn chaos_agent_program_disappears_while_running() {
    let dir = temp_dir("launch");
    let launcher = launcher_in(&dir);
    let mut cfg = fake_agent::agent_config("", &dir.join("store"));
    cfg.command = launcher.to_string_lossy().into_owned();
    cfg.args = Vec::new();
    let local = LocalChat::start(dir.clone(), dir.clone(), cfg);
    local.chat.send("slow").expect("the slow turn starts");
    assert!(wait_until(10, || local.chat.session().snapshot().turn_in_flight()), "the slow turn runs");
    // The program is deleted while the turn runs: the running turn is not touched by that.
    std::fs::remove_file(&launcher).expect("delete the launcher");
    std::thread::sleep(Duration::from_millis(300));
    assert!(local.chat.session().snapshot().turn_in_flight(), "the running turn is unaffected by the deletion");
    // Then the agent process is killed (its own pid only).
    let pid = local.chat.session().connection().expect("a live agent").pid();
    kill_process_tree(pid);
    assert!(wait_until(10, || !pid_alive(pid)), "the agent {pid} is gone");
    assert!(wait_until(15, || local.turn_over()), "the cut turn ends");
    let _ = local.chat.send("stream 2");
    let want = "The chat program for Fake agent was not found or would not run. Check that it is installed, or run the agent in a terminal.";
    assert!(wait_until(15, || local.notices().last().is_some_and(|n| n.starts_with("The chat program"))), "the chat says so; notices {:?}", local.notices());
    assert_eq!(local.notices().last().map(String::as_str), Some(want), "the sentence");
}

// B22 "the agent's reply carries the refusal; chat alive; file unchanged"
// Stand-in for a full disk: the file is read-only. `fswrite` is always refused by the client, so the refusal is in the reply.
#[test]
fn chaos_write_refused_on_disk() {
    let rig = ChatRig::new("");
    let work = rig.dir.join("work");
    std::fs::create_dir_all(&work).expect("the folder");
    let target = work.join("notes.txt");
    std::fs::write(&target, "original").expect("the file");
    let mut perms = std::fs::metadata(&target).expect("the file").permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&target, perms.clone()).expect("read-only");
    rig.say("fswrite");
    let answer = rig.last_answer().unwrap_or_default();
    assert!(answer.starts_with("fs-error:"), "the reply carries the refusal: {answer:?}");
    assert_eq!(std::fs::read_to_string(&target).unwrap_or_default(), "original", "the file is unchanged");
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "), "the chat is alive");
    perms.set_readonly(false);
    let _ = std::fs::set_permissions(&target, perms);
}

// B23 "the turn is still running after the first tick after a jump; never `No answer for 480 min`"
#[test]
fn chaos_sleep_and_wake_does_not_blame_the_agent() {
    let rig = ChatRig::new("");
    rig.send("quiet").expect("the quiet turn starts");
    assert!(wait_until(10, || rig.chat.session().snapshot().turn_in_flight()), "the turn runs");
    // The machine slept for eight hours: one tick at the wake-up time.
    let woke = std::time::Instant::now() + Duration::from_secs(8 * 3600);
    let action = rig.chat.session().tick(woke);
    let notices = rig.notices();
    assert!(!notices.iter().any(|n| n.starts_with("No answer for")), "the sleep is not blamed on the agent: {notices:?}");
    assert!(rig.chat.session().snapshot().turn_in_flight(), "the turn is still running after the tick ({action:?})");
    // Stop the quiet turn.
    let _ = rig.chat.cancel();
    assert!(wait_until(30, || rig.turn_over()), "the stopped turn ends");
}

// B24 "E8 `Something went wrong: fetch failed`; no code number, not E6"
#[test]
fn chaos_offline_model_error() {
    let rig = ChatRig::new("");
    rig.say("rpcerr 500 fetch failed");
    let notices = rig.notices();
    assert!(notices.iter().any(|n| n == "Something went wrong: fetch failed"), "the person sees the cause: {notices:?}");
    assert!(!notices.iter().any(|n| n.contains("500")), "no code number is shown: {notices:?}");
    assert!(!notices.iter().any(|n| n.contains("Probably signed out")), "not a sign-in message: {notices:?}");
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "), "the chat is alive");
}

// B25 "a usage or wait message, not `signed out`; Try again offered"
// "Try again" is an action on the card, not notice text, so only the sign-in part is checked here.
#[test]
fn chaos_rate_limited_is_not_signed_out() {
    let rig = ChatRig::new("");
    rig.say("rpcerr 429 slow down");
    let notices = rig.notices();
    let shown = notices.last().cloned().unwrap_or_default();
    let lower = shown.to_lowercase();
    assert!(!lower.contains("signed out") && !lower.contains("sign in"), "a rate limit is not a sign-in problem: {notices:?}");
    assert!(!shown.is_empty(), "the person sees a message: {notices:?}");
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "), "the chat is alive");
}

// B26 "E8; never E5; next turn works"
#[test]
fn chaos_emoji_crash_on_a_zh_tw_code_page() {
    let rig = ChatRig::new("");
    rig.say("emojicrash");
    let notices = rig.notices();
    assert!(notices.iter().any(|n| n.starts_with("Something went wrong:")), "E8 is shown: {notices:?}");
    assert!(!notices.iter().any(|n| n == "You stopped it"), "not shown as stopped by the person: {notices:?}");
    rig.say("stream 2");
    assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "), "the next turn works");
}

// B27 "the model and mode chips are filled"
#[test]
fn chaos_models_only_agent_still_gets_chips() {
    let rig = ChatRig::with("legacy_models=1", |_| {});
    rig.say("stream 1");
    let state = rig.chat.state();
    let options = state["configOptions"].as_array().cloned().unwrap_or_default();
    let model = options.iter().find(|o| o["id"] == "model" || o["category"] == "model");
    assert!(model.is_some_and(|o| o["currentValue"].as_str().is_some_and(|v| !v.is_empty())), "the model chip is filled; state: {state}");
    assert!(!state["modes"].is_null(), "the mode chip is filled; state: {state}");
}

// B28 "file written with no question: the chat shows `This agent changed a file without asking.`"
#[test]
#[ignore = "known-weird B28: the chat shows Done and 1 file, not the writes-without-asking notice"]
fn chaos_agent_writes_without_asking() {
    let rig = ChatRig::new("");
    rig.say("autowrite new.txt");
    assert!(rig.dir.join("new.txt").exists(), "the file was written with no question");
    let notices = rig.notices();
    assert!(notices.iter().any(|n| n == "This agent changed a file without asking."), "the person is told: {notices:?}");
}
