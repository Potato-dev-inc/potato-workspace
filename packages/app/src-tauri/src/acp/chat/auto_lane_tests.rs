//! Helpers run as chats by default: the `auto` lane really starts a chat (it used to be refused by the gate and fall
//! back to the terminal every time), what falls back to the terminal and why, and what a chat run proves (its
//! receipt and checks). Fake agent, real processes and pipes; the agent facts come from a test lookup, so nothing
//! depends on the machine's settings.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::lanes::LaneNote;
use super::surface::{self, intercept, intercept_noted_with, LaneLookup};
use super::workspace_tests::{agents, conversations_in, deps_for};
use super::{get, StartDeps};
use crate::acp::config::{AgentConfig, HostEnv};
use crate::acp::conversations::Conversations;
use crate::acp::lane::RunLane;
use crate::operations::OperationError;

type Outcome = (Option<Result<Value, OperationError>>, Option<LaneNote>);

/// The facts about the agent the lane decision asks for, set by each test. Nothing is saved on disk.
struct Lookup {
    dir: PathBuf,
    labs: bool,
    definition: bool,
    installed: bool,
    saved: Option<RunLane>,
    /// The installed OpenCode's major version; `opencode` then stands for the fake agent.
    major: Option<u32>,
}

impl LaneLookup for Lookup {
    fn labs_on(&self) -> bool {
        self.labs
    }
    fn config_for(&self, agent: &str) -> Option<AgentConfig> {
        ((agent == "fake" || (agent == "opencode" && self.major.is_some())) && self.definition).then(|| agents("", &self.dir).0["fake"].as_ref().clone())
    }
    fn saved(&self, _: &str) -> Option<RunLane> {
        self.saved
    }
    fn adapter_installed(&self, _: &AgentConfig, _: &dyn HostEnv) -> bool {
        self.installed
    }
    fn opencode_major(&self) -> Option<u32> {
        self.major
    }
}

struct Fx {
    dir: PathBuf,
    deps: StartDeps,
    lookup: Lookup,
    _conversations: Conversations,
}

