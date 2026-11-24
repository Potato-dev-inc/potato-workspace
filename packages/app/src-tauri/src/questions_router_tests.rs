//! The questions routes behind the app's pairing gate and MCP session gate, driven in process. (The gates are the app's, so these tests stay here.)

use pm_core::questions::routes::{self, RouteReply};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

// ---- In-process router transcript: auth gate, then the questions routes. -------------------

/// Mirrors the order in `bridge/router.rs::route`: pairing gate, MCP session gate, then the
/// questions routes. (`route` itself needs a Tauri `AppHandle`, which unit tests cannot build.)
fn call(
    method: &str,
    path: &str,
    body: Value,
    headers: &str,
    peer_loopback: bool,
    session: Option<&str>,
    notified: &AtomicUsize,
) -> RouteReply {
    let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
    crate::mobile_pairing::authorize_bridge_request(headers, peer_loopback, &segments, method)?;
    crate::mcp_sessions::authorize(session, method, path, &body)
        .map_err(|e| (403, json!({ "code": e.code, "error": e.message })))?;
    let via_phone = crate::mobile_pairing::requires_pairing_token(headers, peer_loopback);
    routes::handle(method, &segments, &body, session, via_phone, &|| {
        notified.fetch_add(1, Ordering::SeqCst);
    })
    .unwrap_or_else(|| Err((404, json!({ "error": "not found" }))))
}

fn paired_phone_token() -> String {
    use base64::Engine;
    use ed25519_dalek::SigningKey;
    let store = crate::mobile_pairing::pairing_store().unwrap_or_else(|| {
        let path = std::env::temp_dir().join(format!("pm-questions-pairing-{}.json", uuid::Uuid::new_v4()));
        crate::mobile_pairing::init_pairing_store(path).unwrap()
    });
    let mut guard = store.lock();
    let session = guard.create_pairing_session("http://127.0.0.1:1".into());
    let key = SigningKey::from_bytes(&[7_u8; 32]).verifying_key();
    let request = serde_json::from_value(json!({
        "pairing_code": session.pairing_code,
        "device_name": "test phone",
        "device_public_key": base64::engine::general_purpose::STANDARD.encode(key.as_bytes()),
    }))
    .unwrap();
    guard.pair_device(request).unwrap().device_token
}

#[test]
fn router_transcript_list_answer_dismiss_with_auth() {
    let notified = AtomicUsize::new(0);
    let local = "Host: 127.0.0.1\r\n";
    let token = paired_phone_token();
    let phone = format!("Host: pm.example.com\r\nAuthorization: Bearer {token}\r\n");
    let stranger = "Host: pm.example.com\r\nAuthorization: Bearer not-a-token\r\n";
    let mcp = "agent-connection-1";

    // An MCP session asks (blocks briefly via wait_ms) and gets an unresolved reply with an id.
    let (status, asked) = call(
        "POST",
        "/questions/ask",
        json!({ "question": "Pick a database", "choices": [{"id":"pg","label":"Postgres"},{"id":"sq","label":"SQLite"}],
                "agent": "Planner", "wait_ms": 10 }),
        local,
        true,
        Some(mcp),
        &notified,
    )
    .unwrap();
    assert_eq!((status, asked["resolved"].clone()), (200, json!(false)));
    let id = asked["question_id"].as_str().unwrap().to_string();
    assert!(notified.load(Ordering::SeqCst) >= 1, "creating a question publishes a change");

    // The desktop webview (no session header) lists it.
    let (status, listed) = call("GET", "/questions", json!({}), local, true, None, &notified).unwrap();
    assert_eq!(status, 200);
    let mine = listed["questions"].as_array().unwrap().iter().find(|q| q["id"] == id.as_str()).unwrap();
    assert_eq!(mine["agent"], "Planner");
    assert_eq!(mine["choices"][0]["id"], "pg");

    // Auth: a remote caller with no token and one with a bad token are refused.
    let no_token = call("GET", "/questions", json!({}), "Host: pm.example.com\r\n", false, None, &notified).unwrap_err();
    assert_eq!(no_token.0, 401);
    let bad = call("GET", "/questions", json!({}), stranger, false, None, &notified).unwrap_err();
    assert_eq!(bad.0, 401);
    // An MCP session cannot list or answer: the agent must not answer its own question.
    let denied = call("GET", "/questions", json!({}), local, true, Some(mcp), &notified).unwrap_err();
    assert_eq!(denied.0, 403);
    let denied = call(
        "POST",
        &format!("/questions/{id}/answer"),
        json!({ "choice_id": "pg" }),
        local,
        true,
        Some(mcp),
        &notified,
    )
    .unwrap_err();
    assert_eq!(denied.0, 403);

    // A bad choice is a 400 and leaves the question open.
    let bad_choice = call(
        "POST",
        &format!("/questions/{id}/answer"),
        json!({ "choice_id": "mongo" }),
        &phone,
        false,
        None,
        &notified,
    )
    .unwrap_err();
    assert_eq!((bad_choice.0, bad_choice.1["code"].clone()), (400, json!("INVALID_CHOICE")));

    // The paired phone answers; it is recorded as the phone.
    let (status, done) = call(
        "POST",
        &format!("/questions/{id}/answer"),
        json!({ "choice_id": "sq" }),
        &phone,
        false,
        None,
        &notified,
    )
    .unwrap();
    assert_eq!(status, 200);
    assert_eq!(done["accepted"], true);
    assert_eq!(done["question"]["answer"]["answered_by"], "phone");

    // A second answer from the desktop loses (idempotent, 200, accepted=false).
    let (status, again) = call(
        "POST",
        &format!("/questions/{id}/answer"),
        json!({ "choice_id": "pg" }),
        local,
        true,
        None,
        &notified,
    )
    .unwrap();
    assert_eq!((status, again["accepted"].clone()), (200, json!(false)));
    assert_eq!(again["question"]["answer"]["choice_id"], "sq");

    // The agent's next poll sees the answer as the tool result.
    let (_, result) =
        call("POST", "/questions/ask", json!({ "question_id": id, "wait_ms": 10 }), local, true, Some(mcp), &notified)
            .unwrap();
    assert_eq!(
        result,
        json!({ "resolved": true, "question_id": id, "answered": true, "answered_by": "phone", "choice_id": "sq" })
    );

    // Dismiss: ask again, dismiss from the desktop, the agent sees "cancelled".
    let (_, second) = call(
        "POST",
        "/questions/ask",
        json!({ "question": "Continue?", "choices": [{"id":"go","label":"Go"}], "wait_ms": 1 }),
        local,
        true,
        Some(mcp),
        &notified,
    )
    .unwrap();
    let id2 = second["question_id"].as_str().unwrap().to_string();
    let (status, dismissed) =
        call("POST", &format!("/questions/{id2}/dismiss"), json!({}), local, true, None, &notified).unwrap();
    assert_eq!((status, dismissed["accepted"].clone()), (200, json!(true)));
    let (_, result) =
        call("POST", "/questions/ask", json!({ "question_id": id2, "wait_ms": 10 }), local, true, Some(mcp), &notified)
            .unwrap();
    assert_eq!(result["answered"], false);
    assert_eq!(result["reason"], "cancelled");
    let missing = call("POST", "/questions/nope/dismiss", json!({}), local, true, None, &notified).unwrap_err();
    assert_eq!(missing.0, 404);
}

