//! The phone's rules for the four chat routes: a locked agent refuses all of them, and the draft needs `type` to write.

use crate::mobile_pairing::pane_rules::{self, Level, PaneRule};
use crate::mobile_pairing::{authorize_caller, init_pairing_store, pairing_store, Cap, Caps, PairRequestBody};

fn phone(caps: Caps) -> String {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    while pairing_store().is_none() {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pm-chat-more-{}-{n}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = init_pairing_store(dir.join("pairing.json"));
    }
    let store = pairing_store().expect("pairing store");
    let mut guard = store.lock();
    let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), caps);
    let token = guard
        .pair_device(PairRequestBody { pairing_code: session.pairing_code, device_name: "chat more phone".into(), device_public_key: session.server_public_key })
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

fn routes(pane: &str) -> Vec<(&'static str, Vec<&str>)> {
    vec![
        ("GET", vec!["panes", pane, "chat", "earlier"]),
        ("GET", vec!["panes", pane, "picture"]),
        ("GET", vec!["panes", pane, "draft"]),
        ("POST", vec!["panes", pane, "draft"]),
    ]
}

#[test]
fn an_agent_with_remote_control_off_refuses_every_one_of_them() {
    let headers = phone(Caps::all());
    let pane = "more-off-1";
    for (method, route) in routes(pane) {
        assert_eq!(status(&headers, method, &route), 200, "{method} {route:?} before");
    }
    pane_rules::set(pane, PaneRule { remote: false, level: Level::Full }).unwrap();
    for (method, route) in routes(pane) {
        assert_eq!(status(&headers, method, &route), 403, "{method} {route:?} after");
    }
    let (_, body) = authorize_caller(&headers, true, &["panes", pane, "draft"], "GET").unwrap_err();
    assert_eq!(body["code"], "PANE_REMOTE_OFF");
    // The local app is never limited.
    assert!(authorize_caller("", true, &["panes", pane, "draft"], "POST").is_ok());
}

#[test]
fn a_watch_only_phone_or_agent_can_read_a_draft_but_not_write_it() {
    let watcher = phone(Caps::none().with(Cap::Watch, true));
    assert_eq!(status(&watcher, "GET", &["panes", "more-w-1", "draft"]), 200);
    assert_eq!(status(&watcher, "GET", &["panes", "more-w-1", "chat", "earlier"]), 200);
    assert_eq!(status(&watcher, "POST", &["panes", "more-w-1", "draft"]), 403);

    let full = phone(Caps::all());
    pane_rules::set("more-w-2", PaneRule { remote: true, level: Level::Watch }).unwrap();
    assert_eq!(status(&full, "GET", &["panes", "more-w-2", "picture"]), 200);
    assert_eq!(status(&full, "POST", &["panes", "more-w-2", "draft"]), 403, "an agent set to watch only takes no typing");
}
