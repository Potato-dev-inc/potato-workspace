//! P3.1: the workflow and crew rows of the far call table. The level of every row, the rows that must not exist, the folder rule, what an
//! audit line holds, the `workflow-state` frame, and two real instances on the in-memory net: a Full PC starts a workflow's helpers on the
//! far PC and the far PC's state frame comes back.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::calls::{self, TABLE};
use super::calls_workflows::{audit_detail, folder_with, mine};
use super::services::{EventView, Services};
use super::tests::Fake;
use super::{events, handle, Asks, Caller, Level};
use crate::device_link::tests::{instance_with, pair, real_now, until};
use crate::device_link::Options;
use crate::p2p::memory::MemoryNet;
use crate::p2p::pairing::SystemClock;

/// `(command, level, body)` for every row of the block.
fn rows() -> Vec<(&'static str, Level, Value)> {
    use Level::*;
    let folder = json!({ "slug": "research", "folder": "p0123456789abcdef", "frontPane": "p1" });
    vec![
        ("crews_list", Watch, json!({})),
        ("crews_starters", Watch, json!({})),
        ("crews_get", Watch, json!({ "slug": "research" })),
        ("crews_agents", Watch, json!({})),
        ("crews_draft", Watch, json!({ "paneId": "p1" })),
        ("crews_templates", Watch, json!({})),
        ("crews_open", Watch, json!({ "slug": "research" })),
        ("crews_check", Watch, json!({ "crew": { "name": "Research" } })),
        ("crews_try_task", Watch, json!({ "crew": { "name": "Research" }, "routingText": "", "task": "x" })),
        ("crews_follow", Watch, json!({ "crew": { "name": "Research" } })),
        ("workflows_list", Watch, json!({})),
        ("workflows_hidden_count", Watch, json!({})),
        ("workflows_plan", Watch, json!({ "slug": "research", "folder": "p0123456789abcdef", "request": "go" })),
        ("workflows_start_helpers", Full, folder.clone()),
        ("crews_start", Full, json!({ "slug": "research", "folder": "p0123456789abcdef" })),
        ("crews_save", Full, json!({ "crew": { "name": "Research" } })),
        ("crews_remove", Full, json!({ "slug": "research" })),
    ]
}

fn ask(level: Option<Level>, fake: &FarPc, cmd: &str, body: &Value) -> (u16, Value) {
    let who = Caller { node: "aa", name: "Laptop", level, marked: false, now_ms: 1_000 };
    handle(&who, fake, &Asks::new(), "POST", &format!("/pclink/call/{cmd}"), &serde_json::to_vec(body).unwrap())
}

/// This block's rows: the table lines from the `// ---- P3.1 workflows ----` marker to the next `// ---- ` marker (any block), so another phase
/// adding its block before or after this one never changes what is pinned here.
fn block() -> Vec<(&'static str, &'static str, bool)> {
    let source = include_str!("calls.rs");
    let from = source.find("    // ---- P3.1 workflows ----").expect("the P3.1 marker");
    let body = &source[from..];
    let mut lines = body.lines();
    lines.next();
    let names: Vec<&str> = lines.take_while(|l| !l.trim_start().starts_with("// ---- ")).filter_map(|l| l.trim_start().strip_prefix("(\"")?.split('"').next()).collect();
    names.iter().map(|n| TABLE.iter().find(|r| r.0 == *n).map(|(c, l, p)| (*c, l.as_str(), *p)).expect("a row named in the block")).collect()
}

#[test]
fn the_block_names_exactly_these_commands_at_these_levels() {
    assert_eq!(
        block(),
        [
            ("crews_list", "watch", false),
            ("crews_starters", "watch", false),
            ("crews_get", "watch", false),
            ("crews_agents", "watch", false),
            ("crews_draft", "watch", true),
            ("crews_templates", "watch", false),
            ("crews_open", "watch", false),
            ("crews_check", "watch", false),
            ("crews_try_task", "watch", false),
            ("crews_follow", "watch", false),
            ("workflows_list", "watch", false),
            ("workflows_hidden_count", "watch", false),
            ("workflows_plan", "watch", false),
            ("workflows_start_helpers", "full", false),
            ("crews_start", "full", false),
            ("crews_save", "full", false),
            ("crews_remove", "full", false),
        ]
    );
    // Reads are Watch; starting, stopping and editing are Full. Nothing sits at Answer: answering a helper's question is the
    // existing question route (`POST /pclink/questions/<id>/answer`), which a workflow's helpers use like any other chat.
    for (cmd, level, _) in block() {
        assert!(mine(cmd), "{cmd} is routed to the workflow module");
        let reads = !["workflows_start_helpers", "crews_start", "crews_save", "crews_remove"].contains(&cmd);
        assert_eq!(level, if reads { "watch" } else { "full" }, "{cmd}");
    }
}

