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

use crate::test_support::wait::wait_until;

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
        StartRequest { agent_id: "fake".into(), folder: self.dir.clone(), explicit: true, account: None, ..Default::default() }
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

/// The warm pool is one process-wide slot (`warm::install`). Each test that installs a pool holds this lock for its whole
/// run, so no other test can swap or remove the pool it is claiming from (a parallel test's `install(None)` made a
/// ready session unclaimable).
static WARM_SLOT: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

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
    // Declared first, so it is released after `_installed` has removed the pool.
    let _slot = WARM_SLOT.lock();
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
    let _slot = WARM_SLOT.lock();
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

/// What the phone does: the New chat screen asks for a warm session (`POST /phone/warm`), the person types for a while, then
/// Send starts the chat. Standby ("Keep agents ready") is off here: nothing is wanted and the cap is zero. No desktop window or
/// surface exists (the chat's host is `QuietHost`): the chat starts and answers on its own.
#[test]
fn a_phone_that_opened_new_chat_starts_fast_with_standby_off_and_no_desktop() {
    let _slot = WARM_SLOT.lock();
    let mut rig = Rig::new("init_delay_ms=1200;new_delay_ms=1200");

    // Before: Send on a cold PC pays the whole adapter startup.
    let (cold, cold_ready, cold_answer) = rig.start_and_say();
    assert!(!cold.warm_claimed());

    let host = Arc::new(LiveHost { conversations: rig.conversations.clone() });
    let pool = Pool::new(host);
    pool.set_policy(Policy { cap: 0, idle_ms: 20 * 60_000, recent_ms: 3_600_000, ..Policy::default() });
    let _installed = Installed(pool.clone());
    warm::install(Some(pool.clone()));

    // After, the person reads and types for 3 s before pressing Send: the session is ready, the start is instant.
    let key = WarmKey::new("fake", &rig.dir.to_string_lossy(), None);
    pool.hint(&key, &rig.dir, crate::event_log::now_ms(), 300_000);
    pool.tick(crate::event_log::now_ms());
    assert!(wait_until(30, || pool.ready_counts().get("fake") == Some(&1)), "the warm session became ready while the person typed");
    let (typed, typed_ready, typed_answer) = rig.start_and_say();
    assert!(typed.warm_claimed(), "the start used the session the phone asked for");

    // After, Send pressed as soon as the start is under way: the start waits for the session that is part of the way instead of starting another.
    pool.hint(&key, &rig.dir, crate::event_log::now_ms(), 300_000);
    pool.tick(crate::event_log::now_ms());
    assert!(wait_until(30, || pool.is_starting(&key)), "the warm session is part of the way");
    let (quick, quick_ready, quick_answer) = rig.start_and_say();
    assert!(quick.warm_claimed(), "a start does not begin a second adapter while the warm one is starting");

    println!("TIMING phone start-to-first-reply, fake agent (1.2 s initialize + 1.2 s session/new), no desktop window:");
    println!("TIMING before (cold):               ready {cold_ready:?}, first reply {cold_answer:?}");
    println!("TIMING after (3 s typing, warmed):  ready {typed_ready:?}, first reply {typed_answer:?}");
    println!("TIMING after (Send at 0.3 s):       ready {quick_ready:?}, first reply {quick_answer:?}");
    assert!(cold_ready > Duration::from_millis(2000), "{cold_ready:?}");
    assert!(typed_ready < Duration::from_millis(200), "{typed_ready:?}");
    assert!(typed_answer + Duration::from_millis(1500) < cold_answer, "{typed_answer:?} vs {cold_answer:?}");
    assert!(quick_answer < cold_answer + Duration::from_millis(1000), "{quick_answer:?} vs {cold_answer:?}");
}

// ---- standby helpers keep the model they were made for -------------------------------------------------------------------

/// A pool holding one standby helper per `(id, model)`, all ready, installed where `start` finds it.
fn standby_pool(rig: &Rig, helpers: &[(&str, Option<&str>)]) -> Installed {
    use crate::acp::warm::{HelperMeta, HelperWant};
    let pool = Pool::new(Arc::new(LiveHost { conversations: rig.conversations.clone() }));
    let wants = helpers
        .iter()
        .map(|(id, model)| HelperWant::new(HelperMeta { id: (*id).into(), name: format!("Helper {id}"), model: model.map(str::to_string), close_after_use: false, home: None }, "fake", &rig.dir, None))
        .collect();
    pool.set_policy(Policy { cap: 8, idle_ms: 20 * 60_000, helper_idle_ms: 20 * 60_000, recent_ms: 3_600_000, helpers: wants, ..Policy::default() });
    let installed = Installed(pool.clone());
    warm::install(Some(pool.clone()));
    pool.tick(crate::event_log::now_ms());
    assert!(wait_until(30, || pool.helper_statuses().values().all(|s| s.state == warm::HelperState::Ready)), "the standbys did not become ready");
    installed
}

fn model_of(chat: &AcpChat) -> Option<String> {
    crate::acp::chat::choice::in_use(chat).0
}

#[test]
fn a_standby_made_with_a_model_starts_the_task_on_that_model() {
    let _slot = WARM_SLOT.lock();
    let rig = Rig::new("init_delay_ms=20;new_delay_ms=20");
    let _installed = standby_pool(&rig, &[("s1", Some("b"))]);
    // The agent starts on "a"; the standby was made for "b"; the task names no model.
    let chat = start(&rig.deps, rig.cfg.clone(), rig.request()).expect("starts");
    assert!(chat.warm_claimed(), "the standby was used");
    assert_eq!(model_of(&chat).as_deref(), Some("b"), "the standby's model, not the agent's default");
    assert!(chat.choice_warnings().is_empty());
    chat.retire();
    let _ = rig.conversations.close(chat.pane_id());
}

