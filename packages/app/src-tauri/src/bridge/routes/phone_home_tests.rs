use super::*;
use crate::acp::warm::HelperState;
use crate::mobile_pairing::{authorize_caller, init_pairing_store, pairing_store, route_need, Cap, Caps, Need, PairRequestBody};
use crate::standby::helpers::{AfterTask, HelperEntry, HelpersView};
use crate::turn_summary::model::{assemble, Facts};
use crate::turn_summary::{FileStats, ReceiptFacts};

fn turn(pane: &str, ended: u64, end: &str, files: u32) -> TurnSummary {
    assemble(Facts {
        pane_id: pane.into(),
        agent: "Claude".into(),
        agent_id: Some("claude".into()),
        account: None,
        turn: 1,
        started_at_ms: ended.saturating_sub(50),
        ended_at_ms: ended,
        files: (files > 0).then(|| FileStats { count: files, added: 10, deleted: 2, paths: vec!["a.rs".into()] }),
        approvals: Vec::new(),
        end_status: end.into(),
        end_prompt: None,
        receipt: Some(ReceiptFacts { checks: "2/2 passed".into(), outcome: "passed_checks".into() }),
    })
}

#[test]
fn done_rows_are_newest_first_one_per_chat_and_skip_waiting_and_old_turns() {
    let body = done_body(
        vec![turn("a", 5_000, "idle", 2), turn("b", 9_000, "idle", 0), turn("a", 7_000, "idle", 1), turn("c", 8_000, "waiting_input", 0), turn("old", 100, "idle", 1)],
        1_000,
        10_000,
    );
    let rows = body["rows"].as_array().unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r["paneId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["b", "a"]);
    assert_eq!(rows[1]["endedAtMs"], json!(7_000));
    assert_eq!(rows[1]["files"]["count"], json!(1));
    assert_eq!(rows[0]["agent"], json!("claude"));
    assert_eq!(rows[0]["checks"], json!("2/2 passed"));
}

#[test]
fn done_rows_are_cut_at_the_limit() {
    let many: Vec<TurnSummary> = (0..40).map(|n| turn(&format!("p{n}"), 2_000 + n, "idle", 0)).collect();
    assert_eq!(done_body(many, 1_000, 10_000)["rows"].as_array().unwrap().len(), MAX_ROWS);
}

#[test]
fn helpers_show_the_folder_name_never_the_path() {
    let view = HelpersView {
        helpers: vec![HelperEntry {
            id: "sb-1".into(),
            name: "Reviewer".into(),
            agent: "claude".into(),
            model: None,
            project: "C:/Users/someone/secret-work/app".into(),
            after_task: AfterTask::default(),
            home: None,
            used_by: None,
            taken_over: false,
            state: HelperState::Ready,
            note: None,
            pane_id: None,
            open_pane: None,
            person_pane: None,
        }],
        max: 4,
        idle_minutes: 30,
    };
    let body = helpers_body(view);
    assert_eq!(body["helpers"][0]["folder"], json!("app"));
    assert_eq!(body["helpers"][0]["state"], json!("ready"));
    assert!(!body.to_string().contains("secret-work"));
}

fn phone(caps: Caps) -> String {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    while pairing_store().is_none() {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pm-phone-home-{}-{n}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = init_pairing_store(dir.join("pairing.json"));
    }
    let store = pairing_store().expect("pairing store");
    let mut guard = store.lock();
    let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), caps);
    let token = guard
        .pair_device(PairRequestBody { pairing_code: session.pairing_code, device_name: "phone home test".into(), device_public_key: session.server_public_key })
        .expect("pair")
        .device_token;
    format!("Authorization: Bearer {token}\r\nX-Potato-Workspace-Proxied: 1\r\n")
}

fn status(headers: &str, segments: &[&str]) -> u16 {
    match authorize_caller(headers, true, segments, "GET") {
        Ok(_) => 200,
        Err((code, _)) => code,
    }
}

#[test]
fn both_routes_need_watch_and_a_device_without_it_is_refused() {
    assert_eq!(route_need("GET", &["phone", "done"]), Need::Cap(Cap::Watch));
    assert_eq!(route_need("GET", &["phone", "helpers"]), Need::Cap(Cap::Watch));
    // Nothing else under them is open for less.
    assert_eq!(route_need("POST", &["phone", "done"]), Need::Cap(Cap::Control));
    assert_eq!(route_need("POST", &["phone", "helpers"]), Need::Cap(Cap::Control));
    let blind = phone(Caps::none());
    assert_eq!(status(&blind, &["phone", "done"]), 403);
    assert_eq!(status(&blind, &["phone", "helpers"]), 403);
    let watcher = phone(Caps::none().with(Cap::Watch, true));
    assert_eq!(status(&watcher, &["phone", "done"]), 200);
    assert_eq!(status(&watcher, &["phone", "helpers"]), 200);
    // A proxied request without a token is refused.
    assert_eq!(status("X-Potato-Workspace-Proxied: 1\r\n", &["phone", "done"]), 401);
}
