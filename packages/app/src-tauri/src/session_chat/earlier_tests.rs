use super::*;
use crate::acp::journal::{page_before, Journal};
use crate::session_chat::{ChatItem, ToolDetail};

fn dir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("pm-earlier-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn user(n: usize) -> ChatItem {
    ChatItem::User { id: format!("u{n}"), at: None, text: format!("message {n}"), attachments: Vec::new(), from: None }
}

fn ids(page: &Page) -> Vec<String> {
    page.items.iter().map(|i| i.id().to_string()).collect()
}

/// A journal of 5000 items: more than the live feed keeps (`MAX_ITEMS`), so the oldest are only on disk.
fn big_journal() -> std::path::PathBuf {
    let path = dir().join("c.jsonl");
    let journal = Journal::at(&path);
    for n in 0..5000 {
        journal.append(&user(n));
    }
    journal.flush();
    path
}

#[test]
fn page_two_of_a_5000_item_journal_has_the_right_items_in_order() {
    let path = big_journal();
    // The view holds u4000 and newer. Page 1 is the 50 right before it, oldest first.
    let one = page_before(&path, "u4000", 50);
    assert_eq!(one.items.len(), 50);
    assert_eq!(ids(&one).first().unwrap(), "u3950");
    assert_eq!(ids(&one).last().unwrap(), "u3999");
    assert!(one.more);
    // Page 2 starts from the first item of page 1.
    let two = page_before(&path, &ids(&one)[0], 50);
    assert_eq!(ids(&two).first().unwrap(), "u3900");
    assert_eq!(ids(&two).last().unwrap(), "u3949");
    assert!(two.more);
}

#[test]
fn the_journal_is_read_past_the_live_cap_down_to_the_first_message() {
    let path = big_journal();
    // 5000 items are on disk although the live feed keeps 4000: the first ones are reachable.
    let first = page_before(&path, "u120", 200);
    assert_eq!(first.items.len(), 120);
    assert_eq!(ids(&first)[0], "u0");
    assert!(!first.more, "u0 is the start of the chat");
}

#[test]
fn a_question_with_limit_zero_only_says_whether_there_is_more() {
    let path = big_journal();
    let probe = page_before(&path, "u10", 0);
    assert!(probe.items.is_empty());
    assert!(probe.more);
    assert!(!page_before(&path, "u0", 0).more);
}

#[test]
fn an_unknown_item_or_a_missing_journal_gives_an_empty_page() {
    let path = big_journal();
    assert_eq!(page_before(&path, "nope", 10), Page::default());
    assert_eq!(page_before(&dir().join("none.jsonl"), "u1", 10), Page::default());
}

#[test]
fn a_pane_that_is_not_a_chat_session_has_nothing_earlier() {
    let reply = for_pane("not-a-chat-pane", "u1", 10, true);
    assert_eq!(reply["items"].as_array().unwrap().len(), 0);
    assert_eq!(reply["more"], false);
}

#[test]
fn the_phone_page_is_lean_and_redacted() {
    let call = ChatItem::ToolCall {
        id: "t1".into(),
        at: None,
        call_id: "c1".into(),
        name: "Edit".into(),
        summary: "Edit a.rs".into(),
        detail: ToolDetail { input: Some(serde_json::json!({ "old": "x", "new": "y" })), paths: vec!["a.rs".into()], ..Default::default() },
    };
    let secret = ChatItem::Assistant { id: "a1".into(), at: None, text: "key sk-ant-api03-AbCdEf1234567890 here".into(), model: None, final_answer: false };
    let page = Page { items: vec![call, secret], more: true };
    let phone = answer(page, true);
    assert!(phone["items"][0].get("input").is_none(), "the diff stays on the PC");
    assert_eq!(phone["items"][0]["paths"][0], "a.rs");
    assert!(!phone["items"][1]["text"].as_str().unwrap().contains("AbCdEf1234567890"));
    assert_eq!(phone["more"], true);
}
