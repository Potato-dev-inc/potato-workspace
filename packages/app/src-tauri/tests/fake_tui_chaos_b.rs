//! Chaos cases B02, B13, B14, B15: quit with two terminals, two MCP clients on one helper, the same agent added twice, two viewers on one grid.
//!
//! Filled by branch `test/chaos-b` from SPEC-CHAOS-1113 section 2. Use only `puppet_master_app_lib::fake_tui::{Session, World}`.
//! Included from `fake_tui_e2e.rs` (one test binary, one World).

use puppet_master_app_lib::fake_tui::World;
use serde_json::{json, Value};

// B02 "both terminals back, or each shows new copy `This terminal ended when the app closed. Start it again.`"
// needs-switch quit_and_reopen: Session has no quit-and-reopen path (SPEC 1.3 says skip it if it needs a second process).
#[test]
#[ignore = "needs-switch quit_and_reopen"]
fn chaos_quit_with_two_terminals_then_reopen() {
    panic!("needs-switch: Session::quit_and_reopen does not exist yet");
}

// B13 "b is refused (`AUTHORIZATION_DENIED`); a's run finishes normally"
#[test]
fn chaos_two_mcp_clients_on_one_helper() {
    let session = World::get().session("chaos-b-two-clients");
    session.set_mode_as("a", "both");
    session.set_mode_as("b", "both");
    let started = session.run_as("a", "fake_claude", "Say done", json!({ "keep_pane": false })).unwrap_or_else(|e| panic!("run_agent refused: {e}"));
    let handle = started["handle"].as_str().expect("a handle").to_string();
    let project = session.project().to_string_lossy().into_owned();
    let body = json!({ "project_path": project, "handles": [handle], "until": ["completed", "failed", "cancelled"], "wait_ms": 1000 });

    // The second client tries to wait on a's run: refused by the session gate.
    let refused = session.agents_as(Some("b"), "POST", "/agents/wait", body.clone()).expect_err("b did not start this run");
    assert_eq!(refused["code"], "AUTHORIZATION_DENIED", "{refused}");
    let denied = session.authorize_as("b", "POST", "/agents/wait", body.clone()).expect_err("the gate refuses b");
    assert_eq!(denied["code"], "AUTHORIZATION_DENIED", "{denied}");

    // a's run finishes normally.
    let finished = session.until(90, || {
        let reply: Value = session.agents_as(Some("a"), "POST", "/agents/wait", body.clone()).ok()?;
        let status = reply["agents"][0]["status"].as_str()?.to_string();
        matches!(status.as_str(), "completed" | "failed" | "cancelled").then_some(reply)
    });
    let finished = finished.unwrap_or_else(|| panic!("a's run did not finish"));
    assert_eq!(finished["agents"][0]["status"], "completed", "{finished}");
}

// B14 "one entry in the agent list; second add says new copy `Nimbus is already added.` or updates; never two rows"
// needs-switch agent-list-query: the agent registry is private to the crate (`mod tui` in lib.rs), and `screen_agent`
// swaps the registry itself rather than going through the product's add path, so a duplicate add cannot be seen from here.
#[test]
#[ignore = "needs-switch agent-list-query-and-product-add-path"]
fn chaos_same_agent_added_twice() {
    panic!("needs-switch: no way to list agents or to add one through the product path from an integration test");
}

// B15 "both screens show the same rows; no duplicate lines (the grid invariant)"
#[test]
fn chaos_two_viewers_keep_one_grid() {
    let session = World::get().session("chaos-b-two-viewers");
    let pane = session.spawn_pane("fake_claude").expect("a pane");
    session.until(30, || session.screen(&pane).contains("Try \"edit").then_some(())).expect("the agent drew its input box");
    let viewer = session.second_viewer(&pane);
    assert_eq!(viewer.size(), Some((120, 30)), "the second window sees the pane's grid");

    // The second window resizes the pane: the one grid changes for both.
    assert_eq!(session.resize(&pane, 100, 40), Ok(true));
    let settled = session.until(10, || (viewer.size() == Some((100, 40))).then_some(()));
    assert!(settled.is_some(), "the grid became 100x40 for the second window: {:?}", viewer.size());

    let main = session.screen(&pane);
    let second = viewer.screen();
    assert_eq!(second.matches("Try \"edit").count(), 1, "one input line in the second window:\n{second}");
    assert_eq!(main.matches("Try \"edit").count(), 1, "one input line in the main window:\n{main}");
    session.close_pane(&pane);
}
