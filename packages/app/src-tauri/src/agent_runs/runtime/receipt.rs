//! What a finished run proved and did not (`RunReceipt`) and the caveats on it (`RunWarning`),
//! derived only from recorded facts on the snapshot.

use crate::operations::{OperationSnapshot, OperationStatus, ResultCapture};
use serde::{Deserialize, Serialize};

/// What a run proved and what it did not. Every `not_verified` entry is derived from a fact the
/// run recorded; nothing here is a guess.
/// `(lane_used, lane_reason, lane_fallback)` of a run, from what the worker kept.
pub(super) fn lane_report(snapshot: &OperationSnapshot) -> (Option<String>, Option<String>, Option<serde_json::Value>) {
    let to_headless = snapshot.worker.fallback.as_ref().is_some_and(|f| f.to == "headless");
    match snapshot.worker.lane_note.as_ref().map(|note| note.report(to_headless)) {
        Some((used, reason, fallback)) => (Some(used), Some(reason), fallback),
        None => (None, None, None),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunReceipt {
    pub backend: String,
    /// The model that ran when the backend confirmed it, else the one requested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `enforced`, `unenforced` (requested but the backend cannot enforce it) or `off`.
    pub read_only: String,
    /// `none configured` or `<passed>/<total> passed`.
    pub checks: String,
    pub result_capture: String,
    /// The worker's `potato-result` block when it ended its reply with a valid one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_result: Option<serde_json::Value>,
    pub not_verified: Vec<String>,
    /// One field for "did it work": `passed_checks`, `completed_unchecked`, `failed_checks`,
    /// `failed`, `cancelled`, `needs_input` or `in_progress`. Only `passed_checks` means the
    /// requested behaviour was proven; `completed_unchecked` means the worker finished but nothing
    /// verified it.
    #[serde(default)]
    pub outcome: String,
    /// Potato Workspace build that produced the run, so a result can be tied to the code under test.
    #[serde(default)]
    pub build_id: String,
    /// A warm standby worker (`crate::standby`) ran the turn: no pane spawn or CLI startup was
    /// paid for it. Absent when the run used a freshly spawned worker.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub standby_used: bool,
    /// The saved account id the run used; null when it ran under the CLI's own login.
    #[serde(default)]
    pub account_used: Option<String>,
    /// How the login was chosen: `explicit` (the caller named the account), `helper_default` (the person's
    /// "Helpers use" setting), `asked` (the person answered a card) or `cli_login` (the CLI's own login).
    #[serde(default)]
    pub account_source: String,
    /// Set when the run wanted a visible pane and ran headless instead: `{from, to, reason}` with
    /// reason `no_visible_mode` or `visible_failed`. Null otherwise.
    #[serde(default)]
    pub fallback: Option<crate::operations::RunFallback>,
    /// Set when the agent's "How agent runs work" setting decided the mode: `{mode, source}` with
    /// mode `one_task` or `visible` and source `agent_setting`. When one-task mode was chosen but
    /// not verified, mode is `visible` and `fallback` is `{from: "one_task", to: "visible",
    /// reason: "not_verified"}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<crate::operations::RunModeNote>,
    /// Present when `headless: true` was ignored because "Helper agents" keeps helpers visible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headless_ignored: Option<String>,
    /// Present when "Helper agents" made this run a background one the agent did not ask for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headless_forced: Option<String>,
    /// Present when `requested_model` is the person's helper default for this agent, not something the request named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_note: Option<String>,
    /// `terminal` or `headless` (see `lane_reason`); absent for runs started without the `/agents/run` route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_used: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_reason: Option<String>,
    /// Set when a chat (ACP) was tried first and did not start: `{from, to, code, message}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_fallback: Option<serde_json::Value>,
    /// The definition (id, source, fingerprint, pinned binary) a declarative agent ran from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_definition: Option<crate::tui::DefinitionRef>,
    /// Set when the run worked in an isolated git worktree (`isolation: "worktree"`): where, on
    /// which branch, what it changed, and whether the changes were merged. Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<ReceiptWorktree>,
    /// Set when the agent ran out of usage during the run: still waiting (`state: "waiting"`) or the
    /// person chose to stop there (`state: "stopped"`). `outcome` stays `needs_input` / `cancelled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_limit: Option<ReceiptLimit>,
}

/// The usage limit a run stopped at (`crate::handoff`), as the receipt shows it:
/// "Stopped at a usage limit (resets 14:05)".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptLimit {
    /// `waiting` (the agent is at its limit now) or `stopped` (a person ended the run there).
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    /// When it can continue (epoch ms), when the screen printed a time Potato Workspace could read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at_ms: Option<u64>,
    /// The time as the screen printed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_text: Option<String>,
}

/// The usage limit a run is parked at or was stopped at, read from what `handoff` recorded on it.
pub(crate) fn usage_limit_of(snapshot: &OperationSnapshot) -> Option<ReceiptLimit> {
    let read = |value: &serde_json::Value, state: &str| ReceiptLimit {
        state: state.to_string(),
        window: value.get("window").and_then(|v| v.as_str()).map(str::to_string),
        reset_at_ms: value.get("reset_at_ms").and_then(|v| v.as_u64()),
        reset_text: value.get("reset_text").and_then(|v| v.as_str()).map(str::to_string),
    };
    if let Some(error) = snapshot.error.as_ref().filter(|e| e.code == crate::operations::USAGE_LIMIT_STOPPED) {
        return Some(read(&error.context, "stopped"));
    }
    let action = snapshot.required_action.as_ref()?;
    (snapshot.status == OperationStatus::WaitingInput
        && action.get("kind").and_then(|v| v.as_str()) == Some(crate::operations::USAGE_LIMIT_KIND))
    .then(|| read(action, "waiting"))
}

/// The worktree facts of a receipt. `state` is `unreviewed` (still on disk, not merged),
/// `merged` or `discarded`. The change counts are those recorded when the run finished (absent
/// for a run that did not complete); `worktree_diff` always reads the live state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptWorktree {
    pub path: String,
    pub branch: String,
    pub base: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u32>,
    /// What preparing the copy did: setup steps and files copied in (never committed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<ReceiptSetup>,
}