#[test]
fn a_new_question_triggers_one_push_and_polling_or_cancelling_triggers_none() {
    let notified = AtomicUsize::new(0);
    let local = "Host: 127.0.0.1\r\n";
    let count = |id: &str| crate::push::NOTIFIED_QUESTIONS.lock().iter().filter(|x| x.as_str() == id).count();
    let (_, first) = call(
        "POST",
        "/questions/ask",
        json!({ "question": "Push me once?", "wait_ms": 1 }),
        local,
        true,
        Some("agent-push-1"),
        &notified,
    )
    .unwrap();
    let id = first["question_id"].as_str().unwrap().to_string();
    assert_eq!(count(&id), 1, "creating the question pushes once");
    // The shim's long-poll repeats the call with the id: no new question, no new push.
    for _ in 0..3 {
        call("POST", "/questions/ask", json!({ "question_id": id, "wait_ms": 1 }), local, true, Some("agent-push-1"), &notified).unwrap();
    }
    assert_eq!(count(&id), 1);
    // Listing, answering and cancelling never push.
    call("GET", "/questions", json!({}), local, true, None, &notified).unwrap();
    call("POST", &format!("/questions/{id}/answer"), json!({ "text": "ok" }), local, true, None, &notified).unwrap();
    assert_eq!(count(&id), 1);
    // A second question is its own notification.
    let (_, second) = call("POST", "/questions/ask", json!({ "question": "And me?", "wait_ms": 1 }), local, true, Some("agent-push-1"), &notified).unwrap();
    let id2 = second["question_id"].as_str().unwrap().to_string();
    assert_eq!((count(&id), count(&id2)), (1, 1));
    // A rejected question (empty) pushes nothing. Other tests push concurrently, so compare the
    // ids this call could have created (none) rather than the global list length.
    let before: Vec<String> = crate::push::NOTIFIED_QUESTIONS.lock().clone();
    assert!(call("POST", "/questions/ask", json!({ "question": "  " }), local, true, Some("agent-push-1"), &notified).is_err());
    let open_for_session = |list: &serde_json::Value| -> Vec<String> {
        list["questions"].as_array().into_iter().flatten()
            .filter(|q| q["session_id"].as_str() == Some("agent-push-1") || q["owner"].as_str() == Some("agent-push-1"))
            .filter_map(|q| q["id"].as_str().or(q["question_id"].as_str()).map(str::to_string))
            .collect()
    };
    let (_, listed) = call("GET", "/questions", json!({}), local, true, None, &notified).unwrap();
    let new_ids: Vec<String> = crate::push::NOTIFIED_QUESTIONS.lock().iter().filter(|x| !before.contains(x)).cloned().collect();
    for mine in open_for_session(&listed) {
        assert!(!new_ids.contains(&mine), "the rejected question must not push");
    }
    assert_eq!((count(&id), count(&id2)), (1, 1));
}

