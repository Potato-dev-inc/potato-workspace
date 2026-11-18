//! The PC link's routes: the level each route needs, enforced on the far side per request; the Full request card; the events a
//! level may see; the door that keeps the phone's routes out; and two real app instances on the in-memory net.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::services::EventView;
use super::*;
use crate::device_link::serve::HostBridge;
use crate::device_link::tests::{instance_with, pair, real_now, Instance};
use crate::device_link::Options;
use crate::p2p::memory::MemoryNet;
use crate::p2p::pairing::SystemClock;

/// Every route a PC may call, as `(method, path, body)`, with the level it needs.
fn every_route() -> Vec<(&'static str, &'static str, Value, Level)> {
    use Level::*;
    vec![
        ("GET", "/pclink/me", json!({}), Watch),
        ("GET", "/pclink/sessions", json!({}), Watch),
        ("GET", "/pclink/sessions/p1/transcript?since=3", json!({}), Watch),
        ("GET", "/pclink/sessions/p1/transcript/earlier?before=i9&limit=20", json!({}), Watch),
        ("GET", "/pclink/sessions/p1/picture?path=a.png", json!({}), Watch),
        ("GET", "/pclink/sessions/p1/screen", json!({}), Watch),
        ("GET", "/pclink/projects", json!({}), Watch),
        ("GET", "/pclink/usage", json!({}), Watch),
        ("GET", "/pclink/browse", json!({}), Full),
        ("GET", "/pclink/browse?root=r1&sub=a%2Fb", json!({}), Full),
        ("POST", "/pclink/projects/open", json!({ "root": "r1", "sub": "a/b" }), Full),
        ("GET", "/pclink/agents", json!({}), Watch),
        ("GET", "/pclink/questions", json!({}), Watch),
        ("GET", "/pclink/sessions/p1/messages", json!({}), Answer),
        ("POST", "/pclink/sessions/p1/messages", json!({ "text": "hi" }), Answer),
        ("DELETE", "/pclink/sessions/p1/messages/m1", json!({}), Answer),
        ("POST", "/pclink/sessions/p1/interrupt", json!({}), Answer),
        ("POST", "/pclink/questions/q1/answer", json!({ "choice_id": "yes" }), Answer),
        ("POST", "/pclink/sessions/p1/config", json!({ "option_id": "model", "value": "m" }), Full),
        ("POST", "/pclink/sessions/p1/input", json!({ "text": "ls" }), Full),
        ("GET", "/pclink/agents/claude/models", json!({}), Full),
        ("POST", "/pclink/agents/start", json!({ "agent": "claude", "project": "p1" }), Full),
        ("POST", "/pclink/agents/warm", json!({ "agent": "claude", "project": "p1" }), Full),
        ("DELETE", "/pclink/sessions/p1", json!({}), Full),
        ("POST", "/pclink/move-work", json!({ "project": "p1", "branch": "potato/move-1", "bundle_b64": "AAAA" }), Full),
    ]
}

#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<String>>,
    locked: Mutex<Vec<String>>,
    asked: Mutex<Vec<Ask>>,
    count: AtomicUsize,
}

