//! A follow-up on a closed or stale handle: the same conversation comes back, and the answer says how.

use crate::agent_runs::persist::FollowupOpts;
use crate::agent_runs::runtime::{build_followup_request, plan_followup, refuse_handed_off};
use crate::operations::{self, ContextPolicy};
use serde_json::json;
use std::fs;
use uuid::Uuid;

use super::fixtures::*;

/// A finished first turn that ran in pane `pane-1`.
fn finished_in_pane(project: &str, handle: &str, keep_pane: bool) -> operations::OperationSnapshot {
    let mut request = persist_req(project, handle, 0, "first task");
    request.pane_id = Some("pane-1".into());
    request.keep_pane = keep_pane;
    let first = operations::create_operation(request).unwrap().0;
    finish_turn(project, &first.operation_id, "first answer");
    operations::latest_agent_run(project, handle).unwrap()
}

#[test]
fn followup_on_a_closed_pane_starts_a_new_pane_on_the_same_handle() {
    let project = std::env::temp_dir().join(format!("pm-reopen-closed-{}", Uuid::new_v4()));
    let project_path = project.to_string_lossy().into_owned();
    finished_in_pane(&project_path, "w1", true);
    operations::mark_worker_closed(&project_path, "w1").unwrap();
    let previous = operations::latest_agent_run(&project_path, "w1").unwrap();
    assert!(previous.worker.closed);

    let plan = plan_followup(&previous, false, None, false);
    assert!(plan.fresh_pane);
    assert!(!plan.headless);
    assert_eq!(plan.pane_id, None);
    assert_eq!(plan.policy, ContextPolicy::ParentSummary);
    let reopened = plan.reopened.clone().expect("reopened");
    assert_eq!(reopened["how"], "new_pane_with_summary");
    assert_eq!(reopened["previous_pane_id"], "pane-1");
    assert!(reopened["previous_handle"].is_null());

    let request = build_followup_request(
        &previous,
        &project_path,
        "w1",
        "second task".into(),
        &plan,
        FollowupOpts::default(),
    );
    assert_eq!(request.handle.as_deref(), Some("w1"));
    assert_eq!(request.agent_run_id.as_deref(), Some("w1"));
    assert_eq!(request.turn_index, 1);
    assert_eq!(request.pane_id, None);
    assert!(!request.headless);
    assert!(request.fresh_pane);
    assert!(request.keep_pane, "keep_pane is the previous run's");
    assert_eq!(request.context_policy, ContextPolicy::ParentSummary);

    // The prompt the new turn gets carries the earlier answer.
    let rendered = crate::agent_runs::persist::render_turn_prompt(crate::agent_runs::persist::TurnPromptArgs {
        agent_type: &previous.agent_type,
        policy: request.context_policy,
        task: "second task",
        scope: None,
        prior_result: previous.result.as_deref(),
        prior_user: None,
        selected_history: &[],
        can_resume: false,
        is_followup: true,
    });
    assert!(rendered.prompt.contains("Parent summary:"));
    assert!(rendered.prompt.contains("first answer"));
    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_caller_context_policy_wins_over_the_summary_default() {
    let project = std::env::temp_dir().join(format!("pm-reopen-policy-{}", Uuid::new_v4()));
    let project_path = project.to_string_lossy().into_owned();
    let previous = finished_in_pane(&project_path, "w2", false);
    let plan = plan_followup(&previous, false, Some(ContextPolicy::Packet), false);
    assert!(plan.fresh_pane);
    assert_eq!(plan.policy, ContextPolicy::Packet);
    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_live_pane_is_reused_and_reports_nothing_reopened() {
    let project = std::env::temp_dir().join(format!("pm-reopen-live-{}", Uuid::new_v4()));
    let project_path = project.to_string_lossy().into_owned();
    let previous = finished_in_pane(&project_path, "w3", true);
    let plan = plan_followup(&previous, true, None, false);
    assert!(!plan.fresh_pane);
    assert_eq!(plan.pane_id.as_deref(), Some("pane-1"));
    assert_eq!(plan.reopened, None);
    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_resumable_run_with_a_lost_pane_resumes_its_session() {
    let project = std::env::temp_dir().join(format!("pm-reopen-resume-{}", Uuid::new_v4()));
    let project_path = project.to_string_lossy().into_owned();
    let mut previous = finished_in_pane(&project_path, "w4", false);
    previous.worker.resumable = true;
    let plan = plan_followup(&previous, false, None, false);
    assert!(!plan.fresh_pane);
    assert!(plan.headless);
    assert_eq!(plan.reopened.as_ref().unwrap()["how"], "resumed_session");
    assert_eq!(plan.reopened.as_ref().unwrap()["previous_pane_id"], "pane-1");
    let request = build_followup_request(
        &previous,
        &project_path,
        "w4",
        "again".into(),
        &plan,
        FollowupOpts::default(),
    );
    assert!(request.headless);
    assert_eq!(request.pane_id, None);
    assert!(!request.fresh_pane);
    let _ = fs::remove_dir_all(project);
}

#[test]
fn a_handed_off_run_with_a_lost_pane_is_still_refused() {
    let project = std::env::temp_dir().join(format!("pm-reopen-handoff-{}", Uuid::new_v4()));
    let project_path = project.to_string_lossy().into_owned();
    let mut request = persist_req(&project_path, "w5", 0, "first task");
    request.pane_id = Some("pane-1".into());
    let first = operations::create_operation(request).unwrap().0;
    operations::run_operation_dispatch(&project_path, &first.operation_id, |_| Ok(())).unwrap();
    let handed = operations::mark_operation_handed_off(
        &project_path,
        &first.operation_id,
        json!({ "handle": "w5-new", "agent_type": "fake_b" }),
    )
    .unwrap();
    // send_agent checks this before it looks at the pane, so a closed pane never reopens the run.
    assert_eq!(refuse_handed_off(&handed).unwrap_err().code, "HANDED_OFF");
    let _ = fs::remove_dir_all(project);
}
