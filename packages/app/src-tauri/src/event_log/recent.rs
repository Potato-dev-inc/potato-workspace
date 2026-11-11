//! Recent-event queries over the global log: filtered summaries and a pane's last event.

use super::scan_global_entries_backwards;
use crate::events::{EventEntry, PaneId, SystemEvent};
use crate::opencode::status::LastEventSummary;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RecentEventSummary {
    pub id: String,
    pub timestamp_ms: i64,
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

pub fn read_recent_events(
    limit: usize,
    pane_id: Option<&str>,
    types: Option<&[String]>,
    since_id: Option<&str>,
) -> Result<Vec<RecentEventSummary>, String> {
    let since_id = since_id.map(str::trim).filter(|value| !value.is_empty());
    let limit = limit.clamp(1, 200);
    let type_filter: Option<Vec<String>> = types.map(|values| {
        values
            .iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect()
    });
    let pane_filter = pane_id.map(str::trim).filter(|value| !value.is_empty());
    let mut out = Vec::new();
    // Newest first from the end of the file: the answer is the last `limit` matches, so only the
    // tail is read, however large the log has grown. Reaching `since_id` ends the walk.
    scan_global_entries_backwards(|entry| {
        if since_id.is_some_and(|since| entry.id.0 == since) {
            return true;
        }
        let summary = summarize_event(&entry);
        if let Some(pane_filter) = pane_filter {
            if summary.pane_id.as_deref() != Some(pane_filter) {
                return false;
            }
        }
        if let Some(types) = type_filter.as_ref() {
            if !types
                .iter()
                .any(|kind| summary.event_type.to_ascii_lowercase().contains(kind))
            {
                return false;
            }
        }
        out.push(summary);
        out.len() >= limit
    })?;
    out.reverse();
    Ok(out)
}

pub fn last_pane_event_summary(pane_id: &str) -> Option<LastEventSummary> {
    // Scans from the end of the log: every worker-status call asks this, and the log only grows.
    let entry = super::find_last_entry(
        |entry| matches!(event_pane_id(&entry.payload), Some(id) if id.0 == pane_id),
    )
    .ok()??;
    Some(LastEventSummary {
        event_type: event_type_name(&entry.payload).to_string(),
        timestamp_ms: entry.timestamp_ms,
    })
}

fn summarize_event(entry: &EventEntry) -> RecentEventSummary {
    RecentEventSummary {
        id: entry.id.0.clone(),
        timestamp_ms: entry.timestamp_ms,
        event_type: event_type_name(&entry.payload).to_string(),
        pane_id: event_pane_id(&entry.payload).map(|id| id.0),
    }
}

fn event_pane_id(payload: &SystemEvent) -> Option<PaneId> {
    match payload {
        SystemEvent::PaneSpawned { pane_id, .. }
        | SystemEvent::PaneKilled { pane_id, .. }
        | SystemEvent::PaneInputWritten { pane_id, .. }
        | SystemEvent::PaneOutputObserved { pane_id, .. }
        | SystemEvent::PaneStatusChanged { pane_id, .. }
        | SystemEvent::PaneRoleSet { pane_id, .. }
        | SystemEvent::PaneDigestUpdated { pane_id, .. }
        | SystemEvent::AgentObservation { pane_id, .. }
        | SystemEvent::OpenCodeKeySwap { pane_id, .. }
        | SystemEvent::PaneModelSwitched { pane_id, .. }
        | SystemEvent::PaneTuiReattached { pane_id, .. } => Some(pane_id.clone()),
        SystemEvent::DelegationPrepared { target_pane_id, .. } => target_pane_id.clone(),
        _ => None,
    }
}

pub(crate) fn event_type_name(payload: &SystemEvent) -> &'static str {
    match payload {
        SystemEvent::PaneSpawned { .. } => "PaneSpawned",
        SystemEvent::PaneKilled { .. } => "PaneKilled",
        SystemEvent::PaneInputWritten { .. } => "PaneInputWritten",
        SystemEvent::PaneOutputObserved { .. } => "PaneOutputObserved",
        SystemEvent::PaneStatusChanged { .. } => "PaneStatusChanged",
        SystemEvent::McpToolCalled { .. } => "McpToolCalled",
        SystemEvent::McpToolCompleted { .. } => "McpToolCompleted",
        SystemEvent::TaskCreated { .. } => "TaskCreated",
        SystemEvent::TaskClaimed { .. } => "TaskClaimed",
        SystemEvent::TaskLeaseRenewed { .. } => "TaskLeaseRenewed",
        SystemEvent::TaskStatusUpdated { .. } => "TaskStatusUpdated",
        SystemEvent::TaskCompleted { .. } => "TaskCompleted",
        SystemEvent::TaskBlocked { .. } => "TaskBlocked",
        SystemEvent::ReviewerAssigned { .. } => "ReviewerAssigned",
        SystemEvent::ResourceLockAcquired { .. } => "ResourceLockAcquired",
        SystemEvent::ResourceLockConflict { .. } => "ResourceLockConflict",
        SystemEvent::ResourceLockReleased { .. } => "ResourceLockReleased",
        SystemEvent::ResourceLockExpired { .. } => "ResourceLockExpired",
        SystemEvent::AgentObservation { .. } => "AgentObservation",
        SystemEvent::SessionGoalUpdated { .. } => "SessionGoalUpdated",
        SystemEvent::PaneRoleSet { .. } => "PaneRoleSet",
        SystemEvent::PaneDigestUpdated { .. } => "PaneDigestUpdated",
        SystemEvent::DelegationPrepared { .. } => "DelegationPrepared",
        SystemEvent::OrchestratorStandbyPolicyUpdated { .. } => "OrchestratorStandbyPolicyUpdated",
        SystemEvent::OpenCodeKeySwap { .. } => "OpenCodeKeySwap",
        SystemEvent::PaneModelSwitched { .. } => "PaneModelSwitched",
        SystemEvent::PaneTuiReattached { .. } => "PaneTuiReattached",
    }
}
