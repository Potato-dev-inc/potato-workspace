//! "Sent from": the id that goes on a message comes from the token (a paired phone) or the link's own door (a paired PC),
//! never from a header a caller could write; the new routes need `type` (typing, take over) or only a device (names).

use super::sender_of_parts;
use crate::bridge::link_with_node_for_test;
use crate::mobile_pairing::pane_rules::PaneRule;
use crate::mobile_pairing::{authorize_caller, bearer_token, init_pairing_store, pairing_store, route_need, Cap, Caps, Need, PairRequestBody};

fn phone(caps: Caps, name: &str) -> (String, String) {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    while pairing_store().is_none() {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pm-sender-{}-{n}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = init_pairing_store(dir.join("pairing.json"));
    }
    let store = pairing_store().expect("pairing store");
    let mut guard = store.lock();
    let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), caps);
    let paired = guard
        .pair_device(PairRequestBody { pairing_code: session.pairing_code, device_name: name.into(), device_public_key: session.server_public_key })
        .expect("pair");
    (paired.device_id, format!("Authorization: Bearer {}\r\nX-Potato-Workspace-Proxied: 1\r\n", paired.device_token))
}

fn status(headers: &str, method: &str, segments: &[&str]) -> u16 {
    match authorize_caller(headers, true, segments, method) {
        Ok(_) => 200,
        Err((code, _)) => code,
    }
}

#[test]
fn a_message_from_a_paired_phone_is_marked_with_that_phones_id_and_one_from_the_app_has_none() {
    let (id, headers) = phone(Caps::all(), "Pixel 9");
    assert_eq!(sender_of_parts(None, &headers), Some(id));
    assert_eq!(sender_of_parts(None, "Host: 127.0.0.1\r\n"), None, "the app itself is this PC");
    // An agent's MCP session is not a device, whatever token it carries.
    assert_eq!(sender_of_parts(Some("s1"), &headers), None);
    // A header that names a node is not believed: only the link's own door says who a link request is.
    assert_eq!(sender_of_parts(None, "X-Potato-Link-Node: abc\r\n"), None);
}

#[test]
fn a_message_that_came_over_the_pc_link_is_marked_with_that_pcs_id() {
    link_with_node_for_test("node-abc", || {
        assert_eq!(sender_of_parts(None, "Host: device-link\r\n"), Some("link:node-abc".to_string()));
    });
    assert_eq!(sender_of_parts(None, "Host: device-link\r\n"), None, "the door closes again");
}

#[test]
fn the_phones_own_name_and_the_names_list_need_only_a_device_and_typing_and_taking_over_need_type() {
    assert_eq!(route_need("POST", &["pair", "me"]), Need::Device);
    assert_eq!(route_need("GET", &["devices", "names"]), Need::Device);
    assert_eq!(route_need("POST", &["acp", "sessions", "p1", "typing"]), Need::Cap(Cap::Type));
    assert_eq!(route_need("POST", &["acp", "sessions", "p1", "claim"]), Need::Cap(Cap::Type));
    let (_, watch_only) = phone(Caps::none().with(Cap::Watch, true), "Watcher");
    assert_eq!(status(&watch_only, "GET", &["devices", "names"]), 200);
    assert_eq!(status(&watch_only, "POST", &["pair", "me"]), 200);
    assert_eq!(status(&watch_only, "POST", &["acp", "sessions", "p-typing-1", "typing"]), 403);
    assert_eq!(status(&watch_only, "POST", &["acp", "sessions", "p-typing-1", "claim"]), 403);
    let (_, typing) = phone(Caps::all(), "Typist");
    assert_eq!(status(&typing, "POST", &["acp", "sessions", "p-typing-1", "typing"]), 200);
    // The agent's own remote rule still applies to the pane the route names.
    crate::mobile_pairing::pane_rules::set("p-typing-off", PaneRule { remote: false, level: crate::mobile_pairing::pane_rules::Level::Full }).unwrap();
    assert_eq!(status(&typing, "POST", &["acp", "sessions", "p-typing-off", "typing"]), 403);
    // No token, no route.
    assert_eq!(status("Host: example.com\r\nX-Potato-Workspace-Proxied: 1\r\n", "POST", &["acp", "sessions", "p1", "typing"]), 401);
    let _ = bearer_token;
}

#[test]
fn a_paired_phone_has_a_name_and_a_rename_shows_in_the_list_and_stays_after_the_phone_names_itself_again() {
    use crate::device_identity::{global, DeviceKind};
    let (id, _) = phone(Caps::all(), "OPPO Reno13");
    let listed = |id: &str| pairing_store().unwrap().lock().list_devices().into_iter().find(|d| d.id == id).unwrap().name;
    assert_eq!(listed(&id), "OPPO Reno13");
    assert!(global().rename(&id, "Mum's phone"));
    assert_eq!(listed(&id), "Mum's phone");
    global().observe(&id, DeviceKind::Phone, "OPPO Reno13 Pro");
    assert_eq!(listed(&id), "Mum's phone", "the person's name wins");
    assert!(global().rename(&id, ""));
    assert_eq!(listed(&id), "OPPO Reno13 Pro");
    // Removing the phone removes its record.
    assert!(pairing_store().unwrap().lock().revoke_device(&id).unwrap());
    assert!(global().get(&id).is_none());
}
