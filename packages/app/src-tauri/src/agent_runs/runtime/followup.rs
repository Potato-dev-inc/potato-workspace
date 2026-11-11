//! `send_agent`: starting the next turn on an existing handle, and enqueueing a follow-up behind
//! a running turn.

use super::{
    access::current_agent, handle_lock, queue::queue_followup, request::AgentRunRequest,
    view::AgentRunView,
};
use crate::agent_runs::headless::run_agent;
use crate::agent_runs::messaging::{self};
use crate::agent_runs::persist::{self, FollowupOpts};
use crate::operations::{
    self, ContextPolicy, OperationError, OperationSnapshot, OperationStatus, StateSource,
};
use parking_lot::Mutex;
use std::sync::Arc;
use uuid::Uuid;

/// A follow-up or steer on a run that Keep going handed over to another agent is refused. The old
/// run ended as `HANDED_OFF` and its pane is kept; the work now continues on the handle named in
/// `context.continued_by`. Nothing is queued or started.
pub(in crate::agent_runs) fn refuse_handed_off(
    previous: &OperationSnapshot,
) -> Result<(), OperationError> {
    let Some(error) = previous
        .error
        .as_ref()
        .filter(|error| error.code == operations::HANDED_OFF)
    else {
        return Ok(());
    };
    let continued = &error.context["continued_by"];
    let message = match (continued["agent_type"].as_str(), continued["handle"].as_str()) {
        (Some(agent), Some(handle)) => {
            format!("This task moved to {agent} at a usage limit. Use handle {handle}.")
        }
        _ => "This task moved to another agent at a usage limit.".to_string(),
    };
    let mut refusal = OperationError::new(operations::HANDED_OFF, message, false);
    refusal.context = error.context.clone();
    Err(refusal)
}

pub fn send_agent(
    project: &str,
    handle: &str,
    task: String,
    session_id: Option<String>,
    registry: Arc<Mutex<crate::pty::PaneRegistry>>,
    app: tauri::AppHandle,
    opts: FollowupOpts,
) -> Result<AgentRunView, OperationError> {
    let handle_guard = handle_lock(handle);
    let serial = handle_guard.lock();
    let previous = current_agent(project, handle, session_id.as_deref())?;
    refuse_handed_off(&previous)?;
    let project = previous.project_path.clone();
    // A run whose budget is used up pauses here, before any turn is created or queued; a turn
    // already running is never touched. No budget on the run: no change.
    crate::budgets::check_next_turn(&project, handle)?;
    let blocked_on_trust = crate::agent_runs::headless::blocked_on_trust(&previous);
    if !previous.status.terminal() && !blocked_on_trust {
        let queued = queue_followup(
            &project, handle, previous, task, session_id, registry, app, opts,
        );
        drop(serial);
        return queued;
    }
    let pane_alive = previous
        .pane_id
        .as_deref()
        .is_none_or(|pane_id| registry.lock().panes.contains_key(pane_id));
    let plan = plan_followup(&previous, pane_alive, opts.context_policy, blocked_on_trust);
    if blocked_on_trust {
        // Nothing ran: retire the parked turn so the retry is the handle's live turn.
        if let Ok(parked) = operations::mark_operation_state(
            &project,
            &previous.operation_id,
            OperationStatus::Cancelled,
            StateSource::Native,
            Some("superseded".into()),
            None,
            None,
        ) {
            let _ = crate::bridge::publish_operation(&parked, &registry, &app);
        }
    }
    let pending = messaging::pending_texts(&project, handle);
    let task = if pending.is_empty() {
        task
    } else {
        format!("{task}\n\nSteering messages:\n- {}", pending.join("\n- "))
    };
    let request = build_followup_request(&previous, &project, handle, task, &plan, opts);
    let reopened = plan.reopened;
    drop(serial);
    run_agent(request, registry, app, session_id).map(|mut view| {
        view.reopened = reopened;
        view
    })
}

