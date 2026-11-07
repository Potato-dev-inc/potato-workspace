//! The login of a helper an agent starts through the MCP tools (`run_agent`, `quick_ask`, `delegate_work`,
//! `spawn_agent`). When the caller names no `account`, the person's per-agent choice decides
//! (`accounts::helper`): main login, one account, or a card that asks. These functions are the one place the
//! four routes share, so each of them behaves the same.
//!
//! Only a call that came through an MCP connection (`session` is set) is an agent starting a helper. A run the
//! person starts by hand, one the app starts for itself (Night Shift, keep going, ask bar...), and a phone
//! spawning a pane never come through here and never see the card. A call that adopts a worker or a pane that
//! already exists, or replays a run that already started, starts no new helper and is left alone.

use super::runtime::AgentRunRequest;
use crate::accounts::{helper, Store};
use crate::operations::OperationError;
use std::time::{Duration, Instant};

/// The longest a gate waits for the person inside one call.
const MAX_GATE_WAIT_MS: u64 = 100_000;
/// What a gate keeps back from the caller's own timeout, so the answer still reaches it.
const MARGIN_MS: u64 = 10_000;
const MIN_GATE_WAIT_MS: u64 = 5_000;
/// A call whose HTTP read timeout is the shim's default 30 s (`delegate_work`, `spawn_agent`).
const SHORT_CALL_WAIT_MS: u64 = 20_000;

fn blank(value: Option<&str>) -> bool {
    value.map(str::trim).is_none_or(str::is_empty)
}

fn started_already(project: Option<&str>, key: &str) -> bool {
    let Some(project) = project.map(str::trim).filter(|p| !p.is_empty()) else { return false };
    let prepared = crate::project_path::prepare_project_path_coded(std::path::Path::new(project))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| project.to_string());
    crate::operations::find_by_idempotency_key(&prepared, key).ok().flatten().is_some()
}

/// A stable key for a call that came without one, so a retry of the same call still finds its card.
fn derived_key(parts: &[&str]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    parts.hash(&mut hasher);
    format!("auto-{:016x}", hasher.finish())
}

fn gate(
    store: &Store,
    agent_id: &str,
    project: Option<&str>,
    key: &str,
    session: &str,
    wait_ms: u64,
    notify: &dyn Fn(),
) -> Result<Option<String>, OperationError> {
    let pane = crate::pty::pane_parent::request_caller();
    helper::choose(
        store,
        &helper::Starting {
            agent_id,
            project: project.unwrap_or(""),
            key,
            session: Some(session),
            pane_id: pane.as_deref(),
            wait: Duration::from_millis(wait_ms),
        },
        notify,
    )
    .map_err(OperationError::from)
}

/// `run_agent` and `quick_ask`: fills `request.account` from the person's choice when the caller left it out,
/// and takes the time spent waiting off the run's own wait.
pub(crate) fn for_run(
    request: &mut AgentRunRequest,
    session: Option<&str>,
    store: &Store,
    notify: &dyn Fn(),
) -> Result<(), OperationError> {
    let Some(session) = session else { return Ok(()) };
    if !blank(request.account.as_deref())
        || request.turn_index > 0
        || request.pane_id.is_some()
        || request.worker_id.is_some()
        || request.handle.is_some()
        || request.agent_run_id.is_some()
    {
        return Ok(());
    }
    let project = request.project_path.clone();
    let key = match request.idempotency_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => key.to_string(),
        None => derived_key(&[&request.agent_type, &request.task, project.as_deref().unwrap_or("")]),
    };
    if started_already(project.as_deref(), &key) {
        return Ok(());
    }
    // A named worker that already exists is continued, not started again.
    if let (Some(name), Some(project)) = (request.name.as_deref().filter(|n| !n.trim().is_empty()), project.as_deref()) {
        let exists = super::persist::find_worker(project, name.trim())
            .is_ok_and(|previous| !previous.worker.closed && previous.stage.as_deref() != Some("closed"));
        if exists {
            return Ok(());
        }
    }
    let wait_ms = if request.background {
        SHORT_CALL_WAIT_MS
    } else {
        (request.wait_ms.saturating_add(15_000).saturating_sub(MARGIN_MS)).clamp(MIN_GATE_WAIT_MS, MAX_GATE_WAIT_MS)
    };
    let started = Instant::now();
    let account = gate(store, &request.agent_type, project.as_deref(), &key, session, wait_ms, notify)?;
    request.idempotency_key = Some(key);
    request.account = account;
    if !request.background {
        request.wait_ms = request.wait_ms.saturating_sub(started.elapsed().as_millis() as u64);
    }
    Ok(())
}

/// `delegate_work`: the account goes on the worker the operation is created with.
pub(crate) fn for_delegate(
    request: &mut crate::operations::DelegateWorkRequest,
    session: Option<&str>,
    store: &Store,
    notify: &dyn Fn(),
) -> Result<(), OperationError> {
    let Some(session) = session else { return Ok(()) };
    if !blank(request.worker.account.as_deref())
        || request.turn_index > 0
        || request.pane_id.is_some()
        || request.agent_run_id.is_some()
    {
        return Ok(());
    }
    let key = request.idempotency_key.trim().to_string();
    if key.is_empty() || started_already(Some(&request.project_path), &key) {
        return Ok(());
    }
    let account = gate(
        store,
        &request.agent_type,
        Some(&request.project_path),
        &key,
        session,
        SHORT_CALL_WAIT_MS,
        notify,
    )?;
    request.worker.account = account;
    Ok(())
}

/// `spawn_agent` (POST /panes): the account goes on the spawn arguments. The call has no idempotency key, so the
/// key is made from what the call asks for.
pub(crate) fn for_spawn(
    args: &mut crate::pty::SpawnPaneArgs,
    session: Option<&str>,
    store: &Store,
    notify: &dyn Fn(),
) -> Result<(), OperationError> {
    let Some(session) = session else { return Ok(()) };
    if !blank(args.account.as_deref()) {
        return Ok(());
    }
    let key = derived_key(&[
        "spawn",
        &args.agent_type,
        args.cwd.as_deref().unwrap_or(""),
        args.pane_id.as_deref().unwrap_or(""),
    ]);
    args.account = gate(store, &args.agent_type, args.cwd.as_deref(), &key, session, SHORT_CALL_WAIT_MS, notify)?;
    Ok(())
}

#[cfg(test)]
mod tests;
