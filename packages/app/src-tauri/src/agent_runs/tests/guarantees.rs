//! `verified` means one thing on every lane, and `guarantees` carries the lane facts.

use crate::agent_runs::checks::{Check, CheckResult};
use crate::agent_runs::runtime::AgentRunView;
use crate::agent_runs::tree_proof::ReadOnlyProof;
use crate::operations::OperationStatus;

use super::fixtures::*;

fn view_of(mut snapshot: crate::operations::OperationSnapshot, checks: Vec<(bool, Check)>) -> AgentRunView {
    snapshot.checks = checks.iter().map(|(_, c)| c.clone()).collect();
    snapshot.check_results = checks.into_iter().map(|(passed, check)| CheckResult { check, passed, detail: String::new() }).collect();
    AgentRunView::from(snapshot)
}

fn exists() -> Check {
    Check::FileExists { path: "a".into() }
}

#[test]
fn no_checks_is_null_with_a_reason_never_false_and_a_native_result_does_not_change_that() {
    let mut snapshot = parked_snapshot(OperationStatus::Completed, "none");
    snapshot.verified = true; // a native completion event
    let view = view_of(snapshot, vec![]);
    assert_eq!(view.verified, None);
    assert!(view.verified_reason.as_deref().unwrap().contains("No checks were configured"));
    let json = serde_json::to_value(&view).unwrap();
    assert!(json["verified"].is_null() && json.get("verified").is_some(), "{json}");
    assert_eq!(json["guarantees"]["checks"]["state"], "none");
}

#[test]
fn passing_checks_are_true_and_failing_checks_are_false() {
    let passed = view_of(parked_snapshot(OperationStatus::Completed, "none"), vec![(true, exists())]);
    assert_eq!((passed.verified, passed.verified_reason.clone()), (Some(true), None));
    assert_eq!(passed.guarantees.as_ref().unwrap().checks.ran, vec!["file_exists a".to_string()]);
    let failed = view_of(parked_snapshot(OperationStatus::Failed, "none"), vec![(true, exists()), (false, exists())]);
    assert_eq!(failed.verified, Some(false));
    assert_eq!(failed.guarantees.unwrap().checks.state, "failed");
}

#[test]
fn checks_that_have_not_run_are_null_and_say_pending() {
    let mut snapshot = parked_snapshot(OperationStatus::Running, "none");
    snapshot.checks = vec![exists()];
    let view = AgentRunView::from(snapshot);
    assert_eq!(view.verified, None);
    assert_eq!(view.guarantees.unwrap().checks.state, "pending");
}

#[test]
fn guarantees_say_how_read_only_is_enforced_and_what_the_proof_found() {
    let mut snapshot = parked_snapshot(OperationStatus::Completed, "none");
    snapshot.read_only = true;
    snapshot.worker.read_only_proof = Some(ReadOnlyProof {
        proof: Some("tree_changed".into()),
        changed_paths: vec!["src/x.rs".into()],
        ..Default::default()
    });
    let view = view_of(snapshot.clone(), vec![]);
    let read_only = view.guarantees.as_ref().unwrap().read_only.clone();
    assert!(read_only.requested);
    assert_eq!((read_only.proof.as_deref(), read_only.changed_paths), (Some("tree_changed"), vec!["src/x.rs".to_string()]));
    assert!(view.warnings.iter().any(|w| w.code == "READ_ONLY_VIOLATED"));
    assert!(view.receipt.unwrap().not_verified.iter().any(|n| n.contains("read-only run changed files")));
    // No look recorded (an app restart): no proof, and the reason says so.
    snapshot.worker.read_only_proof = None;
    let none = view_of(snapshot, vec![]).guarantees.unwrap().read_only;
    assert_eq!((none.proof, none.proof_reason.as_deref()), (None, Some("app_restarted")));
    // Not requested: nothing enforced, nothing claimed.
    let mut open = parked_snapshot(OperationStatus::Completed, "none");
    open.read_only = false;
    let off = view_of(open, vec![]).guarantees.unwrap();
    assert_eq!((off.read_only.requested, off.read_only.enforcement.as_str()), (false, "none"));
    assert_eq!(off.isolation.mode, "project_folder");
}

#[test]
fn timing_splits_queue_start_first_output_and_total_from_the_stage_marks() {
    use crate::operations::StageMark;
    let mut snapshot = parked_snapshot(OperationStatus::Completed, "none");
    snapshot.created_at_ms = 1_000;
    snapshot.started_at_ms = Some(1_300);
    snapshot.finished_at_ms = Some(2_000);
    snapshot.worker.standby_used = true;
    snapshot.worker.stage_log = vec![
        StageMark { stage: "dispatching".into(), at_ms: 1_200 },
        StageMark { stage: "first_output".into(), at_ms: 1_500 },
    ];
    let timing = AgentRunView::from(snapshot.clone()).receipt.unwrap().timing.unwrap();
    assert_eq!(
        (timing.queue_ms, timing.start_ms, timing.first_output_ms, timing.total_ms, timing.warm),
        (Some(200), Some(100), Some(200), Some(1_000), true)
    );
    // A lane that marks nothing leaves the parts out instead of guessing.
    snapshot.worker.stage_log.clear();
    let bare = AgentRunView::from(snapshot).receipt.unwrap().timing.unwrap();
    assert_eq!((bare.queue_ms, bare.start_ms, bare.first_output_ms), (None, None, None));
}