/// What a follow-up on a finished run does about the run's pane.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::agent_runs) struct FollowupPlan {
    pub headless: bool,
    /// The pane to continue in; `None` for a headless turn or a new pane.
    pub pane_id: Option<String>,
    /// The old pane is gone: start a new pane on the same handle (never re-adopt `previous.pane_id`).
    pub fresh_pane: bool,
    pub policy: ContextPolicy,
    /// Reported on the answer as `reopened` when the conversation had to be brought back.
    pub reopened: Option<serde_json::Value>,
}

/// Decide how a follow-up on a terminal (or trust-parked) run continues. `pane_alive` is whether
/// the run's pane is still in the registry (ignored when the run had no pane).
pub(in crate::agent_runs) fn plan_followup(
    previous: &OperationSnapshot,
    pane_alive: bool,
    requested_policy: Option<ContextPolicy>,
    blocked_on_trust: bool,
) -> FollowupPlan {
    let pane_lost = previous.pane_id.is_some() && !pane_alive;
    let not_native = previous.agent_type != "opencode_native";
    let policy_for = |default: Option<ContextPolicy>| {
        if blocked_on_trust {
            ContextPolicy::Fresh
        } else {
            requested_policy
                .or(default)
                .unwrap_or_else(|| persist::followup_policy(None, previous.worker.context_policy))
        }
    };
    if pane_lost && previous.worker.resumable {
        // An interrupted run whose pane died with the app resumes its provider session headless.
        return FollowupPlan {
            headless: not_native,
            pane_id: previous.pane_id.clone(),
            fresh_pane: false,
            policy: policy_for(None),
            reopened: Some(reopened_note(
                "resumed_session",
                previous.pane_id.as_deref(),
                "The old pane was gone; continued the earlier provider session.",
            )),
        };
    }
    if pane_lost {
        // Closed (close_agent, closed after the run, lost in a restart) and no session to resume:
        // a new pane on the same handle, told what happened before.
        return FollowupPlan {
            headless: false,
            pane_id: None,
            fresh_pane: true,
            policy: policy_for(Some(ContextPolicy::ParentSummary)),
            reopened: Some(reopened_note(
                "new_pane_with_summary",
                previous.pane_id.as_deref(),
                "The old pane was closed; started a new pane and gave it a summary of the earlier turns.",
            )),
        };
    }
    FollowupPlan {
        headless: previous.pane_id.is_none() && not_native,
        pane_id: previous.pane_id.clone(),
        fresh_pane: false,
        policy: policy_for(None),
        reopened: None,
    }
}

fn reopened_note(how: &str, previous_pane_id: Option<&str>, note: &str) -> serde_json::Value {
    serde_json::json!({
        "how": how,
        "previous_pane_id": previous_pane_id,
        "previous_handle": serde_json::Value::Null,
        "note": note,
    })
}

pub(in crate::agent_runs) fn build_followup_request(
    previous: &OperationSnapshot,
    project: &str,
    handle: &str,
    task: String,
    plan: &FollowupPlan,
    opts: FollowupOpts,
) -> AgentRunRequest {
    let headless = plan.headless;
    AgentRunRequest {
        project_path: Some(project.to_string()),
        task,
        agent_type: previous.agent_type.clone(),
        headless,
        background: opts.background,
        read_only: previous.read_only,
        keep_pane: previous.keep_pane,
        placement: None,
        isolation: None,
        worker_has_mcp_tools: false,
        timeout_ms: previous.timeout_ms,
        wait_ms: if opts.background {
            0
        } else {
            opts.wait_ms.unwrap_or(persist::FOLLOWUP_WAIT_MS)
        },
        idempotency_key: opts
            .idempotency_key
            .clone()
            .or_else(|| Some(Uuid::new_v4().to_string())),
        acceptance_criteria: opts.acceptance_criteria.clone(),
        structured_result: Some(false),
        checks: opts.checks.clone(),
        pane_id: plan.pane_id.clone().filter(|_| !headless),
        worker_id: None,
        allow_broad: false,
        name: previous.worker.name.clone(),
        handle: Some(handle.to_string()),
        agent_run_id: Some(handle.to_string()),
        turn_index: previous.turn_index.saturating_add(1),
        context_policy: plan.policy,
        model: opts
            .requested_model
            .or(previous.worker.requested_model.clone()),
        reasoning: opts
            .requested_reasoning
            .or(previous.worker.requested_reasoning.clone()),
        role: opts.role.or(previous.worker.role.clone()),
        scope: opts.scope.or(previous.worker.scope.clone()),
        selected_history: opts.selected_history,
        locks: opts.locks.clone(),
        trust_workspace: opts.trust_workspace && headless,
        allow_shell: false,
        allowed_commands: None,
        account: previous.worker.account.clone(),
        account_source: previous.worker.account_source.clone(),
        budget_turns: None,
        budget_minutes: None,
        budget_parent: None,
        until_checks_pass: false,
        backup_agents: None,
        join_worktree: None,
        // A follow-up continues in the mode of its run; the setting is never read again.
        headless_unset: false,
        headless_ignored: false,
        headless_forced: false,
        lane_note: None,
        kept_open_by_setting: false,
        model_from_helper_default: false,
        quick: false,
        // The guard is carried by the run's worker record, not by this request.
        guard_env: None,
        on_behalf_of_companion: None,
        fresh_pane: plan.fresh_pane,
    }
}

