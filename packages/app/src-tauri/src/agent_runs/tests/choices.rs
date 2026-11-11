//! What a helper asked for is what runs: a read-only helper can be visible, and the asked model and
//! reasoning reach the command line (hidden and visible) or the receipt says plainly that they did not.

use super::fixtures::parked_snapshot;
use crate::agent_runs::runtime::AgentRunView;
use crate::operations::OperationStatus;
use crate::tui::{HeadlessLaunch, VisibleRun};

#[test]
fn a_hidden_claude_run_is_started_with_the_asked_model_and_reasoning() {
    let launch = HeadlessLaunch {
        model: Some("claude-haiku-5-5"),
        reasoning: Some("low"),
        read_only: true,
        ..HeadlessLaunch::new(".", "a simple task")
    };
    let Ok(spec) = crate::tui::headless_launch("claude", &launch) else {
        return; // claude is not on PATH on this machine
    };
    let has = |flag: &str, value: &str| spec.args.windows(2).any(|pair| pair == [flag, value]);
    assert!(has("--model", "claude-haiku-5-5"), "{:?}", spec.args);
    assert!(has("--effort", "low"), "{:?}", spec.args);
    assert!(has("--permission-mode", "plan"), "{:?}", spec.args);
    assert!(spec.read_only_enforced);
    // Nothing asked: nothing forced, so the person's own settings still apply to a plain run.
    let plain = crate::tui::headless_launch("claude", &HeadlessLaunch::new(".", "x")).unwrap();
    assert!(!plain.args.iter().any(|arg| arg == "--model" || arg == "--effort"));
}

#[test]
fn a_flag_shaped_model_is_never_forwarded() {
    let launch = HeadlessLaunch { model: Some("--dangerously-skip-permissions"), ..HeadlessLaunch::new(".", "x") };
    if let Ok(spec) = crate::tui::headless_launch("claude", &launch) {
        assert!(!spec.args.iter().any(|arg| arg.contains("dangerously")), "{:?}", spec.args);
    }
}

#[test]
fn read_only_works_in_a_visible_pane_only_where_the_profile_can_do_it() {
    let claude = crate::tui::profile_for("claude");
    assert!(crate::tui::enforces_read_only_by_flags(claude.as_ref()));
    let args = claude.visible_run_args(&VisibleRun { read_only: true, ..VisibleRun::default() });
    assert!(args.args.windows(2).any(|pair| pair == ["--permission-mode", "plan"]));
    // A profile with no such flags keeps today's refusal: it never pretends and never hides itself.
    let codex = crate::tui::profile_for("codex");
    assert!(!crate::tui::enforces_read_only_by_flags(codex.as_ref()));
    let none = codex.visible_run_args(&VisibleRun { model: Some("m"), read_only: true, ..VisibleRun::default() });
    assert!(none.args.is_empty() && !none.model_applied && !none.read_only_enforced);
    let message = crate::agent_runs::capabilities::read_only_unsupported_message("codex", true);
    assert!(message.contains("claude (run-spawned pane only)"), "{message}");
}

#[test]
fn the_receipt_says_plainly_when_another_model_ran() {
    let mut snapshot = parked_snapshot(OperationStatus::Completed, "none");
    snapshot.agent_type = "claude".into();
    snapshot.worker.requested_model = Some("claude-haiku-5-5".into());
    snapshot.worker.resolved_model = Some("claude-sonnet-5-5".into());
    let view = AgentRunView::from(snapshot);
    let mismatch = view.warnings.iter().find(|w| w.code == "MODEL_MISMATCH").expect("a mismatch warning");
    assert!(mismatch.detail.contains("claude-haiku-5-5") && mismatch.detail.contains("claude-sonnet-5-5"), "{}", mismatch.detail);
    assert!(view.receipt.unwrap().not_verified.iter().any(|line| line == "model not confirmed"));
}

