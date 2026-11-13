//! The two rigs the chaos tests and the vector runner drive (SPEC-CHAOS-1113 section 1.4).
//!
//! Both are copies of the private `Rig`s in `acp/tests.rs` (session level) and `acp/chat/tests.rs` (chat level), made
//! `pub(crate)` and given the helpers a chaos test needs. The originals stay untouched.
//!
//! * [`AcpRig`]: one `AcpSession` over the fake agent. Events, turns, the agent's pid, a launcher file that can be
//!   deleted, and the clock seam (`tick`).
//! * [`ChatRig`]: one or more `AcpChat`s over the fake agent with the real pane registry and question store. It reads
//!   what a person reads (`notices()`), can show the same chat in a second window (`add_viewer`), and can quit and
//!   reopen the app over one conversations store (`quit` / `reopen`).

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;

use crate::acp::chat::{self, AcpChat, ChatHost, SendError, Sent, StartDeps, StartRequest};
use crate::acp::config::{AgentConfig, HostEnv};
use crate::acp::conversations::{AgentSource, Conversations};
use crate::acp::fake_agent;
use crate::acp::handover::{PaneActivity, PaneHost, TerminalStart};
use crate::acp::record::RecordStore;
use crate::acp::session::{AcpSession, SessionEvent, SessionParams, TickAction};
use crate::acp::state::{Phase, TurnSummary};
use crate::acp::supervisor::{Supervisor, SupervisorConfig};
use crate::proc_util::pid_alive;
use crate::pty::status::PaneStatus;
use crate::pty::PaneRegistry;
use crate::questions::{self, now_ms, Question};

/// Where the fake's files and the rig's folders live: a fresh folder under the system temp dir.
pub(crate) fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-conf-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("a temp folder");
    dir
}

pub(crate) fn wait_until(secs: u64, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    condition()
}

struct RigEnv {
    root: PathBuf,
}

impl HostEnv for RigEnv {
    fn var(&self, name: &str) -> Option<std::ffi::OsString> {
        std::env::var_os(name)
    }
    fn which(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn adapters_dir(&self) -> PathBuf {
        self.root.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.root.join("homes")
    }
}

// ---- AcpRig -------------------------------------------------------------------------------------------------------

/// One ACP session over the fake agent.
pub(crate) struct AcpRig {
    pub(crate) session: Arc<AcpSession>,
    log: Arc<Mutex<Vec<SessionEvent>>>,
    pub(crate) dir: PathBuf,
}

impl AcpRig {
    pub(crate) fn new(opts: &str) -> AcpRig {
        AcpRig::with(opts, |_| {})
    }

    pub(crate) fn with(opts: &str, tweak: impl FnOnce(&mut AgentConfig)) -> AcpRig {
        let dir = temp_dir("acp");
        AcpRig::in_dir(dir, opts, tweak)
    }

    /// Starts the agent through `launch-agent.cmd` in the rig's folder (see [`AcpRig::launcher_cmd`]), so a test can delete the
    /// program while the chat runs.
    pub(crate) fn via_launcher(opts: &str, tweak: impl FnOnce(&mut AgentConfig)) -> AcpRig {
        let dir = temp_dir("acp");
        let launcher = dir.join("launch-agent.cmd");
        let exe = std::env::current_exe().expect("test exe");
        let script = format!(
            "@echo off\r\n\"{}\" --exact acp::fake_agent::tests::child_entry --nocapture --test-threads=1\r\n",
            exe.display()
        );
        std::fs::write(&launcher, script).expect("the launcher file");
        let command = launcher.to_string_lossy().into_owned();
        AcpRig::in_dir(dir, opts, move |cfg| {
            cfg.command = command;
            cfg.args = Vec::new();
            tweak(cfg);
        })
    }

    fn in_dir(dir: PathBuf, opts: &str, tweak: impl FnOnce(&mut AgentConfig)) -> AcpRig {
        let mut cfg = fake_agent::agent_config(opts, &dir.join("store"));
        tweak(&mut cfg);
        let host: Arc<dyn HostEnv> = Arc::new(RigEnv { root: dir.clone() });
        let session = AcpSession::new(Arc::new(cfg), host, SessionParams { key: format!("t-{}", uuid::Uuid::new_v4()), cwd: dir.clone(), resume_session_id: None });
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink_log = log.clone();
        session.add_sink(Arc::new(move |event| sink_log.lock().push(event.clone())));
        AcpRig { session, log, dir }
    }

