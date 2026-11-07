//! The ACP check (`wizard/acp_check.rs`): one `initialize` handshake, no network, no real agent. The fake agents are
//! this test binary: each `#[ignore]`d `fake_*` function is a child that runs only when the check starts it with
//! `--ignored --exact <name>`. Normal test runs skip them.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::tui::declarative::wizard::acp_check::{check_env, check_initialize, check_observed, initialize_line, InitCheck};

use super::support::Tree;

const SECRET: &str = "PM_ACP_TEST_SECRET";
const GOOD: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"fake-acp","version":"9.9"}}}"#;
const WRONG: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"ready":true}}"#;

/// Test name as libtest prints it (the crate name is not part of it).
fn child_args(name: &str) -> Vec<String> {
    let module = module_path!().split_once("::").map_or(module_path!(), |(_, rest)| rest);
    vec!["--ignored".into(), "--exact".into(), format!("{module}::{name}"), "--nocapture".into()]
}

fn this_exe() -> PathBuf {
    std::env::current_exe().expect("test binary path")
}

// ---- the fake agents (children only) -------------------------------------------------------------------------

fn say(line: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(format!("{line}\n").as_bytes());
    let _ = out.flush();
}

/// Reads the one request line the check writes, so the parent's write always has a reader.
fn take_request() {
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
}

#[test]
#[ignore]
fn fake_good() {
    take_request();
    say(GOOD);
    std::process::exit(0);
}

#[test]
#[ignore]
fn fake_noise() {
    take_request();
    say("Welcome to the fake agent");
    say("{not json at all");
    say("");
    say(r#"{"jsonrpc":"2.0","method":"log","params":{"level":"info"}}"#);
    say(GOOD);
    std::process::exit(0);
}

#[test]
#[ignore]
fn fake_garbage() {
    say("just words");
    say("[1, 2, 3]");
    say("{broken");
    std::process::exit(0);
}

#[test]
#[ignore]
fn fake_wrong() {
    take_request();
    say(WRONG);
    std::process::exit(0);
}

#[test]
#[ignore]
fn fake_exit() {
    // Returns at once: the harness prints its own lines, then the process ends with no reply.
}

#[test]
#[ignore]
fn fake_hang() {
    std::thread::sleep(Duration::from_secs(120));
}

/// Answers ok only when the secret from the parent is NOT in its environment.
#[test]
#[ignore]
fn fake_env() {
    take_request();
    if std::env::var_os(SECRET).is_some() {
        say(WRONG);
    } else {
        say(GOOD);
    }
    std::process::exit(0);
}

// ---- the check -----------------------------------------------------------------------------------------------

#[test]
fn a_good_initialize_reply_is_ok_with_the_version_and_name() {
    let got = check_initialize(&this_exe(), &child_args("fake_good"), Duration::from_secs(20));
    assert_eq!(
        got,
        InitCheck {
            ok: true,
            protocol_version: Some(1),
            agent_name: Some("fake-acp".into()),
            agent_version: Some("9.9".into()),
            reason: None,
        }
    );
}

#[test]
fn a_reply_after_noise_lines_is_still_ok() {
    let got = check_initialize(&this_exe(), &child_args("fake_noise"), Duration::from_secs(20));
    assert!(got.ok, "{got:?}");
    assert_eq!(got.protocol_version, Some(1));
}

#[test]
fn garbage_only_is_not_ok_and_says_it_exited() {
    let got = check_initialize(&this_exe(), &child_args("fake_garbage"), Duration::from_secs(20));
    assert!(!got.ok);
    assert_eq!(got.reason.as_deref(), Some("exited before replying"));
}

#[test]
fn a_reply_that_is_not_an_initialize_result_is_refused() {
    let got = check_initialize(&this_exe(), &child_args("fake_wrong"), Duration::from_secs(20));
    assert!(!got.ok);
    assert_eq!(got.reason.as_deref(), Some("reply was not an ACP initialize result"));
}

#[test]
fn a_program_that_exits_at_once_is_not_ok() {
    let got = check_initialize(&this_exe(), &child_args("fake_exit"), Duration::from_secs(20));
    assert!(!got.ok);
    assert_eq!(got.reason.as_deref(), Some("exited before replying"));
}

#[test]
fn a_program_that_cannot_start_says_so() {
    let got = check_initialize(Path::new("Z:/no/such/program-zz.exe"), &[], Duration::from_secs(2));
    assert!(!got.ok);
    assert_eq!(got.reason.as_deref(), Some("could not start"));
}

/// A silent child times out after the limit, and the process itself is gone afterwards (checked by PID).
#[test]
#[cfg(windows)]
fn a_silent_program_times_out_and_its_process_is_really_gone() {
    let mut seen: Option<u32> = None;
    let started = Instant::now();
    let got = check_observed(&this_exe(), &child_args("fake_hang"), Duration::from_secs(1), &mut |pid| seen = Some(pid));
    assert!(started.elapsed() < Duration::from_secs(15), "the check must not wait for the child");
    assert!(!got.ok);
    assert_eq!(got.reason.as_deref(), Some("no reply in 1 s"));
    let pid = seen.expect("the child was started");
    assert!(!process_alive(pid), "process {pid} is still running after the check");
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(0x0800_0000)
        .output()
        .expect("tasklist runs");
    String::from_utf8_lossy(&out.stdout).split_whitespace().any(|word| word == pid.to_string())
}

/// The child gets no secret: the parent sets one, the fake agent reports whether it can see it.
#[test]
fn the_child_environment_has_no_secret_from_the_parent() {
    std::env::set_var(SECRET, "s3cret-value");
    let got = check_initialize(&this_exe(), &child_args("fake_env"), Duration::from_secs(20));
    std::env::remove_var(SECRET);
    assert!(got.ok, "the secret reached the child: {got:?}");
}

#[test]
fn the_built_environment_names_are_fixed_and_point_home_into_the_work_folder() {
    std::env::set_var(SECRET, "s3cret-value");
    let home = Path::new("C:/tmp/pm-acp-check-test");
    let vars = check_env(home);
    std::env::remove_var(SECRET);
    let names: Vec<&str> = vars.iter().map(|(k, _)| k.as_str()).collect();
    assert!(!names.iter().any(|n| n.contains("SECRET") || n.contains("KEY") || n.contains("TOKEN")), "{names:?}");
    for key in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] {
        let value = vars.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        assert_eq!(value, Some(home.display().to_string().as_str()), "{key}");
    }
}

