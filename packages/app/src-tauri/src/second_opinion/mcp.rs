//! Second opinion through MCP: `run_agent(review_by: {...})` and `review_agent(handle)`.
//!
//! After an agent's run has changed files, a read-only run of a DIFFERENT installed agent looks at the diff and its
//! verdict and findings come back inside the same result as `review`. This file holds the decisions (who may
//! review, what the receipt says); everything it needs from the running app is behind [`ReviewIo`], so it is tested
//! with fakes. Generic code never looks at agent names: the reviewers on offer are whatever the registry says can
//! take a read-only headless run (`service::reviewers`).

use super::service::{Poll, ReviewerEntry};
use super::{ParsedReview, Severity, VerdictLevel};
use crate::operations::OperationError;
use serde::Deserialize;
use serde_json::{json, Value};

/// The most findings a receipt carries.
pub const MAX_FINDINGS: usize = 10;
/// How often a running review is looked at.
pub const POLL_MS: u64 = 1_000;
/// Default and largest time one call waits for the reviewer (the bridge caps a request at 300 s).
pub const DEFAULT_WAIT_MS: u64 = 120_000;
pub const MAX_WAIT_MS: u64 = 290_000;

/// What the caller asked for in `review_by`.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReviewAsk {
    /// The reviewer agent; left out = the first installed agent that is not the author.
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Allow the author's own agent to review (off by default: a second opinion should be a different agent).
    #[serde(default)]
    pub allow_same: bool,
}

/// What the review needs to know about the finished run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFacts {
    pub author_agent: String,
    /// The folder the work was done in.
    pub project: String,
    /// The run's pane while it may still be open (empty: none). It only adds checkpoint and worktree diffs.
    pub pane_id: String,
}

/// A reviewer run that was started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub handle: String,
    pub project: String,
    pub source_label: String,
    pub files: usize,
}

pub trait ReviewIo {
    fn facts(&self, project: Option<&str>, handle: &str) -> Result<RunFacts, OperationError>;
    fn reviewers(&self, author: &str) -> Vec<ReviewerEntry>;
    fn start(&self, facts: &RunFacts, reviewer: &str, model: Option<&str>) -> Result<Started, OperationError>;
    fn poll(&self, project: &str, handle: &str) -> Result<Poll, OperationError>;
    fn sleep(&self, ms: u64);
}

/// Who reviews. An explicit agent must be one that can review; the author's own agent only with `allow_same`.
pub fn pick_reviewer(author: &str, ask: &ReviewAsk, offered: &[ReviewerEntry]) -> Result<String, OperationError> {
    let others: Vec<&ReviewerEntry> = offered.iter().filter(|e| !e.id.eq_ignore_ascii_case(author)).collect();
    let names = |list: &[&ReviewerEntry]| list.iter().map(|e| Value::String(e.id.clone())).collect::<Vec<_>>();
    if let Some(wanted) = ask.agent_type.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        let Some(entry) = offered.iter().find(|e| e.id.eq_ignore_ascii_case(wanted)) else {
            let mut error = OperationError::new(
                "REVIEWER_UNAVAILABLE",
                format!("{wanted} cannot review here: it is not installed or has no read-only mode."),
                false,
            );
            error.context = json!({ "available": offered.iter().map(|e| e.id.clone()).collect::<Vec<_>>() });
            return Err(error);
        };
        if entry.id.eq_ignore_ascii_case(author) && !ask.allow_same {
            let mut error = OperationError::new(
                "SAME_AGENT_REVIEWER",
                "A second opinion should come from a different agent. Pick another one, or pass allow_same: true.",
                false,
            );
            error.context = json!({ "author": author, "other_agents": names(&others) });
            return Err(error);
        }
        return Ok(entry.id.clone());
    }
    // Left out: a different agent, one with a warm worker first.
    if let Some(entry) = others.iter().find(|e| e.ready).or_else(|| others.first()) {
        return Ok(entry.id.clone());
    }
    if ask.allow_same {
        if let Some(entry) = offered.iter().find(|e| e.id.eq_ignore_ascii_case(author)) {
            return Ok(entry.id.clone());
        }
    }
    let mut error = OperationError::new(
        "NO_REVIEWER_AVAILABLE",
        "No other installed agent can review. Install one, or pass review_by.allow_same: true to let the same agent review (ideally on another model).",
        false,
    );
    error.context = json!({ "author": author });
    Err(error)
}

