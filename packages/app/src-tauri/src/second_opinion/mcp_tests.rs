//! Second opinion through MCP, with a fake app: who may review, what the receipt says, when it is skipped.

use super::*;
use crate::second_opinion::{Finding, Verdict};
use std::cell::RefCell;

fn entry(id: &str, ready: bool) -> ReviewerEntry {
    ReviewerEntry { id: id.into(), label: id.into(), ready, same: false }
}

fn finding(file: &str, severity: Severity, text: &str) -> Finding {
    Finding { id: "f".into(), file: file.into(), line: Some(3), end_line: None, severity, text: text.into() }
}

struct Fake {
    offered: Vec<ReviewerEntry>,
    nothing_to_review: bool,
    polls_running: RefCell<u32>,
    answer: Poll,
    started_with: RefCell<Vec<(String, Option<String>)>>,
    slept: RefCell<u64>,
}

impl Fake {
    fn new(offered: Vec<ReviewerEntry>, answer: Poll) -> Self {
        Self { offered, nothing_to_review: false, polls_running: RefCell::new(0), answer, started_with: RefCell::default(), slept: RefCell::new(0) }
    }
}

impl ReviewIo for Fake {
    fn facts(&self, _project: Option<&str>, handle: &str) -> Result<RunFacts, OperationError> {
        if handle == "gone" {
            return Err(OperationError::new("AGENT_NOT_FOUND", "no such run", false));
        }
        Ok(RunFacts { author_agent: "claude".into(), project: "p".into(), pane_id: String::new() })
    }
    fn reviewers(&self, _author: &str) -> Vec<ReviewerEntry> {
        self.offered.clone()
    }
    fn start(&self, _facts: &RunFacts, reviewer: &str, model: Option<&str>) -> Result<Started, OperationError> {
        if self.nothing_to_review {
            return Err(crate::second_opinion::source::no_changes());
        }
        self.started_with.borrow_mut().push((reviewer.into(), model.map(str::to_string)));
        Ok(Started { handle: "rev-1".into(), project: "p".into(), source_label: "the last turn".into(), files: 2 })
    }
    fn poll(&self, _project: &str, _handle: &str) -> Result<Poll, OperationError> {
        let mut left = self.polls_running.borrow_mut();
        if *left > 0 {
            *left -= 1;
            return Ok(Poll { state: "running", review: None, error: None });
        }
        Ok(self.answer.clone())
    }
    fn sleep(&self, ms: u64) {
        *self.slept.borrow_mut() += ms;
    }
}

fn done(findings: Vec<Finding>, level: VerdictLevel) -> Poll {
    Poll {
        state: "done",
        review: Some(ParsedReview { findings, verdict: Some(Verdict { level, text: "Looks risky.".into() }), unstructured: None }),
        error: None,
    }
}

#[test]
fn the_same_agent_is_refused_unless_explicitly_allowed() {
    let offered = vec![entry("claude", false), entry("codex", false)];
    let ask = ReviewAsk { agent_type: Some("claude".into()), ..Default::default() };
    let error = pick_reviewer("claude", &ask, &offered).unwrap_err();
    assert_eq!(error.code, "SAME_AGENT_REVIEWER");
    assert_eq!(error.context["other_agents"][0], "codex");
    let allowed = ReviewAsk { allow_same: true, ..ask };
    assert_eq!(pick_reviewer("claude", &allowed, &offered).unwrap(), "claude");
}

#[test]
fn a_reviewer_left_out_is_a_different_agent_with_a_warm_one_first() {
    let offered = vec![entry("claude", true), entry("codex", false), entry("opencode", true)];
    assert_eq!(pick_reviewer("claude", &ReviewAsk::default(), &offered).unwrap(), "opencode");
    let cold = vec![entry("claude", true), entry("codex", false)];
    assert_eq!(pick_reviewer("claude", &ReviewAsk::default(), &cold).unwrap(), "codex");
}

#[test]
fn with_no_other_agent_installed_there_is_a_typed_refusal_and_allow_same_is_the_way_out() {
    let alone = vec![entry("claude", false)];
    let error = pick_reviewer("claude", &ReviewAsk::default(), &alone).unwrap_err();
    assert_eq!(error.code, "NO_REVIEWER_AVAILABLE");
    assert!(error.message.contains("allow_same"));
    let ask = ReviewAsk { allow_same: true, ..Default::default() };
    assert_eq!(pick_reviewer("claude", &ask, &alone).unwrap(), "claude");
}

