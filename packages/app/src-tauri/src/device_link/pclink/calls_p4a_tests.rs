//! P4a rows (`calls_p4a.rs`): the block's exact rows and levels, the level matrix through `pclink::handle`, what is left out, the
//! same-code-path guard (the Tauri command and the row call the same inner function), and what a PC is never shown.

use serde_json::{json, Value};

use super::tests::{call_as, Fake};
use super::*;

/// This block's rows: `(command, least level, names a pane)`.
fn rows() -> Vec<(&'static str, Level, bool)> {
    use Level::*;
    vec![
        ("side_question_target", Answer, true),
        ("side_question_ask", Answer, true),
        ("handoff_file_stat", Full, true),
        ("handoff_quick_prepare", Full, true),
        ("handoff_quick_append", Full, true),
        ("handoff_quick_archive", Full, true),
        ("handoff_pane_account", Full, true),
        ("chat_export_html", Watch, true),
        ("chat_export_markdown", Watch, true),
        ("acp_closed_list", Watch, false),
        ("acp_reopen_closed", Full, false),
        ("acp_delete_closed", Full, false),
        ("chat_search", Watch, false),
        ("chat_search_facets", Watch, false),
    ]
}

#[test]
fn the_block_holds_exactly_these_rows_at_these_levels() {
    let from = calls::TABLE.iter().position(|(c, _, _)| *c == "side_question_target").expect("block");
    let ours: Vec<_> = calls::TABLE[from..from + rows().len()].iter().map(|(c, l, p)| (*c, *l, *p)).collect();
    assert_eq!(ours, rows(), "the P4a block holds exactly these rows");
    assert_eq!(calls_p4a::P4A_ROWS, rows().iter().map(|(c, _, _)| *c).collect::<Vec<_>>().as_slice());
    for (cmd, level, pane) in rows() {
        assert_eq!(calls::need(cmd), Some(level), "{cmd}");
        assert_eq!(calls::names_pane(cmd), pane, "{cmd}");
        assert!(!calls::refused(cmd), "{cmd}");
    }
}

#[test]
fn what_opens_a_window_or_writes_this_pcs_disk_from_afar_is_left_out() {
    for cmd in ["handoff_open_file", "chat_export_save", "acp_delete_all_closed"] {
        assert_eq!(calls::need(cmd), None, "{cmd}");
    }
}

/// One body that carries every argument any row of this block reads.
fn body_of() -> Value {
    json!({ "paneId": "p1", "id": "p1", "stamp": "20260101-1200", "notes": "", "request": { "ask_id": "a", "question": "q", "context": "c" }, "query": "x", "limit": 5 })
}

#[test]
fn each_row_needs_its_level_and_a_pc_that_is_off_or_a_shut_chat_reaches_nothing() {
    let asks = Asks::new();
    for (cmd, needs, pane) in rows() {
        let target = format!("/pclink/call/{cmd}");
        for level in [Level::Watch, Level::Answer, Level::Full] {
            let fake = Fake::default();
            let (status, answer) = call_as(Some(level), false, &fake, &asks, "POST", &target, &body_of());
            if level >= needs {
                assert_eq!(status, 200, "{level:?} {cmd}: {answer}");
                assert_eq!(fake.calls().len(), 1, "{level:?} {cmd}");
            } else {
                assert_eq!((status, answer["code"].as_str(), answer["needs"].as_str()), (403, Some("DEVICE_NOT_ALLOWED"), Some(needs.as_str())), "{level:?} must not {cmd}");
                assert!(fake.calls().is_empty(), "{level:?} {cmd} reached nothing");
            }
        }
        let fake = Fake::default();
        assert_eq!(call_as(None, false, &fake, &asks, "POST", &target, &body_of()).1["code"], "REMOTE_OFF", "{cmd}");
        if pane {
            // A chat its own PC shut for other PCs: nothing, even at Full. No pane named: refused before the app.
            fake.locked.lock().unwrap().push("p1".into());
            assert_eq!(call_as(Some(Level::Full), true, &fake, &asks, "POST", &target, &body_of()).1["code"], "AGENT_LOCKED", "{cmd}");
            assert_eq!(call_as(Some(Level::Full), true, &Fake::default(), &asks, "POST", &target, &json!({})).1["code"], "INVALID_ARGUMENT", "{cmd}");
        }
        assert!(fake.calls().is_empty(), "{cmd}");
    }
}

