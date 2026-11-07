//! The shared entry the MCP routes call before they start a helper: `run_agent`, `quick_ask`,
//! `delegate_work` and `spawn_agent` all go through these functions with the account the caller named (or not).

use super::*;
use crate::accounts::HelperLogin;
use crate::questions::{self, Question, HELPER_LOGIN_KIND};
use serde_json::json;
use std::path::PathBuf;
use std::thread::JoinHandle;

struct Setup {
    store: Store,
    root: PathBuf,
    project: String,
    session: String,
}

impl Setup {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pm-helper-gate-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        Self {
            store: Store::at(&root),
            project: project.to_string_lossy().into_owned(),
            root,
            session: format!("sess-{}", uuid::Uuid::new_v4()),
        }
    }

    fn run(&self, key: Option<&str>, account: Option<&str>) -> AgentRunRequest {
        serde_json::from_value(json!({
            "task": "do it",
            "agent_type": "claude",
            "project_path": self.project,
            "idempotency_key": key,
            "account": account,
            "wait_ms": 20000,
        }))
        .unwrap()
    }

    fn cards(&self) -> Vec<Question> {
        questions::store()
            .list_pending(questions::now_ms())
            .into_iter()
            .filter(|q| q.kind.as_deref() == Some(HELPER_LOGIN_KIND) && q.asker.as_deref() == Some(self.session.as_str()))
            .collect()
    }

    /// The card, once the call that raises it has raised it.
    fn wait_for_card(&self, count: usize) -> Question {
        for _ in 0..200 {
            let cards = self.cards();
            if cards.len() >= count {
                return cards.into_iter().next().unwrap();
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("no card appeared");
    }

    fn answer(&self, card: &Question, choice: &str) {
        questions::store().answer(&card.id, Some(choice), None, "desktop", questions::now_ms()).unwrap();
    }

    fn run_in_thread(&self, mut request: AgentRunRequest) -> JoinHandle<(Result<(), OperationError>, AgentRunRequest)> {
        let (store, session) = (self.store.clone(), self.session.clone());
        std::thread::spawn(move || {
            let result = for_run(&mut request, Some(&session), &store, &|| {});
            (result, request)
        })
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn run_agent_with_a_saved_main_login_or_account_gets_it_without_a_card() {
    let s = Setup::new();
    let work = s.store.add("claude", "Work", None).unwrap();
    s.store.set_helper_login("claude", "main").unwrap();
    let mut request = s.run(Some("k-main"), None);
    for_run(&mut request, Some(&s.session), &s.store, &|| {}).unwrap();
    assert_eq!(request.account, None);

    s.store.set_helper_login("claude", &work.id).unwrap();
    let mut request = s.run(Some("k-acc"), None);
    for_run(&mut request, Some(&s.session), &s.store, &|| {}).unwrap();
    assert_eq!(request.account.as_deref(), Some(work.id.as_str()));
    assert_eq!(request.idempotency_key.as_deref(), Some("k-acc"));
    assert!(s.cards().is_empty());
}

#[test]
fn run_agent_with_ask_me_waits_for_the_pick_then_goes_on_with_it() {
    let s = Setup::new();
    let work = s.store.add("claude", "Work", None).unwrap();
    s.store.add("claude", "Home", None).unwrap();
    let call = s.run_in_thread(s.run(Some("k-ask"), None));
    let card = s.wait_for_card(1);
    assert!(card.question.starts_with("Which login should this "));
    assert!(card.choices.iter().any(|c| c.label == "Always use Work"));
    s.answer(&card, &format!("once:{}", work.id));
    let (result, request) = call.join().unwrap();
    result.unwrap();
    assert_eq!(request.account.as_deref(), Some(work.id.as_str()));
    assert!(request.wait_ms <= 20000);
    assert_eq!(s.store.helper_login("claude"), HelperLogin::Ask);
}

#[test]
fn run_agent_with_no_extra_login_still_asks() {
    let s = Setup::new();
    let call = s.run_in_thread(s.run(Some("k-zero"), None));
    let card = s.wait_for_card(1);
    assert_eq!(card.choices.len(), 2, "Main login, and Main login as the default");
    s.answer(&card, "once:main");
    let (result, request) = call.join().unwrap();
    result.unwrap();
    assert_eq!(request.account, None);
}

#[test]
fn an_always_pick_is_saved_and_the_next_run_asks_nothing() {
    let s = Setup::new();
    let work = s.store.add("claude", "Work", None).unwrap();
    let call = s.run_in_thread(s.run(Some("k-1"), None));
    s.answer(&s.wait_for_card(1), &format!("always:{}", work.id));
    call.join().unwrap().0.unwrap();
    assert_eq!(s.store.helper_login("claude"), HelperLogin::Account(work.id.clone()));
    let mut next = s.run(Some("k-2"), None);
    for_run(&mut next, Some(&s.session), &s.store, &|| {}).unwrap();
    assert_eq!(next.account.as_deref(), Some(work.id.as_str()));
}

#[test]
fn a_saved_account_that_was_deleted_asks_again() {
    let s = Setup::new();
    std::fs::write(s.root.join("accounts.json"), r#"{"version":1,"accounts":[],"helper_logins":{"claude":"acc_deleted"}}"#).unwrap();
    let call = s.run_in_thread(s.run(Some("k-del"), None));
    let card = s.wait_for_card(1);
    s.answer(&card, "once:main");
    let (result, request) = call.join().unwrap();
    result.unwrap();
    assert_eq!(request.account, None);
}

#[test]
fn an_account_the_caller_names_wins_and_raises_no_card() {
    let s = Setup::new();
    s.store.add("claude", "Work", None).unwrap();
    let mut request = s.run(Some("k-explicit"), Some("acc_the_callers"));
    for_run(&mut request, Some(&s.session), &s.store, &|| {}).unwrap();
    assert_eq!(request.account.as_deref(), Some("acc_the_callers"), "left for run_agent to validate as it does today");
    assert!(s.cards().is_empty());
}

#[test]
fn a_run_without_an_mcp_session_never_sees_the_card() {
    // The person starting an agent by hand, and the app's own runs, do not come through an MCP connection.
    let s = Setup::new();
    s.store.add("claude", "Work", None).unwrap();
    let mut request = s.run(Some("k-hand"), None);
    for_run(&mut request, None, &s.store, &|| {}).unwrap();
    assert_eq!(request.account, None);
    assert!(s.cards().is_empty());
}

#[test]
fn a_call_that_adopts_a_worker_or_pane_starts_no_helper_and_asks_nothing() {
    let s = Setup::new();
    for field in ["pane_id", "worker_id", "handle", "agent_run_id"] {
        let mut request = s.run(Some("k-adopt"), None);
        match field {
            "pane_id" => request.pane_id = Some("p1".into()),
            "worker_id" => request.worker_id = Some("w1".into()),
            "handle" => request.handle = Some("h1".into()),
            _ => request.agent_run_id = Some("r1".into()),
        }
        for_run(&mut request, Some(&s.session), &s.store, &|| {}).unwrap();
        assert_eq!(request.account, None);
    }
    assert!(s.cards().is_empty());
}

#[test]
fn a_dismissed_card_returns_an_error_and_nothing_is_picked() {
    let s = Setup::new();
    s.store.add("claude", "Work", None).unwrap();
    let call = s.run_in_thread(s.run(Some("k-no"), None));
    let card = s.wait_for_card(1);
    questions::store().dismiss(&card.id, questions::now_ms()).unwrap();
    let (result, request) = call.join().unwrap();
    let error = result.unwrap_err();
    assert_eq!(error.code, "HELPER_LOGIN_DISMISSED");
    assert!(!error.recoverable);
    assert_eq!(request.account, None);
    // The same call again is the same answer, not a second card.
    let mut again = s.run(Some("k-no"), None);
    assert_eq!(for_run(&mut again, Some(&s.session), &s.store, &|| {}).unwrap_err().code, "HELPER_LOGIN_DISMISSED");
    assert!(s.cards().is_empty());
}

#[test]
fn two_calls_with_the_same_idempotency_key_share_one_card_and_one_answer() {
    let s = Setup::new();
    let work = s.store.add("claude", "Work", None).unwrap();
    let first = s.run_in_thread(s.run(Some("k-retry"), None));
    s.wait_for_card(1);
    // The caller's retry (a transport timeout, say) arrives while the first call still waits.
    let second = s.run_in_thread(s.run(Some("k-retry"), None));
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(s.cards().len(), 1, "one card for both calls");
    s.answer(&s.cards()[0], &format!("once:{}", work.id));
    let (a, first_request) = first.join().unwrap();
    let (b, second_request) = second.join().unwrap();
    a.unwrap();
    b.unwrap();
    assert_eq!(first_request.account, second_request.account);
    assert_eq!(first_request.account.as_deref(), Some(work.id.as_str()));
    assert!(s.cards().is_empty());
}

#[test]
fn quick_ask_and_the_other_helper_tools_follow_the_same_choice() {
    let s = Setup::new();
    let work = s.store.add("claude", "Work", None).unwrap();
    s.store.set_helper_login("claude", &work.id).unwrap();

    // delegate_work: the account goes on the worker the operation is made with.
    let mut delegate: crate::operations::DelegateWorkRequest = serde_json::from_value(json!({
        "project_path": s.project, "task": "t", "agent_type": "claude", "idempotency_key": "k-delegate"
    }))
    .unwrap();
    for_delegate(&mut delegate, Some(&s.session), &s.store, &|| {}).unwrap();
    assert_eq!(delegate.worker.account.as_deref(), Some(work.id.as_str()));
    let mut named: crate::operations::DelegateWorkRequest = serde_json::from_value(json!({
        "project_path": s.project, "task": "t", "agent_type": "claude", "idempotency_key": "k-delegate-2",
        "worker": {"account": "acc_named"}
    }))
    .unwrap();
    for_delegate(&mut named, Some(&s.session), &s.store, &|| {}).unwrap();
    assert_eq!(named.worker.account.as_deref(), Some("acc_named"));

    // spawn_agent: the account goes on the spawn arguments.
    let mut spawn: crate::pty::SpawnPaneArgs =
        serde_json::from_value(json!({"agent_type": "claude", "cwd": s.project})).unwrap();
    for_spawn(&mut spawn, Some(&s.session), &s.store, &|| {}).unwrap();
    assert_eq!(spawn.account.as_deref(), Some(work.id.as_str()));
    let mut by_phone: crate::pty::SpawnPaneArgs =
        serde_json::from_value(json!({"agent_type": "claude", "cwd": s.project})).unwrap();
    for_spawn(&mut by_phone, None, &s.store, &|| {}).unwrap();
    assert_eq!(by_phone.account, None, "a phone or the app spawning a pane is never asked");

    // quick_ask builds its run like run_agent does and takes the same gate.
    let ask: crate::agent_runs::quick::QuickAskRequest =
        serde_json::from_value(json!({"task": "2+2?", "project_path": s.project, "idempotency_key": "k-quick"})).unwrap();
    let mut quick = crate::agent_runs::quick::build_run_request(&ask, "claude").unwrap();
    for_run(&mut quick, Some(&s.session), &s.store, &|| {}).unwrap();
    assert_eq!(quick.account.as_deref(), Some(work.id.as_str()));
}

#[test]
fn delegate_work_with_ask_me_waits_for_the_card_too() {
    let s = Setup::new();
    s.store.add("claude", "Work", None).unwrap();
    let (store, session, project) = (s.store.clone(), s.session.clone(), s.project.clone());
    let call = std::thread::spawn(move || {
        let mut delegate: crate::operations::DelegateWorkRequest = serde_json::from_value(json!({
            "project_path": project, "task": "t", "agent_type": "claude", "idempotency_key": "k-delegate-ask"
        }))
        .unwrap();
        let result = for_delegate(&mut delegate, Some(&session), &store, &|| {});
        (result, delegate)
    });
    s.answer(&s.wait_for_card(1), "once:main");
    let (result, delegate) = call.join().unwrap();
    result.unwrap();
    assert_eq!(delegate.worker.account, None);
}
