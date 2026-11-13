use super::*;
use crate::turn_summary::model::{assemble, Facts};
use crate::turn_summary::{FileStats, ReceiptFacts};

fn summary(receipt: Option<ReceiptFacts>) -> TurnSummary {
    assemble(Facts {
        pane_id: "p1".into(),
        agent: "Claude".into(),
        agent_id: None,
        account: None,
        turn: 3,
        started_at_ms: 1_000,
        ended_at_ms: 241_000,
        files: Some(FileStats { count: 2, added: 48, deleted: 12, paths: vec!["src/auth/redirect.ts".into(), "src/auth/session.ts".into()] }),
        approvals: Vec::new(),
        end_status: "idle".into(),
        end_prompt: None,
        receipt,
    })
}

fn change(path: &str, added: u32, deleted: u32) -> FileChange {
    FileChange { path: path.into(), status: "M".into(), added, deleted, binary: false }
}

#[test]
fn a_pane_with_no_finished_turn_says_there_is_nothing() {
    assert_eq!(build(None, None, None), json!({ "available": false }));
}

#[test]
fn the_answer_has_the_sentence_the_files_and_the_tests_line() {
    let receipt = ReceiptFacts { checks: "3/3 passed".into(), outcome: "passed_checks".into() };
    let body = build(Some(summary(Some(receipt))), Some(vec![change("src/auth/redirect.ts", 30, 8), change("src/auth/session.ts", 18, 4)]), None);
    assert_eq!(body["available"], json!(true));
    assert_eq!(body["turn"], json!(3));
    assert_eq!(body["durationMs"], json!(240_000));
    assert_eq!(body["files"]["count"], json!(2));
    assert_eq!(body["files"]["added"], json!(48));
    assert_eq!(body["tests"], json!("all checks passed (3/3)"));
    assert_eq!(body["changes"][1]["path"], json!("src/auth/session.ts"));
    assert_eq!(body["changes"][0]["added"], json!(30));
    assert!(body["sentence"].as_str().unwrap().contains("edited 2 files"));
    assert!(body.get("patch").is_none(), "no diff unless asked for");
}

#[test]
fn without_a_receipt_there_is_no_tests_line_and_without_checkpoints_no_file_list() {
    let body = build(Some(summary(None)), None, None);
    assert_eq!(body["tests"], json!(null));
    assert_eq!(body["changes"], json!(null));
    assert_eq!(body["available"], json!(true));
}

#[test]
fn the_diff_comes_with_a_cut_flag_and_the_file_list_is_cut_at_sixty() {
    let many: Vec<FileChange> = (0..80).map(|n| change(&format!("src/f{n}.rs"), 1, 0)).collect();
    let body = build(Some(summary(None)), Some(many), Some(("--- a/x\n+++ b/x\n+hello\n".into(), true)));
    assert_eq!(body["changes"].as_array().unwrap().len(), 60);
    assert_eq!(body["patchCut"], json!(true));
    assert!(body["patch"].as_str().unwrap().contains("+hello"));
}
