//! A chat started from a warm session (`acp::warm`) against the fake agent, real processes: it is the same chat, minus the
//! adapter's startup. The fake agent is slowed (`init_delay_ms`, `new_delay_ms`) like a real adapter.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::{start, StartDeps, StartRequest};
use crate::acp::chat::{AcpChat, QuietHost};
use crate::acp::config::{AgentConfig, HostEnv};
use crate::acp::conversations::{AgentSource, Conversations};
use crate::acp::fake_agent;
use crate::acp::record::{LastState, RecordStore};
use crate::acp::supervisor::{Supervisor, SupervisorConfig};
use crate::acp::warm::{self, LiveHost, Policy, Pool, WarmKey, WarmWant};
use crate::pty::PaneRegistry;

struct Env {
    root: PathBuf,
}

impl HostEnv for Env {
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

struct Agents(BTreeMap<String, Arc<AgentConfig>>);

impl AgentSource for Agents {
    fn config(&self, agent: &str) -> Option<Arc<AgentConfig>> {
        self.0.get(agent).cloned()
    }
}

fn wait_until(secs: u64, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    condition()
}

struct Rig {
    dir: PathBuf,
    cfg: AgentConfig,
    conversations: Conversations,
    deps: StartDeps,
    chats: Vec<Arc<AcpChat>>,
}

impl Rig {
    fn new(opts: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("pm-acp-warm-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = fake_agent::agent_config(opts, &dir.join("agent-sessions"));
        let agents = Arc::new(Agents(BTreeMap::from([("fake".to_string(), Arc::new(cfg.clone()))])));
        let env: Arc<dyn HostEnv> = Arc::new(Env { root: dir.clone() });
        let conversations = Conversations::new(RecordStore::at(dir.join("conversations.json")), Arc::new(Supervisor::new(SupervisorConfig::default())), env.clone(), agents);
        let deps = StartDeps { registry: Arc::new(Mutex::new(PaneRegistry::new())), host: Arc::new(QuietHost), env, conversations: Some(conversations.clone()) };
        Rig { dir, cfg, conversations, deps, chats: Vec::new() }
    }

    fn request(&self) -> StartRequest {
        StartRequest { agent_id: "fake".into(), folder: self.dir.clone(), explicit: true, account: None }
    }

    /// `start()` to the chat being ready, then a tiny prompt to its answer. Returns the chat and both times.
    fn start_and_say(&mut self) -> (Arc<AcpChat>, Duration, Duration) {
        let begun = Instant::now();
        let chat = start(&self.deps, self.cfg.clone(), self.request()).expect("the fake agent starts");
        let ready = begun.elapsed();
        chat.send("stream 1").unwrap_or_else(|e| panic!("send: {e:?}"));
        let turn = chat.session().snapshot().turn;
        assert!(wait_until(30, || chat.items().iter().any(|i| serde_json::to_value(i).unwrap()["id"] == format!("end:{turn}"))), "the turn did not end");
        let answered = begun.elapsed();
        self.chats.push(chat.clone());
        (chat, ready, answered)
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        for chat in &self.chats {
            chat.retire();
            let _ = self.conversations.close(chat.pane_id());
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Puts the pool where `start` finds it, and takes it away (and kills what it holds) when dropped.
struct Installed(Arc<Pool<LiveHost>>);

impl Drop for Installed {
    fn drop(&mut self) {
        warm::install(None);
        self.0.shutdown();
    }
}

fn item_kinds(chat: &AcpChat) -> Vec<String> {
    chat.items().iter().map(|i| i.id().split(':').next().unwrap_or_default().to_string()).collect()
}

#[test]
fn a_chat_from_a_warm_session_is_ready_at_once_and_is_the_same_chat() {
    let mut rig = Rig::new("init_delay_ms=300;new_delay_ms=500");

    // Cold: the adapter starts inside start().
    let (cold, cold_ready, cold_answer) = rig.start_and_say();
    assert!(!cold.warm_claimed());
    let cold_kinds = item_kinds(&cold);

    // A pool that wants this agent in this folder; its session starts in the background.
    let host = Arc::new(LiveHost { conversations: rig.conversations.clone() });
    let pool = Pool::new(host);
    let key = WarmKey::new("fake", &rig.dir.to_string_lossy(), None);
    pool.set_policy(Policy { wanted: vec![WarmWant { key: key.clone(), folder: rig.dir.clone() }], cap: 4, idle_ms: 20 * 60_000, recent_ms: 3_600_000, ..Policy::default() });
    let _installed = Installed(pool.clone());
    warm::install(Some(pool.clone()));
    pool.tick(crate::event_log::now_ms());
    assert!(wait_until(30, || pool.ready_counts().get("fake") == Some(&1)), "the warm session did not become ready");

    // Warm: start() takes it.
    let (warm_chat, warm_ready, warm_answer) = rig.start_and_say();
    assert!(warm_chat.warm_claimed(), "the start used the warm session");
    println!("TIMING cold: ready {cold_ready:?}, first reply {cold_answer:?}");
    println!("TIMING warm: ready {warm_ready:?}, first reply {warm_answer:?}");
    assert!(warm_ready < Duration::from_millis(150), "a warm start is ready at once: {warm_ready:?}");
    assert!(cold_ready > Duration::from_millis(700), "the cold start pays the adapter: {cold_ready:?}");
    assert!(warm_answer + Duration::from_millis(500) < cold_answer, "warm {warm_answer:?} vs cold {cold_answer:?}");

    // The same chat: the conversation record, the session, the first items, the writer.
    let id = warm_chat.pane_id().to_string();
    assert!(id.starts_with("acp-"));
    let record = rig.conversations.record(&id).expect("the conversation was recorded");
    assert_eq!(record.agent, "fake");
    assert_eq!(Path::new(&record.cwd), rig.dir.as_path());
    assert_eq!(record.account, None);
    assert_eq!(record.last_known_state, LastState::Live);
    let session_id = warm_chat.session().snapshot().session_id.clone().expect("the session has an id");
    assert_eq!(record.session_id.as_deref(), Some(session_id.as_str()));
    assert!(!record.config_options.is_empty(), "the settings the agent offered were kept");
    assert!(rig.conversations.writer(&id).is_some_and(|w| !w.is_terminal()), "the chat holds the conversation");
    assert!(Arc::ptr_eq(&rig.conversations.session(&id).unwrap(), warm_chat.session()), "the supervisor holds the warm session");
    assert_eq!(item_kinds(&warm_chat), cold_kinds, "the chat shows the same as a cold one: the session item came through");

    // The pool refilled with a new session.
    assert!(wait_until(30, || pool.ready_counts().get("fake") == Some(&1)), "the pool did not refill");
    let again = warm::claim(&rig.cfg, &rig.dir, None).expect("the refilled session is claimable");
    assert_ne!(again.id, id);
    assert_ne!(again.session.snapshot().session_id.as_deref(), Some(session_id.as_str()));
    again.session.close();

    // A start for another folder or account never takes it.
    assert!(warm::claim(&rig.cfg, &rig.dir.join("elsewhere"), None).is_none());
}

#[test]
fn a_warm_session_whose_agent_definition_changed_is_not_used() {
    let mut rig = Rig::new("init_delay_ms=50;new_delay_ms=50");
    let host = Arc::new(LiveHost { conversations: rig.conversations.clone() });
    let pool = Pool::new(host);
    let key = WarmKey::new("fake", &rig.dir.to_string_lossy(), None);
    pool.set_policy(Policy { wanted: vec![WarmWant { key, folder: rig.dir.clone() }], cap: 4, idle_ms: 20 * 60_000, recent_ms: 3_600_000, ..Policy::default() });
    let _installed = Installed(pool.clone());
    warm::install(Some(pool.clone()));
    pool.tick(crate::event_log::now_ms());
    assert!(wait_until(30, || pool.ready_counts().get("fake") == Some(&1)));
    // The start is asked for with a different definition: it is a miss and the cold path runs.
    rig.cfg.args.push("--different".into());
    assert!(warm::claim(&rig.cfg, &rig.dir, None).is_none());
}
