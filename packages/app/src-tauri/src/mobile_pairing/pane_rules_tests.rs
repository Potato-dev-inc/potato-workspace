use crate::mobile_pairing::pane_rules;
use super::*;
use crate::mobile_pairing::{authorize_caller, init_pairing_store, pairing_store, Cap, Caps, PairRequestBody};

/// A paired phone with `caps`; returns its request headers (as if through the tunnel).
fn phone(caps: Caps) -> String {
    // Tests run side by side and the first store set wins: every call tries its own folder until one is set, so two
    // tests never read one half-written file (same pattern as the phone_control tests).
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    while pairing_store().is_none() {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pm-pane-rules-{}-{n}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = init_pairing_store(dir.join("pairing.json"));
    }
    let store = pairing_store().expect("pairing store");
    let mut guard = store.lock();
    let session = guard.create_pairing_session_with_caps("https://example.invalid".into(), caps);
    let token = guard
        .pair_device(PairRequestBody {
            pairing_code: session.pairing_code,
            device_name: "rule test phone".into(),
            device_public_key: session.server_public_key,
        })
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

fn set(pane: &str, remote: bool, level: Level) {
    pane_rules::set(pane, PaneRule { remote, level }).unwrap();
}

const ANSWER: [&str; 5] = ["opencode", "permissions", "x", "reply", ""];

fn answer_route(pane: &str) -> Vec<&str> {
    let mut route = vec!["panes", pane];
    route.extend_from_slice(&ANSWER[..4]);
    route
}

#[test]
fn a_switched_off_agent_refuses_read_answer_and_input_from_a_phone() {
    let headers = phone(Caps::all());
    let pane = "rule-off-1";
    // Before: the phone does all three.
    assert_eq!(status(&headers, "GET", &["panes", pane, "chat"]), 200);
    assert_eq!(status(&headers, "POST", &answer_route(pane)), 200);
    assert_eq!(status(&headers, "POST", &["panes", pane, "input"]), 200);

    set(pane, false, Level::Full);
    assert_eq!(status(&headers, "GET", &["panes", pane, "chat"]), 403, "read");
    assert_eq!(status(&headers, "GET", &["panes", pane, "messages"]), 403, "read messages");
    assert_eq!(status(&headers, "POST", &answer_route(pane)), 403, "answer");
    assert_eq!(status(&headers, "POST", &["panes", pane, "input"]), 403, "input");
    assert_eq!(status(&headers, "POST", &["panes", pane, "key"]), 403, "keys");
    assert_eq!(status(&headers, "POST", &["panes", pane, "close"]), 403, "control");
    // The refusal names the reason.
    let (_, body) = authorize_caller(&headers, true, &["panes", pane, "chat"], "GET").unwrap_err();
    assert_eq!(body["code"], "PANE_REMOTE_OFF");

    // Another agent is not touched, and the list (its name) still works.
    assert_eq!(status(&headers, "GET", &["panes", "rule-other", "chat"]), 200);
    assert_eq!(status(&headers, "GET", &["panes"]), 200);
    // Switched back on: reachable again.
    set(pane, true, Level::Full);
    assert_eq!(status(&headers, "GET", &["panes", pane, "chat"]), 200);
}

#[test]
fn the_level_for_an_agent_is_capped_by_the_phones_own_level() {
    let pane = "rule-level-1";
    // A full phone on an agent set to Watch can only watch.
    let full = phone(Caps::all());
    set(pane, true, Level::Watch);
    assert_eq!(status(&full, "GET", &["panes", pane, "chat"]), 200);
    assert_eq!(status(&full, "POST", &answer_route(pane)), 403);
    assert_eq!(status(&full, "POST", &["panes", pane, "input"]), 403);
    let (_, body) = authorize_caller(&full, true, &["panes", pane, "input"], "POST").unwrap_err();
    assert_eq!(body["code"], "PANE_LEVEL");

    // Watch and answer: no typing.
    set(pane, true, Level::Answer);
    assert_eq!(status(&full, "POST", &answer_route(pane)), 200);
    assert_eq!(status(&full, "POST", &["panes", pane, "input"]), 403);

    // A watch-only phone is never raised by a Full agent.
    let watcher = phone(Caps::none().with(Cap::Watch, true));
    set(pane, true, Level::Full);
    assert_eq!(status(&watcher, "GET", &["panes", pane, "chat"]), 200);
    assert_eq!(status(&watcher, "POST", &["panes", pane, "input"]), 403);
    assert_eq!(status(&watcher, "POST", &answer_route(pane)), 403);
}

#[test]
fn the_local_app_is_never_limited_by_an_agents_rule() {
    set("rule-local-1", false, Level::Watch);
    assert!(authorize_caller("", true, &["panes", "rule-local-1", "input"], "POST").is_ok());
    assert!(crate::mobile_pairing::caller_may_on("", true, Cap::Type, Some("rule-local-1")));
}

#[test]
fn a_phones_socket_frames_follow_the_agents_rule_too() {
    let headers = phone(Caps::all());
    set("rule-ws-1", false, Level::Full);
    assert!(!crate::mobile_pairing::caller_may_on(&headers, true, Cap::Type, Some("rule-ws-1")));
    assert!(crate::mobile_pairing::caller_may_on(&headers, true, Cap::Type, Some("rule-ws-other")));
}

#[test]
fn the_pane_a_route_names_leaves_out_the_list_and_the_wait_routes() {
    assert_eq!(pane_of_route(&["panes", "p1", "chat"]), Some("p1"));
    assert_eq!(pane_of_route(&["panes", "p1"]), Some("p1"));
    assert_eq!(pane_of_route(&["panes"]), None);
    assert_eq!(pane_of_route(&["panes", "wait", "model"]), None);
    assert_eq!(pane_of_route(&["questions", "q1", "answer"]), None);
}

#[test]
fn a_switched_off_agents_stream_content_is_hidden_but_its_name_and_status_stay() {
    set("rule-ev-1", false, Level::Full);
    let ev = |name: &str, pane: &str| format!("event: {name}\ndata: {{\"pane_id\":\"{pane}\",\"b64\":\"eA==\"}}\n\n");
    assert!(pane_rules::hides_event(&ev("terminal", "rule-ev-1")));
    assert!(pane_rules::hides_event(&ev("operation", "rule-ev-1")));
    assert!(!pane_rules::hides_event(&ev("terminal", "rule-ev-2")));
    assert!(!pane_rules::hides_event(&ev("pane-status", "rule-ev-1")));
    assert!(!pane_rules::hides_event("event: panes\ndata: [{\"id\":\"rule-ev-1\"}]\n\n"));
    // Through the phone's own viewer the hidden event never arrives, the other one does.
    let headers = phone(Caps::all());
    let token = crate::mobile_pairing::bearer_token(&headers).unwrap();
    let id = pairing_store().unwrap().lock().device_id_for_token(&token).unwrap();
    let viewer = crate::mobile_pairing::Viewer::Device(id);
    assert_eq!(viewer.view(&ev("terminal", "rule-ev-1")), Some(None));
    assert!(matches!(viewer.view(&ev("terminal", "rule-ev-2")), Some(Some(_))));
}

#[test]
fn rules_that_equal_the_default_are_not_stored_and_a_file_round_trips() {
    let mut rules = PaneRules::default();
    rules.set("a", PaneRule::default()).unwrap();
    assert!(rules.rules.is_empty());
    rules.set("a", PaneRule { remote: false, level: Level::Answer }).unwrap();
    let dir = std::env::temp_dir().join(format!("pm-pane-rules-file-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pane-remote.json");
    rules.save(&path).unwrap();
    let back = PaneRules::load(&path);
    assert_eq!(back.rule("a"), PaneRule { remote: false, level: Level::Answer });
    assert_eq!(back.rule("b"), PaneRule::default());
    assert!(back.refuses("a", Cap::Watch));
    assert!(!back.refuses("b", Cap::Type));
    // A broken file means "no rules", never a crash.
    std::fs::write(&path, "{nope").unwrap();
    assert!(PaneRules::load(&path).rules.is_empty());
}

#[test]
fn an_empty_or_huge_pane_id_is_refused() {
    let mut rules = PaneRules::default();
    assert!(rules.set("", PaneRule { remote: false, ..PaneRule::default() }).is_err());
    assert!(rules.set(&"x".repeat(300), PaneRule { remote: false, ..PaneRule::default() }).is_err());
    assert!(Level::parse("root").is_err());
}

fn watch() -> PaneRule {
    PaneRule { remote: true, level: Level::Watch }
}

#[test]
fn a_grant_ends_at_its_time_even_with_no_timer_running() {
    let mut rules = PaneRules::default();
    rules.set("p", watch()).unwrap();
    rules.grant("p", watch(), 1_000).unwrap();
    // While it runs the agent is open; at the end time a plain read already sees the old rule.
    assert_eq!(rules.rule_at("p", 999), PaneRule::default());
    assert!(!rules.refuses_at("p", Cap::Type, 999));
    assert_eq!(rules.rule_at("p", 1_000), watch());
    assert!(rules.refuses_at("p", Cap::Type, 1_000));
    // Settling writes the old rule back and drops the grant.
    assert!(rules.expire(1_000));
    assert_eq!(rules.rule("p"), watch());
    assert!(rules.grant_of("p").is_none());
    assert!(!rules.expire(5_000));
}

#[test]
fn the_global_rule_reads_settle_an_expired_grant() {
    let pane = "grant-global-1";
    pane_rules::set(pane, watch()).unwrap();
    pane_rules::grant(pane, 5_000).unwrap(); // far in the past: already over
    assert_eq!(pane_rules::rule(pane), watch());
    assert!(pane_rules::grant_before(pane).is_none());
    // A running grant (far future) opens the agent, and the person's own change ends it.
    pane_rules::grant(pane, u64::MAX).unwrap();
    assert_eq!(pane_rules::rule_at(pane, 10), PaneRule::default());
    assert_eq!(pane_rules::grant_before(pane), Some(watch()));
    assert!(!pane_rules::refuses_at(pane, Cap::Type, 10));
    pane_rules::set(pane, PaneRule { remote: false, level: Level::Full }).unwrap();
    assert!(pane_rules::grant_before(pane).is_none());
    assert!(pane_rules::rule(pane).remote == false);
}

#[test]
fn a_restart_with_a_past_expiry_returns_the_old_rule() {
    let dir = std::env::temp_dir().join(format!("pm-pane-rules-restart-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pane-remote.json");
    let mut rules = PaneRules::default();
    rules.set("p", PaneRule { remote: false, level: Level::Answer }).unwrap();
    rules.grant("p", PaneRule { remote: false, level: Level::Answer }, 2_000).unwrap();
    rules.save(&path).unwrap();
    // The app closes and starts again: the file holds the grant, the clock is past it.
    let mut back = PaneRules::load(&path);
    assert_eq!(back.rule_at("p", 1_999), PaneRule::default());
    assert_eq!(back.rule_at("p", 3_000), PaneRule { remote: false, level: Level::Answer });
    assert!(back.expire(3_000));
    back.save(&path).unwrap();
    let again = PaneRules::load(&path);
    assert!(again.grant_of("p").is_none());
    assert_eq!(again.rule("p"), PaneRule { remote: false, level: Level::Answer });
}

#[test]
fn a_grant_never_raises_above_the_phones_own_level() {
    let pane = "grant-cap-1";
    pane_rules::set(pane, watch()).unwrap();
    pane_rules::grant(pane, u64::MAX).unwrap();
    let watcher = phone(Caps::none().with(Cap::Watch, true));
    assert_eq!(status(&watcher, "GET", &["panes", pane, "chat"]), 200);
    assert_eq!(status(&watcher, "POST", &["panes", pane, "input"]), 403);
    assert_eq!(status(&watcher, "POST", &answer_route(pane)), 403);
    // A full phone does get typing while the grant runs.
    let full = phone(Caps::all());
    assert_eq!(status(&full, "POST", &["panes", pane, "input"]), 200);
    pane_rules::set(pane, PaneRule::default()).unwrap();
}
