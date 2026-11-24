//! P6.1 row (`calls_lend.rs`): the one far call and the start's account check, and what no PC may reach.

use serde_json::json;

use super::app_services::AppServices;
use super::*;

#[test]
fn the_row_is_a_full_row_that_names_no_chat_and_nothing_to_lend_is_a_far_call() {
    assert_eq!(calls::need("own_borrow_ask"), Some(Level::Full));
    assert!(!calls::names_pane("own_borrow_ask"));
    // The window-only commands that make the promise, renew it or list a pane on it are never far calls, and never rows.
    for cmd in ["lend_far_offer", "lend_far_note_pane", "lend_far_renew", "lend_answer", "lend_request_own"] {
        assert_eq!(calls::need(cmd), None, "{cmd}");
        assert!(calls::refused(cmd), "{cmd} is in the refused prefixes");
    }
    // A watch-only or answer-level PC cannot ask (it would start a shim on this PC).
    assert!(calls::TABLE.iter().filter(|(c, _, _)| *c == "own_borrow_ask").all(|(_, level, _)| *level == Level::Full));
}

#[test]
fn the_row_needs_its_arguments_and_never_takes_the_lender_from_them() {
    let svc = AppServices::new(std::sync::Arc::new(|| "Desk".into()));
    assert_eq!(svc.call("aa", "own_borrow_ask", &json!({})).1["code"], "INVALID_ARGUMENT");
    assert_eq!(svc.call("aa", "own_borrow_ask", &json!({ "agentId": "claude" })).1["code"], "INVALID_ARGUMENT");
    // Whatever node the arguments name, the lender is the caller: a `lenderNode` argument is not read (and lending is off in a unit test).
    let (status, answer) = svc.call("aa", "own_borrow_ask", &json!({ "agentId": "claude", "offerRef": "ab", "secs": 60, "lenderNode": "bb" }));
    assert!(status >= 400, "{status} {answer}");
}

#[test]
fn the_start_takes_only_a_lend_the_caller_made_to_this_pc() {
    // No lend service in a unit test: no lend exists, so every account is refused, and a login of this PC can never be named.
    for account in ["lend:lg_abc", "default", "acc-7f", "", "lend:", "../x", "LEND:lg_abc"] {
        match calls_lend::start_account("aa", "claude", account) {
            Err((403, body)) => assert_eq!(body["code"], "ACCOUNT_REFUSED", "{account}"),
            other => panic!("{account:?} was not refused: {other:?}"),
        }
    }
}

#[test]
fn the_start_route_still_reads_the_account_only_from_the_pc_link_body() {
    // The bridge's own chat start never takes an account; only the PC link's start passes one, after the check above.
    let bridge = include_str!("../../../crates/pm-core/src/acp/chat/api.rs");
    let plain = bridge.split("pub fn start_with_account").next().unwrap();
    assert!(plain.contains("start_with(body, deps, false, None)"), "the bridge route passes no account");
    let link = include_str!("app_services.rs");
    assert!(link.contains("calls_lend::start_account(node, agent, account)"));
}

#[test]
fn a_terminal_start_carries_the_checked_lend_into_the_spawn() {
    // The chat and the terminal take the same account, checked once by `start_account`; there is no chat-only refusal any more.
    let link = include_str!("app_services.rs");
    assert!(!link.contains("LEND_CHAT_ONLY"));
    assert!(link.contains(r#"spawn["account"] = json!(account)"#));
}

#[test]
fn the_plan_row_is_a_watch_read_and_needs_an_agent() {
    assert_eq!(calls::need("own_borrow_plan"), Some(Level::Watch));
    assert!(!calls::names_pane("own_borrow_plan"));
    let svc = AppServices::new(std::sync::Arc::new(|| "Desk".into()));
    assert_eq!(svc.call("aa", "own_borrow_plan", &json!({})).1["code"], "INVALID_ARGUMENT");
    // No lend service in a unit test: nothing is lent, and the answer names no grant.
    let (status, answer) = svc.call("aa", "own_borrow_plan", &json!({ "agentId": "claude" }));
    assert_eq!(status, 200);
    assert!(answer["lend"].is_null(), "{answer}");
}

#[test]
fn a_far_start_on_a_copy_takes_the_callers_lend_like_any_other_start() {
    // The copy start used to pass no account at all, so "Work on a copy" on a signed-out PC never used the lend (a chat that could not answer).
    let attach = include_str!("calls_attach.rs");
    assert!(!attach.contains("start_with_copy("), "the far copy start must take the default account");
    assert!(attach.contains("start_copy_with_account(&request, &deps, account)"));
    assert!(include_str!("../../../crates/pm-core/src/acp/chat/api.rs").contains("start_with(body, deps, true, account)"));
}
