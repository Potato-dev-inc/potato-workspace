use super::client::valid_base;
use super::service::{AccountService, Parts};
use super::signin::{parse_link, PendingSignIn, SignInLink, PENDING_SECS};
use super::statement::{device_statement, revoke_statement, sha256_hex, sign_request, DEVICE_PREFIX, REQUEST_PREFIX, REVOKE_PREFIX};
use super::store::{SessionStore, StoredSession};
use crate::keys::crypto::{b64, new_signing_key, unb64};
use crate::secrets::MemoryBackend;
use ed25519_dalek::{Signature, Verifier};
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;

const TICKET: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const STATE: &str = "state-state-state-state-state-1234";
const ACCT: &str = "0b4f5c1e-2b3a-4a76-9c52-0d3f4a5b6c7d";

fn link_url(ticket: &str, state: &str, acct: &str) -> String {
    format!("potato-workspace://signin?ticket={ticket}&state={state}&acct={acct}")
}

// ---------- the deep link ----------

#[test]
fn a_well_formed_sign_in_link_is_read() {
    let link = parse_link(&link_url(TICKET, STATE, ACCT)).unwrap();
    assert_eq!(link, SignInLink { ticket: TICKET.into(), state: STATE.into(), account: ACCT.into() });
    // The OS may write the scheme in any case; keys may come in any order.
    let odd = format!("POTATO-WORKSPACE://SIGNIN?acct={ACCT}&state={STATE}&ticket={TICKET}");
    assert_eq!(parse_link(&odd), Some(link));
}

#[test]
fn every_other_link_is_dropped() {
    let good = link_url(TICKET, STATE, ACCT);
    let bad = [
        format!("potato-workspace://join/{TICKET}?w=team.example.com"),
        format!("potato-workspace://signin/extra?ticket={TICKET}&state={STATE}&acct={ACCT}"),
        format!("potato-workspace://settings?ticket={TICKET}&state={STATE}&acct={ACCT}"),
        format!("https://account.example.com/signin?ticket={TICKET}&state={STATE}&acct={ACCT}"),
        format!("{good}&extra=1"),
        format!("{good}#frag"),
        format!("{good}&ticket={TICKET}"),
        link_url(TICKET, STATE, "not-a-uuid"),
        link_url("short", STATE, ACCT),
        link_url(TICKET, "short", ACCT),
        link_url("bad ticket bad ticket bad ticket", STATE, ACCT),
        link_url(&"a".repeat(600), STATE, ACCT),
        format!("potato-workspace://signin?ticket={TICKET}&state={STATE}"),
        "potato-workspace://signin?".to_string(),
        String::new(),
        "\u{feff}".to_string() + &good,
    ];
    for url in bad {
        assert_eq!(parse_link(&url), None, "{url}");
    }
}

#[test]
fn a_link_finishes_only_the_sign_in_this_app_started() {
    let pending = PendingSignIn::default();
    let link = |state: &str| SignInLink { ticket: TICKET.into(), state: state.into(), account: ACCT.into() };
    // Nothing started: a link from a web page does nothing.
    assert!(pending.accept(&link(STATE), 100).is_none());
    let started = pending.start(100);
    // A wrong state is dropped and does not cancel the real sign-in.
    assert!(pending.accept(&link(STATE), 101).is_none());
    assert!(pending.is_waiting(101));
    // The right state is taken once.
    let taken = pending.accept(&link(started.state()), 102).expect("matching state");
    assert_eq!(taken.verifier(), started.verifier());
    assert!(!pending.is_waiting(102));
    assert!(pending.accept(&link(started.state()), 103).is_none(), "a link is single use");
}

#[test]
fn a_sign_in_that_waited_too_long_is_gone() {
    let pending = PendingSignIn::default();
    let started = pending.start(100);
    let link = SignInLink { ticket: TICKET.into(), state: started.state().into(), account: ACCT.into() };
    assert!(!pending.is_waiting(100 + PENDING_SECS + 1));
    assert!(pending.accept(&link, 100 + PENDING_SECS + 1).is_none());
}