impl Fake {
    fn note(&self, what: &str) -> (u16, Value) {
        self.calls.lock().unwrap().push(what.to_string());
        self.count.fetch_add(1, Ordering::SeqCst);
        (200, json!({ "ok": true, "did": what }))
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl Services for Fake {
    fn name(&self) -> String {
        "Desk".into()
    }
    fn ceiling(&self, session: &str) -> Option<Level> {
        (!self.locked.lock().unwrap().iter().any(|s| s == session)).then_some(Level::Full)
    }
    fn sessions(&self) -> (u16, Value) {
        self.note("sessions");
        (200, json!({ "sessions": [{ "id": "p1", "agent": "claude", "title": "t", "status": "idle", "project": "pabc", "folder": "x", "chat": true, "branch": "feat/meta", "model": "Sonnet 5.5", "mode": "asks" }] }))
    }
    fn transcript(&self, s: &str, _: Option<u64>) -> (u16, Value) {
        self.note(&format!("transcript {s}"))
    }
    fn transcript_earlier(&self, s: &str, _: &str, _: Option<usize>) -> (u16, Value) {
        self.note(&format!("earlier {s}"))
    }
    fn picture(&self, s: &str, _: &str) -> (u16, Value) {
        self.note(&format!("picture {s}"))
    }
    fn screen(&self, s: &str) -> (u16, Value) {
        self.note(&format!("screen {s}"))
    }
    fn projects(&self) -> (u16, Value) {
        self.note("projects")
    }
    fn usage(&self) -> (u16, Value) {
        self.note("usage")
    }
    fn browse(&self, root: Option<&str>, sub: &str) -> (u16, Value) {
        self.note(&format!("browse {} {sub}", root.unwrap_or("-")))
    }
    fn open_folder(&self, root: &str, sub: &str) -> (u16, Value) {
        self.note(&format!("open_folder {root} {sub}"))
    }
    fn agents(&self) -> (u16, Value) {
        self.note("agents")
    }
    fn questions(&self, full: bool) -> (u16, Value) {
        self.note(&format!("questions full={full}"))
    }
    fn outbox(&self, s: &str) -> (u16, Value) {
        self.note(&format!("outbox {s}"))
    }
    fn send(&self, _: &str, s: &str, text: &str, full: bool) -> (u16, Value) {
        self.note(&format!("send {s} {text} full={full}"))
    }
    fn cancel_message(&self, s: &str, m: &str) -> (u16, Value) {
        self.note(&format!("cancel {s} {m}"))
    }
    fn interrupt(&self, s: &str) -> (u16, Value) {
        self.note(&format!("interrupt {s}"))
    }
    fn answer_question(&self, id: &str, _: &Value, full: bool) -> (u16, Value) {
        self.note(&format!("answer {id} full={full}"))
    }
    fn known_folder(&self, path: &str) -> bool {
        path == "D:/known"
    }
    fn set_config(&self, _: &str, s: &str, o: &str, v: &str, _: bool) -> (u16, Value) {
        self.note(&format!("config {s} {o} {v}"))
    }
    fn input(&self, _: &str, s: &str, t: &str) -> (u16, Value) {
        self.note(&format!("input {s} {t}"))
    }
    fn models(&self, a: &str) -> (u16, Value) {
        self.note(&format!("models {a}"))
    }
    fn start(&self, _: &str, a: &str, p: &str, l: &str, _: &Value) -> (u16, Value) {
        self.note(&format!("start {a} {p} {l}"))
    }
    fn warm(&self, a: &str, p: &str) -> (u16, Value) {
        self.note(&format!("warm {a} {p}"))
    }
    fn close(&self, _: &str, s: &str) -> (u16, Value) {
        self.note(&format!("close {s}"))
    }
    fn move_work(&self, p: &str, b: &str, _: &str) -> (u16, Value) {
        self.note(&format!("move {p} {b}"))
    }
    fn notify_full_request(&self, ask: &Ask) {
        self.asked.lock().unwrap().push(ask.clone());
    }
    fn events(&self, _: Option<u64>, _: Duration, _: &EventView<'_>) -> (u64, String) {
        (0, String::new())
    }
}

fn call(level: Option<Level>, fake: &Fake, asks: &Asks, method: &str, target: &str, body: &Value) -> (u16, Value) {
    let who = Caller { node: "aa", name: "Laptop", level, now_ms: 1_000 };
    let bytes = if body.as_object().is_some_and(|o| o.is_empty()) { Vec::new() } else { serde_json::to_vec(body).unwrap() };
    handle(&who, fake, asks, method, target, &bytes)
}

#[test]
fn a_watch_pc_gets_branch_model_and_mode_on_the_session_list_and_no_path() {
    let asks = Asks::new();
    let fake = Fake::default();
    let (status, answer) = call(Some(Level::Watch), &fake, &asks, "GET", "/pclink/sessions", &json!({}));
    assert_eq!(status, 200);
    let row = &answer["sessions"][0];
    assert_eq!((row["branch"].as_str(), row["model"].as_str(), row["mode"].as_str()), (Some("feat/meta"), Some("Sonnet 5.5"), Some("asks")));
    assert!(["asks", "acts_without_asking", "unknown"].contains(&row["mode"].as_str().unwrap()));
    // No new route: the list is still one Watch route, and nothing that looks like a path travels in the new fields.
    assert_eq!(need("GET", &["sessions"]), Some(Level::Watch));
    for key in ["branch", "model", "mode"] {
        let text = row[key].as_str().unwrap();
        assert!(!text.contains('\\') && !text.contains(':') && text.chars().count() <= super::meta::NAME_MAX, "{key}");
    }
}

#[test]
fn the_levels_are_ordered_and_named() {
    assert!(Level::Watch < Level::Answer && Level::Answer < Level::Full);
    assert_eq!(["watch", "answer", "full"], [Level::Watch, Level::Answer, Level::Full].map(Level::as_str));
}

#[test]
fn the_route_table_names_the_level_each_route_needs() {
    for (method, target, _, level) in every_route() {
        let path = target.split('?').next().unwrap();
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).skip(1).collect();
        assert_eq!(need(method, &segs), Some(level), "{method} {target}");
    }
    assert_eq!(need("POST", &["full-request"]), Some(Level::Watch), "asking is not doing");
    // A route that is not in the table does not exist, at any level.
    for (method, segs) in [("GET", vec!["phone", "chats"]), ("POST", vec!["panes"]), ("GET", vec!["settings"]), ("PUT", vec!["sessions"]), ("DELETE", vec!["sessions"]), ("POST", vec!["sessions", "p1", "kill"])] {
        assert_eq!(need(method, &segs), None, "{method} {segs:?}");
    }
}

#[test]
fn the_rights_matrix_holds_for_every_route_at_every_level() {
    let asks = Asks::new();
    for level in [Level::Watch, Level::Answer, Level::Full] {
        for (method, target, body, needs) in every_route() {
            let fake = Fake::default();
            let (status, answer) = call(Some(level), &fake, &asks, method, target, &body);
            if level >= needs {
                assert_eq!(status, 200, "{level:?} may {method} {target}: {answer}");
                // `me` answers from the PC link itself; every other route reaches the app once.
                assert_eq!(fake.calls().len(), usize::from(target != "/pclink/me"), "{method} {target} ran once");
            } else {
                assert_eq!((status, answer["error"].as_str(), answer["needs"].as_str()), (403, Some("not_allowed"), Some(needs.as_str())), "{level:?} must not {method} {target}");
                assert_eq!(answer["have"], level.as_str());
                assert!(fake.calls().is_empty(), "{level:?} ran nothing for {method} {target}");
            }
        }
    }
}

#[test]
fn a_watch_pc_cannot_send_stop_start_or_type_and_an_answer_pc_cannot_start_or_use_the_terminal() {
    let (fake, asks) = (Fake::default(), Asks::new());
    for (method, target, body) in [
        ("POST", "/pclink/sessions/p1/messages", json!({ "text": "x" })),
        ("POST", "/pclink/sessions/p1/interrupt", json!({})),
        ("POST", "/pclink/agents/start", json!({ "agent": "a", "project": "p" })),
        ("POST", "/pclink/sessions/p1/input", json!({ "text": "rm" })),
        ("POST", "/pclink/questions/q/answer", json!({ "text": "y" })),
    ] {
        assert_eq!(call(Some(Level::Watch), &fake, &asks, method, target, &body).0, 403, "{target}");
    }
    for (method, target, body) in [
        ("POST", "/pclink/agents/start", json!({ "agent": "a", "project": "p" })),
        ("POST", "/pclink/agents/warm", json!({ "agent": "a", "project": "p" })),
        ("POST", "/pclink/sessions/p1/input", json!({ "text": "rm" })),
        ("POST", "/pclink/sessions/p1/config", json!({ "option_id": "mode", "value": "bypass" })),
        ("GET", "/pclink/agents/claude/models", json!({})),
    ] {
        assert_eq!(call(Some(Level::Answer), &fake, &asks, method, target, &body).0, 403, "{target}");
    }
    assert!(fake.calls().is_empty(), "nothing reached the app");
    // What Answer can do.
    for (method, target, body) in [
        ("POST", "/pclink/sessions/p1/messages", json!({ "text": "go on" })),
        ("POST", "/pclink/sessions/p1/interrupt", json!({})),
        ("GET", "/pclink/sessions/p1/transcript", json!({})),
    ] {
        assert_eq!(call(Some(Level::Answer), &fake, &asks, method, target, &body).0, 200, "{target}");
    }
}

#[test]
fn with_the_switch_off_there_is_no_level_and_every_route_is_refused() {
    let (fake, asks) = (Fake::default(), Asks::new());
    for (method, target, body, _) in every_route() {
        let (status, answer) = call(None, &fake, &asks, method, target, &body);
        assert_eq!((status, answer["code"].as_str()), (403, Some("REMOTE_OFF")), "{method} {target}");
    }
    assert_eq!(call(None, &fake, &asks, "POST", "/pclink/full-request", &json!({})).0, 403, "a PC that is not let in cannot even ask");
    assert!(fake.calls().is_empty());
}

#[test]
fn only_pclink_paths_exist_and_unknown_routes_are_404() {
    let (fake, asks) = (Fake::default(), Asks::new());
    for target in ["/panes", "/phone/chats", "/settings", "/pclink/nothing", "/pclink", "/pclinkx/sessions"] {
        assert_eq!(call(Some(Level::Full), &fake, &asks, "GET", target, &json!({})).0, 404, "{target}");
    }
    assert_eq!(call(Some(Level::Full), &fake, &asks, "POST", "/pclink/sessions", &json!({})).0, 404);
    assert_eq!(call(Some(Level::Full), &fake, &asks, "POST", "/pclink/sessions/p1/messages", &json!({ "nope": 1 })).0, 400, "a message needs text");
    assert!(fake.calls().is_empty());
}

#[test]
fn an_agent_switched_off_for_other_pcs_refuses_every_session_route_but_stays_in_the_list() {
    let (fake, asks) = (Fake::default(), Asks::new());
    fake.locked.lock().unwrap().push("p1".into());
    for (method, target, body, _) in every_route().into_iter().filter(|r| r.1.contains("/sessions/p1")) {
        let (status, answer) = call(Some(Level::Full), &fake, &asks, method, target, &body);
        assert_eq!((status, answer["code"].as_str()), (403, Some("AGENT_LOCKED")), "{method} {target}");
    }
    assert_eq!(call(Some(Level::Full), &fake, &asks, "GET", "/pclink/sessions", &json!({})).0, 200);
    assert_eq!(call(Some(Level::Full), &fake, &asks, "GET", "/pclink/sessions/p2/transcript", &json!({})).0, 200, "another agent is not affected");
}

#[test]
fn me_tells_the_asking_pc_its_own_level() {
    let (fake, asks) = (Fake::default(), Asks::new());
    for level in [Level::Watch, Level::Answer, Level::Full] {
        let (status, body) = call(Some(level), &fake, &asks, "GET", "/pclink/me", &json!({}));
        assert_eq!((status, body["level"].as_str(), body["name"].as_str(), body["asked"].as_bool()), (200, Some(level.as_str()), Some("Desk"), Some(false)));
    }
}

#[test]
fn asking_for_full_puts_a_card_on_the_far_pc_and_grants_nothing() {
    let (fake, asks) = (Fake::default(), Asks::new());
    let (status, body) = call(Some(Level::Answer), &fake, &asks, "POST", "/pclink/full-request", &json!({}));
    assert_eq!((status, body["asked"].as_bool()), (202, Some(true)), "{body}");
    assert_eq!(fake.asked.lock().unwrap().len(), 1, "one card was raised");
    assert_eq!(fake.asked.lock().unwrap()[0].name, "Laptop");
    // The asking side sees it is waiting.
    assert_eq!(call(Some(Level::Answer), &fake, &asks, "GET", "/pclink/me", &json!({})).1["asked"], true);
    // Asking again does not raise a second card.
    let (status, body) = call(Some(Level::Answer), &fake, &asks, "POST", "/pclink/full-request", &json!({}));
    assert_eq!((status, body["already"].as_bool()), (202, Some(true)));
    assert_eq!(fake.asked.lock().unwrap().len(), 1);
    // Still no right: a start is refused until the person says yes.
    assert_eq!(call(Some(Level::Answer), &fake, &asks, "POST", "/pclink/agents/start", &json!({ "agent": "a", "project": "p" })).0, 403);
    // A PC that is already Full is told so.
    assert_eq!(call(Some(Level::Full), &fake, &asks, "POST", "/pclink/full-request", &json!({})).1["code"], "ALREADY_FULL");
}

#[test]
fn the_asks_hold_a_gap_a_cap_and_fade() {
    let asks = Asks::new();
    let first = asks.request("n1", "One", 0).unwrap();
    assert_eq!(asks.request("n1", "One", 10), Err(Refusal::Pending));
    assert_eq!(asks.pending(10).len(), 1);
    assert!(asks.take(&first.id, 20).is_some(), "the person answered");
    assert!(matches!(asks.request("n1", "One", 30), Err(Refusal::TooSoon { .. })), "a No does not shorten the wait");
    assert!(asks.request("n1", "One", asks::ASK_GAP_MS + 100).is_ok());
    // An ask nobody answers fades.
    assert!(asks.pending(asks::ASK_GAP_MS + 100 + asks::ASK_LIFE_MS + 1).is_empty());
    // Not too many at once.
    let many = Asks::new();
    for i in 0..10 {
        many.request(&format!("n{i}"), "x", 5).unwrap();
    }
    assert_eq!(many.request("n99", "x", 5), Err(Refusal::Busy));
    // An unpaired PC's card goes away.
    many.drop_node("n3");
    assert!(!many.pending_for("n3", 6));
}

#[test]
fn events_are_the_pc_links_own_few_and_cut_by_level() {
    let panes = "event: panes\ndata: [{\"id\":\"p1\",\"cwd\":\"D:/secret\"}]\n\n";
    let status = "event: pane-status\ndata: {\"pane_id\":\"p1\",\"status\":\"idle\"}\n\n";
    let outbox = "event: pane-outbox\ndata: {\"paneId\":\"p1\",\"messages\":[{\"text\":\"private\"}]}\n\n";
    let questions = "event: questions\ndata: {\"revision\":4}\n\n";
    let panes_view = events::view(Level::Watch, panes).unwrap();
    assert_eq!(panes_view, "event: sessions\ndata: {}\n\n");
    assert!(!panes_view.contains("secret"), "no pane data rides the event");
    assert_eq!(events::view(Level::Watch, status).unwrap(), "event: session-status\ndata: {\"id\":\"p1\",\"status\":\"idle\"}\n\n");
    assert!(events::view(Level::Watch, outbox).is_none(), "Watch sees no messages");
    assert_eq!(events::view(Level::Watch, questions).unwrap(), "event: questions
data: {}

", "Watch may read the questions, so its list refreshes");
    let outbox_view = events::view(Level::Answer, outbox).unwrap();
    assert_eq!(outbox_view, "event: outbox\ndata: {\"id\":\"p1\"}\n\n");
    assert!(!outbox_view.contains("private"));
    assert!(events::view(Level::Answer, questions).is_some());
    for dropped in [
        "event: terminal\ndata: {\"pane_id\":\"p1\"}\n\n",
        "event: log\ndata: {}\n\n",
        "event: settings\ndata: {\"token\":\"x\"}\n\n",
        "event: attention\ndata: {}\n\n",
        "event: pane-preview\ndata: {}\n\n",
        "event: companion\ndata: []\n\n",
        "garbage",
    ] {
        assert!(events::view(Level::Full, dropped).is_none(), "{dropped}");
    }
}

struct Legacy(Mutex<Vec<String>>);

#[async_trait]
impl HostBridge for Legacy {
    async fn call(&self, _: &str, method: &str, target: &str, _: Vec<u8>) -> (u16, Vec<u8>) {
        self.0.lock().unwrap().push(format!("{method} {target}"));
        (200, br#"{"legacy":true}"#.to_vec())
    }
    async fn poll(&self, _: &str, _: Option<u64>, _: Duration) -> Option<(u64, String)> {
        Some((0, "event: terminal\ndata: {}\n\n".into()))
    }
}

fn make_door(level: Option<Level>) -> (Door, Arc<Fake>, Arc<Legacy>) {
    let (fake, legacy) = (Arc::new(Fake::default()), Arc::new(Legacy(Mutex::new(Vec::new()))));
    let door = Door {
        legacy: legacy.clone(),
        services: fake.clone(),
        asks: Arc::new(Asks::new()),
        level_of: Arc::new(move |_| level),
        name_of: Arc::new(|_| "Laptop".into()),
        lend_ok: Arc::new(|_| true),
        now_ms: Arc::new(|| 1_000),
    };
    (door, fake, legacy)
}

#[tokio::test]
async fn the_door_serves_pclink_and_keeps_every_phone_route_out_of_a_pcs_reach() {
    let (door, fake, legacy) = make_door(Some(Level::Full));
    let (status, body) = door.call("aa", "GET", "/pclink/sessions", Vec::new()).await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    assert_eq!(fake.calls(), ["sessions"]);
    for (method, target) in [
        ("GET", "/panes"),
        ("POST", "/panes"),
        ("POST", "/phone/chats"),
        ("GET", "/phone/new-chat"),
        ("POST", "/phone/warm"),
        ("POST", "/phone/move-work"),
        ("POST", "/panes/p1/messages"),
        ("POST", "/panes/p1/interrupt"),
        ("POST", "/control-asks"),
        ("GET", "/settings"),
        ("POST", "/pair"),
        ("GET", "/agents/run"),
        ("POST", "/lend/item/extra"),
    ] {
        let (status, body) = door.call("aa", method, target, b"{}".to_vec()).await;
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!((status, body["code"].as_str()), (404, Some("USE_PCLINK")), "{method} {target}");
    }
    assert!(legacy.0.lock().unwrap().is_empty(), "no phone route reached the old door");
    // The two PC-to-PC doors that are not phone routes still work.
    for (method, target) in [("POST", "/agents/run"), ("POST", "/lend/item")] {
        assert_eq!(door.call("aa", method, target, b"{}".to_vec()).await.0, 200);
    }
    assert_eq!(*legacy.0.lock().unwrap(), ["POST /agents/run", "POST /lend/item"]);
}

fn door_with(level: Option<Level>, lend: bool) -> (Door, Arc<Fake>, Arc<Legacy>) {
    let (mut door, fake, legacy) = make_door(level);
    door.lend_ok = Arc::new(move |_| lend);
    (door, fake, legacy)
}

#[tokio::test]
async fn the_door_itself_asks_full_for_agents_run_and_the_lend_right_for_lend_item() {
    // The real door, with a legacy behind it that would say yes to anything: the refusal is the door's.
    for level in [None, Some(Level::Watch), Some(Level::Answer)] {
        let (door, _, legacy) = door_with(level, false);
        let (status, body) = door.call("aa", "POST", "/agents/run", br#"{"task":"x"}"#.to_vec()).await;
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!((status, body["code"].as_str(), body["needs"].as_str()), (403, Some("DEVICE_NOT_ALLOWED"), Some("full")), "{level:?}");
        assert!(legacy.0.lock().unwrap().is_empty(), "{level:?} reached nothing");
    }
    let (door, _, legacy) = door_with(Some(Level::Full), true);
    assert_eq!(door.call("aa", "POST", "/agents/run", br#"{"task":"x"}"#.to_vec()).await.0, 200);
    assert_eq!(legacy.0.lock().unwrap().len(), 1);
    // Lending needs its own right, whatever the level: Full without it is refused, Watch with it is not stopped by the level.
    let (door, _, legacy) = door_with(Some(Level::Full), false);
    assert_eq!(door.call("aa", "POST", "/lend/item", b"{}".to_vec()).await.0, 403);
    assert!(legacy.0.lock().unwrap().is_empty());
    let (door, _, legacy) = door_with(Some(Level::Watch), true);
    assert_eq!(door.call("aa", "POST", "/lend/item", b"{}".to_vec()).await.0, 200);
    assert_eq!(legacy.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn agents_run_starts_only_in_a_folder_this_pc_knows() {
    let (door, _, legacy) = door_with(Some(Level::Full), false);
    for folder in ["C:/Windows", "D:/known/../secret", "//host/share"] {
        let body = serde_json::to_vec(&json!({ "task": "x", "project_path": folder })).unwrap();
        let (status, answer) = door.call("aa", "POST", "/agents/run", body).await;
        let answer: Value = serde_json::from_slice(&answer).unwrap();
        assert_eq!((status, answer["code"].as_str()), (404, Some("UNKNOWN_PROJECT")), "{folder}");
    }
    assert!(legacy.0.lock().unwrap().is_empty());
    // A known folder, and no folder at all (this PC's own default project), go through.
    for body in [json!({ "task": "x", "project_path": "D:/known" }), json!({ "task": "x" }), json!({ "task": "x", "project_path": "  " })] {
        assert_eq!(door.call("aa", "POST", "/agents/run", serde_json::to_vec(&body).unwrap()).await.0, 200, "{body}");
    }
}

#[test]
fn a_message_carries_the_askers_level_so_the_app_can_refuse_below_full() {
    let (fake, asks) = (Fake::default(), Asks::new());
    for level in [Level::Answer, Level::Full] {
        assert_eq!(call(Some(level), &fake, &asks, "POST", "/pclink/sessions/p1/messages", &json!({ "text": "go" })).0, 200);
    }
    assert_eq!(fake.calls(), ["send p1 go full=false", "send p1 go full=true"]);
}

#[test]
fn the_questions_routes_pass_the_askers_level_to_the_app() {
    let (fake, asks) = (Fake::default(), Asks::new());
    call(Some(Level::Watch), &fake, &asks, "GET", "/pclink/questions", &json!({}));
    call(Some(Level::Full), &fake, &asks, "GET", "/pclink/questions", &json!({}));
    call(Some(Level::Answer), &fake, &asks, "POST", "/pclink/questions/q1/answer", &json!({ "choice_id": "deny" }));
    call(Some(Level::Full), &fake, &asks, "POST", "/pclink/questions/q1/answer", &json!({ "choice_id": "allow" }));
    assert_eq!(fake.calls(), ["questions full=false", "questions full=true", "answer q1 full=false", "answer q1 full=true"]);
}

#[tokio::test]
async fn the_door_events_follow_the_level_and_end_with_the_switch() {
    let (door, _, _) = make_door(Some(Level::Watch));
    assert_eq!(door.poll("aa", Some(0), Duration::from_millis(5)).await, Some((0, String::new())), "the old door's frames are not forwarded");
    let (off, _, _) = make_door(None);
    assert_eq!(off.poll("aa", Some(0), Duration::from_millis(5)).await, None, "no switch: the stream is over");
}

// ----- two real app instances on the in-memory net -----

fn instance_with_services(name: &str, net: &MemoryNet, fake: Arc<Fake>) -> Instance {
    let mut options = Options::memory();
    options.pclink = Some(fake);
    instance_with(name, net.factory(), false, Arc::new(SystemClock), Arc::new(real_now), options)
}

async fn level_of(a: &Instance, b_node: &str) -> (u16, Value) {
    a.link.request(b_node, "GET", "/pclink/me", None).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pairing_grants_nothing_and_each_level_is_enforced_on_the_far_pc() {
    let net = MemoryNet::new();
    let (fake_a, fake_b) = (Arc::new(Fake::default()), Arc::new(Fake::default()));
    let a = instance_with_services("alpha", &net, fake_a);
    let b = instance_with_services("beta", &net, fake_b.clone());
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());

    // Paired, nothing switched on: every route is shut, and B's services ran nothing.
    let (status, body) = level_of(&a, &b_node).await;
    assert_eq!((status, body["error"].as_str()), (403, Some("not_allowed")), "{body}");
    assert_eq!(b.link.view()["devices"][0]["level"], "watch");
    assert_eq!(b.link.view()["devices"][0]["lets_run"], false);
    assert!(fake_b.calls().is_empty());

    // Watch: reads only.
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    assert_eq!(level_of(&a, &b_node).await.1["level"], "watch");
    assert_eq!(a.link.request(&b_node, "GET", "/pclink/sessions", None).await.unwrap().0, 200);
    for (method, path, body) in [
        ("POST", "/pclink/sessions/p1/messages", json!({ "text": "x" })),
        ("POST", "/pclink/sessions/p1/interrupt", json!({})),
        ("POST", "/pclink/agents/start", json!({ "agent": "a", "project": "p" })),
        ("POST", "/pclink/sessions/p1/input", json!({ "text": "x" })),
    ] {
        assert_eq!(a.link.request(&b_node, method, path, Some(body)).await.unwrap().0, 403, "Watch must not {path}");
    }
    assert_eq!(fake_b.calls(), ["sessions"]);

    // Answer: messages and stop, but no start and no terminal.
    b.link.set_permission(&a_node, true, Some("answer")).unwrap();
    assert_eq!(b.link.view()["devices"][0]["level"], "answer");
    assert_eq!(level_of(&a, &b_node).await.1["level"], "answer");
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/sessions/p1/messages", Some(json!({ "text": "go on" }))).await.unwrap().0, 200);
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/sessions/p1/interrupt", Some(json!({}))).await.unwrap().0, 200);
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/agents/start", Some(json!({ "agent": "a", "project": "p" }))).await.unwrap().0, 403);
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/sessions/p1/input", Some(json!({ "text": "x" }))).await.unwrap().0, 403);

    // The phone's routes are not served to a PC at any level, Full included.
    b.link.set_permission(&a_node, true, Some("full")).unwrap();
    assert_eq!(b.link.view()["devices"][0]["level"], "full");
    for path in ["/phone/chats", "/panes", "/phone/new-chat", "/control-asks"] {
        let method = if path == "/panes" || path == "/phone/new-chat" { "GET" } else { "POST" };
        assert_eq!(a.link.request(&b_node, method, path, Some(json!({}))).await.unwrap().0, 404, "{path}");
    }
    // Full: start and the terminal.
    let (status, body) = a.link.request(&b_node, "POST", "/pclink/agents/start", Some(json!({ "agent": "a", "project": "p" }))).await.unwrap();
    assert_eq!(status, 200, "{body}");
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/sessions/p1/input", Some(json!({ "text": "ls" }))).await.unwrap().0, 200);
    assert!(fake_b.calls().iter().any(|c| c == "start a p chat"));

    // Switching it off shuts every route again at once.
    b.link.set_permission(&a_node, false, None).unwrap();
    assert_eq!(a.link.request(&b_node, "GET", "/pclink/sessions", None).await.unwrap().0, 403);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pc_asks_for_full_the_person_at_the_far_pc_taps_allow_and_only_then_it_can_start() {
    let net = MemoryNet::new();
    let (fake_a, fake_b) = (Arc::new(Fake::default()), Arc::new(Fake::default()));
    let a = instance_with_services("alpha", &net, fake_a);
    let b = instance_with_services("beta", &net, fake_b.clone());
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("answer")).unwrap();
    let start = json!({ "agent": "a", "project": "p" });
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/agents/start", Some(start.clone())).await.unwrap().0, 403);

    // A asks. B's person sees a real card, with A's name for it.
    let (status, body) = a.link.request(&b_node, "POST", "/pclink/full-request", Some(json!({}))).await.unwrap();
    assert_eq!((status, body["asked"].as_bool()), (202, Some(true)), "{body}");
    assert_eq!(fake_b.asked.lock().unwrap().len(), 1, "the far PC raised its card");
    let cards = b.link.full_asks();
    assert_eq!(cards.as_array().unwrap().len(), 1);
    assert_eq!(cards[0]["name"], "alpha");
    assert_eq!(a.link.request(&b_node, "GET", "/pclink/me", None).await.unwrap().1["asked"], true);
    // Asking granted nothing.
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/agents/start", Some(start.clone())).await.unwrap().0, 403);

    // The person says No: nothing changes, the card is gone.
    let id = cards[0]["id"].as_str().unwrap().to_string();
    b.link.answer_full_ask(&id, false).unwrap();
    assert!(b.link.full_asks().as_array().unwrap().is_empty());
    assert_eq!(b.link.view()["devices"][0]["level"], "answer");
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/agents/start", Some(start.clone())).await.unwrap().0, 403);
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/full-request", Some(json!({}))).await.unwrap().0, 429, "not again at once");
    assert!(b.link.answer_full_ask(&id, true).is_err(), "a card can be answered once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn allow_on_the_card_turns_full_on_and_an_unpaired_pcs_card_cannot_be_allowed() {
    let net = MemoryNet::new();
    let fake_b = Arc::new(Fake::default());
    let a = instance_with_services("alpha", &net, Arc::new(Fake::default()));
    let b = instance_with_services("beta", &net, fake_b.clone());
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    b.link.set_permission(&a_node, true, Some("answer")).unwrap();
    a.link.request(&b_node, "POST", "/pclink/full-request", Some(json!({}))).await.unwrap();
    let id = b.link.full_asks()[0]["id"].as_str().unwrap().to_string();
    b.link.answer_full_ask(&id, true).unwrap();
    assert_eq!(b.link.view()["devices"][0]["level"], "full");
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/agents/start", Some(json!({ "agent": "a", "project": "p" }))).await.unwrap().0, 200);
    // Turning the switch off takes it away again.
    b.link.set_permission(&a_node, false, None).unwrap();
    assert_eq!(b.link.view()["devices"][0]["level"], "watch");
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/agents/start", Some(json!({ "agent": "a", "project": "p" }))).await.unwrap().0, 403);
    // A card whose PC was switched off before the tap grants nothing.
    b.link.set_permission(&a_node, true, Some("answer")).unwrap();
    assert!(b.link.full_asks().as_array().unwrap().is_empty());
}

#[test]
fn usage_is_watch_and_browse_and_open_folder_are_full_and_the_query_reaches_the_app() {
    let asks = Asks::new();
    // Usage: any level that is let in.
    let fake = Fake::default();
    assert_eq!(call(Some(Level::Watch), &fake, &asks, "GET", "/pclink/usage", &json!({})).0, 200);
    assert_eq!(fake.calls(), vec!["usage"]);
    // Browse and open a folder: Watch and Answer are refused before the app is reached, with no switch there is no level at all.
    for level in [Level::Watch, Level::Answer] {
        let fake = Fake::default();
        for (method, target, body) in [("GET", "/pclink/browse", json!({})), ("GET", "/pclink/browse?root=r1&sub=a", json!({})), ("POST", "/pclink/projects/open", json!({ "root": "r1", "sub": "a" }))] {
            let (status, answer) = call(Some(level), &fake, &asks, method, target, &body);
            assert_eq!((status, answer["needs"].as_str()), (403, Some("full")), "{level:?} {target}");
        }
        assert!(fake.calls().is_empty(), "{level:?} reached nothing");
    }
    let fake = Fake::default();
    for (method, target, body) in [("GET", "/pclink/browse", json!({})), ("GET", "/pclink/usage", json!({})), ("POST", "/pclink/projects/open", json!({ "root": "r1" }))] {
        assert_eq!(call(None, &fake, &asks, method, target, &body).1["code"], "REMOTE_OFF", "{target}");
    }
    assert!(fake.calls().is_empty());
    // Full: the root and the (decoded) sub go to the app; the root is optional for browse, required for open.
    let fake = Fake::default();
    assert_eq!(call(Some(Level::Full), &fake, &asks, "GET", "/pclink/browse", &json!({})).0, 200);
    assert_eq!(call(Some(Level::Full), &fake, &asks, "GET", "/pclink/browse?root=r1&sub=code%2Fbilling%20service", &json!({})).0, 200);
    assert_eq!(call(Some(Level::Full), &fake, &asks, "POST", "/pclink/projects/open", &json!({ "root": "r1", "sub": "code/x" })).0, 200);
    assert_eq!(call(Some(Level::Full), &fake, &asks, "POST", "/pclink/projects/open", &json!({ "sub": "code/x" })).0, 400, "a root is required");
    assert_eq!(fake.calls(), vec!["browse - ", "browse r1 code/billing service", "open_folder r1 code/x"]);
}
