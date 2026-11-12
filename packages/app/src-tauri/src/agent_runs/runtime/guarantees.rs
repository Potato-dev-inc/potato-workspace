//! What a run guarantees, in one shape for every lane (chat, terminal pane, headless).
//!
//! `verified` has one meaning everywhere: the app ran the caller's checks and all of them passed.
//! `true` = they all passed, `false` = one failed, `null` = nothing was verified (no checks were set,
//! or they have not run) and `verified_reason` says which. Everything lane-specific (how read-only is
//! enforced, whether the model was confirmed, where the work ran) lives in `guarantees`.

use crate::agent_runs::checks::{Check, CheckResult};
use crate::agent_runs::tree_proof::ReadOnlyProof;
use serde::{Deserialize, Serialize};

/// `guarantees.read_only`: what was asked, what enforces it, and the before/after proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadOnlyGuarantee {
    pub requested: bool,
    /// `permission_reject` (the app rejects every non-read permission), `plan_mode` (the agent's own
    /// read-only mode), `sandbox`, `cli_flag` (launch flags) or `none`.
    pub enforcement: String,
    /// `tree_unchanged` or `tree_changed`; null when the folder could not be checked (see `proof_reason`).
    pub proof: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub changed_total: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// `guarantees.isolation`: `worktree` (own copy on its own branch) or `project_folder`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IsolationGuarantee {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// `guarantees.checks`: `state` is `passed`, `failed`, `pending`, `not_run` or `none`; `by` is always `app`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecksGuarantee {
    pub state: String,
    pub ran: Vec<String>,
    pub by: String,
}

/// `guarantees.model`: the model asked for and whether the backend confirmed it ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelGuarantee {
    pub asked: Option<String>,
    pub confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Guarantees {
    pub read_only: ReadOnlyGuarantee,
    pub isolation: IsolationGuarantee,
    pub checks: ChecksGuarantee,
    pub model: ModelGuarantee,
}

/// A short, plain name for a check ("command_exits npm test").
pub fn describe(check: &Check) -> String {
    match check {
        Check::FileExists { path } => format!("file_exists {path}"),
        Check::FileContains { path, .. } => format!("file_contains {path}"),
        Check::FileAbsent { path } => format!("file_absent {path}"),
        Check::ResultContains { .. } => "result_contains".to_string(),
        Check::CommandExits { command, .. } => format!("command_exits {}", command.join(" ")),
    }
}

/// How the checks stand. `configured` are the checks set on the run; `results` what the app got from
/// running them (only a turn that ended has any); `ended` says the turn is over.
pub fn checks_guarantee(configured: &[Check], results: Option<&[CheckResult]>, ended: bool) -> ChecksGuarantee {
    let ran: Vec<String> = results.map(|r| r.iter().map(|c| describe(&c.check)).collect()).unwrap_or_default();
    let state = match results {
        _ if configured.is_empty() => "none",
        Some(r) if r.len() >= configured.len() && r.iter().all(|c| c.passed) => "passed",
        Some(r) if r.iter().any(|c| !c.passed) => "failed",
        _ if ended => "not_run",
        _ => "pending",
    };
    ChecksGuarantee { state: state.into(), ran, by: "app".into() }
}

/// The one `verified` value: `Some(true)` only when the app ran checks and all passed.
pub fn verified_of(checks: &ChecksGuarantee) -> Option<bool> {
    match checks.state.as_str() {
        "passed" => Some(true),
        "failed" => Some(false),
        _ => None,
    }
}

/// Why `verified` is not `true`, in a sentence; `None` when it is.
pub fn verified_reason(checks: &ChecksGuarantee) -> Option<String> {
    let text = match checks.state.as_str() {
        "passed" => return None,
        "failed" => "At least one check did not pass.",
        "pending" => "The checks have not run yet: they run when the turn ends.",
        "not_run" => "The turn ended before the checks ran.",
        _ => "No checks were configured, so the app verified nothing; the result is the agent's own report. Pass checks (file_exists, command_exits, ...) to get verified: true.",
    };
    Some(text.to_string())
}

pub fn read_only_guarantee(requested: bool, enforcement: &str, proof: Option<&ReadOnlyProof>, ended: bool) -> ReadOnlyGuarantee {
    let (value, reason, paths, total) = match (requested, proof) {
        (false, _) => (None, Some("not_requested".to_string()), Vec::new(), 0),
        (true, Some(p)) => (p.proof.clone(), p.reason.clone(), p.changed_paths.clone(), p.changed_total),
        (true, None) if !ended => (None, Some("run_in_progress".to_string()), Vec::new(), 0),
        (true, None) => (None, Some("app_restarted".to_string()), Vec::new(), 0),
    };
    ReadOnlyGuarantee {
        requested,
        enforcement: if requested { enforcement } else { "none" }.into(),
        proof: value,
        proof_reason: reason,
        changed_paths: paths,
        changed_total: total,
    }
}

impl Guarantees {
    pub fn verified(&self) -> Option<bool> {
        verified_of(&self.checks)
    }

    pub fn verified_reason(&self) -> Option<String> {
        verified_reason(&self.checks)
    }
}