#[test]
fn the_level_matrix_each_level_may_call_what_its_rows_say_and_nothing_else_reaches_the_app() {
    for (cmd, needs, body) in rows() {
        for level in [Level::Watch, Level::Answer, Level::Full] {
            let fake = FarPc::new();
            let (status, answer) = ask(Some(level), &fake, cmd, &body);
            if level >= needs {
                assert_eq!((status, fake.inner.calls().len()), (200, 1), "{level:?} may {cmd}: {answer}");
            } else {
                assert_eq!((status, answer["code"].as_str(), answer["needs"].as_str()), (403, Some("DEVICE_NOT_ALLOWED"), Some(needs.as_str())), "{level:?} must not {cmd}");
                assert!(fake.inner.calls().is_empty(), "{cmd} was refused before it reached the app");
            }
        }
        // A PC with no rights at all reaches nothing.
        let fake = FarPc::new();
        assert_eq!(ask(None, &fake, cmd, &body).1["code"], "REMOTE_OFF", "{cmd}");
        assert!(fake.inner.calls().is_empty());
    }
}

#[test]
fn the_rows_that_would_hand_over_more_are_not_served() {
    // Saving from the canvas, keeping standby helpers, talking to a lead and the file export stay on the PC they belong to (a later step).
    let fake = FarPc::new();
    for cmd in ["crews_save_canvas", "crews_apply", "crews_talk", "crews_export_file", "crews_import_read", "workflows_delete"] {
        let (status, answer) = ask(Some(Level::Full), &fake, cmd, &json!({ "slug": "x", "paneId": "p1" }));
        assert_eq!((status, answer["code"].as_str()), (404, Some("UNKNOWN_ROUTE")), "{cmd}");
    }
    assert!(fake.inner.calls().is_empty());
}

#[test]
fn a_draft_of_a_chat_shut_for_other_pcs_is_refused_even_at_full() {
    let fake = FarPc::new();
    fake.locked.lock().unwrap().push("p1".into());
    let (status, answer) = ask(Some(Level::Full), &fake, "crews_draft", &json!({ "paneId": "p1" }));
    assert_eq!((status, answer["code"].as_str()), (403, Some("AGENT_LOCKED")));
    assert_eq!(ask(Some(Level::Full), &fake, "crews_draft", &json!({})).1["code"], "INVALID_ARGUMENT");
    assert!(fake.inner.calls().is_empty());
    assert!(calls::names_pane("crews_draft") && !calls::names_pane("workflows_start_helpers"));
}

#[test]
fn a_folder_is_one_of_this_pcs_known_projects_by_id_or_path_and_nothing_else() {
    let known = vec![("D:/code/a".to_string(), "a".to_string(), "ok".to_string()), ("D:/code/b".to_string(), "b".to_string(), "ok".to_string())];
    let id_of = |p: &str| format!("p{}", p.replace('\\', "/").trim_end_matches('/').to_lowercase());
    assert_eq!(folder_with(&known, "pd:/code/b", &id_of).as_deref(), Some("D:/code/b"), "by its opaque id");
    assert_eq!(folder_with(&known, "D:\\code\\a\\", &id_of).as_deref(), Some("D:/code/a"), "by its path, written another way");
    for stranger in ["D:/code/c", "C:/Windows", "", "../a", "pd:/code/c"] {
        assert_eq!(folder_with(&known, stranger, &id_of), None, "{stranger:?}");
    }
}

