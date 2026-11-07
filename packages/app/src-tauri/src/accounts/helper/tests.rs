//! The saved choice for helpers, and the card that asks when it is "Ask me".

use super::*;
use crate::questions::Question;
use std::path::PathBuf;

fn temp_store(name: &str) -> (Store, PathBuf) {
    let root = std::env::temp_dir().join(format!("pm-helper-login-{name}-{}", uuid::Uuid::new_v4()));
    (Store::at(&root), root)
}

fn session() -> String {
    format!("sess-{}", uuid::Uuid::new_v4())
}

fn starting<'a>(session: &'a str, key: &'a str, wait_ms: u64) -> Starting<'a> {
    Starting {
        agent_id: "claude",
        project: "C:/work/p",
        key,
        session: Some(session),
        pane_id: None,
        wait: Duration::from_millis(wait_ms),
    }
}

fn cards(session: &str) -> Vec<Question> {
    questions::store()
        .list_pending(questions::now_ms())
        .into_iter()
        .filter(|q| q.kind.as_deref() == Some(HELPER_LOGIN_KIND) && q.asker.as_deref() == Some(session))
        .collect()
}

fn answer(card: &Question, choice: &str) {
    let resolution = questions::store().answer(&card.id, Some(choice), None, "desktop", questions::now_ms()).unwrap();
    assert!(resolution.accepted);
}