#[test]
fn the_challenge_is_the_hash_of_the_verifier_and_the_start_page_carries_only_the_challenge() {
    let pending = PendingSignIn::default().start(1);
    let want = b64(&Sha256::digest(pending.verifier().as_bytes()));
    assert_eq!(pending.challenge(), want);
    assert_eq!(pending.challenge().len(), 43);
    let url = pending.start_url("http://127.0.0.1:8787/");
    assert!(url.starts_with("http://127.0.0.1:8787/v1/auth/start?challenge="));
    assert!(url.contains(&format!("state={}", pending.state())) && url.ends_with("&return=app"));
    assert!(!url.contains(pending.verifier()), "the verifier never leaves the app");
}

#[test]
fn the_server_address_is_https_or_this_pc() {
    assert_eq!(valid_base("https://account.example.com/").as_deref(), Some("https://account.example.com"));
    assert_eq!(valid_base("http://127.0.0.1:8787").as_deref(), Some("http://127.0.0.1:8787"));
    assert_eq!(valid_base("http://localhost:9").as_deref(), Some("http://localhost:9"));
    for bad in ["", "http://account.example.com", "ftp://127.0.0.1", "https://", "https://a.com/x", "https://u@a.com", "http://127.0.0.1.evil.com", "https://a.com?x=1"] {
        assert_eq!(valid_base(bad), None, "{bad}");
    }
}

// ---------- what the device signs ----------

fn verify(key: &ed25519_dalek::SigningKey, prefix: &str, text: &str, sig: &str) -> bool {
    let sig: [u8; 64] = unb64(sig).unwrap().try_into().unwrap();
    key.verifying_key().verify([prefix.as_bytes(), text.as_bytes()].concat().as_slice(), &Signature::from_bytes(&sig)).is_ok()
}

#[test]
fn the_device_statement_carries_the_key_and_is_signed_under_its_own_prefix() {
    let key = new_signing_key();
    let s = device_statement(&key, ACCT, "dev-1", "pc", "Desk");
    let v: Value = serde_json::from_str(&s.statement).unwrap();
    assert_eq!(v["v"], 1);
    assert_eq!(v["account_id"], ACCT);
    assert_eq!(v["kind"], "pc");
    assert_eq!(v["device_pub"], b64(key.verifying_key().as_bytes()));
    assert!(verify(&key, DEVICE_PREFIX, &s.statement, &s.signature));
    assert!(!verify(&key, REVOKE_PREFIX, &s.statement, &s.signature), "a statement is not valid under another prefix");
    assert!(!verify(&new_signing_key(), DEVICE_PREFIX, &s.statement, &s.signature));
}

#[test]
fn a_revocation_names_who_signed_whom_out() {
    let key = new_signing_key();
    let s = revoke_statement(&key, "not_me", "target", "me", 1_700_000_000);
    let v: Value = serde_json::from_str(&s.statement).unwrap();
    assert_eq!((v["action"].as_str(), v["target_device_id"].as_str(), v["by_device_id"].as_str(), v["at"].as_u64()), (Some("not_me"), Some("target"), Some("me"), Some(1_700_000_000)));
    assert!(verify(&key, REVOKE_PREFIX, &s.statement, &s.signature));
}

#[test]
fn a_request_signature_covers_method_path_time_nonce_and_body() {
    let key = new_signing_key();
    let body = br#"{"a":1}"#;
    let auth = sign_request(&key, "POST", "/v1/x?y=1", 1_700_000_000, body);
    let text = format!("POST\n/v1/x?y=1\n{}\n{}\n{}", auth.timestamp, auth.nonce, sha256_hex(body));
    assert!(verify(&key, REQUEST_PREFIX, &text, &auth.signature));
    let other = format!("POST\n/v1/other\n{}\n{}\n{}", auth.timestamp, auth.nonce, sha256_hex(body));
    assert!(!verify(&key, REQUEST_PREFIX, &other, &auth.signature));
    assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_ne!(auth.nonce, sign_request(&key, "POST", "/v1/x?y=1", 1_700_000_000, body).nonce, "a nonce is never reused");
}

// ---------- where the session is kept ----------

fn session(token: &str) -> StoredSession {
    StoredSession { token: token.into(), device_id: "d".into(), account_id: ACCT.into(), display_name: "Ren".into(), provider: "password".into(), server: "http://127.0.0.1:1".into() }
}