#[test]
fn an_audit_line_holds_ids_only() {
    let line = audit_detail("workflow.start", "research", Some("p1"), Some("p0123456789abcdef"));
    assert_eq!(line, json!({ "event": "workflow.start", "slug": "research", "pane_id": "p1", "project": "p0123456789abcdef" }));
    let keys: Vec<_> = line.as_object().unwrap().keys().cloned().collect();
    assert!(keys.iter().all(|k| ["event", "slug", "pane_id", "project"].contains(&k.as_str())), "no name, folder, crew text or message: {keys:?}");
}

#[test]
fn the_workflow_state_frame_is_an_allowlisted_event_about_one_chat_and_carries_ids_and_a_count() {
    let payload = crate::commands::workflows::state_payload("p1", "research", 2);
    assert_eq!(payload, json!({ "paneId": "p1", "slug": "research", "started": 2 }));
    let frame = events::app_frame(crate::commands::workflows::WORKFLOW_STATE_EVENT, &payload);
    for level in [Level::Watch, Level::Answer, Level::Full] {
        assert_eq!(events::view(level, &frame).unwrap(), frame, "{level:?}");
    }
    assert_eq!(events::app_pane(&frame).as_deref(), Some("p1"), "the door can hold it to that chat's own rule");
    // Without the chat it is about, it is dropped, like every other app event.
    let nameless = events::app_frame("workflow-state", &json!({ "slug": "research" }));
    assert!(events::view(Level::Full, &nameless).is_none());
    // The state frame of a chat is still there beside it.
    let chat = events::app_frame("acp-chat-state", &json!({ "paneId": "p1", "state": {} }));
    assert!(events::view(Level::Watch, &chat).is_some());
}

/// The far PC as two-instance tests see it: the shared fake for everything, plus what the real start does that a PC can see:
/// the `workflow-state` frame (built by the real `state_payload`) in the far PC's event log.
struct FarPc {
    inner: Arc<Fake>,
    log: Mutex<Vec<String>>,
    /// Chats the person shut for other PCs on this PC.
    locked: Mutex<Vec<String>>,
}

impl FarPc {
    fn new() -> Self {
        Self { inner: Arc::default(), log: Mutex::default(), locked: Mutex::default() }
    }
}