#[test]
fn an_old_file_without_the_setting_reads_as_ask_me_and_keeps_accounts_when_the_setting_is_saved() {
    let (store, root) = temp_store("old-file");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("accounts.json"),
        r#"{"version":1,"accounts":[{"id":"acc_1","agent_id":"claude","label":"Work","home":"C:/x"}]}"#,
    )
    .unwrap();
    assert_eq!(store.helper_login("claude"), HelperLogin::Ask);
    assert_eq!(store.set_helper_login("claude", "acc_1").unwrap(), HelperLogin::Account("acc_1".into()));
    assert_eq!(store.list().len(), 1, "saving the setting keeps the accounts");
    // Adding and renaming rewrite the file; they must keep the setting.
    store.add("claude", "Home", None).unwrap();
    store.rename("acc_1", "Work (Max)").unwrap();
    assert_eq!(Store::at(&root).helper_login("claude"), HelperLogin::Account("acc_1".into()));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn the_setting_is_per_agent_validated_and_cleared_with_its_account() {
    let (store, root) = temp_store("setting");
    let work = store.add("claude", "Work", None).unwrap();
    let other = store.add("codex", "Work", None).unwrap();
    assert!(store.set_helper_login("claude", &other.id).is_err(), "another agent's account");
    assert!(store.set_helper_login("claude", "acc_nope").is_err(), "unknown account");
    assert!(store.set_helper_login("opencode", "main").is_err(), "an agent without accounts");
    assert_eq!(store.set_helper_login("claude", "main").unwrap(), HelperLogin::Main);
    assert_eq!(store.helper_login("codex"), HelperLogin::Ask, "other agents are untouched");
    store.set_helper_login("claude", &work.id).unwrap();
    assert_eq!(store.effective_helper_login("claude"), HelperLogin::Account(work.id.clone()));
    store.remove(&work.id, false).unwrap();
    assert_eq!(store.helper_login("claude"), HelperLogin::Ask, "removing the account clears the setting");
    store.set_helper_login("claude", "main").unwrap();
    assert_eq!(store.set_helper_login("claude", "ask").unwrap(), HelperLogin::Ask);
    assert_eq!(store.helper_login("claude"), HelperLogin::Ask);
    let overview = crate::accounts::overview(&store);
    assert_eq!(overview["helper_logins"]["claude"], "ask");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn main_login_and_a_saved_account_are_used_without_a_card() {
    let (store, root) = temp_store("no-card");
    let work = store.add("claude", "Work", None).unwrap();
    let who = session();
    store.set_helper_login("claude", "main").unwrap();
    assert_eq!(choose(&store, &starting(&who, "k1", 50), &|| {}).unwrap(), None);
    store.set_helper_login("claude", &work.id).unwrap();
    assert_eq!(choose(&store, &starting(&who, "k2", 50), &|| {}).unwrap(), Some(work.id));
    assert!(cards(&who).is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_agent_without_accounts_has_nothing_to_ask() {
    let (store, root) = temp_store("no-scheme");
    let who = session();
    let mut call = starting(&who, "k", 50);
    call.agent_id = "opencode";
    assert_eq!(choose(&store, &call, &|| {}).unwrap(), None);
    assert!(cards(&who).is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_saved_account_that_is_gone_asks_again() {
    let (store, root) = temp_store("gone");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("accounts.json"), r#"{"version":1,"accounts":[],"helper_logins":{"claude":"acc_gone"}}"#).unwrap();
    assert_eq!(store.effective_helper_login("claude"), HelperLogin::Ask);
    let who = session();
    let refused = choose(&store, &starting(&who, "k", 100), &|| {}).unwrap_err();
    assert_eq!(refused.code, "HELPER_LOGIN_PENDING");
    assert_eq!(cards(&who).len(), 1, "a card, not a silent pick");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ask_me_with_no_other_login_still_asks_and_offers_main_login() {
    let (store, root) = temp_store("zero");
    let who = session();
    let refused = choose(&store, &starting(&who, "k", 100), &|| {}).unwrap_err();
    assert_eq!(refused.code, "HELPER_LOGIN_PENDING");
    assert!(refused.recoverable);
    let card = cards(&who).remove(0);
    let label = agent_label("claude");
    assert_eq!(card.question, format!("Which login should this {label} helper use?"));
    let ids: Vec<&str> = card.choices.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["once:main", "always:main"]);
    assert_eq!(card.choices[0].label, "Main login");
    assert!(!card.allow_free_text);
    assert!(card.context.as_deref().unwrap().contains("Settings"));
    answer(&card, "once:main");
    assert_eq!(choose(&store, &starting(&who, "k", 100), &|| {}).unwrap(), None);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn the_card_lists_main_login_and_each_account_and_once_does_not_save() {
    let (store, root) = temp_store("list");
    let work = store.add("claude", "Work", None).unwrap();
    let home = store.add("claude", "Home", None).unwrap();
    let _codex = store.add("codex", "Other agent", None).unwrap();
    let who = session();
    assert_eq!(choose(&store, &starting(&who, "k", 100), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    let card = cards(&who).remove(0);
    let labels: Vec<&str> = card.choices.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(labels, ["Main login", "Always use Main login", "Work", "Always use Work", "Home", "Always use Home"]);
    assert_eq!(card.kind.as_deref(), Some(HELPER_LOGIN_KIND));
    answer(&card, &format!("once:{}", home.id));
    assert_eq!(choose(&store, &starting(&who, "k", 100), &|| {}).unwrap(), Some(home.id.clone()));
    assert_eq!(store.helper_login("claude"), HelperLogin::Ask, "a one-time pick saves nothing");
    // "Always use this" saves the pick, and the next helper asks nothing.
    let who2 = session();
    assert_eq!(choose(&store, &starting(&who2, "k", 100), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    answer(&cards(&who2).remove(0), &format!("always:{}", work.id));
    assert_eq!(choose(&store, &starting(&who2, "k", 100), &|| {}).unwrap(), Some(work.id.clone()));
    assert_eq!(store.helper_login("claude"), HelperLogin::Account(work.id.clone()));
    let who3 = session();
    assert_eq!(choose(&store, &starting(&who3, "other", 50), &|| {}).unwrap(), Some(work.id));
    assert!(cards(&who3).is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_retry_with_the_same_key_finds_the_same_card() {
    let (store, root) = temp_store("retry");
    let who = session();
    for _ in 0..3 {
        assert_eq!(choose(&store, &starting(&who, "same", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    }
    assert_eq!(cards(&who).len(), 1, "three calls, one card");
    // Another key is another helper: its own card.
    assert_eq!(choose(&store, &starting(&who, "different", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    assert_eq!(cards(&who).len(), 2);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_dismissed_card_is_an_error_and_a_retry_does_not_ask_again() {
    let (store, root) = temp_store("dismiss");
    let who = session();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    let card = cards(&who).remove(0);
    questions::store().dismiss(&card.id, questions::now_ms()).unwrap();
    for _ in 0..2 {
        let refused = choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err();
        assert_eq!(refused.code, "HELPER_LOGIN_DISMISSED");
        assert!(!refused.recoverable);
    }
    assert!(cards(&who).is_empty(), "no second card");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_saved_setting_closes_the_open_card_so_it_leaves_the_inbox() {
    let (store, root) = temp_store("saved-closes");
    let who = session();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    assert_eq!(cards(&who).len(), 1);
    store.set_helper_login("claude", "main").unwrap();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap(), None);
    assert!(cards(&who).is_empty(), "the card is closed once the setting answers it");

    store.set_helper_login("claude", "ask").unwrap();
    let work = store.add("claude", "Work", None).unwrap();
    let other = session();
    assert_eq!(choose(&store, &starting(&other, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    store.set_helper_login("claude", &work.id).unwrap();
    assert_eq!(choose(&store, &starting(&other, "k", 80), &|| {}).unwrap(), Some(work.id.clone()));
    assert!(cards(&other).is_empty(), "an account setting closes the card too");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_card_nobody_answers_times_out_with_an_error() {
    let (store, root) = temp_store("timeout");
    let who = session();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    let card = cards(&who).remove(0);
    assert!(questions::store().expire(&card.id, questions::now_ms()));
    let refused = choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err();
    assert_eq!(refused.code, "HELPER_LOGIN_TIMED_OUT");
    assert!(refused.message.contains("No helper was started"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_login_added_while_the_card_is_open_replaces_the_card() {
    let (store, root) = temp_store("added");
    let who = session();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    let first = cards(&who).remove(0);
    store.add("claude", "Work", None).unwrap();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    let now = cards(&who);
    assert_eq!(now.len(), 1, "the old card is closed, not left beside the new one");
    assert_ne!(now[0].id, first.id);
    assert_eq!(now[0].choices.len(), 4);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn only_the_person_can_answer_or_dismiss_the_card_over_plain_loopback() {
    let (store, root) = temp_store("person-only");
    let who = session();
    let _ = choose(&store, &starting(&who, "k", 50), &|| {});
    let card = cards(&who).remove(0);
    let answer_body = serde_json::json!({"choice_id": "once:main"});
    let path_answer = format!("/questions/{}/answer", card.id);
    let path_dismiss = format!("/questions/{}/dismiss", card.id);
    for (path, body) in [(path_answer, answer_body), (path_dismiss, serde_json::json!({}))] {
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let reply = questions::routes::handle("POST", &segments, &body, None, false, &|| {}).unwrap();
        let (status, value) = reply.unwrap_err();
        assert_eq!(status, 403);
        assert_eq!(value["code"], "HELPER_LOGIN_NEEDS_PERSON");
    }
    assert_eq!(cards(&who).len(), 1, "still waiting for the person");
    let _ = std::fs::remove_dir_all(root);
}