impl Fx {
    fn new() -> Fx {
        let dir = std::env::temp_dir().join(format!("pm-acp-auto-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conversations = conversations_in(&dir, "");
        let deps = deps_for(&dir, &conversations);
        let lookup = Lookup { dir: dir.clone(), labs: true, definition: true, installed: true, saved: None, major: None };
        Fx { dir, deps, lookup, _conversations: conversations }
    }

    fn run(&self, extra: Value) -> Outcome {
        self.run_as(extra, None)
    }

    fn run_as(&self, extra: Value, session: Option<&str>) -> Outcome {
        let mut body = json!({ "task": "stream 2", "agent_type": "fake", "project_path": self.dir.to_string_lossy(), "wait_ms": 20000 });
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            body[key] = value;
        }
        intercept_noted_with("POST", &["agents", "run"], "", body.to_string().as_bytes(), &self.deps, session, &self.lookup)
    }

    fn call(&self, method: &str, segments: &[&str], body: Value) -> Value {
        intercept(method, segments, "", body.to_string().as_bytes(), &self.deps, None).expect("a chat's route").expect("answered")
    }

    fn panes(&self) -> usize {
        self.deps.registry.lock().panes.len()
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        for pane in self.deps.registry.lock().panes.keys().cloned().collect::<Vec<_>>() {
            if let Some(chat) = get(&pane) {
                chat.retire();
            }
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn answer(outcome: Outcome) -> Value {
    outcome.0.expect("a chat took it").expect("and answered")
}

#[test]
fn with_no_lane_and_nothing_saved_a_helper_runs_as_a_chat() {
    let fx = Fx::new();
    let (reply, note) = fx.run(json!({}));
    assert!(note.is_none(), "the terminal is not involved");
    let view = reply.expect("a chat took it").expect("and answered");
    assert_eq!(view["lane"], "acp");
    assert_eq!(view["lane_used"], "acp");
    assert!(view["lane_reason"].as_str().unwrap().starts_with("auto:"), "{view}");
    assert_eq!(view["status"], "completed");
    assert_eq!(view["result"], "w0 w1 ");
    assert!(get(view["handle"].as_str().unwrap()).is_some(), "the handle is a live chat");
}

#[test]
fn it_falls_back_to_the_terminal_and_says_why() {
    type Tweak = Box<dyn Fn(&mut Fx)>;
    let cases: Vec<(&str, Tweak, Value, &str)> = vec![
        ("no definition", Box::new(|fx| fx.lookup.definition = false), json!({}), "no chat (ACP) way"),
        ("add-on missing", Box::new(|fx| fx.lookup.installed = false), json!({}), "add-on"),
        ("labs off", Box::new(|fx| fx.lookup.labs = false), json!({}), "off in Labs"),
        ("read_only", Box::new(|_| {}), json!({ "read_only": true }), "read_only"),
        ("headless", Box::new(|_| {}), json!({ "headless": true }), "background"),
        ("isolation", Box::new(|_| {}), json!({ "isolation": "worktree" }), "isolation"),
        ("saved terminal", Box::new(|fx| fx.lookup.saved = Some(RunLane::Terminal)), json!({}), "terminal"),
        ("explicit terminal", Box::new(|_| {}), json!({ "lane": "terminal" }), "terminal"),
    ];
    for (name, tweak, extra, reason) in cases {
        let mut fx = Fx::new();
        tweak(&mut fx);
        let (reply, note) = fx.run(extra);
        assert!(reply.is_none(), "{name}: the terminal runs it");
        let note = note.unwrap_or_else(|| panic!("{name}: the terminal run is explained"));
        assert_eq!(note.used, "terminal", "{name}");
        assert!(note.reason.contains(reason), "{name}: {}", note.reason);
        assert_eq!(fx.panes(), 0, "{name}: no chat was started");
    }
}

#[test]
fn several_terminal_only_options_are_all_named_in_the_reason() {
    let fx = Fx::new();
    let (reply, note) = fx.run(json!({ "read_only": true, "locks": ["file:a"], "budget_turns": 3, "allow_shell": true }));
    assert!(reply.is_none());
    let reason = note.unwrap().reason;
    for field in ["read_only", "locks", "budget_turns", "allow_shell"] {
        assert!(reason.contains(field), "{reason}");
    }
}

#[test]
fn asking_for_a_chat_with_a_terminal_only_option_is_chat_cannot_do() {
    let fx = Fx::new();
    for (extra, field) in [
        (json!({ "read_only": true }), "read_only"),
        (json!({ "backup_agents": ["claude"] }), "backup_agents"),
        (json!({ "scope": "src only" }), "scope"),
        (json!({ "context_policy": "resume" }), "context_policy"),
    ] {
        let mut extra = extra;
        extra["lane"] = json!("acp");
        let (reply, note) = fx.run(extra);
        let error = reply.expect("ours").expect_err("refused");
        assert_eq!(error.code, "CHAT_CANNOT_DO");
        assert!(!error.recoverable);
        assert!(error.message.contains(field), "{}", error.message);
        assert!(error.context["fix"].as_str().unwrap().contains("terminal"));
        assert!(note.is_none());
    }
    assert_eq!(fx.panes(), 0, "nothing was started");
}

#[test]
fn options_a_chat_honours_do_not_send_it_to_the_terminal() {
    let fx = Fx::new();
    let view = answer(fx.run(json!({ "role": "reviewer", "structured_result": true, "context_policy": "packet", "isolation": "none", "locks": [], "model": "b" })));
    assert_eq!(view["lane_used"], "acp");
    assert_eq!(view["model"], "b");
}

#[test]
fn a_chats_receipt_says_what_was_not_checked() {
    let fx = Fx::new();
    let view = answer(fx.run(json!({ "model": "b" })));
    let receipt = &view["receipt"];
    assert_eq!(receipt["backend"], "acp");
    assert_eq!(receipt["outcome"], "completed_unchecked");
    assert_eq!(receipt["checks"], "none configured");
    assert_eq!(receipt["read_only"], "off");
    assert_eq!(receipt["result_capture"], "authoritative");
    assert_eq!(receipt["model"], "b", "the model the agent confirmed");
    assert_eq!(receipt["lane_used"], "acp");
    assert_eq!(receipt["account_source"], "cli_login");
    assert!(receipt["build_id"].as_str().is_some_and(|b| !b.is_empty()));
    let unverified: Vec<&str> = receipt["not_verified"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(unverified, ["no checks configured"], "the confirmed model is not listed as unverified");
    assert!(receipt.get("standby_used").is_none(), "no warm chat was used");
}

#[test]
fn a_passing_check_makes_the_outcome_passed_checks_and_a_failing_one_failed_checks() {
    let fx = Fx::new();
    let pass = answer(fx.run(json!({ "checks": [{ "type": "result_contains", "text": "w1" }] })));
    assert_eq!(pass["receipt"]["outcome"], "passed_checks");
    assert_eq!(pass["receipt"]["checks"], "1/1 passed");
    assert_eq!(pass["acceptance_status"], "passed");
    assert_eq!(pass["checks"][0]["passed"], true);
    assert_eq!(pass["status"], "completed");

    let fail = answer(fx.run(json!({ "checks": [{ "type": "result_contains", "text": "never said" }] })));
    assert_eq!(fail["receipt"]["outcome"], "failed_checks");
    assert_eq!(fail["receipt"]["checks"], "0/1 passed");
    assert_eq!(fail["acceptance_status"], "failed");
    assert_eq!(fail["status"], "failed", "a failing check fails the run like the terminal's");
    assert_eq!(fail["error"]["code"], "ACCEPTANCE_FAILED");
    assert_eq!(fail["result"], "w0 w1 ", "the reply is still there");
}

#[test]
fn checks_run_once_per_turn_and_a_followup_can_replace_them() {
    let fx = Fx::new();
    let marker = fx.dir.join("ran.txt");
    let script = format!("echo x >> {}", marker.to_string_lossy().replace('\\', "/"));
    let command: Vec<String> = if cfg!(windows) { vec!["cmd".into(), "/C".into(), script] } else { vec!["sh".into(), "-c".into(), script] };
    let first = answer(fx.run(json!({ "checks": [{ "type": "command_exits", "command": command }] })));
    assert_eq!(first["receipt"]["outcome"], "passed_checks", "{first}");
    let handle = first["handle"].as_str().unwrap().to_string();
    for _ in 0..3 {
        let waited = fx.call("POST", &["agents", "wait"], json!({ "handles": [handle], "wait_ms": 2000 }));
        assert_eq!(waited["agents"][0]["receipt"]["outcome"], "passed_checks");
        fx.call("GET", &["agents", &handle], Value::Null);
    }
    assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(), 1, "the command ran once for the turn");

    let next = fx.call("POST", &["agents", "followup"], json!({ "handle": handle, "task": "stream 1", "wait_ms": 20000, "checks": [{ "type": "result_contains", "text": "nope" }] }));
    assert_eq!(next["receipt"]["outcome"], "failed_checks", "the new checks replaced the old: {next}");
    assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(), 1, "the old command did not run again");
}

#[test]
fn a_bad_check_is_the_callers_mistake_not_a_reason_for_the_terminal() {
    let fx = Fx::new();
    let (reply, note) = fx.run(json!({ "checks": [{ "type": "file_exists", "path": "/etc/passwd" }] }));
    assert_eq!(reply.expect("ours").expect_err("refused").code, "INVALID_ARGUMENT");
    assert!(note.is_none());
    assert_eq!(fx.panes(), 0);
}

#[test]
fn the_same_idempotency_key_returns_the_chat_it_started() {
    let fx = Fx::new();
    let key = format!("key-{}", uuid::Uuid::new_v4());
    let first = answer(fx.run_as(json!({ "idempotency_key": key }), Some("session-K")));
    let again = answer(fx.run_as(json!({ "idempotency_key": key }), Some("session-K")));
    assert_eq!(first["handle"], again["handle"]);
    assert_eq!(fx.panes(), 1, "one chat, not two");
    // Another session with the same key is another caller.
    let other = answer(fx.run_as(json!({ "idempotency_key": key }), Some("session-L")));
    assert_ne!(first["handle"], other["handle"]);
}

#[test]
fn a_warm_chat_is_named_in_the_receipt() {
    let fx = Fx::new();
    let view = answer(fx.run(json!({})));
    let chat = get(view["handle"].as_str().unwrap()).unwrap();
    chat.set_warm_claimed(true);
    assert_eq!(surface::view(&chat)["receipt"]["standby_used"], true);
}

#[test]
fn the_receipt_lists_a_requested_model_the_agent_did_not_confirm() {
    use super::receipt::{build, ReceiptInputs};
    let inputs = |requested, in_use| ReceiptInputs {
        status: "completed",
        final_turn: true,
        checks_total: 0,
        results: None,
        reply: Some("done"),
        requested_model: requested,
        model_in_use: in_use,
        account: None,
        account_source: None,
        lane_note: None,
        warm: false,
    };
    let unconfirmed = "model not confirmed".to_string();
    assert!(build(&inputs(Some("fast-1"), Some("slow-2"))).not_verified.contains(&unconfirmed));
    assert!(build(&inputs(Some("fast-1"), None)).not_verified.contains(&unconfirmed));
    assert!(!build(&inputs(Some("fast-1"), Some("Fast-1"))).not_verified.contains(&unconfirmed));
    assert!(!build(&inputs(None, Some("slow-2"))).not_verified.contains(&unconfirmed));
}

#[test]
fn a_potato_result_block_in_the_reply_is_the_structured_result() {
    use super::receipt::{build, ReceiptInputs};
    let reply = "All done.\n```potato-result\n{\"summary\":\"ok\",\"files_changed\":[],\"checks_run\":[],\"open_questions\":[]}\n```";
    let receipt = build(&ReceiptInputs {
        status: "completed",
        final_turn: true,
        checks_total: 0,
        results: None,
        reply: Some(reply),
        requested_model: None,
        model_in_use: None,
        account: Some("work"),
        account_source: Some("helper_default"),
        lane_note: None,
        warm: false,
    });
    assert_eq!(receipt.result_capture, "structured");
    assert_eq!(receipt.structured_result.unwrap()["summary"], "ok");
    assert_eq!((receipt.account_used.as_deref(), receipt.account_source.as_str()), (Some("work"), "helper_default"));
}

#[test]
fn with_opencode_2_a_native_run_goes_to_the_opencode_chat_and_says_so() {
    let mut fx = Fx::new();
    fx.lookup.major = Some(2);
    let (reply, note) = fx.run(json!({ "agent_type": "opencode_native" }));
    assert!(note.is_none(), "the terminal is not involved");
    let view = reply.expect("a chat took it").expect("and answered");
    assert_eq!(view["lane_used"], "acp");
    assert!(view["lane_reason"].as_str().unwrap().contains("OpenCode 2.x has no native terminal agent"), "{view}");
}

#[test]
fn with_opencode_2_a_demanded_terminal_for_the_native_agent_is_a_clear_error() {
    let mut fx = Fx::new();
    fx.lookup.major = Some(2);
    let (reply, _) = fx.run(json!({ "agent_type": "opencode_native", "lane": "terminal" }));
    let error = reply.expect("answered").unwrap_err();
    assert_eq!(error.code, "OPENCODE_NATIVE_UNAVAILABLE");
    assert!(error.message.contains("not available with OpenCode 2.x"), "{}", error.message);
}

#[test]
fn with_opencode_1_the_native_agent_is_left_to_the_terminal_path() {
    let mut fx = Fx::new();
    fx.lookup.major = Some(1);
    let (reply, note) = fx.run(json!({ "agent_type": "opencode_native" }));
    assert!(reply.is_none() || note.is_some(), "untouched: no chat was started for opencode_native");
    assert_eq!(fx.panes(), 0);
}