#[test]
fn an_asked_model_that_ran_raises_no_warning_even_as_an_alias() {
    for (asked, ran) in [("claude-haiku-5-5", "claude-haiku-5-5"), ("haiku", "claude-haiku-5-5"), ("Haiku 5.5", "claude-haiku-5-5")] {
        let mut snapshot = parked_snapshot(OperationStatus::Completed, "none");
        snapshot.agent_type = "claude".into();
        snapshot.worker.requested_model = Some(asked.into());
        snapshot.worker.resolved_model = Some(ran.into());
        let view = AgentRunView::from(snapshot);
        assert!(!view.warnings.iter().any(|w| w.code.starts_with("MODEL_M")), "{asked} vs {ran}: {:?}", view.warnings);
        assert!(!view.receipt.unwrap().not_verified.iter().any(|line| line == "model not confirmed"), "{asked}");
    }
}

#[test]
fn a_model_an_agent_cannot_be_told_is_reported_as_not_applied() {
    let mut snapshot = parked_snapshot(OperationStatus::Completed, "none");
    snapshot.agent_type = "codex".into();
    snapshot.pane_id = Some("pane-1".into());
    snapshot.worker.requested_model = Some("gpt-x".into());
    let view = AgentRunView::from(snapshot);
    let warning = view.warnings.iter().find(|w| w.code == "MODEL_NOT_APPLIED").expect("not applied");
    assert!(warning.detail.contains("gpt-x") && warning.detail.contains("in a pane"), "{}", warning.detail);
}

#[test]
fn a_new_run_does_not_claim_the_asked_model_as_the_one_that_ran() {
    let choice = crate::agent_runs::persist::resolve_model_choice(Some("claude-haiku-5-5"), Some("low"), None);
    assert_eq!(choice.requested_model.as_deref(), Some("claude-haiku-5-5"));
    assert_eq!(choice.resolved_model, None, "resolved_model is read from the run, never copied from the request");
}

#[test]
fn model_names_match_by_alias_but_not_across_families() {
    use crate::agent_runs::persist::model_matches;
    assert!(model_matches("claude-haiku-5-5", "claude-haiku-5-5"));
    assert!(model_matches("haiku", "claude-haiku-5-5"));
    assert!(!model_matches("claude-haiku-5-5", "claude-sonnet-5-5"));
    assert!(!model_matches("haiku", "claude-sonnet-5-5"));
}

#[test]
fn a_claude_error_result_reaches_the_receipt_in_the_agents_own_words() {
    let profile = crate::tui::profile_for("claude");
    let output = r#"{"type":"result","is_error":true,"result":"There is an issue with the selected model (nope). It may not exist."}"#;
    let (code, message) = profile.classify_headless_failure(output, 1).expect("classified");
    assert_eq!(code, "AGENT_REPORTED_ERROR");
    assert!(message.contains("issue with the selected model"), "{message}");
    assert!(profile.classify_headless_failure(r#"{"result":"fine"}"#, 0).is_none());
}

#[test]
fn the_receipt_notes_a_model_that_came_from_the_helper_default() {
    let mut snapshot = parked_snapshot(OperationStatus::Completed, "none");
    snapshot.agent_type = "claude".into();
    snapshot.worker.requested_model = Some("sonnet".into());
    snapshot.worker.model_note = Some(crate::agent_run_mode::HELPER_MODEL_NOTE.to_string());
    let view = AgentRunView::from(snapshot);
    assert_eq!(view.requested_model.as_deref(), Some("sonnet"));
    assert_eq!(view.model_note.as_deref(), Some(crate::agent_run_mode::HELPER_MODEL_NOTE));
    assert_eq!(view.receipt.unwrap().model_note.as_deref(), Some(crate::agent_run_mode::HELPER_MODEL_NOTE));
}

#[test]
fn a_requested_model_carries_no_helper_default_note() {
    let mut snapshot = parked_snapshot(OperationStatus::Completed, "none");
    snapshot.agent_type = "claude".into();
    snapshot.worker.requested_model = Some("opus".into());
    let view = AgentRunView::from(snapshot);
    assert!(view.model_note.is_none());
    assert!(view.receipt.unwrap().model_note.is_none());
}