#[test]
fn an_agent_that_cannot_review_is_named_with_the_ones_that_can() {
    let ask = ReviewAsk { agent_type: Some("ghost".into()), ..Default::default() };
    let error = pick_reviewer("claude", &ask, &[entry("codex", false)]).unwrap_err();
    assert_eq!(error.code, "REVIEWER_UNAVAILABLE");
    assert_eq!(error.context["available"][0], "codex");
}

#[test]
fn the_receipt_holds_the_verdict_and_the_worst_ten_findings() {
    let mut findings: Vec<Finding> = (0..12).map(|i| finding(&format!("f{i}.rs"), Severity::Low, "small")).collect();
    findings.push(finding("bug.rs", Severity::High, "BUG-MARKER dereferences null"));
    let fake = Fake::new(vec![entry("codex", false)], done(findings, VerdictLevel::Changes));
    let ask = ReviewAsk { model: Some("big".into()), ..Default::default() };
    let out = review_run(&fake, None, "h1", &ask, 5_000).unwrap();
    assert_eq!(out["by"], "codex");
    assert_eq!(out["model"], "big");
    assert_eq!(out["verdict"], "fail");
    assert_eq!(out["state"], "done");
    assert_eq!(out["findings"].as_array().unwrap().len(), MAX_FINDINGS);
    assert_eq!(out["findings"][0]["file"], "bug.rs");
    assert_eq!(out["findings"][0]["note"], "BUG-MARKER dereferences null");
    assert_eq!(fake.started_with.borrow().as_slice(), [("codex".to_string(), Some("big".to_string()))]);
}

#[test]
fn an_approving_review_is_a_pass_and_an_answer_without_a_verdict_is_concerns_only_with_findings() {
    let fake = Fake::new(vec![entry("codex", false)], done(vec![], VerdictLevel::Approve));
    assert_eq!(review_run(&fake, None, "h", &ReviewAsk::default(), 0).unwrap()["verdict"], "pass");
    let fake = Fake::new(vec![entry("codex", false)], done(vec![finding("a.rs", Severity::Medium, "x")], VerdictLevel::Unknown));
    assert_eq!(review_run(&fake, None, "h", &ReviewAsk::default(), 0).unwrap()["verdict"], "concerns");
    let fake = Fake::new(vec![entry("codex", false)], done(vec![], VerdictLevel::Unknown));
    assert_eq!(review_run(&fake, None, "h", &ReviewAsk::default(), 0).unwrap()["verdict"], "unknown");
}

#[test]
fn nothing_changed_is_skipped_not_an_error() {
    let mut fake = Fake::new(vec![entry("codex", false)], done(vec![], VerdictLevel::Approve));
    fake.nothing_to_review = true;
    let out = review_run(&fake, None, "h", &ReviewAsk::default(), 5_000).unwrap();
    assert_eq!(out, json!({ "skipped": "no changes" }));
}

#[test]
fn a_slow_reviewer_is_waited_for_a_while_then_handed_back_as_running_with_a_next_step() {
    let fake = Fake::new(vec![entry("codex", false)], done(vec![], VerdictLevel::Approve));
    *fake.polls_running.borrow_mut() = 2;
    let out = review_run(&fake, None, "h", &ReviewAsk::default(), 10_000).unwrap();
    assert_eq!(out["verdict"], "pass");
    assert_eq!(*fake.slept.borrow(), 2 * POLL_MS);

    let fake = Fake::new(vec![entry("codex", false)], done(vec![], VerdictLevel::Approve));
    *fake.polls_running.borrow_mut() = 1000;
    let out = review_run(&fake, None, "h", &ReviewAsk::default(), 3_000).unwrap();
    assert_eq!(out["state"], "running");
    assert_eq!(out["next"]["tool"], "wait_agents");
    assert_eq!(out["next"]["args"]["handles"][0], "rev-1");
}

#[test]
fn a_failed_reviewer_says_so_in_the_receipt() {
    let failed = Poll { state: "failed", review: None, error: Some("codex gave an empty answer.".into()) };
    let fake = Fake::new(vec![entry("codex", false)], failed);
    let out = review_run(&fake, None, "h", &ReviewAsk::default(), 0).unwrap();
    assert_eq!(out["state"], "failed");
    assert_eq!(out["verdict"], "unknown");
    assert!(out["error"].as_str().unwrap().contains("empty answer"));
}

#[test]
fn an_unknown_run_is_an_error() {
    let fake = Fake::new(vec![entry("codex", false)], done(vec![], VerdictLevel::Approve));
    assert_eq!(review_run(&fake, None, "gone", &ReviewAsk::default(), 0).unwrap_err().code, "AGENT_NOT_FOUND");
}
