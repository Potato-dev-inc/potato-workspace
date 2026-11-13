use crate::mobile_pairing::pane_rules::{self, Level, PaneRule};
use crate::mobile_pairing::{authorize_caller, init_pairing_store, pairing_store, route_need, Cap, Caps, Need, PairRequestBody};

/// A paired phone with `caps`; its request headers, as if through the tunnel.
fn phone(caps: Caps) -> String {
    // Tests run side by side and the first store set wins: every call tries its own folder until one is set, so two tests never
    // read one half-written file.
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    while pairing_store().is_none() {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pm-phone-control-{}-{n}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = init_pairing_store(dir.join("pairing.json"));
    }
    let store = pairing_store().expect("pairing store");
    let mut guard = store.lock();
    let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), caps);
    let token = guard
        .pair_device(PairRequestBody { pairing_code: session.pairing_code, device_name: "interrupt test phone".into(), device_public_key: session.server_public_key })
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
fn the_interrupt_route_needs_typing_and_the_asks_and_rules_routes_need_only_a_device() {
    assert_eq!(route_need("POST", &["panes", "p1", "interrupt"]), Need::Cap(Cap::Type));
    assert_eq!(route_need("GET", &["pane-rules"]), Need::Device);
    assert_eq!(route_need("POST", &["control-asks"]), Need::Device);
    // Nothing else under control-asks or pane-rules is open to a bare device.
    assert_eq!(route_need("POST", &["pane-rules"]), Need::Cap(Cap::Control));
    assert_eq!(route_need("GET", &["control-asks"]), Need::Cap(Cap::Watch));
}

#[test]
fn a_watch_only_device_is_refused_the_interrupt_route() {
    let watch_only = phone(Caps::none().with(Cap::Watch, true));
    assert_eq!(status(&watch_only, "POST", &["panes", "stop-watch-1", "interrupt"]), 403);
    let answer_only = phone(Caps::watch_and_answer());
    assert_eq!(status(&answer_only, "POST", &["panes", "stop-watch-1", "interrupt"]), 403);
    // A device that may type is let through.
    let typing = phone(Caps::all());
    assert_eq!(status(&typing, "POST", &["panes", "stop-watch-1", "interrupt"]), 200);
}

#[test]
fn a_switched_off_agent_and_a_watch_only_agent_refuse_the_interrupt_route() {
    let headers = phone(Caps::all());
    let off = "stop-off-1";
    assert_eq!(status(&headers, "POST", &["panes", off, "interrupt"]), 200, "before the switch");
    pane_rules::set(off, PaneRule { remote: false, level: Level::Full }).unwrap();
    assert_eq!(status(&headers, "POST", &["panes", off, "interrupt"]), 403, "switched off");

    let watch = "stop-watch-2";
    pane_rules::set(watch, PaneRule { remote: true, level: Level::Watch }).unwrap();
    assert_eq!(status(&headers, "POST", &["panes", watch, "interrupt"]), 403, "watch only");
    pane_rules::set(watch, PaneRule { remote: true, level: Level::Answer }).unwrap();
    assert_eq!(status(&headers, "POST", &["panes", watch, "interrupt"]), 403, "answer only");
    pane_rules::set(watch, PaneRule::default()).unwrap();
    assert_eq!(status(&headers, "POST", &["panes", watch, "interrupt"]), 200, "back to the default");
    // Another agent is not touched by those rules.
    assert_eq!(status(&headers, "POST", &["panes", "stop-other-3", "interrupt"]), 200);
}

#[test]
fn asking_for_control_is_allowed_even_where_the_agent_refuses_everything() {
    let headers = phone(Caps::all());
    let pane = "ask-off-1";
    pane_rules::set(pane, PaneRule { remote: false, level: Level::Full }).unwrap();
    // The ask is not under /panes/{id}, so the agent's own rule does not refuse it: the person on the PC decides.
    assert_eq!(status(&headers, "POST", &["control-asks"]), 200);
    assert_eq!(status(&headers, "GET", &["pane-rules"]), 200);
    // A phone with no caps at all may still ask (it is a paired device) but not stop anything.
    let nothing = phone(Caps::none());
    assert_eq!(status(&nothing, "POST", &["control-asks"]), 200);
    assert_eq!(status(&nothing, "POST", &["panes", "x", "interrupt"]), 403);
}

#[test]
fn the_rules_list_names_only_agents_with_their_own_rule() {
    pane_rules::set("list-off-1", PaneRule { remote: false, level: Level::Full }).unwrap();
    pane_rules::set("list-watch-1", PaneRule { remote: true, level: Level::Watch }).unwrap();
    let body = super::rules_body();
    assert_eq!(body["rules"]["list-off-1"], serde_json::json!({ "remote": false, "level": "full" }));
    assert_eq!(body["rules"]["list-watch-1"], serde_json::json!({ "remote": true, "level": "watch" }));
    assert!(body["rules"].get("list-default-1").is_none());
}

#[test]
fn the_phone_routes_are_not_exposed_to_mcp_sessions() {
    // Agents must not stop a sibling or ask for control through the bridge: the routes are not tools.
    let session = uuid::Uuid::new_v4().to_string();
    for (method, path) in [("POST", "/panes/some-pane/interrupt"), ("POST", "/control-asks"), ("GET", "/pane-rules")] {
        let result = crate::mcp_sessions::authorize(Some(&session), method, path, &serde_json::json!({ "pane_id": "some-pane" }));
        assert!(result.is_err(), "{method} {path} must be refused for an MCP session");
    }
}
