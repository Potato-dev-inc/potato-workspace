//! What a chat run proved and did not: the same `receipt` the terminal runs carry (`agent_runs::RunReceipt`), plus the
//! acceptance `checks` of the run.
//!
//! * The facts live with the chat (`RunMeta`): the folder, the requested model, the checks, the account, the key the
//!   run was started with. Pure helpers here build the receipt and decide the outcome.
//! * Checks are evaluated once per completed turn (`checked`): `wait_agents` and `inspect_agent` read the cached
//!   results, so a `command_exits` check is never run twice for one turn.
//! * Nothing here names an agent.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::AcpChat;
use crate::agent_runs::checks::{self, Check, CheckResult};
use crate::agent_runs::RunReceipt;

/// The results of one turn's checks.
#[derive(Debug, Clone)]
pub struct CheckedTurn {
    pub turn: u64,
    pub results: Vec<CheckResult>,
}

/// What the `run_agent` that started a chat asked for, kept with the chat. Empty for a chat the person started.
#[derive(Debug, Default)]
pub struct RunMeta {
    /// The folder the agent works in (checks are evaluated against it).
    pub folder: Option<PathBuf>,
    /// Acceptance checks for the next turns; `followup_task` with new checks replaces them.
    pub checks: Vec<Check>,
    /// The model the caller asked for (it reached the agent as a config option before the first message).
    pub requested_model: Option<String>,
    pub account: Option<String>,
    pub account_source: Option<String>,
    /// The results of the newest completed turn. Shared so one evaluation runs at a time.
    pub cache: Arc<Mutex<Option<CheckedTurn>>>,
}

impl AcpChat {
    /// Remembers what the starting `run_agent` asked for.
    pub(crate) fn set_run_meta(&self, meta: RunMeta) {
        *self.run_meta.lock() = meta;
    }

    /// New checks for the following turns (callers pass them only when the follow-up names some).
    pub(crate) fn replace_checks(&self, checks: Vec<Check>) {
        let mut meta = self.run_meta.lock();
        meta.checks = checks;
        *meta.cache.lock() = None;
    }

    pub(crate) fn note_requested_model(&self, model: Option<String>) {
        self.run_meta.lock().requested_model = model;
    }

    pub(crate) fn run_folder(&self) -> Option<PathBuf> {
        self.run_meta.lock().folder.clone()
    }

    pub fn checks_configured(&self) -> usize {
        self.run_meta.lock().checks.len()
    }

    /// The checks' results for the newest turn when it completed: evaluated at most once per turn.
    /// `None`: no checks, or the turn is not a completed one.
    pub(crate) fn checked(&self, completed: bool, turn: u64, reply: Option<&str>) -> Option<Vec<CheckResult>> {
        let (checks, folder, cache) = {
            let meta = self.run_meta.lock();
            (meta.checks.clone(), meta.folder.clone(), meta.cache.clone())
        };
        if checks.is_empty() || !completed {
            return None;
        }
        let mut cached = cache.lock();
        if let Some(done) = cached.as_ref().filter(|done| done.turn == turn) {
            return Some(done.results.clone());
        }
        let folder = folder?;
        let commands = checks::run_command_checks(&folder, &checks);
        let results = checks::evaluate_with_commands(&folder, &checks, reply, &commands);
        *cached = Some(CheckedTurn { turn, results: results.clone() });
        Some(results)
    }

    pub(crate) fn run_meta_snapshot(&self) -> (Option<String>, Option<String>, Option<String>) {
        let meta = self.run_meta.lock();
        (meta.requested_model.clone(), meta.account.clone(), meta.account_source.clone())
    }
}

/// `completed`, `running`, ... as the receipt's one-word outcome.
pub fn outcome_of(status: &str, checks_total: usize, results: Option<&[CheckResult]>) -> &'static str {
    match status {
        "completed" => match results {
            Some(results) if checks_total > 0 && results.len() >= checks_total && results.iter().all(|r| r.passed) => "passed_checks",
            Some(results) if checks_total > 0 && results.iter().any(|r| !r.passed) => "failed_checks",
            _ => "completed_unchecked",
        },
        "failed" => "failed",
        "cancelled" => "cancelled",
        "waiting_input" => "needs_input",
        _ => "in_progress",
    }
}

