use serde_json::json;

use super::{merge_agents, needs_hold, offered_agents, parse_lane, project_id, resolve_project};
use crate::mobile_pairing::pane_rules::{self, Level, PaneRule};
use crate::mobile_pairing::{authorize_caller, init_pairing_store, pairing_store, route_need, Cap, Caps, Need, PairRequestBody};

/// A paired phone with `caps`; its request headers, as if through the tunnel.
fn phone(caps: Caps) -> String {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    while pairing_store().is_none() {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pm-phone-chat-{}-{n}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = init_pairing_store(dir.join("pairing.json"));
    }
    let store = pairing_store().expect("pairing store");
    let mut guard = store.lock();
    let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), caps);
    let token = guard
        .pair_device(PairRequestBody { pairing_code: session.pairing_code, device_name: "phone chat test".into(), device_public_key: session.server_public_key })
        .expect("pair")
        .device_token;
    format!("Authorization: Bearer {token}\r\nX-Potato-Workspace-Proxied: 1\r\n")
}

fn status(headers: &str, method: &str, segments: &[&str]) -> u16 {
    match authorize_caller(headers, true, segments, method) {
        Ok(_) => 200,
        Err((code, _)) => code,
    }
}

#[test]
fn the_phone_chat_routes_need_the_rights_they_say() {
    assert_eq!(route_need("GET", &["phone", "new-chat"]), Need::Cap(Cap::Watch));
    assert_eq!(route_need("GET", &["acp", "closed"]), Need::Cap(Cap::Watch));
    assert_eq!(route_need("POST", &["phone", "chats"]), Need::Cap(Cap::Control));
    assert_eq!(route_need("POST", &["acp", "sessions", "p1", "config"]), Need::Cap(Cap::Control));
    assert_eq!(route_need("POST", &["acp", "closed", "c1", "reopen"]), Need::Cap(Cap::Control));
    // Nothing else under these paths is open for less.
    assert_eq!(route_need("POST", &["acp", "closed"]), Need::Cap(Cap::Control));
    assert_eq!(route_need("DELETE", &["acp", "closed", "c1"]), Need::Cap(Cap::Control));
}

#[test]
fn a_watch_only_device_may_read_the_choices_but_not_start_change_or_reopen() {
    let watch_only = phone(Caps::none().with(Cap::Watch, true));
    assert_eq!(status(&watch_only, "GET", &["phone", "new-chat"]), 200);
    assert_eq!(status(&watch_only, "GET", &["acp", "closed"]), 200);
    assert_eq!(status(&watch_only, "POST", &["phone", "chats"]), 403, "start a chat");
    assert_eq!(status(&watch_only, "POST", &["acp", "sessions", "wo-1", "config"]), 403, "change the model");
    assert_eq!(status(&watch_only, "POST", &["acp", "closed", "wo-2", "reopen"]), 403, "reopen");
    let answer = phone(Caps::watch_and_answer());
    assert_eq!(status(&answer, "POST", &["phone", "chats"]), 403);
    assert_eq!(status(&answer, "POST", &["acp", "sessions", "wo-1", "config"]), 403);
    // A device that may control is let through to the route.
    let control = phone(Caps::all());
    assert_eq!(status(&control, "POST", &["phone", "chats"]), 200);
    assert_eq!(status(&control, "POST", &["acp", "sessions", "wo-1", "config"]), 200);
    assert_eq!(status(&control, "POST", &["acp", "closed", "wo-2", "reopen"]), 200);
    // A device with no watch cannot read the lists.
    let nothing = phone(Caps::none());
    assert_eq!(status(&nothing, "GET", &["phone", "new-chat"]), 403);
    assert_eq!(status(&nothing, "GET", &["acp", "closed"]), 403);
}

#[test]
fn a_switched_off_or_limited_agent_refuses_the_settings_and_the_reopen_routes() {
    let headers = phone(Caps::all());
    for (pane, route) in [("cfg-off-1", "config"), ("cfg-off-2", "reopen")] {
        let path: Vec<&str> = if route == "config" { vec!["acp", "sessions", pane, "config"] } else { vec!["acp", "closed", pane, "reopen"] };
        assert_eq!(status(&headers, "POST", &path), 200, "before the switch");
        pane_rules::set(pane, PaneRule { remote: false, level: Level::Full }).unwrap();
        assert_eq!(status(&headers, "POST", &path), 403, "switched off: {route}");
        pane_rules::set(pane, PaneRule { remote: true, level: Level::Watch }).unwrap();
        assert_eq!(status(&headers, "POST", &path), 403, "watch only: {route}");
        pane_rules::set(pane, PaneRule { remote: true, level: Level::Answer }).unwrap();
        assert_eq!(status(&headers, "POST", &path), 403, "answer only: {route}");
        pane_rules::set(pane, PaneRule::default()).unwrap();
        assert_eq!(status(&headers, "POST", &path), 200, "back to the default");
    }
    // The state and cancel routes of the same chat now meet the agent's rule too.
    let off = "cfg-off-3";
    pane_rules::set(off, PaneRule { remote: false, level: Level::Full }).unwrap();
    assert_eq!(status(&headers, "GET", &["acp", "sessions", off]), 403);
    assert_eq!(status(&headers, "POST", &["acp", "sessions", off, "cancel"]), 403);
    // Another agent is not touched.
    assert_eq!(status(&headers, "POST", &["acp", "sessions", "cfg-other", "config"]), 200);
}