    /// The `.cmd` file a [`AcpRig::via_launcher`] rig starts the agent through.
    pub(crate) fn launcher_cmd(&self) -> PathBuf {
        self.dir.join("launch-agent.cmd")
    }

    pub(crate) fn events(&self) -> Vec<SessionEvent> {
        self.log.lock().clone()
    }

    pub(crate) fn mark(&self) -> usize {
        self.log.lock().len()
    }

    /// First event at or after `from` that satisfies `pred`.
    pub(crate) fn wait_event(&self, from: usize, pred: impl Fn(&SessionEvent) -> bool, secs: u64) -> Option<(usize, SessionEvent)> {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            {
                let log = self.log.lock();
                if let Some((at, event)) = log.iter().enumerate().skip(from).find(|(_, e)| pred(e)) {
                    return Some((at, event.clone()));
                }
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub(crate) fn wait_turn_end(&self, from: usize) -> TurnSummary {
        match self.wait_event(from, |e| matches!(e, SessionEvent::TurnEnded(_)), 30) {
            Some((_, SessionEvent::TurnEnded(summary))) => summary,
            _ => panic!("the turn did not end; events: {:#?}", self.events().iter().map(brief).collect::<Vec<_>>()),
        }
    }

    /// Sends one message and waits (up to 30 s) for the turn to end.
    pub(crate) fn run_turn(&self, text: &str) -> TurnSummary {
        let from = self.mark();
        self.session.prompt_text(text).unwrap_or_else(|e| panic!("prompt {text:?} failed: {e}"));
        self.wait_turn_end(from)
    }

    /// The agent's message text since event index `from`.
    pub(crate) fn text_since(&self, from: usize) -> String {
        chunks_since(&self.events(), from).concat()
    }

    /// The pid of the live agent process.
    pub(crate) fn pid(&self) -> u32 {
        self.session.connection().expect("a live connection").pid()
    }

    pub(crate) fn wait_phase(&self, phase: Phase) -> crate::acp::state::Snapshot {
        self.session.wait_for(|s| s.phase == phase, Duration::from_secs(20)).unwrap_or_else(|| panic!("never reached {phase:?}; now {}", self.session.snapshot()))
    }

    /// The clock seam: one supervisor tick at `now`.
    pub(crate) fn tick(&self, now: Instant) -> TickAction {
        self.session.tick(now)
    }

    /// The pid of the agent's grandchild (`grandchild=1`), once the agent wrote it down.
    pub(crate) fn grandchild_pid(&self) -> Option<u32> {
        std::fs::read_to_string(self.dir.join("store").join("grandchild.pid")).ok().and_then(|t| t.trim().parse().ok())
    }
}

impl Drop for AcpRig {
    fn drop(&mut self) {
        self.session.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub(crate) fn brief(event: &SessionEvent) -> String {
    match event {
        SessionEvent::Update { update, replay } => format!("Update(replay={replay}) {}", serde_json::to_value(update.as_ref()).map(|v| v["sessionUpdate"].to_string()).unwrap_or_default()),
        SessionEvent::Snapshot(s) => format!("Snapshot({s})"),
        other => format!("{other:?}").chars().take(120).collect(),
    }
}

/// Every non-replayed `agent_message_chunk` text since event index `from`.
pub(crate) fn chunks_since(events: &[SessionEvent], from: usize) -> Vec<String> {
    events
        .iter()
        .skip(from)
        .filter_map(|e| match e {
            SessionEvent::Update { update, replay: false } => match serde_json::to_value(update.as_ref()) {
                Ok(v) if v["sessionUpdate"] == "agent_message_chunk" => v["content"]["text"].as_str().map(str::to_string),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

// ---- ChatRig ------------------------------------------------------------------------------------------------------

#[derive(Default)]
pub(crate) struct Recorder {
    statuses: Mutex<Vec<(String, PaneStatus)>>,
    pub(crate) question_changes: AtomicUsize,
    pub(crate) pane_changes: AtomicUsize,
    pub(crate) states: AtomicUsize,
}

impl ChatHost for Recorder {
    fn status_changed(&self, pane_id: &str, status: PaneStatus) {
        self.statuses.lock().push((pane_id.to_string(), status));
    }
    fn state_changed(&self, _: &str, _: &Value) {
        self.states.fetch_add(1, Ordering::SeqCst);
    }
    fn questions_changed(&self, _: Option<&Question>) {
        self.question_changes.fetch_add(1, Ordering::SeqCst);
    }
    fn panes_changed(&self) {
        self.pane_changes.fetch_add(1, Ordering::SeqCst);
    }
}

struct Agents(std::collections::BTreeMap<String, Arc<AgentConfig>>);

impl AgentSource for Agents {
    fn config(&self, agent: &str) -> Option<Arc<AgentConfig>> {
        self.0.get(agent).cloned()
    }
}

/// Panes that exist only as a table: no terminal is ever started by a chat rig.
struct NoTerminals;

impl PaneHost for NoTerminals {
    fn start(&self, _: &TerminalStart) -> Result<String, String> {
        Err("a chat rig has no terminals".into())
    }
    fn activity(&self, _: &str) -> PaneActivity {
        PaneActivity::Gone
    }
    fn stop(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// A second window on the same chat: it reads the chat's items on its own.
pub(crate) struct ChatViewer {
    chat: Arc<AcpChat>,
}

impl ChatViewer {
    pub(crate) fn items(&self) -> Vec<Value> {
        self.chat.items().iter().map(|i| serde_json::to_value(i).unwrap()).collect()
    }
}

/// What starting a chat needs from the app, over a throw-away registry.
pub(crate) fn start_deps() -> StartDeps {
    StartDeps { registry: Arc::new(Mutex::new(PaneRegistry::new())), host: Arc::new(Recorder::default()), env: Arc::new(RigEnv { root: std::env::temp_dir() }), conversations: None }
}

/// One conversation (or more) over the fake agent, with the real registry, question store and chat code.
pub(crate) struct ChatRig {
    pub(crate) chat: Arc<AcpChat>,
    pub(crate) registry: Arc<Mutex<PaneRegistry>>,
    pub(crate) host: Arc<Recorder>,
    pub(crate) dir: PathBuf,
    opts: String,
    conversations: Option<Conversations>,
    /// Every agent pid this rig has seen, so `alive_pids()` can tell what is left.
    seen_pids: Mutex<Vec<u32>>,
    tweak_secs: Mutex<Option<Arc<dyn Fn(&mut AgentConfig) + Send + Sync>>>,
}

impl ChatRig {
    pub(crate) fn new(opts: &str) -> ChatRig {
        ChatRig::with(opts, |_| {})
    }

    pub(crate) fn with(opts: &str, tweak: impl Fn(&mut AgentConfig) + Send + Sync + 'static) -> ChatRig {
        let dir = temp_dir("chat");
        let tweak: Arc<dyn Fn(&mut AgentConfig) + Send + Sync> = Arc::new(tweak);
        let mut cfg = fake_agent::agent_config(opts, &dir.join("store"));
        tweak(&mut cfg);
        let registry = Arc::new(Mutex::new(PaneRegistry::new()));
        let host = Arc::new(Recorder::default());
        let deps = StartDeps { registry: registry.clone(), host: host.clone(), env: Arc::new(RigEnv { root: dir.clone() }), conversations: None };
        let chat = chat::start(&deps, cfg, StartRequest { agent_id: "fake".into(), folder: dir.clone(), explicit: true, account: None, ..Default::default() }).expect("the fake agent starts");
        let rig = ChatRig { chat, registry, host, dir, opts: opts.to_string(), conversations: None, seen_pids: Mutex::new(Vec::new()), tweak_secs: Mutex::new(Some(tweak)) };
        rig.note_pid();
        rig
    }

    /// A rig whose chats are saved conversations in a store under its folder, so [`ChatRig::quit`] and [`ChatRig::reopen`] mean
    /// something. `chats` conversations are started, each with its own folder.
    pub(crate) fn with_store(opts: &str, chats: usize) -> ChatRig {
        let dir = temp_dir("chatstore");
        let conversations = conversations_in(&dir, opts);
        let registry = Arc::new(Mutex::new(PaneRegistry::new()));
        let host = Arc::new(Recorder::default());
        let deps = StartDeps { registry: registry.clone(), host: host.clone(), env: Arc::new(RigEnv { root: dir.clone() }), conversations: Some(conversations.clone()) };
        let mut first = None;
        for n in 0..chats.max(1) {
            let folder = dir.join(format!("work{n}"));
            std::fs::create_dir_all(&folder).unwrap();
            let cfg = store_config(&dir, opts);
            let chat = chat::start(&deps, cfg, StartRequest { agent_id: "fake".into(), folder, explicit: true, account: None, ..Default::default() }).expect("the fake agent starts");
            first.get_or_insert(chat);
        }
        let rig = ChatRig { chat: first.expect("one chat"), registry, host, dir, opts: opts.to_string(), conversations: Some(conversations), seen_pids: Mutex::new(Vec::new()), tweak_secs: Mutex::new(None) };
        rig.note_pid();
        rig
    }

    fn note_pid(&self) {
        if let Some(conn) = self.chat.session().connection() {
            let mut pids = self.seen_pids.lock();
            if !pids.contains(&conn.pid()) {
                pids.push(conn.pid());
            }
        }
    }

    pub(crate) fn id(&self) -> String {
        self.chat.pane_id().to_string()
    }

    pub(crate) fn items(&self) -> Vec<Value> {
        self.chat.items().iter().map(|i| serde_json::to_value(i).unwrap()).collect()
    }

    pub(crate) fn kinds(&self) -> Vec<String> {
        self.items().iter().map(|i| i["kind"].as_str().unwrap_or("?").to_string()).collect()
    }

    pub(crate) fn phase(&self) -> Phase {
        self.chat.session().snapshot().phase
    }

    pub(crate) fn wait_phase(&self, phase: Phase) {
        assert!(wait_until(30, || self.phase() == phase), "wanted {phase:?}, the session is {:?}; items: {:#?}", self.phase(), self.kinds());
    }

    /// Starts a message without waiting.
    pub(crate) fn send(&self, text: &str) -> Result<Sent, SendError> {
        let sent = self.chat.send(text);
        self.note_pid();
        sent
    }

    /// Sends a message and waits until the turn is over.
    pub(crate) fn say(&self, text: &str) {
        self.send(text).unwrap_or_else(|e| panic!("send {text:?}: {e:?}"));
        assert!(wait_until(30, || self.turn_over()), "the turn did not end: {:#?}", self.kinds());
        self.note_pid();
    }

    /// The turn that was last started has a `turnEnd` item.
    pub(crate) fn turn_over(&self) -> bool {
        let turn = self.chat.session().snapshot().turn;
        self.items().iter().any(|i| i["kind"] == "turnEnd" && i["id"] == format!("end:{turn}"))
    }

    /// What a person reads in notices, in order (the sentence of every `notice` item).
    pub(crate) fn notices(&self) -> Vec<String> {
        self.items().iter().filter(|i| i["kind"] == "notice").filter_map(|i| i["text"].as_str().map(str::to_string)).collect()
    }

    pub(crate) fn last_notice(&self) -> Option<String> {
        self.notices().pop()
    }

    /// How each finished turn ended (`completed`, `failed`, ...), in order.
    pub(crate) fn outcomes(&self) -> Vec<String> {
        self.items().iter().filter(|i| i["kind"] == "turnEnd").filter_map(|i| i["outcome"].as_str().map(str::to_string)).collect()
    }

    /// The text of the last answer of the agent.
    pub(crate) fn last_answer(&self) -> Option<String> {
        self.items().iter().rev().find(|i| i["kind"] == "assistant").and_then(|i| i["text"].as_str().map(str::to_string))
    }

    pub(crate) fn pane_status(&self) -> String {
        self.registry.lock().get(&self.id()).expect("the pane").info().status
    }

    /// The pending permission cards of this pane.
    pub(crate) fn cards(&self) -> Vec<Question> {
        let id = self.id();
        questions::store().list_pending(now_ms()).into_iter().filter(|q| q.pane_id.as_deref() == Some(id.as_str())).collect()
    }

    pub(crate) fn wait_card(&self) -> Question {
        assert!(wait_until(30, || !self.cards().is_empty()), "no permission card was raised; items {:#?}", self.kinds());
        self.cards().remove(0)
    }

    /// A second window on the same chat.
    pub(crate) fn add_viewer(&self) -> ChatViewer {
        ChatViewer { chat: self.chat.clone() }
    }

    /// The agent processes this rig started that are still running.
    pub(crate) fn alive_pids(&self) -> Vec<u32> {
        self.note_pid();
        self.seen_pids.lock().iter().copied().filter(|pid| pid_alive(*pid)).collect()
    }

    /// The app quits: every chat's session stops, its conversation record stays as it was (so the next start brings it back).
    pub(crate) fn quit(&self) {
        for id in self.conversation_ids() {
            if let Some(chat) = chat::get(&id) {
                self.note_pid_of(&chat);
                chat.retire();
            }
        }
        if self.conversations.is_none() {
            self.chat.retire();
        }
    }

    fn note_pid_of(&self, chat: &Arc<AcpChat>) {
        if let Some(conn) = chat.session().connection() {
            let mut pids = self.seen_pids.lock();
            if !pids.contains(&conn.pid()) {
                pids.push(conn.pid());
            }
        }
    }

    /// The conversation ids this rig holds (the saved ones; the single chat's id for a rig with no store).
    pub(crate) fn conversation_ids(&self) -> Vec<String> {
        match &self.conversations {
            Some(c) => c.list().into_iter().map(|v| v.id).collect(),
            None => vec![self.id()],
        }
    }

    /// The app starts again over the same store: a new `Conversations`, the pane of every open conversation listed, nothing
    /// started. Returns the pane ids that came back.
    pub(crate) fn reopen(&mut self) -> Vec<String> {
        let conversations = conversations_in(&self.dir, &self.opts);
        conversations.restore_lazily(&NoTerminals);
        self.registry = Arc::new(Mutex::new(PaneRegistry::new()));
        let deps = StartDeps { registry: self.registry.clone(), host: self.host.clone(), env: Arc::new(RigEnv { root: self.dir.clone() }), conversations: Some(conversations.clone()) };
        let ids = chat::restore_panes(&deps);
        self.conversations = Some(conversations);
        if let Some(chat) = ids.first().and_then(|id| chat::get(id)) {
            self.chat = chat;
        }
        ids
    }

    /// The chat of conversation `id` (after [`ChatRig::reopen`]).
    pub(crate) fn chat_of(&self, id: &str) -> Option<Arc<AcpChat>> {
        chat::get(id)
    }
}

impl Drop for ChatRig {
    fn drop(&mut self) {
        match &self.conversations {
            Some(c) => {
                for view in c.list() {
                    chat::on_pane_closed(&view.id);
                }
            }
            None => chat::on_pane_closed(&self.id()),
        }
        let _ = self.tweak_secs.lock().take();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn store_config(dir: &Path, opts: &str) -> AgentConfig {
    let mut cfg = fake_agent::agent_config(opts, &dir.join("agent-sessions"));
    cfg.resume_command = vec!["resume".into(), "{session}".into()];
    cfg
}

fn conversations_in(dir: &Path, opts: &str) -> Conversations {
    let agents = Arc::new(Agents(std::collections::BTreeMap::from([("fake".to_string(), Arc::new(store_config(dir, opts)))])));
    let host: Arc<dyn HostEnv> = Arc::new(RigEnv { root: dir.to_path_buf() });
    Conversations::new(RecordStore::at(dir.join("conversations.json")), Arc::new(Supervisor::new(SupervisorConfig::default())), host, agents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_acp_rig_runs_a_turn_and_reads_its_text() {
        let rig = AcpRig::new("");
        let from = rig.mark();
        let summary = rig.run_turn("stream 3");
        assert_eq!(summary.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(rig.text_since(from), "w0 w1 w2 ");
        assert!(pid_alive(rig.pid()));
    }

    #[test]
    fn the_acp_rig_can_start_the_agent_through_a_launcher_file_a_test_can_delete() {
        let rig = AcpRig::via_launcher("", |_| {});
        assert!(rig.launcher_cmd().exists());
        let summary = rig.run_turn("stream 2");
        assert_eq!(summary.stop_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn the_chat_rig_reads_notices_answers_and_leftovers() {
        let rig = ChatRig::new("");
        rig.say("stream 2");
        assert_eq!(rig.last_answer().as_deref(), Some("w0 w1 "));
        assert_eq!(rig.outcomes(), ["completed"]);
        assert!(rig.last_notice().is_some());
        let viewer = rig.add_viewer();
        assert_eq!(viewer.items().len(), rig.items().len());
        let pids = rig.alive_pids();
        assert_eq!(pids.len(), 1, "the one live agent");
        rig.chat.close();
        assert!(wait_until(10, || rig.alive_pids().is_empty()), "the agent is gone after close");
    }

    #[test]
    fn the_chat_rig_quits_and_reopens_over_one_store() {
        let mut rig = ChatRig::with_store("", 2);
        for id in rig.conversation_ids() {
            let chat = rig.chat_of(&id).expect("a chat per conversation");
            chat.send("stream 2").unwrap();
            assert!(wait_until(30, || chat.items().iter().any(|i| serde_json::to_value(i).map(|v| v["kind"] == "turnEnd").unwrap_or(false))));
        }
        rig.quit();
        assert!(wait_until(10, || rig.alive_pids().is_empty()), "quitting stops every agent");
        let back = rig.reopen();
        assert_eq!(back.len(), 2, "both chats are listed again");
        assert!(rig.alive_pids().is_empty(), "no agent runs until a chat is opened");
    }
}