/// The setup of a separate copy, as the receipt shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptSetup {
    /// `ok` or `failed`.
    pub status: String,
    /// One plain sentence ("Ran npm ci; copied .env (never committed).").
    pub sentence: String,
    pub copied: Vec<String>,
}

/// The receipt's `account_source`: recorded by the app when it chose the login, else `explicit` for a named account
/// and `cli_login` for none.
fn account_source_of(worker: &crate::operations::WorkerPersist) -> String {
    match (&worker.account_source, &worker.account) {
        (Some(source), _) => source.clone(),
        (None, Some(_)) => crate::accounts::helper::SOURCE_EXPLICIT.into(),
        (None, None) => crate::accounts::helper::SOURCE_CLI_LOGIN.into(),
    }
}

pub(super) fn build_receipt(
    snapshot: &OperationSnapshot,
    warnings: &[RunWarning],
    model_verified: Option<bool>,
    result_capture: &str,
) -> RunReceipt {
    let terminal = snapshot.status.terminal();
    // Prefer the facts recorded when the turn started; old snapshots fall back to the live registry.
    let held = snapshot.worker.run_features.unwrap_or_else(|| {
        crate::operations::RunFeatures::of(crate::tui::profile_for(&snapshot.agent_type).as_ref())
    });
    let read_only = if !snapshot.read_only {
        "off"
    } else if held.read_only_headless
        || (held.read_only_visible_flags && snapshot.pane_id.is_some())
        || (held.read_only_spawned_pane
            && snapshot
                .pane_id
                .as_deref()
                .is_some_and(crate::tui::opencode::read_only::is_enforced))
    {
        "enforced"
    } else {
        "unenforced"
    };
    let total = snapshot.checks.len();
    let checks = if total == 0 {
        "none configured".to_string()
    } else if terminal {
        let passed = snapshot
            .check_results
            .iter()
            .filter(|result| result.passed)
            .count();
        format!("{passed}/{total} passed")
    } else {
        format!("0/{total} passed (pending)")
    };
    let mut not_verified = Vec::new();
    if total == 0 {
        not_verified.push("no checks configured".to_string());
    }
    if terminal && result_capture == "inferred" {
        not_verified.push("result read from terminal screen".to_string());
    }
    if terminal && snapshot.worker.requested_model.is_some() && model_verified != Some(true) {
        not_verified.push("model not confirmed".to_string());
    }
    if snapshot.worker.worktree.as_ref().and_then(|w| w.setup.as_ref()).is_some_and(|s| s.failed()) {
        not_verified.push("setting up the copy failed".to_string());
    }
    if let Some(fallback) = &snapshot.worker.fallback {
        if fallback.is_one_task_to_visible() {
            not_verified.push(format!(
                "one-task mode is set for this agent but not verified; ran in a visible pane ({})",
                fallback.reason
            ));
        } else {
            not_verified.push(format!(
                "ran headless, not in a visible pane ({})",
                fallback.reason
            ));
        }
    }
    if held.experimental {
        not_verified.push("experimental agent: screen heuristics only".to_string());
    }
    if read_only == "unenforced" {
        not_verified.push("read_only not enforced".to_string());
    }
    if warnings
        .iter()
        .any(|warning| warning.code == "SHELL_COMMAND_REJECTED")
    {
        not_verified.push("shell commands rejected".to_string());
    }
    if warnings
        .iter()
        .any(|warning| warning.code == "AGENT_REPORTED_ERROR")
    {
        not_verified.push("agent reported a tool failure".to_string());
    }
    let outcome = receipt_outcome(snapshot, total);
    let lane = lane_report(snapshot);
    RunReceipt {
        backend: snapshot.agent_type.clone(),
        model: snapshot
            .worker
            .resolved_model
            .clone()
            .or_else(|| snapshot.worker.requested_model.clone()),
        read_only: read_only.into(),
        checks,
        result_capture: result_capture.into(),
        structured_result: None,
        not_verified,
        outcome: outcome.into(),
        build_id: env!("PM_BUILD_ID").to_string(),
        standby_used: snapshot.worker.standby_used,
        account_used: snapshot.worker.account.clone(),
        account_source: account_source_of(&snapshot.worker),
        fallback: snapshot.worker.fallback.clone(),
        run_mode: snapshot.worker.run_mode.clone(),
        headless_ignored: snapshot.worker.headless_ignored.clone(),
        headless_forced: snapshot.worker.headless_forced.clone(),
        model_note: snapshot.worker.model_note.clone(),
        lane_used: lane.0,
        lane_reason: lane.1,
        lane_fallback: lane.2,
        agent_definition: snapshot.worker.agent_definition.clone(),
        worktree: snapshot.worker.worktree.as_ref().map(|worktree| ReceiptWorktree {
            path: worktree.path.clone(),
            branch: worktree.branch.clone(),
            base: worktree.base.clone(),
            state: worktree
                .closed
                .clone()
                .unwrap_or_else(|| "unreviewed".to_string()),
            files_changed: worktree.changes.map(|c| c.files_changed),
            additions: worktree.changes.map(|c| c.additions),
            deletions: worktree.changes.map(|c| c.deletions),
            setup: worktree.setup.as_ref().map(|setup| ReceiptSetup {
                status: setup.status.clone(),
                sentence: setup.sentence(),
                copied: setup.copied.clone(),
            }),
        }),
        usage_limit: usage_limit_of(snapshot),
    }
}