#[test]
fn the_session_lives_in_the_credential_store_and_is_forgotten_on_sign_out() {
    let backend = Arc::new(MemoryBackend::new());
    let store = SessionStore::with_backend(backend.clone(), "p1");
    assert!(store.load().is_none());
    store.save(&session("tok-1")).unwrap();
    assert_eq!(store.load().unwrap().token, "tok-1");
    // Another profile is another device: it does not see it.
    assert!(SessionStore::with_backend(backend, "p2").load().is_none());
    store.clear();
    assert!(store.load().is_none());
}

#[test]
fn a_store_that_cannot_keep_the_session_is_an_error_not_a_sign_in() {
    let store = SessionStore::with_backend(Arc::new(MemoryBackend::unavailable()), "p1");
    assert!(store.save(&session("tok")).is_err());
    assert!(store.load().is_none());
}

#[test]
fn the_device_id_is_made_once_and_survives_sign_out() {
    let store = SessionStore::with_backend(Arc::new(MemoryBackend::new()), "p1");
    let id = store.device_id().unwrap();
    assert!(uuid::Uuid::parse_str(&id).is_ok());
    store.save(&session("t")).unwrap();
    store.clear();
    assert_eq!(store.device_id().unwrap(), id);
}

#[test]
fn the_token_never_shows_in_debug_text() {
    let text = format!("{:?}", session("super-secret-token"));
    assert!(!text.contains("super-secret-token"));
}

// ---------- the whole flow against a server on this PC ----------

#[derive(Default)]
struct Seen {
    lines: Vec<String>,
    redeemed_device_pub: Mutex<Option<String>>,
}