/// Everything a receipt needs, gathered by `surface::view`.
pub struct ReceiptInputs<'a> {
    /// The status the view shows (`completed`, `running`, ...).
    pub status: &'a str,
    pub final_turn: bool,
    pub checks_total: usize,
    pub results: Option<&'a [CheckResult]>,
    pub reply: Option<&'a str>,
    pub requested_model: Option<&'a str>,
    /// The model the agent's config options report right now.
    pub model_in_use: Option<&'a str>,
    pub account: Option<&'a str>,
    pub account_source: Option<&'a str>,
    pub lane_note: Option<&'a Value>,
    pub warm: bool,
}

pub fn build(inputs: &ReceiptInputs) -> RunReceipt {
    let structured = if inputs.final_turn { inputs.reply.and_then(crate::agent_runs::structured::parse) } else { None };
    let result_capture = if structured.is_some() {
        "structured"
    } else if inputs.final_turn {
        "authoritative"
    } else {
        "pending"
    };
    let total = inputs.checks_total;
    let checks = if total == 0 {
        "none configured".to_string()
    } else if let Some(results) = inputs.results {
        format!("{}/{} passed", results.iter().filter(|r| r.passed).count(), total)
    } else {
        format!("0/{total} passed (pending)")
    };
    let mut not_verified = Vec::new();
    if total == 0 {
        not_verified.push("no checks configured".to_string());
    }
    let model_confirmed = match (inputs.requested_model, inputs.model_in_use) {
        (Some(asked), Some(ran)) => crate::agent_runs::persist::model_matches(asked, ran),
        _ => false,
    };
    if inputs.final_turn && inputs.requested_model.is_some() && !model_confirmed {
        not_verified.push("model not confirmed".to_string());
    }
    let note = |key: &str| inputs.lane_note.and_then(|n| n.get(key)).and_then(Value::as_str).map(str::to_string);
    let account_source = inputs.account_source.map(str::to_string).unwrap_or_else(|| {
        if inputs.account.is_some() { crate::accounts::helper::SOURCE_EXPLICIT } else { crate::accounts::helper::SOURCE_CLI_LOGIN }.to_string()
    });
    RunReceipt {
        backend: "acp".into(),
        model: inputs.model_in_use.map(str::to_string).or_else(|| inputs.requested_model.map(str::to_string)),
        read_only: "off".into(),
        checks,
        result_capture: result_capture.into(),
        structured_result: structured,
        not_verified,
        outcome: outcome_of(inputs.status, total, inputs.results).into(),
        build_id: env!("PM_BUILD_ID").to_string(),
        standby_used: inputs.warm,
        account_used: inputs.account.map(str::to_string),
        account_source,
        fallback: None,
        run_mode: None,
        headless_ignored: None,
        headless_forced: None,
        lane_used: note("lane_used"),
        lane_reason: note("lane_reason"),
        lane_fallback: inputs.lane_note.and_then(|n| n.get("lane_fallback")).cloned(),
        agent_definition: None,
        worktree: None,
        usage_limit: None,
    }
}

/// The receipt of a chat as a JSON value for its answers.
pub fn receipt_value(receipt: &RunReceipt) -> Value {
    serde_json::to_value(receipt).unwrap_or_else(|_| json!(null))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(passed: bool) -> CheckResult {
        CheckResult { check: Check::ResultContains { text: "x".into() }, passed, detail: String::new() }
    }

    #[test]
    fn the_outcome_is_one_word_for_how_it_went() {
        assert_eq!(outcome_of("completed", 0, None), "completed_unchecked");
        assert_eq!(outcome_of("completed", 1, Some(&[result(true)])), "passed_checks");
        assert_eq!(outcome_of("completed", 2, Some(&[result(true), result(false)])), "failed_checks");
        assert_eq!(outcome_of("failed", 0, None), "failed");
        assert_eq!(outcome_of("cancelled", 0, None), "cancelled");
        assert_eq!(outcome_of("waiting_input", 0, None), "needs_input");
        assert_eq!(outcome_of("running", 1, None), "in_progress");
        assert_eq!(outcome_of("idle", 0, None), "in_progress");
    }
}