fn receipt_outcome(snapshot: &OperationSnapshot, checks_total: usize) -> &'static str {
    match snapshot.status {
        OperationStatus::Completed => {
            let all_passed = checks_total > 0
                && snapshot.check_results.len() >= checks_total
                && snapshot.check_results.iter().all(|result| result.passed);
            // Completed with checks that did not all pass cannot normally happen (a failing
            // check fails the run); never report it as proven.
            if all_passed {
                "passed_checks"
            } else {
                "completed_unchecked"
            }
        }
        OperationStatus::Failed => {
            if snapshot
                .error
                .as_ref()
                .is_some_and(|error| error.code == "ACCEPTANCE_FAILED")
            {
                "failed_checks"
            } else {
                "failed"
            }
        }
        OperationStatus::Cancelled => "cancelled",
        OperationStatus::WaitingInput => "needs_input",
        OperationStatus::Queued
        | OperationStatus::Starting
        | OperationStatus::Running
        | OperationStatus::Cancelling => "in_progress",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunWarning {
    pub code: String,
    /// `capture` (how the result was obtained) or `heuristic` (text match; not a fact).
    pub source: String,
    pub detail: String,
}

pub(super) fn run_warnings(snapshot: &OperationSnapshot) -> Vec<RunWarning> {
    if !snapshot.status.terminal() {
        return Vec::new();
    }
    let mut warnings = Vec::new();
    let mut push = |code: &str, source: &str, detail: &str| {
        warnings.push(RunWarning {
            code: code.into(),
            source: source.into(),
            detail: detail.into(),
        })
    };
    for warning in &snapshot.warnings {
        push(&warning.code, "capture", &warning.detail);
    }
    let facts = crate::tui::RunFacts {
        result: snapshot.result.as_deref(),
        has_pane: snapshot.pane_id.is_some(),
        completed: snapshot.status == OperationStatus::Completed,
        result_inferred: matches!(snapshot.result_capture, Some(ResultCapture::Inferred)),
        model_requested: snapshot.worker.requested_model.is_some(),
        model_unconfirmed: snapshot.worker.model_unconfirmed,
    };
    for warning in crate::tui::profile_for(&snapshot.agent_type).run_warnings(&facts) {
        push(warning.code, warning.source, warning.detail);
    }
    if snapshot.status == OperationStatus::Completed {
        if snapshot.worker.resolved_model.is_none() {
            // Never a silent null: say whether it was asked for and that the backend stayed silent.
            let detail = if snapshot.worker.requested_model.is_some() {
                "A model was requested but the backend did not confirm which model ran.".to_string()
            } else {
                format!(
                    "{} did not report which model ran and no configured default could be determined, so resolved_model is null.",
                    snapshot.agent_type
                )
            };
            warnings.push(RunWarning {
                code: "MODEL_UNRESOLVED".into(),
                source: "capture".into(),
                detail,
            });
        } else if snapshot.worker.model_unconfirmed
            && !warnings.iter().any(|warning| warning.code == "MODEL_UNCONFIRMED")
        {
            warnings.push(RunWarning {
                code: "MODEL_UNCONFIRMED".into(),
                source: "capture".into(),
                detail: "The backend does not report which model ran; resolved_model is the CLI's configured default, not a confirmation.".into(),
            });
        }
    }
    if let Some(warning) = model_choice_warning(snapshot) {
        warnings.push(warning);
    }
    warnings
}

/// Says plainly when the model a run asked for is not the one that ran: either the agent cannot be told
/// a model the way this run started (`MODEL_NOT_APPLIED`), or it was told and a different one ran
/// (`MODEL_MISMATCH`). Nothing when no model was asked for, or the one that ran is the one asked.
fn model_choice_warning(snapshot: &OperationSnapshot) -> Option<RunWarning> {
    let requested = snapshot.worker.requested_model.as_deref()?;
    let profile = crate::tui::profile_for(&snapshot.agent_type);
    let visible = snapshot.pane_id.is_some();
    let applied = if visible {
        profile
            .visible_run_args(&crate::tui::VisibleRun { model: Some(requested), ..Default::default() })
            .model_applied
    } else {
        profile.accepts_headless_model()
    };
    let ran = snapshot.worker.resolved_model.as_deref().filter(|_| !snapshot.worker.model_unconfirmed);
    let (code, detail) = if !applied {
        let how = if visible { "in a pane" } else { "in a headless run" };
        (
            "MODEL_NOT_APPLIED",
            format!(
                "{} cannot be told which model to use {how}, so the requested model {requested} was not applied and the run used the agent's own choice{}.",
                snapshot.agent_type,
                ran.map(|model| format!(" ({model})")).unwrap_or_default()
            ),
        )
    } else if let Some(ran) = ran.filter(|ran| !crate::agent_runs::persist::model_matches(requested, ran)) {
        (
            "MODEL_MISMATCH",
            format!("The run asked for model {requested}, but {ran} is the model that ran. The agent or its settings did not use the requested model."),
        )
    } else {
        return None;
    };
    Some(RunWarning { code: code.into(), source: "capture".into(), detail })
}