#[test]
fn the_phone_chat_routes_are_not_exposed_to_mcp_sessions() {
    let session = uuid::Uuid::new_v4().to_string();
    for (method, path) in [
        ("POST", "/phone/chats"),
        ("GET", "/phone/new-chat"),
        ("POST", "/acp/sessions/some-pane/config"),
        ("GET", "/acp/closed"),
        ("POST", "/acp/closed/some-chat/reopen"),
    ] {
        let result = crate::mcp_sessions::authorize(Some(&session), method, path, &json!({ "pane_id": "some-pane" }));
        assert!(result.is_err(), "{method} {path} must be refused for an MCP session");
    }
}

#[test]
fn a_project_is_named_by_an_id_that_never_shows_the_path() {
    let path = r"C:\Users\someone\work\shop";
    let id = project_id(path);
    assert!(id.starts_with('p') && id.len() == 17, "{id}");
    assert!(!id.to_lowercase().contains("shop") && !id.contains("work"));
    // The same folder spelled another way is the same project; another folder is not.
    assert_eq!(id, project_id("c:/users/someone/work/shop/"));
    assert_ne!(id, project_id(r"C:\Users\someone\work\other"));
}

#[test]
fn only_a_project_the_pc_already_knows_resolves() {
    let projects = vec![
        (r"C:\work\shop".to_string(), "shop".to_string(), "repo".to_string()),
        (r"C:\work\blog".to_string(), "blog".to_string(), "folder".to_string()),
    ];
    assert_eq!(resolve_project(&projects, &project_id(r"C:\work\blog")).as_deref(), Some(r"C:\work\blog"));
    assert_eq!(resolve_project(&projects, &project_id(r"C:\Windows\System32")), None);
    // A raw path is not an id.
    assert_eq!(resolve_project(&projects, r"C:\work\shop"), None);
    assert_eq!(resolve_project(&projects, ""), None);
}

#[test]
fn an_agent_that_can_do_both_is_one_row_with_both_ways() {
    let chat = vec![("claude".to_string(), "Claude".to_string()), ("kilo".to_string(), "Kilo".to_string())];
    let terminal = vec![("claude".to_string(), "Claude".to_string()), ("codex".to_string(), "Codex".to_string())];
    let rows = merge_agents(&chat, &terminal);
    assert_eq!(rows.len(), 3);
    let by = |id: &str| rows.iter().find(|r| r["id"] == id).unwrap().clone();
    assert_eq!((by("claude")["chat"].as_bool(), by("claude")["terminal"].as_bool()), (Some(true), Some(true)));
    assert_eq!((by("kilo")["chat"].as_bool(), by("kilo")["terminal"].as_bool()), (Some(true), Some(false)));
    assert_eq!((by("codex")["chat"].as_bool(), by("codex")["terminal"].as_bool()), (Some(false), Some(true)));
}

#[test]
fn the_lane_word_is_chat_or_terminal_only() {
    assert_eq!(parse_lane("chat"), Some(true));
    assert_eq!(parse_lane("acp"), Some(true));
    assert_eq!(parse_lane("terminal"), Some(false));
    assert_eq!(parse_lane("headless"), None);
    assert_eq!(parse_lane(""), None);
}

#[test]
fn a_mode_with_no_questions_asked_needs_a_press_and_hold() {
    let options = vec![
        json!({ "id": "mode", "category": "mode", "options": [
            { "value": "default", "name": "Ask each time" },
            { "value": "bypassPermissions", "name": "Full access" },
            { "value": "plan", "name": "Plan" },
        ]}),
        json!({ "id": "model", "category": "model", "options": [
            { "value": "big", "name": "Big" },
            { "value": "yolo-fast", "name": "Fast" },
        ]}),
    ];
    assert!(needs_hold(&options, "mode", "bypassPermissions"));
    assert!(!needs_hold(&options, "mode", "default"));
    assert!(!needs_hold(&options, "mode", "plan"));
    // Only a mode setting counts: a model with such a word in it is just a model.
    assert!(!needs_hold(&options, "model", "yolo-fast"));
    // Unknown settings are not held here; the chat itself refuses them.
    assert!(!needs_hold(&options, "nope", "bypassPermissions"));
}

#[test]
fn with_terminals_off_the_phone_is_offered_chat_agents_only_and_told_how_many_were_left_out() {
    let chat = vec![("claude".to_string(), "Claude".to_string()), ("codex".to_string(), "Codex".to_string())];
    let terminal = vec![("claude".to_string(), "Claude".to_string()), ("codex".to_string(), "Codex".to_string()), ("aider".to_string(), "Aider".to_string())];
    // On: today's list, nothing hidden.
    let (all, hidden) = offered_agents(&chat, &terminal, true);
    assert_eq!(all.len(), 3);
    assert_eq!(hidden, 0);
    assert_eq!(all.iter().find(|a| a["id"] == "claude").unwrap()["terminal"], json!(true));
    // Off: no terminal-only agent and no agent says it can run in a terminal, so the phone draws no Terminal pill.
    let (listed, hidden) = offered_agents(&chat, &terminal, false);
    assert_eq!(listed.iter().map(|a| a["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["claude", "codex"]);
    assert_eq!(hidden, 1);
    assert!(listed.iter().all(|a| a["chat"] == true && a["terminal"] == false));
}

#[test]
fn the_terminal_lane_is_refused_while_terminals_are_off() {
    // The route refuses `lane: terminal` with TERMINALS_OFF exactly when `show_terminals::allowed` says no.
    assert!(!crate::show_terminals::allowed(false, true));
    assert!(crate::show_terminals::allowed(true, true));
}
