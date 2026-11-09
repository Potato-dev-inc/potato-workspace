//! Startup recovery: operations left active by a previous app process are failed as interrupted.

use super::model::*;
use super::store::{current_runtime_id, indexed_projects, read_or_quarantine, root};
use super::mark_operation_state;
use std::fs;

/// Mark work left active by a previous app process as interrupted. It cannot be inferred as successful.
pub fn recover_interrupted_operations(
    project: &str,
) -> Result<Vec<OperationSnapshot>, OperationError> {
    let dir = root(project)?;
    let entries = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(OperationError::io(e)),
    };
    let mut recovered = Vec::new();
    for entry in entries {
        let entry = entry.map_err(OperationError::io)?;
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            let Some(op) = read_or_quarantine(&entry.path())? else { continue };
            if op.runtime_id != current_runtime_id()
                && matches!(
                    op.status,
                    OperationStatus::Queued
                        | OperationStatus::Starting
                        | OperationStatus::Running
                        | OperationStatus::WaitingInput
                )
            {
                let mut error = OperationError::new(
                    "OPERATION_INTERRUPTED",
                    "app restarted while operation was active",
                    true,
                );
                error.context = serde_json::json!({ "operation_id": op.operation_id });
                let result = mark_operation_state(
                    project,
                    &op.operation_id,
                    OperationStatus::Failed,
                    StateSource::Native,
                    Some("interrupted".into()),
                    None,
                    Some(error),
                );
                match result {
                    Ok(snapshot) => {
                        recovered.push(mark_resumable_if_possible(project, snapshot));
                    }
                    Err(error) if error.code == "OPERATION_NOT_FOUND" => continue,
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(recovered)
}

pub fn recover_all_interrupted_operations() -> Result<Vec<OperationSnapshot>, OperationError> {
    let mut recovered = Vec::new();
    for project in indexed_projects()? {
        recovered.extend(recover_interrupted_operations(&project)?);
    }
    Ok(recovered)
}

/// An interrupted run that still has a provider session id the CLI/ACP agent can resume from is
/// flagged `worker.resumable`. Best effort: any failure leaves the plain failed record.
fn mark_resumable_if_possible(project: &str, snapshot: OperationSnapshot) -> OperationSnapshot {
    if !crate::agent_runs::persist::snapshot_can_resume(&snapshot) {
        return snapshot;
    }
    let _serial = super::store::update_lock();
    let Ok(mut op) = super::get_operation(project, &snapshot.operation_id) else {
        return snapshot;
    };
    op.worker.resumable = true;
    match super::store::bump(&mut op) {
        Ok(()) => op,
        Err(_) => snapshot,
    }
}
