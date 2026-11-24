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
use serde_json::Value;

use super::AcpChat;
use crate::agent_runs::checks::{self, Check, CheckResult};

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
    /// The folder look of the newest read-only turn, taken once when the turn ended: `(turn, proof)`.
    pub proof: Option<(u64, crate::agent_runs::tree_proof::ReadOnlyProof)>,
    /// The files the newest turn changed (git, start to end), taken once when the turn ended: `(turn, files)`.
    pub files: Option<(u64, Vec<String>)>,
}

impl AcpChat {
    /// Remembers what the starting `run_agent` asked for.
    pub fn set_run_meta(&self, meta: RunMeta) {
        *self.run_meta.lock() = meta;
    }

    /// New checks for the following turns (callers pass them only when the follow-up names some).
    pub fn replace_checks(&self, checks: Vec<Check>) {
        let mut meta = self.run_meta.lock();
        meta.checks = checks;
        *meta.cache.lock() = None;
    }

    pub fn note_requested_model(&self, model: Option<String>) {
        self.run_meta.lock().requested_model = model;
    }

    pub fn run_folder(&self) -> Option<PathBuf> {
        self.run_meta.lock().folder.clone()
    }

    pub fn run_checks(&self) -> Vec<Check> {
        self.run_meta.lock().checks.clone()
    }

    pub fn checks_configured(&self) -> usize {
        self.run_meta.lock().checks.len()
    }

    /// The checks' results for the newest turn when it completed: evaluated at most once per turn.
    /// `None`: no checks, or the turn is not a completed one.
    pub fn checked(&self, completed: bool, turn: u64, reply: Option<&str>) -> Option<Vec<CheckResult>> {
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

    /// A read-only run is looked at as each turn starts (`agent_runs::tree_proof`); a chat the person started is not.
    pub fn begin_read_only_look(&self) {
        let folder = {
            let mut meta = self.run_meta.lock();
            meta.proof = None;
            meta.folder.clone()
        };
        if let Some(folder) = folder.filter(|_| self.session().is_read_only()) {
            crate::agent_runs::tree_proof::begin(self.pane_id(), &folder, true, false);
        }
    }

    /// The folder look for turn `turn` of a read-only run, once it ended: compared once and kept.
    pub fn read_only_proof(&self, final_turn: bool, turn: u64) -> Option<crate::agent_runs::tree_proof::ReadOnlyProof> {
        if !self.session().is_read_only() {
            return None;
        }
        let folder = {
            let meta = self.run_meta.lock();
            if let Some((seen, proof)) = meta.proof.as_ref().filter(|(seen, _)| *seen == turn) {
                let _ = seen;
                return Some(proof.clone());
            }
            meta.folder.clone()?
        };
        if !final_turn {
            return None;
        }
        let proof = crate::agent_runs::tree_proof::finish(self.pane_id(), &folder)
            .unwrap_or_else(|| crate::agent_runs::tree_proof::ReadOnlyProof::not_checked("app_restarted"));
        self.run_meta.lock().proof = Some((turn, proof.clone()));
        Some(proof)
    }

    /// A turn of a `run_agent` chat starts: how its folder looks now, so the result can list what changed.
    pub fn begin_result_facts(&self) {
        let folder = {
            let mut meta = self.run_meta.lock();
            meta.files = None;
            meta.folder.clone()
        };
        if let Some(folder) = folder {
            crate::agent_runs::structured::begin(self.pane_id(), &folder);
        }
    }

    /// The files turn `turn` changed, once it ended: compared once and kept. Empty before that.
    pub fn result_files(&self, final_turn: bool, turn: u64) -> Vec<String> {
        let folder = {
            let meta = self.run_meta.lock();
            if let Some((_, files)) = meta.files.as_ref().filter(|(seen, _)| *seen == turn) {
                return files.clone();
            }
            match meta.folder.clone() {
                Some(folder) => folder,
                None => return Vec::new(),
            }
        };
        if !final_turn {
            return Vec::new();
        }
        let files = crate::agent_runs::structured::finish(self.pane_id(), &folder);
        self.run_meta.lock().files = Some((turn, files.clone()));
        files
    }

    pub fn run_meta_snapshot(&self) -> (Option<String>, Option<String>, Option<String>) {
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

/// What the result is built from besides the reply (`agent_runs::structured`).
#[derive(Debug, Default)]
pub struct ResultFacts {
    pub files_changed: Vec<String>,
    /// The commands the agent ran this turn, from its tool calls.
    pub commands: Vec<String>,
    pub open_questions: Vec<String>,
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
    /// The chat's read-only guards are on (`chat::read_only::enable` succeeded).
    pub read_only: bool,
    /// How they hold: `plan_mode` when the agent also took its own read-only mode, else `permission_reject`.
    pub read_only_enforcement: &'a str,
    /// The before/after look at the folder for this turn, once the turn ended (`agent_runs::tree_proof`).
    pub read_only_proof: Option<&'a crate::agent_runs::tree_proof::ReadOnlyProof>,
    /// The agent that cannot be made read-only here (`None`: it can). Said in `not_verified` while the guards are off.
    pub read_only_cannot: Option<&'a str>,
    pub checks: &'a [Check],
    pub facts: &'a ResultFacts,
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
