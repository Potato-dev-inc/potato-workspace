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
    assert!(store.set_helper_login("opencode_native", "main").is_err(), "an agent without accounts");
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
    call.agent_id = "opencode_native";
    assert_eq!(choose(&store, &call, &|| {}).unwrap(), None);
    assert!(cards(&who).is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_saved_account_that_is_gone_asks_again() {
    let (store, root) = temp_store("gone");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("accounts.json"),
        r#"{"version":1,"accounts":[{"id":"acc_1","agent_id":"claude","label":"Work","home":"C:/x"}],"helper_logins":{"claude":"acc_gone"}}"#,
    )
    .unwrap();
    assert_eq!(store.effective_helper_login("claude"), HelperLogin::Ask);
    let who = session();
    let refused = choose(&store, &starting(&who, "k", 100), &|| {}).unwrap_err();
    assert_eq!(refused.code, "HELPER_LOGIN_PENDING");
    assert_eq!(cards(&who).len(), 1, "a card, not a silent pick");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ask_me_with_no_other_login_uses_the_main_login_without_a_card() {
    let (store, root) = temp_store("zero");
    let who = session();
    // One login only: nothing to choose, so no card and no wait.
    let started = Instant::now();
    let got = choose_with_source(&store, &starting(&who, "k", 5_000), &|| {}).unwrap();
    assert_eq!(got, (None, SOURCE_CLI_LOGIN));
    assert!(started.elapsed() < Duration::from_secs(2), "it did not wait");
    assert!(cards(&who).is_empty(), "no question for the Inbox");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_card_left_open_is_closed_when_the_second_login_was_never_added() {
    // A card raised while an account existed is retired once the account is gone (one login again).
    let (store, root) = temp_store("zero-retire");
    let work = store.add("claude", "Work", None).unwrap();
    let who = session();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    assert_eq!(cards(&who).len(), 1);
    store.remove(&work.id, false).unwrap();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap(), None);
    assert!(cards(&who).is_empty(), "the stale card left the Inbox");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn with_two_logins_the_waiting_call_names_the_key_and_the_answer_starts_the_retry() {
    let (store, root) = temp_store("retry-key");
    store.add("claude", "Work", None).unwrap();
    let who = session();
    // A key the agent chose: the message repeats it, so the retry can carry it.
    let refused = choose(&store, &starting(&who, "demo-key-1", 80), &|| {}).unwrap_err();
    assert_eq!(refused.code, "HELPER_LOGIN_PENDING");
    assert!(refused.recoverable);
    assert!(refused.message.contains("idempotency_key \"demo-key-1\""), "{}", refused.message);
    // A key made from the call (the agent never saw it): the message says to repeat the same arguments.
    let auto = choose(&store, &starting(&who, "auto-00ff", 80), &|| {}).unwrap_err();
    assert!(auto.message.contains("exactly the same arguments"), "{}", auto.message);
    assert!(!auto.message.contains("auto-00ff"));
    // The person picks Main login (and "always"): the same call, retried, now goes through and it is remembered.
    answer(&cards(&who).into_iter().find(|c| c.question.contains("login")).unwrap(), "always:main");
    let got = choose(&store, &starting(&who, "demo-key-1", 80), &|| {}).unwrap();
    assert_eq!(got, None, "main login");
    assert_eq!(store.helper_login("claude"), HelperLogin::Main, "always: the next helper asks nothing");
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
    store.add("claude", "Work", None).unwrap();
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
    store.add("claude", "Spare", None).unwrap(); // a second login, so the card is asked
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
    store.add("claude", "Spare", None).unwrap(); // a second login, so the card is asked
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
    store.add("claude", "Spare", None).unwrap(); // a second login, so the card is asked
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
    store.add("claude", "Spare", None).unwrap(); // a second login, so the card is asked
    let who = session();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    let first = cards(&who).remove(0);
    store.add("claude", "Work", None).unwrap();
    assert_eq!(choose(&store, &starting(&who, "k", 80), &|| {}).unwrap_err().code, "HELPER_LOGIN_PENDING");
    let now = cards(&who);
    assert_eq!(now.len(), 1, "the old card is closed, not left beside the new one");
    assert_ne!(now[0].id, first.id);
    assert_eq!(now[0].choices.len(), 6, "Main login and two accounts, once and always each");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn only_the_person_can_answer_or_dismiss_the_card_over_plain_loopback() {
    let (store, root) = temp_store("person-only");
    store.add("claude", "Spare", None).unwrap(); // a second login, so the card is asked
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

#[test]
fn a_saved_default_is_used_without_asking_and_says_where_it_came_from() {
    let (store, root) = temp_store("source-default");
    let work = store.add("claude", "Work", None).unwrap();
    store.add("claude", "Home", None).unwrap();
    let who = session();
    store.set_helper_login("claude", &work.id).unwrap();
    let got = choose_with_source(&store, &starting(&who, "k1", 50), &|| {}).unwrap();
    assert_eq!(got, (Some(work.id), SOURCE_HELPER_DEFAULT));
    store.set_helper_login("claude", "main").unwrap();
    let got = choose_with_source(&store, &starting(&who, "k2", 50), &|| {}).unwrap();
    assert_eq!(got, (None, SOURCE_HELPER_DEFAULT));
    assert!(cards(&who).is_empty(), "a default never raises a card");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn no_default_and_two_accounts_asks_and_says_asked() {
    let (store, root) = temp_store("source-asked");
    let work = store.add("claude", "Work", None).unwrap();
    store.add("claude", "Home", None).unwrap();
    let who = session();
    let refused = choose_with_source(&store, &starting(&who, "k", 100), &|| {}).unwrap_err();
    assert_eq!(refused.code, "HELPER_LOGIN_PENDING");
    let card = cards(&who).remove(0);
    assert_eq!(card.choices.len(), 6, "Main login and two accounts, once and always each");
    answer(&card, &format!("once:{}", work.id));
    let got = choose_with_source(&store, &starting(&who, "k", 100), &|| {}).unwrap();
    assert_eq!(got, (Some(work.id), SOURCE_ASKED));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_agent_without_accounts_reports_its_own_login() {
    let (store, root) = temp_store("source-cli");
    let who = session();
    let mut call = starting(&who, "k", 50);
    call.agent_id = "opencode_native";
    assert_eq!(choose_with_source(&store, &call, &|| {}).unwrap(), (None, SOURCE_CLI_LOGIN));
    let _ = std::fs::remove_dir_all(root);
}