pub(in crate::agent_runs) fn enqueue_followup(
    project: &str,
    handle: &str,
    previous: &OperationSnapshot,
    task: String,
    session_id: Option<String>,
    opts: FollowupOpts,
) -> Result<(OperationSnapshot, bool), OperationError> {
    if task.trim().is_empty() {
        return Err(OperationError::new(
            "INVALID_TASK",
            "task is required",
            false,
        ));
    }
    let next_turn = previous.turn_index.saturating_add(1);
    let policy = persist::followup_policy(opts.context_policy, previous.worker.context_policy);
    let choice = persist::resolve_model_choice(
        opts.requested_model
            .as_deref()
            .or(previous.worker.requested_model.as_deref()),
        opts.requested_reasoning
            .as_deref()
            .or(previous.worker.requested_reasoning.as_deref()),
        None,
    );
    let conversation = persist::conversation_facts(&previous.project_path, handle);
    let rendered = persist::render_turn_prompt(persist::TurnPromptArgs {
        agent_type: &previous.agent_type,
        policy,
        task: task.trim(),
        scope: opts.scope.as_deref().or(previous.worker.scope.as_deref()),
        prior_result: previous.result.as_deref(),
        prior_user: conversation.as_deref(),
        selected_history: opts.selected_history.as_deref().unwrap_or(&[]),
        can_resume: persist::snapshot_can_resume(previous) || persist::pane_keeps_context(previous),
        is_followup: true,
    });
    let mut worker = persist::build_worker(
        handle,
        previous.worker.name.as_deref(),
        opts.role.as_deref().or(previous.worker.role.as_deref()),
        opts.scope.as_deref().or(previous.worker.scope.as_deref()),
        Some(project),
        Some(previous),
        &rendered,
        &choice,
    );
    worker.queued_task_ids = vec![];
    worker.closed = false;
    worker.event_cursor = previous.revision.max(previous.worker.event_cursor);
    let idempotency_key = opts
        .idempotency_key
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let queued_checks = opts.checks.clone().unwrap_or_default();
    crate::agent_runs::checks::validate(std::path::Path::new(project), &queued_checks)
        .map_err(|message| OperationError::new("INVALID_ARGUMENT", message, false))?;
    operations::create_operation(operations::DelegateWorkRequest {
        project_path: project.to_string(),
        task,
        agent_type: previous.agent_type.clone(),
        pane_id: previous.pane_id.clone(),
        idempotency_key,
        acceptance_criteria: opts
            .acceptance_criteria
            .clone()
            .filter(|items| !items.is_empty()),
        task_id: None,
        exclusive: false,
        locks: opts.locks.clone(),
        timeout_ms: previous.timeout_ms,
        read_only: previous.read_only,
        keep_pane: previous.keep_pane,
        placement: None,
        owner_session_id: session_id.or(previous.owner_session_id.clone()),
        parent_pane_id: crate::pty::pane_parent::request_caller(),
        worker_has_mcp_tools: false,
        agent_run_id: Some(handle.to_string()),
        turn_index: next_turn,
        worker,
        context_policy: Some(policy),
        checks: queued_checks,
    })
}