/// A tiny account server on loopback: answers `n` requests, checks what a real server checks, records what it saw.
fn fake_server(n: usize, challenge: Arc<Mutex<String>>, key_pub: Arc<Mutex<Option<ed25519_dalek::VerifyingKey>>>, seen: Arc<Mutex<Seen>>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        for _ in 0..n {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head_end, len) = loop {
                let got = sock.read(&mut chunk).unwrap();
                buf.extend_from_slice(&chunk[..got]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                    let len = head.lines().find_map(|l| l.strip_prefix("content-length: ")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                    if buf.len() >= pos + 4 + len {
                        break (pos + 4, len);
                    }
                }
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
            let body = buf[head_end..head_end + len].to_vec();
            let mut lines = head.lines();
            let first = lines.next().unwrap().to_string();
            let header = |name: &str| lines.clone().find_map(|l| l.to_ascii_lowercase().strip_prefix(&format!("{name}: ")).map(|_| l.split_once(": ").unwrap().1.to_string()));
            let (method, path) = {
                let mut p = first.split(' ');
                (p.next().unwrap().to_string(), p.next().unwrap().to_string())
            };
            seen.lock().lines.push(format!("{method} {path}"));
            let (status, reply) = if method == "POST" && path == "/v1/session" {
                let b: Value = serde_json::from_slice(&body).unwrap();
                let verifier = b["verifier"].as_str().unwrap();
                let ok_pkce = b64(&Sha256::digest(verifier.as_bytes())) == *challenge.lock() && b["ticket"] == TICKET;
                let stmt: Value = serde_json::from_str(b["statement"].as_str().unwrap()).unwrap();
                let pub_bytes: [u8; 32] = unb64(stmt["device_pub"].as_str().unwrap()).unwrap().try_into().unwrap();
                let vk = ed25519_dalek::VerifyingKey::from_bytes(&pub_bytes).unwrap();
                let sig: [u8; 64] = unb64(b["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
                let signed = vk.verify([DEVICE_PREFIX.as_bytes(), b["statement"].as_str().unwrap().as_bytes()].concat().as_slice(), &Signature::from_bytes(&sig)).is_ok();
                *key_pub.lock() = Some(vk);
                *seen.lock().redeemed_device_pub.lock() = Some(stmt["device_pub"].as_str().unwrap().to_string());
                if ok_pkce && signed && stmt["account_id"] == ACCT {
                    (200, json!({ "token": "tok-secret", "account": { "id": ACCT, "display_name": "Test Person", "provider": "password" }, "device": { "id": stmt["device_id"] } }))
                } else {
                    (401, json!({ "error": "invalid_ticket" }))
                }
            } else {
                // Every later call must be signed by the key from the sign-in.
                let ts = header("x-timestamp").unwrap();
                let nonce = header("x-nonce").unwrap();
                let sig = header("x-signature").unwrap();
                let text = format!("{method}\n{path}\n{ts}\n{nonce}\n{}", sha256_hex(&body));
                let vk = key_pub.lock().unwrap();
                let sig: [u8; 64] = unb64(&sig).unwrap().try_into().unwrap();
                let good = vk.verify([REQUEST_PREFIX.as_bytes(), text.as_bytes()].concat().as_slice(), &Signature::from_bytes(&sig)).is_ok() && header("authorization").as_deref() == Some("Bearer tok-secret");
                if !good {
                    (401, json!({ "error": "unauthorized" }))
                } else if path == "/v1/devices" {
                    (200, json!({ "devices": [
                        { "id": "11111111-1111-4111-8111-111111111111", "kind": "pc", "name": "This one", "created_at": 10, "last_seen_at": 20, "online": true, "revoked_at": null, "not_me": false, "self": true },
                        { "id": "22222222-2222-4222-8222-222222222222", "kind": "phone", "name": "Phone", "created_at": 30, "last_seen_at": 40, "online": false, "revoked_at": null, "not_me": false, "self": false, "device_pub": "x" },
                        { "id": "not-an-id", "kind": "pc", "name": "junk" },
                    ] }))
                } else if path.ends_with("/sign-out") || path.ends_with("/not-me") {
                    let b: Value = serde_json::from_slice(&body).unwrap();
                    let stmt = b["statement"].as_str().unwrap();
                    let sig: [u8; 64] = unb64(b["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
                    let ok = vk.verify([REVOKE_PREFIX.as_bytes(), stmt.as_bytes()].concat().as_slice(), &Signature::from_bytes(&sig)).is_ok();
                    (if ok { 200 } else { 400 }, json!({ "ok": ok }))
                } else {
                    (204, Value::Null)
                }
            };
            let text = if reply.is_null() { String::new() } else { reply.to_string() };
            let status_text = match status { 200 => "OK", 204 => "No Content", 400 => "Bad Request", _ => "Unauthorized" };
            let resp = format!("HTTP/1.1 {status} {status_text}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
            sock.write_all(resp.as_bytes()).unwrap();
        }
    });
    (base, handle)
}

fn service(base: &str, scope: &str, backend: Arc<MemoryBackend>, opened: Arc<Mutex<Vec<String>>>) -> AccountService {
    let key = new_signing_key();
    let base = base.to_string();
    AccountService::new(Parts {
        store: SessionStore::with_backend(backend, scope),
        key: Box::new(move || Ok(key.clone())),
        base: Box::new(move || Some(base.clone())),
        name: Box::new(|| "Test PC".into()),
        open: Box::new(move |url| {
            opened.lock().push(url.to_string());
            Ok(())
        }),
    })
}

#[test]
fn sign_in_list_sign_out_against_a_local_server() {
    let challenge = Arc::new(Mutex::new(String::new()));
    let key_pub = Arc::new(Mutex::new(None));
    let seen = Arc::new(Mutex::new(Seen::default()));
    // redeem, devices, sign-out of another device (+ the list again), sign-out here (leave the address book, then sign this device out)
    let (base, server) = fake_server(6, challenge.clone(), key_pub, seen.clone());
    let opened = Arc::new(Mutex::new(Vec::new()));
    let svc = service(&base, "p1", Arc::new(MemoryBackend::new()), opened.clone());

    assert!(svc.view().configured && !svc.view().signed_in);
    let waiting = svc.start_sign_in().unwrap();
    assert!(waiting.waiting);
    let url = opened.lock()[0].clone();
    let q = |name: &str| url.split(&['?', '&'][..]).find_map(|p| p.strip_prefix(&format!("{name}="))).unwrap().to_string();
    *challenge.lock() = q("challenge");
    let state = q("state");

    // A link with the wrong state is ignored; the real sign-in still waits.
    let wrong = SignInLink { ticket: TICKET.into(), state: "x".repeat(32), account: ACCT.into() };
    assert!(!svc.finish_sign_in(&wrong));
    assert!(svc.view().waiting && !svc.view().signed_in);

    let link = parse_link(&link_url(TICKET, &state, ACCT)).unwrap();
    assert!(svc.finish_sign_in(&link));
    let view = svc.view();
    assert!(view.signed_in && !view.waiting && view.message.is_none());
    assert_eq!(view.account.as_ref().unwrap().display_name, "Test Person");
    let serialized = serde_json::to_string(&view).unwrap();
    assert!(!serialized.contains("tok-secret"), "the window never gets the token");

    let list = svc.devices().unwrap();
    assert!(list.signed_in);
    assert_eq!(list.devices.len(), 2, "a row without a real id is dropped");
    assert!(list.devices[0].is_this && list.devices[0].online);
    assert_eq!(list.devices[1].kind, "phone");

    let after = svc.revoke("22222222-2222-4222-8222-222222222222", "sign_out").unwrap();
    assert!(after.signed_in && after.devices.len() == 2);
    assert!(svc.revoke("not-an-id", "sign_out").is_err());
    assert!(svc.revoke("22222222-2222-4222-8222-222222222222", "delete_all").is_err());

    let me = svc.view().device_id.unwrap();
    assert!(!svc.sign_out_here().signed_in);
    server.join().unwrap();
    let lines = seen.lock().lines.clone();
    assert_eq!(
        lines,
        vec![
            "POST /v1/session".to_string(),
            "GET /v1/devices".into(),
            "POST /v1/devices/22222222-2222-4222-8222-222222222222/sign-out".into(),
            "GET /v1/devices".into(),
            // Signing out leaves the address book first (no link id, no relay), then signs this very device out.
            "PATCH /v1/devices/self".into(),
            format!("POST /v1/devices/{me}/sign-out"),
        ]
    );
}

#[test]
fn a_session_from_another_server_is_not_used() {
    let backend = Arc::new(MemoryBackend::new());
    SessionStore::with_backend(backend.clone(), "p1").save(&session("tok")).unwrap();
    let svc = service("http://127.0.0.1:9", "p1", backend, Arc::new(Mutex::new(Vec::new())));
    assert!(!svc.view().signed_in, "the stored session belongs to http://127.0.0.1:1");
    assert!(svc.revoke("22222222-2222-4222-8222-222222222222", "sign_out").is_err());
}

#[test]
fn a_rejected_ticket_signs_nobody_in_and_says_so_plainly() {
    let challenge = Arc::new(Mutex::new("not-the-challenge".to_string()));
    let (base, server) = fake_server(1, challenge, Arc::new(Mutex::new(None)), Arc::new(Mutex::new(Seen::default())));
    let opened = Arc::new(Mutex::new(Vec::new()));
    let svc = service(&base, "p1", Arc::new(MemoryBackend::new()), opened.clone());
    svc.start_sign_in().unwrap();
    let url = opened.lock()[0].clone();
    let state = url.split("state=").nth(1).unwrap().split('&').next().unwrap().to_string();
    assert!(svc.finish_sign_in(&parse_link(&link_url(TICKET, &state, ACCT)).unwrap()));
    server.join().unwrap();
    let view = svc.view();
    assert!(!view.signed_in);
    assert_eq!(view.message.as_deref(), Some("That sign-in did not work. Start again."));
}

#[test]
fn a_session_the_server_refuses_is_forgotten_here_too() {
    let challenge = Arc::new(Mutex::new(String::new()));
    let (base, server) = fake_server(2, challenge.clone(), Arc::new(Mutex::new(None)), Arc::new(Mutex::new(Seen::default())));
    let backend = Arc::new(MemoryBackend::new());
    let opened = Arc::new(Mutex::new(Vec::new()));
    let signer = service(&base, "p1", backend.clone(), opened.clone());
    signer.start_sign_in().unwrap();
    let url = opened.lock()[0].clone();
    *challenge.lock() = url.split("challenge=").nth(1).unwrap().split('&').next().unwrap().to_string();
    let state = url.split("state=").nth(1).unwrap().split('&').next().unwrap().to_string();
    assert!(signer.finish_sign_in(&parse_link(&link_url(TICKET, &state, ACCT)).unwrap()));
    assert!(signer.view().signed_in);
    // The same store, but a key that is not the one the server knows (a copied token without the key): refused.
    let thief = service(&base, "p1", backend, Arc::new(Mutex::new(Vec::new())));
    let reply = thief.devices().unwrap();
    server.join().unwrap();
    assert!(!reply.signed_in);
    assert!(!thief.view().signed_in, "the refused session is removed");
    assert_eq!(thief.view().message.as_deref(), Some("You were signed out. Sign in again."));
}

// ---------- the link as the OS and the url crate hand it over ----------

fn server_link() -> (String, String, String, String) {
    // Built like account/server/src/auth.ts: ticket b64u of 32 bytes, state = the app's own state, acct = a uuid,
    // each through encodeURIComponent (a no-op for url-safe base64 and a uuid).
    let ticket = b64(&crate::keys::crypto::random_bytes::<32>());
    let pending = PendingSignIn::default().start(0);
    let state = pending.state().to_string();
    let acct = uuid::Uuid::new_v4().to_string();
    (format!("potato-workspace://signin?ticket={ticket}&state={state}&acct={acct}"), ticket, state, acct)
}

#[test]
fn the_exact_server_link_survives_the_url_crate_and_the_single_instance_argv() {
    for _ in 0..50 {
        let (link, ticket, state, acct) = server_link();
        let want = SignInLink { ticket, state, account: acct };
        // deep-link plugin: Url::parse(arg) then `.to_string()` (both the on_open_url path and the argv path).
        let round = url::Url::parse(&link).unwrap().to_string();
        assert_eq!(parse_link(&link), Some(want.clone()), "{link}");
        assert_eq!(parse_link(&round), Some(want.clone()), "{round}");
        // Forms a browser or the OS may hand over.
        let (head, query) = link.split_once('?').unwrap();
        for form in [
            format!("{head}/?{query}"),
            format!("{link}/"),
            format!("{head}/?{query}/"),
            format!("\"{link}\""),
            link.replacen("potato-workspace://signin", "POTATO-WORKSPACE://SIGNIN", 1),
        ] {
            assert_eq!(parse_link(&form), Some(want.clone()), "{form}");
            // (a quoted argv value is not a URL for the url crate; the app reads it straight)
            if let Ok(url) = url::Url::parse(&form) {
                assert_eq!(parse_link(&url.to_string()), Some(want.clone()), "{url}");
            }
        }
    }
}

#[test]
fn percent_encoded_values_are_decoded_and_still_checked() {
    // encodeURIComponent leaves url-safe base64 alone, but a proxy may encode '-' and '_'.
    let enc = |s: &str| s.replace('-', "%2D").replace('_', "%5F");
    let link = link_url(&enc(TICKET), &enc(STATE), ACCT);
    assert_eq!(parse_link(&link), Some(SignInLink { ticket: TICKET.into(), state: STATE.into(), account: ACCT.into() }));
    // An escape that decodes to a bad character, a broken escape and a decoded slash are refused.
    for t in ["abcdefghijklmnop%2Fqrstuvwxyz", "abcdefghijklmnop%2", "abcdefghijklmnop%ZZqrst", "abcdefghijklmnop%00qrst"] {
        assert_eq!(parse_link(&link_url(t, STATE, ACCT)), None, "{t}");
    }
}

#[test]
fn a_refused_sign_in_link_says_why_without_values() {
    use super::signin::{check_link, Refused};
    let good = link_url(TICKET, STATE, ACCT);
    assert_eq!(check_link("potato-workspace://join/ABC?w=x").unwrap_err(), Refused::NotSignIn);
    assert_eq!(check_link(&format!("{good}&x=1")).unwrap_err(), Refused::Shape);
    assert_eq!(check_link(&format!("{good}#f")).unwrap_err(), Refused::Value);
    assert_eq!(check_link(&link_url("short", STATE, ACCT)).unwrap_err(), Refused::Value);
    assert_eq!(check_link(&"potato-workspace://signin?".repeat(30)).unwrap_err(), Refused::TooLong);
    assert!(!Refused::Value.why().contains(TICKET));
}

// ---------- my PCs in the address book ----------

mod book {
    use super::*;
    use crate::account::directory::{pc_rows, valid_relay_hint, NOT_PUBLISHED, STALE_SECS};
    use crate::account::statement::{device_statement_published, device_statement_with_node, verify_device_statement};

    const D1: &str = "11111111-1111-4111-8111-111111111111";
    const NOW: u64 = 5_000_000;

    /// A row as the server's `GET /v1/devices` gives it, for a device with this key.
    fn row(key: &ed25519_dalek::SigningKey, id: &str, name: &str, node: Option<&str>) -> Value {
        let s = match node {
            Some(n) if n != NOT_PUBLISHED => device_statement_published(key, ACCT, id, name, n, Some("https://relay.example.com"), NOW - 10),
            _ => device_statement_with_node(key, ACCT, id, "pc", name, node),
        };
        json!({
            "id": id, "kind": "pc", "name": name, "device_pub": b64(key.verifying_key().as_bytes()), "node_id": node,
            "node_binding": node.map(|_| "{\"node\":\"x\"}"), "home_relay": "https://evil.example.com", "created_at": NOW - 100, "last_seen_at": NOW - 10,
            "online": true, "revoked_at": null, "not_me": false, "self": false, "statement": s.statement, "statement_sig": s.signature,
        })
    }

    fn rows_of(list: Vec<Value>) -> Vec<crate::account::directory::PcRow> {
        pc_rows(&json!({ "devices": list }), ACCT, NOW)
    }

    #[test]
    fn a_statement_with_a_link_id_verifies_only_under_its_own_key_and_text() {
        let (key, other) = (new_signing_key(), new_signing_key());
        let node = "ab".repeat(32);
        let s = device_statement_with_node(&key, ACCT, D1, "pc", "Desk", Some(&node));
        let v: Value = serde_json::from_str(&s.statement).unwrap();
        assert_eq!(v["node_id"], node.as_str());
        let public = b64(key.verifying_key().as_bytes());
        assert!(verify_device_statement(&public, &s.statement, &s.signature));
        assert!(!verify_device_statement(&b64(other.verifying_key().as_bytes()), &s.statement, &s.signature), "another key");
        assert!(!verify_device_statement(&public, &s.statement.replace(&node, &"cd".repeat(32)), &s.signature), "changed text");
        assert!(!verify_device_statement(&public, &s.statement, "x"), "not a signature");
        // A plain statement has no link id at all.
        let plain: Value = serde_json::from_str(&device_statement(&key, ACCT, D1, "pc", "Desk").statement).unwrap();
        assert!(plain.get("node_id").is_none());
    }

    #[test]
    fn a_row_is_listed_only_when_its_own_statement_checks_out() {
        let (key, thief) = (new_signing_key(), new_signing_key());
        let node = "ab".repeat(32);
        let good = row(&key, D1, "Desk", Some(&node));
        let listed = rows_of(vec![good.clone()]);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].name.as_str(), listed[0].node.as_deref()), ("Desk", Some(node.as_str())));
        assert_eq!(listed[0].relay.as_deref(), Some("https://relay.example.com"));

        // The server changes the link id after the PC signed it.
        let mut moved = good.clone();
        moved["statement"] = json!(good["statement"].as_str().unwrap().replace(&node, &"cd".repeat(32)));
        assert!(rows_of(vec![moved]).is_empty());
        // The server changes the name column: the list uses the signed name, not the column.
        let mut renamed = good.clone();
        renamed["name"] = json!("Bank");
        assert_eq!(rows_of(vec![renamed])[0].name, "Desk");
        // The server puts another key on the row.
        let mut other_key = good.clone();
        other_key["device_pub"] = json!(b64(thief.verifying_key().as_bytes()));
        assert!(rows_of(vec![other_key]).is_empty());
        // A row for another device id, another account, or a phone.
        let mut wrong_id = good.clone();
        wrong_id["id"] = json!("22222222-2222-4222-8222-222222222222");
        assert!(rows_of(vec![wrong_id]).is_empty());
        let foreign = {
            let s = device_statement_with_node(&key, "99999999-9999-4999-8999-999999999999", D1, "pc", "Desk", Some(&node));
            let mut r = good.clone();
            r["statement"] = json!(s.statement);
            r["statement_sig"] = json!(s.signature);
            r
        };
        assert!(rows_of(vec![foreign]).is_empty());
        let mut phone = good.clone();
        phone["kind"] = json!("phone");
        assert!(rows_of(vec![phone]).is_empty());
        // Junk where a statement should be.
        let mut junk = good.clone();
        junk["statement"] = json!("not json");
        assert!(rows_of(vec![junk]).is_empty());
    }

    #[test]
    fn signed_out_and_stale_rows_disappear_and_this_pc_is_never_stale() {
        let key = new_signing_key();
        let mut gone = row(&key, D1, "Desk", None);
        gone["revoked_at"] = json!(NOW - 5);
        assert!(rows_of(vec![gone]).is_empty());
        let mut stale = row(&key, D1, "Desk", None);
        stale["last_seen_at"] = json!(NOW - STALE_SECS - 1);
        assert!(rows_of(vec![stale.clone()]).is_empty());
        stale["self"] = json!(true);
        assert_eq!(rows_of(vec![stale]).len(), 1);
    }

    #[test]
    fn a_pc_that_took_the_tick_off_lists_with_no_link_id_and_a_link_id_without_a_record_is_not_openable() {
        let key = new_signing_key();
        // The "not published" word is never a link id.
        let off = rows_of(vec![row(&key, D1, "Desk", Some(NOT_PUBLISHED))]);
        assert!(off[0].node.is_none() && off[0].binding.is_none() && off[0].relay.is_none());
        // A real link id but no node record next to it.
        let mut bare = row(&key, D1, "Desk", Some(&"ab".repeat(32)));
        bare["node_binding"] = Value::Null;
        let listed = rows_of(vec![bare]);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].node.is_none(), "nothing to check the link id against");
        // A link id that is not 64 hex characters.
        assert!(rows_of(vec![row(&key, D1, "Desk", Some("not-hex"))])[0].node.is_none());
    }

    #[test]
    fn the_relay_comes_from_the_signed_statement_and_an_old_or_future_statement_names_no_link_id() {
        let key = new_signing_key();
        let node = "ab".repeat(32);
        let signed_at = |at: u64| {
            let s = device_statement_published(&key, ACCT, D1, "Desk", &node, Some("https://relay.example.com"), at);
            let mut r = row(&key, D1, "Desk", None);
            r["statement"] = json!(s.statement);
            r["statement_sig"] = json!(s.signature);
            r["node_binding"] = json!("{\"node\":\"x\"}");
            r["home_relay"] = json!("https://evil.example.com");
            rows_of(vec![r])
        };
        let fresh = signed_at(NOW - 30);
        assert_eq!(fresh[0].relay.as_deref(), Some("https://relay.example.com"), "never the account's own column");
        assert_eq!(fresh[0].node.as_deref(), Some(node.as_str()));
        // Older than the window (the PC says again every minute while it is open), or from the future: not a place to knock.
        assert!(signed_at(NOW - 3600)[0].node.is_none());
        assert!(signed_at(NOW + 3600)[0].node.is_none());
        // A statement of a PC that never said when (an older app) names no link id either.
        let mut old = row(&key, D1, "Desk", None);
        let s = device_statement_with_node(&key, ACCT, D1, "pc", "Desk", Some(&node));
        old["statement"] = json!(s.statement);
        old["statement_sig"] = json!(s.signature);
        old["node_binding"] = json!("{\"node\":\"x\"}");
        assert!(rows_of(vec![old])[0].node.is_none());
    }

    #[test]
    fn a_relay_hint_is_a_plain_https_address_or_nothing() {
        for ok in ["https://relay.example.com", "https://euw1-1.relay.n0.iroh.iroh.link./", "https://relay.example.com:7443/path"] {
            assert!(valid_relay_hint(ok).is_some(), "{ok}");
        }
        for bad in ["", "http://relay.example.com", "https://", "https://user@relay.example.com", "https://a b.example.com", r"https://evil.example.com\@good.com", "javascript:alert(1)", "https://x.com/\u{7}", &format!("https://{}.com", "a".repeat(300))] {
            assert!(valid_relay_hint(bad).is_none(), "{bad}");
        }
    }
}
