//! A9: an agent the Add an agent ladder just wrote is a helper like any other. The definition is the one the ladder
//! writes (`ladder_save::terminal_text`), loaded into the process-wide registry for the length of a test.

use std::sync::Arc;

use serde_json::json;

use super::{chips_json, forget, record_handshake, HandshakeFacts, Tri};
use crate::agent_runs::headless::check_read_only;
use crate::agent_runs::AgentRunRequest;
use crate::tui::declarative::loader::{last_entries, store_last, DefState, Entry};
use crate::tui::declarative::wizard::ladder_save::terminal_text;
use crate::tui::declarative::{parse_definition, DeclarativeProfile};
use crate::tui::registry;

const ID: &str = "zz_added_fake";

/// The ladder's definition for `ID` in the registry, and its loader row (source `user`, so not shipped).
struct Added {
    _serial: parking_lot::ReentrantMutexGuard<'static, ()>,
    rows: Vec<Entry>,
}

impl Added {
    fn new() -> Self {
        let serial = registry::test_serial();
        let rows = last_entries();
        let def = parse_definition(&terminal_text(ID, "Zz Added Fake", "zz-added-fake")).expect("the ladder's text parses");
        let profile = DeclarativeProfile::new(def).expect("a profile");
        registry::registry().set_declarative(vec![Arc::new(profile)]);
        let mut with_row = rows.clone();
        with_row.push(Entry {
            path: std::path::PathBuf::from(format!("agents/{ID}.toml")),
            id: Some(ID.into()),
            source: "user",
            state: DefState::Active,
            approval: None,
            fingerprint: None,
            errors: Vec::new(),
            shadowed_by: None,
            meta: None,
            binary_changed: false,
        });
        store_last(with_row);
        forget(ID);
        Added { _serial: serial, rows }
    }
}

impl Drop for Added {
    fn drop(&mut self) {
        registry::registry().set_declarative(Vec::new());
        store_last(std::mem::take(&mut self.rows));
        forget(ID);
    }
}

fn request(extra: serde_json::Value) -> AgentRunRequest {
    let mut body = json!({"task": "say hi", "agent_type": ID});
    body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    serde_json::from_value(body).expect("a run request")
}

#[test]
fn added_fake_agent_is_a_valid_run_agent_type() {
    let _added = Added::new();
    // The resolver knows the id, nothing holds it back, and a plain (not read-only) run passes the gate.
    let profile = crate::tui::require_registered(ID).expect("registered");
    assert!(profile.features().dispatchable, "the ladder marks its definition experimental, which makes it dispatchable");
    assert!(registry::unavailable(ID).is_none());
    check_read_only(&request(json!({}))).expect("a normal run is not refused");
    // Ids are matched like the others (any case) and an id nobody added is still refused with the valid list.
    assert!(crate::tui::require_registered(&ID.to_ascii_uppercase()).is_ok());
    assert!(crate::tui::require_registered("zz_nobody_added_this").is_err());
    // list_agents offers it as a type.
    let rows = crate::agent_run_mode::types_summary();
    assert!(rows.as_array().unwrap().iter().any(|r| r["id"] == ID), "{rows}");
}

#[test]
fn read_only_refused_with_try_when_not_claimed() {
    let _added = Added::new();
    for headless in [true, false] {
        let error = check_read_only(&request(json!({"read_only": true, "headless": headless, "model": "m1"}))).expect_err("refused");
        assert_eq!(error.code, "READ_ONLY_UNSUPPORTED", "headless={headless}");
        let call = &error.context["try"];
        assert_eq!(call["tool"], "run_agent", "{}", error.context);
        assert_eq!(call["weakens"], json!(["read_only"]));
        assert_eq!(call["args"]["agent_type"], ID);
        assert_eq!(call["args"]["task"], "say hi");
        assert_eq!(call["args"]["model"], "m1");
        assert!(call["args"].get("read_only").is_none(), "the corrected call does not ask for read-only");
    }
    // The table says the same: nothing was claimed, so the chip is not "yes".
    assert_ne!(super::for_agent(ID).read_only.value, Tri::Yes);
    // An agent that does enforce it is not touched.
    let claude: AgentRunRequest = serde_json::from_value(json!({"task": "t", "agent_type": "claude", "read_only": true, "headless": true})).unwrap();
    check_read_only(&claude).expect("claude runs read-only");
}

#[test]
fn list_agents_shows_caps_chips() {
    let _added = Added::new();
    let rows = crate::agent_run_mode::types_summary();
    let row = rows.as_array().unwrap().iter().find(|r| r["id"] == ID).expect("the added agent is listed").clone();
    assert_eq!(row["caps"], chips_json(ID), "the listing and the Add an agent screen read one table");
    assert_eq!(row["caps"]["read_only"], "unknown", "{row}");
    assert_eq!(row["caps"]["level"], "l5");
    // What the free check learns shows up in the same row.
    let hs = HandshakeFacts { at: "2026-11-13T00:00:00Z".into(), init_ok: true, protocol_version: Some(1), session_new_ok: true, ..HandshakeFacts::default() };
    record_handshake(ID, &hs).expect("recorded");
    let after = crate::agent_run_mode::types_summary();
    let row = after.as_array().unwrap().iter().find(|r| r["id"] == ID).unwrap();
    assert_eq!(row["caps"]["chat"], "yes", "{row}");
    // A shipped agent's read-only chip follows the run table.
    let claude = after.as_array().unwrap().iter().find(|r| r["id"] == "claude").unwrap();
    assert_eq!(claude["caps"]["read_only"], "yes");
}
