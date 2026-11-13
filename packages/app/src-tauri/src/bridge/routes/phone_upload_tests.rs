use super::*;
use crate::mobile_pairing::pane_rules::{self, Level, PaneRule};
use crate::mobile_pairing::{authorize_caller, init_pairing_store, pairing_store, route_need, Cap, Caps, Need, PairRequestBody};
use chrono::NaiveDate;

/// A paired phone with `caps`; its request headers, as if through the tunnel.
fn phone(caps: Caps) -> String {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    while pairing_store().is_none() {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pm-phone-compose-{}-{n}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = init_pairing_store(dir.join("pairing.json"));
    }
    let store = pairing_store().expect("pairing store");
    let mut guard = store.lock();
    let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), caps);
    let token = guard
        .pair_device(PairRequestBody { pairing_code: session.pairing_code, device_name: "upload test phone".into(), device_public_key: session.server_public_key })
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

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("pm-phone-uploads-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

fn day(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

#[test]
fn the_upload_route_needs_typing_and_the_result_route_needs_watching() {
    assert_eq!(route_need("POST", &["panes", "p1", "uploads"]), Need::Cap(Cap::Type));
    assert_eq!(route_need("GET", &["panes", "p1", "result"]), Need::Cap(Cap::Watch));
    // Other verbs on the same paths are not let through as reads.
    assert_eq!(route_need("DELETE", &["panes", "p1", "uploads"]), Need::Cap(Cap::Control));
}

#[test]
fn a_watch_only_device_is_refused_the_upload_route() {
    let watch_only = phone(Caps::none().with(Cap::Watch, true));
    assert_eq!(status(&watch_only, "POST", &["panes", "up-watch-1", "uploads"]), 403);
    let answer_only = phone(Caps::watch_and_answer());
    assert_eq!(status(&answer_only, "POST", &["panes", "up-watch-1", "uploads"]), 403);
    let typing = phone(Caps::all());
    assert_eq!(status(&typing, "POST", &["panes", "up-watch-1", "uploads"]), 200);
}

#[test]
fn a_switched_off_agent_and_a_watch_only_agent_refuse_the_upload_route() {
    let headers = phone(Caps::all());
    let off = "up-off-1";
    assert_eq!(status(&headers, "POST", &["panes", off, "uploads"]), 200, "before the switch");
    pane_rules::set(off, PaneRule { remote: false, level: Level::Full }).unwrap();
    assert_eq!(status(&headers, "POST", &["panes", off, "uploads"]), 403, "switched off");
    let watch = "up-watch-2";
    pane_rules::set(watch, PaneRule { remote: true, level: Level::Watch }).unwrap();
    assert_eq!(status(&headers, "POST", &["panes", watch, "uploads"]), 403, "watch only");
    pane_rules::set(watch, PaneRule { remote: true, level: Level::Answer }).unwrap();
    assert_eq!(status(&headers, "POST", &["panes", watch, "uploads"]), 403, "answer only");
    pane_rules::set(watch, PaneRule::default()).unwrap();
    assert_eq!(status(&headers, "POST", &["panes", watch, "uploads"]), 200, "back to the default");
    assert_eq!(status(&headers, "POST", &["panes", "up-other-3", "uploads"]), 200);
}

#[test]
fn the_result_route_is_refused_to_a_device_that_cannot_watch_and_to_a_switched_off_agent() {
    let blind = phone(Caps::none().with(Cap::Type, true));
    assert_eq!(status(&blind, "GET", &["panes", "res-1", "result"]), 403);
    let watching = phone(Caps::none().with(Cap::Watch, true));
    assert_eq!(status(&watching, "GET", &["panes", "res-1", "result"]), 200);
    pane_rules::set("res-off-1", PaneRule { remote: false, level: Level::Full }).unwrap();
    assert_eq!(status(&watching, "GET", &["panes", "res-off-1", "result"]), 403, "switched off");
}

#[test]
fn the_phone_file_routes_are_not_exposed_to_mcp_sessions() {
    let session = uuid::Uuid::new_v4().to_string();
    for (method, path) in [("POST", "/panes/some-pane/uploads"), ("GET", "/panes/some-pane/result")] {
        let result = crate::mcp_sessions::authorize(Some(&session), method, path, &serde_json::json!({}));
        assert!(result.is_err(), "{method} {path} must be refused for an MCP session");
    }
}

#[test]
fn only_the_upload_route_may_carry_a_body_over_8_mb() {
    use crate::bridge::http::{body_limit, MAX_BODY_BYTES, MAX_UPLOAD_BODY_BYTES};
    assert_eq!(body_limit("POST", "/panes/p1/uploads"), MAX_UPLOAD_BODY_BYTES);
    assert_eq!(body_limit("POST", "/bridge/panes/p1/uploads?x=1"), MAX_UPLOAD_BODY_BYTES);
    assert_eq!(body_limit("POST", "/panes/p1/messages"), MAX_BODY_BYTES);
    assert_eq!(body_limit("GET", "/panes/p1/uploads"), MAX_BODY_BYTES);
    assert_eq!(body_limit("POST", "/panes/p1/uploads/more"), MAX_BODY_BYTES);
    // 10 MB of file fits in the raised limit, and the limit is not unbounded.
    assert!(MAX_UPLOAD_BYTES / 3 * 4 + 8 <= MAX_UPLOAD_BODY_BYTES);
    assert!(MAX_UPLOAD_BODY_BYTES < 16 * 1024 * 1024);
}

#[test]
fn a_picture_is_saved_in_the_dated_folder_with_a_safe_name() {
    let root = temp_root("save");
    let saved = save_in(&root, day(2026, 11, 13), "../../evil name!.PNG", "image/png", &b64(&PNG)).unwrap();
    assert_eq!(saved.kind, AttachKind::Image);
    assert_eq!(saved.mime.as_deref(), Some("image/png"));
    assert_eq!(saved.size, PNG.len() as u64);
    assert!(saved.name.ends_with(".png") && !saved.name.contains(['/', '\\', ' ', '!']), "name {}", saved.name);
    let path = Path::new(&saved.path);
    assert!(path.is_file());
    assert!(path.starts_with(std::path::absolute(&root).unwrap().join("2026-11-13")), "{}", saved.path);
    assert_eq!(fs::read(path).unwrap(), PNG);
    assert!(is_inside(&root, &saved.path));
    // Two uploads of the same name never overwrite each other.
    let again = save_in(&root, day(2026, 11, 13), "../../evil name!.PNG", "image/png", &b64(&PNG)).unwrap();
    assert_ne!(again.path, saved.path);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn text_and_pdf_files_are_taken_and_the_kind_follows_the_type() {
    let root = temp_root("kinds");
    let text = save_in(&root, day(2026, 11, 13), "notes.md", "text/markdown", &b64(b"# hello")).unwrap();
    assert_eq!(text.kind, AttachKind::Text);
    assert_eq!(text.mime.as_deref(), Some("text/plain"));
    let pdf = save_in(&root, day(2026, 11, 13), "paper.pdf", "application/pdf", &b64(b"%PDF-1.7 ...")).unwrap();
    assert_eq!(pdf.kind, AttachKind::File);
    assert_eq!(pdf.mime.as_deref(), Some("application/pdf"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_bad_type_a_fake_picture_a_big_file_and_bad_data_are_refused_and_nothing_is_written() {
    let root = temp_root("refuse");
    let code = |result: Result<ChatAttachment, (u16, serde_json::Value)>| result.err().map(|(status, body)| (status, body["code"].as_str().unwrap_or("").to_string()));
    assert_eq!(code(save_in(&root, day(2026, 11, 13), "run.exe", "application/octet-stream", &b64(b"MZ..."))), Some((415, "UPLOAD_BAD_TYPE".into())));
    assert_eq!(code(save_in(&root, day(2026, 11, 13), "noext", "", &b64(b"hello"))), Some((415, "UPLOAD_BAD_TYPE".into())));
    assert_eq!(code(save_in(&root, day(2026, 11, 13), "photo.png", "image/png", &b64(b"this is text"))), Some((415, "UPLOAD_BAD_TYPE".into())));
    assert_eq!(code(save_in(&root, day(2026, 11, 13), "x.txt", "text/plain", &b64(&[b'a', 0, b'b']))), Some((415, "UPLOAD_BAD_TYPE".into())));
    assert_eq!(code(save_in(&root, day(2026, 11, 13), "x.txt", "text/plain", "!!!not base64!!!")), Some((400, "UPLOAD_BAD_DATA".into())));
    assert_eq!(code(save_in(&root, day(2026, 11, 13), "x.txt", "text/plain", "")), Some((400, "UPLOAD_BAD_DATA".into())));
    let eleven_mb = vec![b'a'; MAX_UPLOAD_BYTES + 1];
    assert_eq!(code(save_in(&root, day(2026, 11, 13), "big.txt", "text/plain", &b64(&eleven_mb))), Some((413, "UPLOAD_TOO_BIG".into())));
    // Exactly 10 MB is fine.
    let ten_mb = vec![b'a'; MAX_UPLOAD_BYTES];
    assert!(save_in(&root, day(2026, 11, 13), "ok.txt", "text/plain", &b64(&ten_mb)).is_ok());
    // Nothing but the one good file is on disk.
    assert_eq!(folder_size(&root), MAX_UPLOAD_BYTES as u64);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_folder_is_capped_as_a_whole() {
    let root = temp_root("full");
    let dir = root.join("2026-11-13");
    fs::create_dir_all(&dir).unwrap();
    let f = fs::File::create(dir.join("filler.bin")).unwrap();
    f.set_len(MAX_FOLDER_BYTES - 10).unwrap();
    let refused = save_in(&root, day(2026, 11, 13), "a.txt", "text/plain", &b64(b"this is more than ten bytes")).err().unwrap();
    assert_eq!(refused.0, 507);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn day_folders_older_than_seven_days_are_deleted_and_nothing_else() {
    let root = temp_root("clean");
    for name in ["2026-11-01", "2026-11-05", "2026-11-06", "2026-11-13", "not-a-date"] {
        fs::create_dir_all(root.join(name)).unwrap();
        fs::write(root.join(name).join("f.txt"), b"x").unwrap();
    }
    fs::write(root.join("loose.txt"), b"x").unwrap();
    let removed = clean_old(&root, day(2026, 11, 13));
    // 11-01 is 12 days old and 11-05 is 8 days old: gone. 11-06 is exactly 7 days old: kept.
    assert_eq!(removed, 2);
    assert!(!root.join("2026-11-01").exists() && !root.join("2026-11-05").exists());
    assert!(root.join("2026-11-06").exists() && root.join("2026-11-13").exists());
    assert!(root.join("not-a-date").exists() && root.join("loose.txt").exists());
    // A missing folder is not an error.
    assert_eq!(clean_old(&root.join("nope"), day(2026, 11, 13)), 0);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_message_may_carry_only_files_this_route_made() {
    let root = temp_root("ours");
    let saved = save_in(&root, day(2026, 11, 13), "a.png", "image/png", &b64(&PNG)).unwrap();
    assert!(is_inside(&root, &saved.path));
    let outside = std::env::temp_dir().join(format!("pm-phone-outside-{}.txt", std::process::id()));
    fs::write(&outside, b"secret").unwrap();
    assert!(!is_inside(&root, &outside.display().to_string()), "a file outside the folder");
    assert!(!is_inside(&root, &format!("{}/../{}", root.display(), outside.file_name().unwrap().to_string_lossy())), "a path with ..");
    assert!(!is_inside(&root, &root.display().to_string()), "the folder itself is not a file");
    assert!(!is_inside(&root, &root.join("2026-11-13").join("missing.png").display().to_string()));
    let _ = fs::remove_file(&outside);
    let _ = fs::remove_dir_all(&root);
}
