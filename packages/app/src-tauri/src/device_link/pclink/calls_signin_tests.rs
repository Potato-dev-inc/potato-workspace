//! P2.2: the sign-in rows of the far call table. The level of each row, what a refused level runs (nothing), that no row can read a
//! login, and the few rules `calls_signin.rs` applies before it reaches the app.

use serde_json::{json, Value};

use super::super::calls::{need, refused, TABLE};
use super::super::tests::Fake;
use super::super::{handle, Asks, Caller, Level};
use super::*;

/// `(command, body, least level)` for every P2.2 row.
fn rows() -> Vec<(&'static str, Value, Level)> {
    vec![
        ("agents_detect_installed", json!({}), Level::Watch),
        ("agents_health", json!({}), Level::Watch),
        ("agent_login_states", json!({ "fresh": true }), Level::Watch),
        ("agent_signin_start", json!({ "agent_id": "claude" }), Level::Full),
        ("agent_signin_status", json!({ "agent_id": "claude" }), Level::Full),
        ("agent_signin_stop", json!({ "agent_id": "claude" }), Level::Full),
        ("chat_signin_start", json!({ "pane_id": "p1" }), Level::Full),
        ("chat_signin_status", json!({ "pane_id": "p1" }), Level::Full),
        ("chat_signin_stop", json!({ "pane_id": "p1" }), Level::Full),
        ("acp_chat_retry_sign_in", json!({ "pane_id": "p1" }), Level::Full),
    ]
}

fn post(level: Level, fake: &Fake, cmd: &str, body: &Value) -> u16 {
    let who = Caller { node: "aa", name: "Laptop", level: Some(level), marked: false, now_ms: 1_000 };
    handle(&who, fake, &Asks::new(), "POST", &format!("/pclink/call/{cmd}"), &serde_json::to_vec(body).unwrap()).0
}

#[test]
fn the_sign_in_rows_need_these_levels_and_are_all_in_the_table() {
    for (cmd, _, level) in rows() {
        assert_eq!(need(cmd), Some(level), "{cmd}");
    }
    // The rows from this block's marker to the next `// ---- ` marker, so a block another phase adds after (or before) it changes nothing here.
    let source = include_str!("../../../crates/pm-core/src/device_link/pclink/calls.rs");
    let from = source.find("    // ---- P2.2 sign-in ----").expect("the P2.2 marker");
    let block: Vec<&str> = source[from..].lines().skip(1).take_while(|l| !l.trim_start().starts_with("// ---- ")).filter_map(|l| l.trim_start().strip_prefix("(\"")?.split('"').next()).collect();
    assert_eq!(block, rows().iter().map(|(c, _, _)| *c).collect::<Vec<_>>(), "the P2.2 block holds exactly these rows, in order");
}

#[test]
fn watch_reads_state_but_only_full_signs_in() {
    for level in [Level::Watch, Level::Answer, Level::Full] {
        let fake = Fake::default();
        for (cmd, body, least) in rows() {
            let status = post(level, &fake, cmd, &body);
            if level >= least {
                assert_eq!(status, 200, "{level:?} {cmd}");
            } else {
                assert_eq!(status, 403, "{level:?} {cmd}");
            }
        }
        let ran = rows().iter().filter(|(_, _, least)| level >= *least).count();
        assert_eq!(fake.calls().len(), ran, "{level:?} ran only what its level allows");
    }
}

#[test]
fn no_sign_in_row_can_name_or_serve_a_login() {
    for (cmd, _, _) in rows() {
        assert!(!refused(cmd), "{cmd} is in the refused list");
        for word in ["token", "secret", "credential", "key", "account", "keystore"] {
            assert!(!cmd.contains(word), "{cmd} names {word}");
        }
    }
    // The module itself never opens a file or reads a credential; it only calls the commands' own bodies.
    let source = include_str!("calls_signin.rs");
    let code = source.split("#[cfg(test)]").next().unwrap();
    for word in ["std::fs", "read_to_string", "credentials", ".json\"", "access_token", "env::var"] {
        assert!(!code.contains(word), "calls_signin.rs must not use {word}");
    }
}

#[test]
fn another_pcs_account_is_not_served_and_a_missing_agent_is_refused_before_the_app_is_touched() {
    for cmd in ["agent_signin_start", "agent_signin_status", "agent_signin_stop"] {
        let (status, body) = agent_call("aa", cmd, &json!({ "agentId": "claude", "accountId": "acc-1" })).unwrap();
        assert_eq!((status, body["code"].as_str()), (400, Some("INVALID_ARGUMENT")), "{cmd}");
        assert_eq!(agent_call("aa", cmd, &json!({})).unwrap().0, 400, "{cmd} needs agentId");
    }
    assert!(agent_call("aa", "acp_chat_state", &json!({})).is_none() && pane_call("aa", "agents_health", "p1").is_none());
}

#[test]
fn a_found_agent_travels_with_its_file_name_and_not_its_folder() {
    use crate::agent_store::detect::{FoundAgent, FoundKind};
    let found = FoundAgent {
        id: "claude".into(),
        display_name: "Claude Code".into(),
        path: std::path::PathBuf::from("/home/someone/.local/bin/claude"),
        kind: FoundKind::Catalog,
        version: Some("2.1.0".into()),
    };
    let row = found_row(&found);
    assert_eq!(row["path"], "claude");
    assert_eq!((row["id"].as_str(), row["displayName"].as_str(), row["version"].as_str()), (Some("claude"), Some("Claude Code"), Some("2.1.0")));
    assert!(!row.to_string().contains("someone"), "no home folder name");
}

#[test]
fn an_error_of_the_command_keeps_its_code_and_a_missing_chat_is_a_404() {
    assert_eq!(command_error("ACP_SIGN_IN_NEEDED: Sign in first.").1["code"], "ACP_SIGN_IN_NEEDED");
    assert_eq!(command_error("PANE_NOT_FOUND: p9 is not a chat session").0, 404);
    assert_eq!(command_error("That agent is not known.").1["code"], "COMMAND_FAILED");
}
