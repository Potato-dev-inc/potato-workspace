//! What the PC link's routes do on a screen-less host. It says who it is, lists its projects, serves the far Files and git rows for a
//! known project, and runs the chat: start, transcript, cards, messages, Stop and a chat's settings, through the SAME functions the
//! app calls (`pm_core::device_link::pclink::engine_services`). Terminals, worktrees, checkpoints and everything that needs the app's
//! bridge (`agent_runs`, MCP, standby, handover) answer 404 `NOT_ON_THIS_MACHINE`, so the asking PC draws those controls disabled. The
//! rights were checked by `pclink::handle` (pm-core) before any of this runs, with the same table the app uses.

mod chat;
mod files;
mod terminal;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pm_core::device_link::pclink::engine_services as engine;
use pm_core::device_link::pclink::services::EventView;
use pm_core::device_link::pclink::{Ask, Level, Services};
use serde_json::{json, Value};

use crate::projects::Projects;

pub struct HostServices {
    pub name: String,
    pub projects: Projects,
    chat: engine::ProjectChatEnv,
}

pub fn not_here() -> (u16, Value) {
    (404, json!({ "code": "NOT_ON_THIS_MACHINE", "error": "Not on this machine yet." }))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl HostServices {
    pub fn new(name: String, projects: Projects) -> Self {
        let chat = engine::ProjectChatEnv::new(Arc::new(projects.clone()));
        Self { name, projects, chat }
    }

    /// The chats that were open when this machine last stopped come back as panes (nothing starts until one is used).
    pub fn restore_chats(&self) -> usize {
        self.chat.restore_chats()
    }

    /// With a chat environment of its own (a test starts the fake agent through the real rows).
    #[cfg(test)]
    pub fn with_chat(name: String, projects: Projects, chat: engine::ProjectChatEnv) -> Self {
        Self { name, projects, chat }
    }
}

impl Services for HostServices {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn ceiling(&self, _session: &str) -> Option<Level> {
        Some(Level::Full)
    }
    fn sessions(&self) -> (u16, Value) {
        engine::sessions(&self.chat)
    }
    fn transcript(&self, session: &str, since: Option<u64>) -> (u16, Value) {
        engine::transcript(&self.chat, session, since)
    }
    fn transcript_earlier(&self, session: &str, before: &str, limit: Option<usize>) -> (u16, Value) {
        engine::transcript_earlier(&self.chat, session, before, limit)
    }
    fn picture(&self, session: &str, path: &str) -> (u16, Value) {
        engine::picture(&self.chat, session, path)
    }
    fn projects(&self) -> (u16, Value) {
        self.projects.list()
    }
    fn usage(&self) -> (u16, Value) {
        (200, json!({ "rows": [], "refreshed_at_ms": now_ms() }))
    }
    fn agents(&self) -> (u16, Value) {
        // Chats only: a terminal is not offered on this machine yet (`need_terminals` stays 0: there is no hidden terminal switch to turn on).
        let (agents, _) = engine::offered_agents(&engine::chat_agents(), &[], false);
        (200, json!({ "agents": agents, "terminals": false, "need_terminals": 0 }))
    }
    fn questions(&self, full: bool) -> (u16, Value) {
        engine::questions(&self.chat, full)
    }
    fn outbox(&self, session: &str) -> (u16, Value) {
        engine::outbox_list(&self.chat, session)
    }
    fn send(&self, node: &str, session: &str, text: &str, full: bool) -> (u16, Value) {
        engine::send_message(&self.chat, node, session, text, full, &[])
    }
    fn cancel_message(&self, session: &str, message: &str) -> (u16, Value) {
        engine::cancel_message(&self.chat, session, message)
    }
    fn interrupt(&self, session: &str) -> (u16, Value) {
        engine::interrupt(&self.chat, session)
    }
    fn answer_question(&self, id: &str, body: &Value, full: bool) -> (u16, Value) {
        engine::answer_question(&self.chat, id, body, full)
    }
    fn set_config(&self, node: &str, session: &str, option: &str, value: &str, hold: bool) -> (u16, Value) {
        engine::set_config_as(&self.chat, node, session, option, value, hold, hold)
    }
    fn models(&self, _: &str) -> (u16, Value) {
        not_here()
    }
    fn browse(&self, root: Option<&str>, sub: &str) -> (u16, Value) {
        self.projects.browse(root, sub)
    }
    fn open_folder(&self, root: &str, sub: &str) -> (u16, Value) {
        self.projects.open_folder(root, sub)
    }
    fn start(&self, node: &str, agent: &str, project: &str, lane: &str, body: &Value) -> (u16, Value) {
        chat::start(&self.chat, &self.projects, node, agent, project, lane, body)
    }
    fn warm(&self, agent: &str, project: &str) -> (u16, Value) {
        engine::warm(&self.chat, agent, project)
    }
    fn close(&self, _node: &str, session: &str) -> (u16, Value) {
        engine::close_session(&self.chat, session)
    }
    fn known_folder(&self, path: &str) -> bool {
        self.projects.known_folder(path)
    }
    fn move_work(&self, _: &str, _: &str, _: &str) -> (u16, Value) {
        not_here()
    }
    fn call(&self, node: &str, cmd: &str, args: &Value) -> (u16, Value) {
        files::call(&self.chat, node, cmd, args).or_else(|| chat::call(&self.chat, node, cmd, args)).unwrap_or_else(not_here)
    }
    fn notify_full_request(&self, _ask: &Ask) {
        // No screen to show a card on, and nothing is ever granted by asking. Never prints the peer's text.
        eprintln!("potato-host: a paired PC asked for more rights; change rights with the PC that set this machine up.");
    }
    fn events(&self, cursor: Option<u64>, wait: Duration, _view: &EventView<'_>) -> (u64, String) {
        // No event log feeds a host yet, so the poll holds like the app's when nothing happens: a far screen reads a chat by asking for its
        // transcript from a revision (`transcript`), not from pushed frames.
        std::thread::sleep(wait.min(Duration::from_secs(25)));
        (cursor.unwrap_or(0), String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pm_core::device_link::pclink::{handle, Asks, Caller};

    fn call(level: Option<Level>, method: &str, target: &str, body: &str) -> (u16, Value) {
        // A data folder of its own beside the test exe (in the cargo target folder), empty each time.
        let dir = std::env::current_exe().unwrap().parent().unwrap().join("host-services-tests");
        let _ = std::fs::remove_dir_all(&dir);
        let svc = HostServices::new("box".into(), Projects::open(&dir, None));
        let who = Caller { node: "aa", name: "PC", level, marked: false, now_ms: 1 };
        handle(&who, &svc, &Asks::new(), method, target, body.as_bytes())
    }

    /// The host answers through pm-core's own route table and rights: the same code the app runs.
    #[test]
    fn the_shared_rights_code_guards_the_host() {
        assert_eq!(call(None, "GET", "/pclink/me", "").0, 403, "switch off: nothing");
        let (status, me) = call(Some(Level::Watch), "GET", "/pclink/me", "");
        assert_eq!((status, me["name"].as_str(), me["level"].as_str()), (200, Some("box"), Some("watch")));
        assert_eq!(call(Some(Level::Watch), "POST", "/pclink/agents/start", r#"{"agent":"claude","project":"p"}"#).0, 403, "Watch may not start");
        assert_eq!(call(Some(Level::Full), "POST", "/pclink/call/secret_set", "{}").0, 404, "refused commands are never served");
        // A chat that is not here is a plain null (the app's own answer for a pane that is no chat), not a path or a crash.
        assert_eq!(call(Some(Level::Full), "POST", "/pclink/call/acp_chat_state", r#"{"paneId":"p1"}"#), (200, Value::Null));
        assert_eq!(call(Some(Level::Full), "POST", "/pclink/call/checkpoints_list", r#"{"paneId":"p1"}"#).1["code"], "NOT_ON_THIS_MACHINE");
        assert_eq!(call(Some(Level::Full), "GET", "/phone/panes", "").0, 404, "no phone route");
    }

    #[test]
    fn lists_are_empty_not_errors() {
        assert_eq!(call(Some(Level::Watch), "GET", "/pclink/sessions", "").1, json!({ "sessions": [] }));
        assert!(call(Some(Level::Watch), "GET", "/pclink/agents", "").1["agents"].is_array(), "chat agents only: whichever are installed here");
        assert_eq!(call(Some(Level::Watch), "GET", "/pclink/projects", "").1, json!({ "projects": [] }));
    }
}