impl Services for FarPc {
    fn name(&self) -> String {
        self.inner.name()
    }
    fn ceiling(&self, session: &str) -> Option<Level> {
        if self.locked.lock().unwrap().iter().any(|l| l == session) {
            return None;
        }
        self.inner.ceiling(session)
    }
    fn sessions(&self) -> (u16, Value) {
        self.inner.sessions()
    }
    fn transcript(&self, session: &str, since: Option<u64>) -> (u16, Value) {
        self.inner.transcript(session, since)
    }
    fn transcript_earlier(&self, session: &str, before: &str, limit: Option<usize>) -> (u16, Value) {
        self.inner.transcript_earlier(session, before, limit)
    }
    fn picture(&self, session: &str, path: &str) -> (u16, Value) {
        self.inner.picture(session, path)
    }
    fn projects(&self) -> (u16, Value) {
        self.inner.projects()
    }
    fn usage(&self) -> (u16, Value) {
        self.inner.usage()
    }
    fn agents(&self) -> (u16, Value) {
        self.inner.agents()
    }
    fn questions(&self, full: bool) -> (u16, Value) {
        self.inner.questions(full)
    }
    fn outbox(&self, session: &str) -> (u16, Value) {
        self.inner.outbox(session)
    }
    fn send(&self, node: &str, session: &str, text: &str, full: bool) -> (u16, Value) {
        self.inner.send(node, session, text, full)
    }
    fn cancel_message(&self, session: &str, message: &str) -> (u16, Value) {
        self.inner.cancel_message(session, message)
    }
    fn interrupt(&self, session: &str) -> (u16, Value) {
        self.inner.interrupt(session)
    }
    fn answer_question(&self, id: &str, body: &Value, full: bool) -> (u16, Value) {
        self.inner.answer_question(id, body, full)
    }
    fn set_config(&self, node: &str, session: &str, option: &str, value: &str, hold: bool) -> (u16, Value) {
        self.inner.set_config(node, session, option, value, hold)
    }
    fn models(&self, agent: &str) -> (u16, Value) {
        self.inner.models(agent)
    }
    fn browse(&self, root: Option<&str>, sub: &str) -> (u16, Value) {
        self.inner.browse(root, sub)
    }
    fn open_folder(&self, root: &str, sub: &str) -> (u16, Value) {
        self.inner.open_folder(root, sub)
    }
    fn start(&self, node: &str, agent: &str, project: &str, lane: &str, body: &Value) -> (u16, Value) {
        self.inner.start(node, agent, project, lane, body)
    }
    fn warm(&self, agent: &str, project: &str) -> (u16, Value) {
        self.inner.warm(agent, project)
    }
    fn close(&self, node: &str, session: &str) -> (u16, Value) {
        self.inner.close(node, session)
    }
    fn known_folder(&self, path: &str) -> bool {
        self.inner.known_folder(path)
    }
    fn move_work(&self, project: &str, branch: &str, bundle_b64: &str) -> (u16, Value) {
        self.inner.move_work(project, branch, bundle_b64)
    }
    fn call(&self, node: &str, cmd: &str, args: &Value) -> (u16, Value) {
        let out = self.inner.call(node, cmd, args);
        if cmd == "workflows_start_helpers" {
            let front = args["frontPane"].as_str().unwrap_or("");
            let payload = crate::commands::workflows::state_payload(front, args["slug"].as_str().unwrap_or(""), 2);
            self.log.lock().unwrap().push(events::app_frame(crate::commands::workflows::WORKFLOW_STATE_EVENT, &payload));
        }
        out
    }
    fn notify_full_request(&self, ask: &super::Ask) {
        self.inner.notify_full_request(ask)
    }
    fn events(&self, cursor: Option<u64>, wait: Duration, view: &EventView<'_>) -> (u64, String) {
        let from = cursor.unwrap_or(0) as usize;
        let end = std::time::Instant::now() + wait.min(Duration::from_millis(50));
        loop {
            let log = self.log.lock().unwrap().clone();
            if log.len() > from || std::time::Instant::now() >= end {
                return (log.len() as u64, log[from.min(log.len())..].iter().filter_map(|p| view(p)).map(|c| c.into_owned()).collect());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_far_workflow_start_runs_on_the_far_pc_and_its_state_frame_comes_back() {
    let net = MemoryNet::new();
    let far = Arc::new(FarPc::new());
    let inner = far.inner.clone();
    let mut options_b = Options::memory();
    options_b.pclink = Some(far.clone());
    let b = instance_with("beta", net.factory(), false, Arc::new(SystemClock), Arc::new(real_now), options_b);
    let mut options_a = Options::memory();
    options_a.pclink = Some(Arc::new(Fake::default()));
    let a = instance_with("alpha", net.factory(), false, Arc::new(SystemClock), Arc::new(real_now), options_a);
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    let got: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = got.clone();
    a.link.set_event_sink(Arc::new(move |_, f| sink.lock().unwrap().push(f.to_string())));
    let start = json!({ "slug": "research", "folder": "p0123456789abcdef", "frontPane": "p1" });

    // Watch reads the workflows but may not start one; nothing ran on the far PC.
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    a.link.subscribe(&b_node).unwrap();
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/workflows_list", Some(json!({}))).await.unwrap().0, 200);
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/workflows_start_helpers", Some(start.clone())).await.unwrap().0, 403);
    b.link.set_permission(&a_node, true, Some("answer")).unwrap();
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/workflows_start_helpers", Some(start.clone())).await.unwrap().0, 403);
    assert!(!inner.calls().iter().any(|c| c.contains("workflows_start_helpers")));

    // Full: it runs on the far PC, and the far PC's workflow-state frame arrives.
    b.link.set_permission(&a_node, true, Some("full")).unwrap();
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/workflows_start_helpers", Some(start)).await.unwrap().0, 200);
    assert!(inner.calls().iter().any(|c| c.contains("workflows_start_helpers")));
    until("the workflow-state frame", || got.lock().unwrap().iter().any(|f| f.starts_with("event: app") && f.contains("workflow-state") && f.contains("\"paneId\":\"p1\"") && f.contains("\"started\":2"))).await;
    a.link.unsubscribe(&b_node).unwrap();
}