#[test]
fn a_standby_model_the_agent_does_not_offer_is_said_in_the_result() {
    let _slot = WARM_SLOT.lock();
    let rig = Rig::new("init_delay_ms=20;new_delay_ms=20");
    let _installed = standby_pool(&rig, &[("s1", Some("zzz-9"))]);
    let chat = start(&rig.deps, rig.cfg.clone(), rig.request()).expect("starts");
    assert!(chat.warm_claimed());
    let warnings = chat.choice_warnings();
    assert!(warnings.iter().any(|w| w.contains("started on a because the standby's model zzz-9 isn't available")), "{warnings:?}");
    chat.retire();
    let _ = rig.conversations.close(chat.pane_id());
}

#[test]
fn a_helper_with_no_model_takes_the_standby_that_has_the_helper_default_model() {
    let _slot = WARM_SLOT.lock();
    let rig = Rig::new("init_delay_ms=20;new_delay_ms=20");
    let _installed = standby_pool(&rig, &[("s-a", Some("a")), ("s-b", Some("b"))]);
    crate::acp::chat::default_model::note_settings(&serde_json::json!({ "helper_default_models": { "fake": "b" } }));
    let chat = start(&rig.deps, rig.cfg.clone(), StartRequest { is_helper: true, ..rig.request() }).expect("starts");
    crate::acp::chat::default_model::note_settings(&serde_json::Value::Null);
    assert!(chat.warm_claimed());
    assert_eq!(model_of(&chat).as_deref(), Some("b"), "the helper default model decided which standby, and the session is on it");
    let statuses = warm::pool().unwrap().helper_statuses();
    assert_eq!(statuses["s-b"].state, warm::HelperState::Busy);
    assert_eq!(statuses["s-a"].state, warm::HelperState::Ready, "the other standby is untouched");
    chat.retire();
    let _ = rig.conversations.close(chat.pane_id());
}

#[test]
fn a_named_model_picks_the_standby_with_that_model_and_wins() {
    let _slot = WARM_SLOT.lock();
    let rig = Rig::new("init_delay_ms=20;new_delay_ms=20");
    let _installed = standby_pool(&rig, &[("s-a", Some("a")), ("s-b", Some("b"))]);
    let chat = start(&rig.deps, rig.cfg.clone(), StartRequest { model: Some("b".into()), is_helper: true, ..rig.request() }).expect("starts");
    assert!(chat.warm_claimed());
    assert_eq!(warm::pool().unwrap().helper_statuses()["s-b"].state, warm::HelperState::Busy);
    chat.retire();
    let _ = rig.conversations.close(chat.pane_id());
}

#[test]
fn a_standby_the_person_opened_is_taken_with_a_fresh_cold_session_on_its_model() {
    let _slot = WARM_SLOT.lock();
    let rig = Rig::new("init_delay_ms=20;new_delay_ms=20");
    let _installed = standby_pool(&rig, &[("s1", Some("b"))]);
    let pool = warm::pool().unwrap();

    // The person opens the waiting standby like a chat: it stays in the pool, ready, and says which chat it is.
    let person = crate::acp::chat::open_standby_chat(&rig.deps, "s1").expect("a ready standby opens");
    assert_eq!(crate::acp::chat::open_standby_chat(&rig.deps, "s1").unwrap(), person, "the same chat again");
    let person_chat = crate::acp::chat::get(&person).expect("the chat exists");
    assert_eq!(model_of(&person_chat).as_deref(), Some("b"), "the standby's model shows in the opened chat");
    let status = pool.helper_statuses()["s1"].clone();
    assert_eq!((status.state, status.open_pane.as_deref()), (warm::HelperState::Ready, Some(person.as_str())));
    let person_session = rig.conversations.session(&person).expect("the person's chat has its session");

    // Sending in it makes the helper "with you".
    person_chat.send("stream 1").unwrap_or_else(|e| panic!("send: {e:?}"));
    assert_eq!(pool.helper_statuses()["s1"].used_by, Some(warm::HelperUser::Person));

    // A task from an agent takes it: a cold session, never the person's, on the standby's model.
    let chat = start(&rig.deps, rig.cfg.clone(), rig.request()).expect("starts");
    assert!(!chat.warm_claimed(), "a taken-over standby starts a fresh session");
    assert_ne!(chat.pane_id(), person);
    assert!(!Arc::ptr_eq(chat.session(), &person_session));
    assert_eq!(model_of(&chat).as_deref(), Some("b"), "the standby's model is applied to the fresh chat");
    let status = pool.helper_statuses()["s1"].clone();
    assert_eq!((status.state, status.used_by, status.taken_over), (warm::HelperState::Busy, Some(warm::HelperUser::Agent), true));
    assert_eq!((status.pane_id.as_deref(), status.person_pane.as_deref()), (Some(chat.pane_id()), Some(person.as_str())), "the pool watches the new chat");
    // The person's chat and its session are alive and readable.
    assert!(rig.conversations.session(&person).is_some_and(|s| Arc::ptr_eq(&s, &person_session)));
    assert!(crate::acp::chat::get(&person).is_some());

    for pane in [chat.pane_id().to_string(), person] {
        if let Some(c) = crate::acp::chat::get(&pane) {
            c.retire();
        }
        let _ = rig.conversations.close(&pane);
    }
}