#[test]
fn the_request_is_one_initialize_line_and_nothing_else() {
    let line = initialize_line();
    assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
    let v: serde_json::Value = serde_json::from_str(line.trim_end()).expect("json");
    assert_eq!(v["method"], json!("initialize"));
    assert_eq!(v["id"], json!(1));
    assert_eq!(v["params"]["protocolVersion"], json!(1));
    assert!(!line.contains("session/"), "{line}");
}

// ---- detect_program wiring -----------------------------------------------------------------------------------

#[cfg(windows)]
fn write_cmd(dir: &Path, name: &str, body: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(name), format!("@echo off\r\n{body}\r\n")).unwrap();
}

/// A `.cmd` that prints its help with an `acp` row, and answers `acp` with a good reply.
#[cfg(windows)]
const ACP_SHIM: &str = "if \"%1\"==\"acp\" goto acp\necho Usage: shimagent [command]\necho   run   run a task\necho   acp   start the protocol server\nexit /b 0\n:acp\necho {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1,\"agentInfo\":{\"name\":\"shim\",\"version\":\"1.0\"}}}\nexit /b 0";

#[cfg(windows)]
#[test]
fn detect_program_runs_the_check_on_the_help_found_acp_command() {
    use crate::tui::declarative::wizard::acp::detect_program;
    let tree = Tree::new("acp-check-help");
    let dir = tree.root.join("helpbin");
    write_cmd(&dir, "shimagent.cmd", ACP_SHIM);
    let wizard = tree.wizard_with({
        let dir = dir.clone();
        move |e| e.path_dirs = Some(vec![dir.clone()])
    });
    let out = detect_program(&wizard, "shimagent").expect("detect");
    assert_eq!(out["candidates"][0]["args"], json!(["acp"]), "{out}");
    assert_eq!(out["initialize_check"]["ok"], json!(true), "{out}");
    assert_eq!(out["initialize_check"]["protocol_version"], json!(1), "{out}");
    assert_eq!(out["initialize_check"]["agent_name"], json!("shim"), "{out}");
}

/// Help shows no ACP command; `<name>-acp` on PATH answers the handshake, so it is reported as the command.
#[cfg(windows)]
#[test]
fn detect_program_reports_a_sibling_that_answers_when_help_shows_none() {
    use crate::tui::declarative::wizard::acp::detect_program;
    let tree = Tree::new("acp-check-sibling");
    let dir = tree.root.join("siblingbin");
    write_cmd(&dir, "shimagent.cmd", "echo Usage: shimagent [command]\necho   run   run a task\nexit /b 0");
    write_cmd(&dir, "shimagent-acp.cmd", "echo {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}\nexit /b 0");
    let wizard = tree.wizard_with({
        let dir = dir.clone();
        move |e| e.path_dirs = Some(vec![dir.clone()])
    });
    let out = detect_program(&wizard, "shimagent").expect("detect");
    assert_eq!(out["command"], json!("shimagent-acp"), "{out}");
    assert_eq!(out["candidates"][0]["args"], json!([]), "{out}");
    assert_eq!(out["initialize_check"]["ok"], json!(true), "{out}");
}

/// A sibling that does not answer is not reported, and help-only is never called checked.
#[cfg(windows)]
#[test]
fn a_sibling_that_does_not_answer_is_not_reported_and_nothing_is_checked() {
    use crate::tui::declarative::wizard::acp::detect_program;
    let tree = Tree::new("acp-check-silent-sibling");
    let dir = tree.root.join("silentbin");
    write_cmd(&dir, "shimagent.cmd", "echo Usage: shimagent [command]\nexit /b 0");
    write_cmd(&dir, "shimagent-acp.cmd", "echo nothing useful\nexit /b 0");
    let wizard = tree.wizard_with({
        let dir = dir.clone();
        move |e| e.path_dirs = Some(vec![dir.clone()])
    });
    let out = detect_program(&wizard, "shimagent").expect("detect");
    assert!(out["candidates"].as_array().unwrap().is_empty(), "{out}");
    assert!(out["initialize_check"].is_null(), "{out}");
}