#[test]
fn the_window_command_and_the_far_row_call_the_same_inner_function() {
    // (the Tauri command's file, the inner function). The file defines it and calls it from its `#[tauri::command]`; the far row calls it by path.
    let commands = [
        (include_str!("../../commands/chat_export.rs"), "export_text("),
        (include_str!("../../commands/side_question.rs"), "ask_blocking("),
        (include_str!("../../commands/side_question.rs"), "side_target_of("),
        (include_str!("../../commands/handoff_file.rs"), "stat_of("),
        (include_str!("../../commands/handoff_file.rs"), "account_of("),
        (include_str!("../../commands/handoff_file.rs"), "prepare_quick("),
        (include_str!("../../commands/handoff_file.rs"), "append_notes("),
        (include_str!("../../commands/handoff_file.rs"), "archive_quick("),
        (include_str!("../../commands/acp_conversations.rs"), "reopen_closed_blocking("),
        (include_str!("../../commands/acp_conversations.rs"), "delete_closed_of("),
        (include_str!("../../commands/session_chat.rs"), "search_in("),
        (include_str!("../../commands/session_chat.rs"), "facets_in("),
    ];
    let far = include_str!("calls_p4a.rs");
    for (file, inner) in commands {
        assert!(file.matches(inner).count() >= 2, "{inner} is defined and called by the Tauri command");
        assert!(far.contains(&format!("::{inner}")), "{inner} is called by the far row");
    }
}

#[test]
fn a_row_is_not_served_before_the_app_is_ready_and_other_commands_are_not_this_blocks() {
    assert!(calls_p4a::dispatch("aa", "acp_chat_state", &json!({})).is_none());
    // No app handle (a unit test): a row says so and never invents an answer.
    assert_eq!(calls_p4a::dispatch("aa", "acp_closed_list", &json!({})).map(|r| r.0), Some(503));
}

#[test]
fn an_export_over_the_cap_is_refused_and_no_token_stays_on_the_far_pc() {
    assert_eq!(calls_p4a::EXPORT_MAX, 5 * 1024 * 1024);
    // The far side never keeps a token: the row answers the text only (this PC's Save dialog writes it).
    let far = include_str!("calls_p4a.rs");
    assert!(far.contains("json!({ \"html\": text })") && !far.contains("pages().keep"));
}

#[test]
fn closed_chats_below_full_show_a_folder_name_and_at_full_the_path_and_search_never_shows_imported_chats() {
    let list = json!([{ "id": "c1", "agent": "claude", "label": "Claude", "cwd": "C:\\work\\site", "updated_ms": 5, "title": "t" }, { "id": "c2", "cwd": "/home/me/app/" }]);
    let below = calls_p4a::closed_rows(list.clone(), false);
    assert_eq!((below[0]["cwd"].as_str(), below[1]["cwd"].as_str()), (Some("site"), Some("app")));
    assert_eq!(calls_p4a::closed_rows(list, true)[0]["cwd"], "C:\\work\\site");
    assert_eq!(calls_p4a::closed_rows(json!("nope"), true), json!([]));
    let answer = json!({ "enabled": true, "hits": [{ "paneId": "p1", "imported": false }, { "paneId": "p2", "imported": true }] });
    let kept = calls_p4a::searched(answer);
    assert_eq!(kept["hits"].as_array().map(Vec::len), Some(1));
    assert_eq!(kept["hits"][0]["paneId"], "p1");
    assert_eq!(calls_p4a::searched(json!({ "enabled": false, "hits": [] }))["enabled"], false);
}
