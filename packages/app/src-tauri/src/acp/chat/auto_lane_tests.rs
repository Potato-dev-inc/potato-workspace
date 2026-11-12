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
    /// The fake agent's options (`acp::fake_agent`, plus `read_only=` of `workspace_tests::agents`).
    opts: String,
    /// The definition says the terminal is no way out (`chat_only`).
    chat_only: bool,
}

impl LaneLookup for Lookup {
    fn labs_on(&self) -> bool {
        self.labs
    }
    fn config_for(&self, agent: &str) -> Option<AgentConfig> {
        ((agent == "fake" || (agent == "opencode" && self.major.is_some())) && self.definition).then(|| {
            let mut cfg = agents(&self.opts, &self.dir).0["fake"].as_ref().clone();
            cfg.chat_only = self.chat_only;
            cfg
        })
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
        Fx::with_opts("")
    }

    fn with_opts(opts: &str) -> Fx {
        let dir = std::env::temp_dir().join(format!("pm-acp-auto-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conversations = conversations_in(&dir, opts);
        let deps = deps_for(&dir, &conversations);
        let lookup = Lookup { dir: dir.clone(), labs: true, definition: true, installed: true, saved: None, major: None, opts: opts.to_string(), chat_only: false };
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
fn a_model_the_agent_does_not_offer_falls_back_unless_the_definition_says_chat_only() {
    let fx = Fx::new();
    let (reply, note) = fx.run(json!({ "model": "no-such-model-1017" }));
    assert!(reply.is_none() && note.is_some_and(|n| n.used == "terminal" && n.reason.contains("could not start")), "an ordinary agent still gets the terminal");
    let mut only = Fx::new();
    only.lookup.chat_only = true;
    let (reply, note) = only.run(json!({ "model": "no-such-model-1017" }));
    let error = reply.expect("the chat answers").expect_err("a plain error, not the terminal");
    assert!(note.is_none());
    assert_eq!(error.code, "UNKNOWN_MODEL");
    assert!(error.context.get("fallback").is_none(), "{:?}", error.context);
}

#[test]
fn a_stale_helper_default_model_is_dropped_with_a_note_and_the_chat_still_starts() {
    let mut fx = Fx::new();
    fx.lookup.chat_only = true;
    let view = answer(fx.run(json!({ "model": "no-such-model-1017", "model_from_helper_default": true })));
    assert_eq!(view["status"], "completed", "{view}");
    assert!(get(view["handle"].as_str().unwrap()).is_some());
}

#[test]
fn several_terminal_only_options_are_all_named_in_the_reason() {
    let fx = Fx::new();
    let (reply, note) = fx.run(json!({ "isolation": "worktree", "locks": ["file:a"], "budget_turns": 3, "allow_shell": true }));
    assert!(reply.is_none());
    let reason = note.unwrap().reason;
    for field in ["isolation", "locks", "budget_turns", "allow_shell"] {
        assert!(reason.contains(field), "{reason}");
    }
}

#[test]
fn asking_for_a_chat_with_a_terminal_only_option_is_chat_cannot_do_when_strict() {
    let fx = Fx::new();
    for (extra, field) in [
        (json!({ "read_only": true }), "read_only"),
        (json!({ "backup_agents": ["claude"] }), "backup_agents"),
        (json!({ "scope": "src only" }), "scope"),
        (json!({ "context_policy": "resume" }), "context_policy"),
    ] {
        let mut extra = extra;
        extra["lane"] = json!("acp");
        extra["strict"] = json!(true);
        let (reply, note) = fx.run(extra);
        let error = reply.expect("ours").expect_err("refused");
        assert_eq!(error.code, "CHAT_CANNOT_DO");
        assert!(!error.recoverable);
        assert!(error.message.contains(field), "{}", error.message);
        assert_eq!(error.context["try"]["tool"], "run_agent");
        assert_eq!(error.context["try"]["tool"], "run_agent");
        assert!(note.is_none());
    }
    assert_eq!(fx.panes(), 0, "nothing was started");
}

#[test]
fn asking_for_a_chat_with_a_terminal_only_option_runs_in_the_terminal_and_says_so() {
    let fx = Fx::new();
    for (extra, field) in [(json!({ "isolation": "worktree" }), "isolation"), (json!({ "backup_agents": ["claude"] }), "backup_agents")] {
        let mut extra = extra;
        extra["lane"] = json!("acp");
        let (reply, note) = fx.run(extra);
        assert!(reply.is_none(), "the terminal runs it");
        let note = note.expect("explained");
        assert_eq!(note.used, "terminal");
        let adjusted = &note.adjusted[0];
        assert_eq!((adjusted["field"].as_str(), adjusted["asked"].as_str(), adjusted["used"].as_str()), (Some("lane"), Some("acp"), Some("terminal")));
        assert!(adjusted["why"].as_str().unwrap().contains(field), "{adjusted}");
        assert_eq!(note.to_value()["adjusted"][0]["used"], "terminal");
    }
    assert_eq!(fx.panes(), 0);
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
        read_only: false,
        read_only_enforcement: "permission_reject",
        read_only_proof: None,
        checks: &[],
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
        read_only: false,
        read_only_enforcement: "permission_reject",
        read_only_proof: None,
        checks: &[],
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
fn with_opencode_2_a_demanded_terminal_for_the_native_agent_is_a_clear_error_when_strict() {
    let mut fx = Fx::new();
    fx.lookup.major = Some(2);
    let (reply, _) = fx.run(json!({ "agent_type": "opencode_native", "lane": "terminal", "strict": true }));
    let error = reply.expect("answered").unwrap_err();
    assert_eq!(error.code, "OPENCODE_NATIVE_UNAVAILABLE");
    assert!(error.message.contains("not available with OpenCode 2.x"), "{}", error.message);
    assert_eq!(error.context["try"]["args"]["agent_type"], "opencode_native");
    assert!(error.context["try"]["args"].get("lane").is_none() || error.context["try"]["args"]["lane"] == "acp", "{}", error.context);
}

#[test]
fn with_opencode_2_a_demanded_terminal_for_the_native_agent_runs_as_a_chat_and_says_so() {
    let mut fx = Fx::new();
    fx.lookup.major = Some(2);
    let view = answer(fx.run(json!({ "agent_type": "opencode_native", "lane": "terminal" })));
    assert_eq!(view["lane_used"], "acp");
    assert_eq!(view["adjusted"][0]["asked"], "terminal");
    assert_eq!(view["adjusted"][0]["used"], "acp");
}

#[test]
fn with_opencode_1_the_native_agent_is_left_to_the_terminal_path() {
    let mut fx = Fx::new();
    fx.lookup.major = Some(1);
    let (reply, note) = fx.run(json!({ "agent_type": "opencode_native" }));
    assert!(reply.is_none() || note.is_some(), "untouched: no chat was started for opencode_native");
    assert_eq!(fx.panes(), 0);
}

// ---- read-only chats ------------------------------------------------------------------------------------------

fn handle_of(view: &Value) -> String {
    view["handle"].as_str().unwrap().to_string()
}

fn follow(fx: &Fx, handle: &str, task: &str) -> Value {
    fx.call("POST", &["agents", "followup"], json!({ "handle": handle, "task": task, "wait_ms": 20000 }))
}

#[test]
fn a_read_only_chat_rejects_edits_and_file_writes_allows_reads_and_the_receipt_says_enforced() {
    let fx = Fx::with_opts("modes=1;read_only=plan");
    let (reply, note) = fx.run(json!({ "read_only": true, "task": "mode" }));
    assert!(note.is_none(), "an agent with no terminal read-only runs read-only as a chat");
    let view = reply.expect("a chat took it").expect("and answered");
    assert_eq!(view["lane_used"], "acp");
    assert_eq!(view["result"], "mode:plan", "the agent's own read-only mode was picked before the first message");
    assert_eq!(view["receipt"]["read_only"], "enforced");
    let handle = handle_of(&view);

    // Every tool that is not a read is rejected by this app, without a question to anyone.
    for kind in ["edit", "delete", "move", "execute", "other", "switch_mode"] {
        let view = follow(&fx, &handle, &format!("permkind {kind}"));
        assert_eq!(view["status"], "completed", "{kind}: the agent was answered, not parked: {view}");
        assert_eq!(view["result"], format!("asked:{kind} outcome:selected option:reject_once"), "{kind}");
    }
    // A file write is never served.
    let view = follow(&fx, &handle, "fswrite");
    let result = view["result"].as_str().unwrap();
    assert!(result.starts_with("fs-error:-32601") && result.contains("read-only"), "{result}");
    // A read is not rejected: it is the normal question, open for an answer.
    let view = follow(&fx, &handle, "permkind read");
    assert_eq!(view["status"], "waiting_input", "{view}");
    assert_eq!(view["prompt"]["tool_kind"], "read");
    assert_eq!(view["receipt"]["read_only"], "enforced");
    let _ = fx.call("POST", &["agents", "cancel"], json!({ "handle": handle }));
}

#[test]
fn a_chat_that_is_not_read_only_still_parks_an_edit_question() {
    let fx = Fx::with_opts("read_only=plan_ask");
    let view = answer(fx.run(json!({ "task": "permkind edit", "wait_ms": 3000 })));
    assert_eq!(view["status"], "waiting_input", "{view}");
    assert_eq!(view["receipt"]["read_only"], "off");
    let _ = fx.call("POST", &["agents", "cancel"], json!({ "handle": handle_of(&view) }));
}

// ---- auto_approve: "reads" -------------------------------------------------------------------------------------

#[test]
fn auto_approve_reads_answers_reads_allow_once_and_logs_them_in_the_receipt() {
    let fx = Fx::with_opts("read_only=plan_ask");
    let view = answer(fx.run(json!({ "auto_approve": "reads", "task": "permkind read", "wait_ms": 20000 })));
    assert_eq!(view["status"], "completed", "a read did not park the turn: {view}");
    assert_eq!(view["result"], "asked:read outcome:selected option:allow_once");
    assert_eq!(view["auto_approve"], "reads");
    assert_eq!(view["receipt"]["auto_approved"][0]["kind"], "read", "{view}");
    let handle = handle_of(&view);
    for kind in ["search", "fetch", "think"] {
        let next = follow(&fx, &handle, &format!("permkind {kind}"));
        assert_eq!(next["result"], format!("asked:{kind} outcome:selected option:allow_once"), "{kind}");
    }
    assert_eq!(follow(&fx, &handle, "permkind read")["auto_approved"].as_array().unwrap().len(), 5);
}

#[test]
fn auto_approve_reads_never_answers_an_edit_or_a_command_they_still_park() {
    let fx = Fx::with_opts("read_only=plan_ask");
    for kind in ["edit", "execute", "delete", "move", "other"] {
        let view = answer(fx.run(json!({ "auto_approve": "reads", "task": format!("permkind {kind}"), "wait_ms": 3000 })));
        assert_eq!(view["status"], "waiting_input", "{kind} must wait for a person: {view}");
        assert_eq!(view["prompt"]["tool_kind"], kind);
        assert_eq!(view["auto_approved"], json!([]));
        let _ = fx.call("POST", &["agents", "cancel"], json!({ "handle": handle_of(&view) }));
    }
}

#[test]
fn without_auto_approve_a_read_still_parks_and_a_bigger_ask_is_refused() {
    let fx = Fx::with_opts("read_only=plan_ask");
    let view = answer(fx.run(json!({ "task": "permkind read", "wait_ms": 3000 })));
    assert_eq!(view["status"], "waiting_input", "{view}");
    assert_eq!(view["auto_approve"], "ask");
    let _ = fx.call("POST", &["agents", "cancel"], json!({ "handle": handle_of(&view) }));
    let fx = Fx::with_opts("read_only=plan_ask");
    let (reply, _) = fx.run(json!({ "auto_approve": "project_edits", "task": "hi" }));
    let error = reply.expect("ours").expect_err("refused");
    assert_eq!(error.code, "INVALID_ARGUMENT");
    assert_eq!(fx.panes(), 0, "nothing was started");
}

#[test]
fn a_read_only_chat_with_auto_approve_reads_still_rejects_edits() {
    let fx = Fx::with_opts("read_only=ask");
    let view = answer(fx.run(json!({ "read_only": true, "auto_approve": "reads", "task": "permkind execute" })));
    assert_eq!(view["result"], "asked:execute outcome:selected option:reject_once");
}

#[test]
fn the_agents_session_modes_are_used_when_it_has_no_mode_setting() {
    let fx = Fx::with_opts("modes=2;read_only=plan");
    let view = answer(fx.run(json!({ "read_only": true, "task": "mode" })));
    assert_eq!(view["result"], "mode:plan");
    assert_eq!(view["receipt"]["read_only"], "enforced");
}

#[test]
fn an_agent_that_runs_tools_unasked_and_has_no_read_only_mode_is_refused_and_nothing_starts() {
    // Needs its own mode (it does not ask before every tool), and the fake offers none.
    let fx = Fx::with_opts("read_only=plan");
    let (reply, _) = fx.run(json!({ "read_only": true }));
    let error = reply.expect("ours").expect_err("refused");
    assert_eq!(error.code, "READ_ONLY_UNSUPPORTED");
    assert!(error.message.contains("nothing was started"), "{}", error.message);
    assert_eq!(fx.panes(), 0);
    // An agent that asks before every tool is guarded by the permission rejection alone.
    let fx = Fx::with_opts("read_only=ask");
    let view = answer(fx.run(json!({ "read_only": true, "task": "permkind execute" })));
    assert_eq!(view["receipt"]["read_only"], "enforced");
    assert_eq!(view["result"], "asked:execute outcome:selected option:reject_once");
}

#[test]
fn an_agent_with_no_read_only_chat_is_never_started_read_only_and_the_refusal_says_what_works() {
    let fx = Fx::new();
    let (reply, _) = fx.run(json!({ "read_only": true, "lane": "acp", "strict": true }));
    let error = reply.expect("ours").expect_err("refused");
    assert_eq!(error.code, "CHAT_CANNOT_DO");
    assert!(error.message.contains("cannot enforce read_only") && error.message.contains("list_agents"), "{}", error.message);
    // The only call that starts it drops read_only, and says it weakens the run.
    assert_eq!(error.context["try"]["weakens"], json!(["read_only"]), "{}", error.context);
    assert!(error.context["try"]["args"].get("read_only").is_none());
    assert_eq!(fx.panes(), 0);
    // Without strict, nothing can run it read-only: NO_LANE_FITS names what blocks each way.
    let (reply, _) = fx.run(json!({ "read_only": true, "lane": "acp" }));
    let error = reply.expect("ours").expect_err("refused");
    assert_eq!(error.code, "NO_LANE_FITS");
    assert_eq!(error.context["tried"].as_array().unwrap().len(), 2, "{}", error.context);
    assert_eq!(fx.panes(), 0);
}

#[test]
fn verified_is_true_only_when_a_check_passed_and_otherwise_says_why() {
    let fx = Fx::new();
    let view = answer(fx.run(json!({})));
    assert_eq!(view["verified"], Value::Null, "no checks ran, so nothing was verified: not false");
    assert!(view["verified_reason"].as_str().unwrap().contains("No checks were configured"), "{view}");
    assert_eq!(view["verified_note"], view["verified_reason"]);
    assert_eq!(view["guarantees"]["checks"]["state"], "none");
    assert_eq!(view["not_verified"], json!(["no checks configured"]));
    let checked = answer(fx.run(json!({ "checks": [{ "type": "result_contains", "text": "w1" }] })));
    assert_eq!(checked["verified"], true, "{checked}");
    assert_eq!(checked["verified_reason"], Value::Null);
    assert_eq!(checked["guarantees"]["checks"]["state"], "passed");
    let failed = answer(fx.run(json!({ "checks": [{ "type": "result_contains", "text": "nope" }] })));
    assert_eq!(failed["verified"], false);
    assert!(failed["verified_reason"].as_str().unwrap().contains("did not pass"));
}