fn verdict_word(level: VerdictLevel) -> &'static str {
    match level {
        VerdictLevel::Approve => "pass",
        VerdictLevel::Concerns => "concerns",
        VerdictLevel::Changes => "fail",
        VerdictLevel::Unknown => "unknown",
    }
}

/// `verdict` and `findings` of a parsed answer: the findings, worst first, at most [`MAX_FINDINGS`].
pub fn verdict_and_findings(review: &ParsedReview) -> (&'static str, String, Vec<Value>) {
    let mut ranked: Vec<&super::Finding> = review.findings.iter().collect();
    ranked.sort_by_key(|f| std::cmp::Reverse(f.severity));
    let findings: Vec<Value> = ranked
        .into_iter()
        .take(MAX_FINDINGS)
        .map(|f| {
            let severity = match f.severity {
                Severity::High => "high",
                Severity::Medium => "medium",
                Severity::Low => "low",
                Severity::Info => "info",
            };
            json!({ "file": f.file, "line": f.line, "note": f.text, "severity": severity })
        })
        .collect();
    let (word, text) = match &review.verdict {
        Some(v) if v.level != VerdictLevel::Unknown => (verdict_word(v.level), v.text.clone()),
        // No verdict line: findings mean concerns, an answer with neither is not a verdict.
        Some(v) => (if findings.is_empty() { "unknown" } else { "concerns" }, v.text.clone()),
        None => (if findings.is_empty() { "unknown" } else { "concerns" }, review.unstructured.clone().unwrap_or_default()),
    };
    (word, text, findings)
}

/// The `review` object of a result.
pub fn receipt(by: &str, model: Option<&str>, started: &Started, poll: &Poll) -> Value {
    let mut out = json!({ "by": by, "handle": started.handle, "reviewed": started.source_label, "files": started.files });
    if let Some(model) = model {
        out["model"] = json!(model);
    }
    match poll.state {
        "done" => {
            let review = poll.review.clone().unwrap_or_default();
            let (verdict, summary, findings) = verdict_and_findings(&review);
            out["state"] = json!("done");
            out["verdict"] = json!(verdict);
            if !summary.trim().is_empty() {
                out["summary"] = json!(summary);
            }
            out["findings"] = json!(findings);
        }
        "running" => {
            out["state"] = json!("running");
            out["next"] = json!({ "tool": "wait_agents", "args": { "handles": [started.handle] } });
        }
        other => {
            out["state"] = json!(other);
            out["verdict"] = json!("unknown");
            out["error"] = json!(poll.error.clone().unwrap_or_else(|| "The reviewer did not answer.".into()));
        }
    }
    out
}

pub fn skipped(why: &str) -> Value {
    json!({ "skipped": why })
}

/// Review the finished run `handle`: pick a reviewer, start it read-only on the diff and wait up to `wait_ms`.
/// Nothing changed = `{skipped}`, not an error.
pub fn review_run(io: &dyn ReviewIo, project: Option<&str>, handle: &str, ask: &ReviewAsk, wait_ms: u64) -> Result<Value, OperationError> {
    let facts = io.facts(project, handle)?;
    let reviewer = pick_reviewer(&facts.author_agent, ask, &io.reviewers(&facts.author_agent))?;
    let started = match io.start(&facts, &reviewer, ask.model.as_deref()) {
        Ok(started) => started,
        Err(error) if error.code == "NOTHING_TO_REVIEW" => return Ok(skipped("no changes")),
        Err(error) => return Err(error),
    };
    let polls = wait_ms.min(MAX_WAIT_MS) / POLL_MS;
    let mut last = io.poll(&started.project, &started.handle)?;
    for _ in 0..polls {
        if last.state != "running" {
            break;
        }
        io.sleep(POLL_MS);
        last = io.poll(&started.project, &started.handle)?;
    }
    Ok(receipt(&reviewer, ask.model.as_deref(), &started, &last))
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
