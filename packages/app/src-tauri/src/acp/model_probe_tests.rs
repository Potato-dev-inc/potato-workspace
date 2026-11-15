//! The model list before any chat: cache by adapter version, one probe, no prompt (`model_probe`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::config::HostEnv;
use super::fake_agent;
use super::model_probe::*;
use super::session::{AcpSession, SessionParams};

fn temp_file() -> PathBuf {
    std::env::temp_dir().join(format!("pm-model-cache-{}", uuid::Uuid::new_v4())).join("model_cache.json")
}

fn model(ids: &[&str]) -> Value {
    json!({"id": "model", "category": "model", "type": "select", "currentValue": ids[0], "options": ids.iter().map(|i| json!({"value": i, "name": i.to_uppercase()})).collect::<Vec<_>>()})
}

/// A probe that counts its reads; the version and the answer can be changed between calls.
struct Fake {
    version: Mutex<Option<String>>,
    answer: Mutex<Result<Vec<Value>, String>>,
    reads: AtomicUsize,
    now: AtomicI64,
}

impl Fake {
    fn new(version: &str, answer: Result<Vec<Value>, String>) -> Arc<Self> {
        Arc::new(Self { version: Mutex::new(Some(version.into())), answer: Mutex::new(answer), reads: AtomicUsize::new(0), now: AtomicI64::new(1_000) })
    }
}

impl Probe for Fake {
    fn version(&self, _: &str) -> Option<String> {
        self.version.lock().clone()
    }
    fn read(&self, _: &str) -> Result<Vec<Value>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.answer.lock().clone()
    }
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

#[test]
fn the_first_look_probes_once_then_the_cache_answers() {
    let cache = ModelCache::at(temp_file());
    let probe = Fake::new("1.0.0", Ok(vec![model(&["a", "b"])]));
    assert_eq!(cache.resolve(&*probe, "Agy", None), Outcome::Found(model(&["a", "b"])));
    assert_eq!(cache.resolve(&*probe, "agy", None), Outcome::Found(model(&["a", "b"])));
    assert_eq!(probe.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn the_cache_survives_a_restart_and_is_dropped_when_the_adapter_version_changes() {
    let path = temp_file();
    let probe = Fake::new("1.0.0", Ok(vec![model(&["a", "b"])]));
    ModelCache::at(path.clone()).resolve(&*probe, "agy", None);
    // A new process: the file answers.
    let again = ModelCache::at(path.clone());
    assert_eq!(again.resolve(&*probe, "agy", None), Outcome::Found(model(&["a", "b"])));
    assert_eq!(probe.reads.load(Ordering::SeqCst), 1);
    // The adapter updated: the list is read again, and replaces the old one.
    *probe.version.lock() = Some("2.0.0".into());
    *probe.answer.lock() = Ok(vec![model(&["c", "d", "e"])]);
    assert_eq!(again.resolve(&*probe, "agy", None), Outcome::Found(model(&["c", "d", "e"])));
    assert_eq!(probe.reads.load(Ordering::SeqCst), 2);
    assert_eq!(again.resolve(&*probe, "agy", None), Outcome::Found(model(&["c", "d", "e"])));
    assert_eq!(probe.reads.load(Ordering::SeqCst), 2);
}

#[test]
fn a_list_an_old_chat_saved_is_used_without_a_probe() {
    let cache = ModelCache::at(temp_file());
    let probe = Fake::new("1.0.0", Err("should not run".into()));
    assert_eq!(cache.resolve(&*probe, "claude", Some(model(&["x", "y"]))), Outcome::Found(model(&["x", "y"])));
    assert_eq!(probe.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn a_failed_probe_falls_back_and_is_not_repeated_at_once() {
    let cache = ModelCache::at(temp_file());
    let probe = Fake::new("1.0.0", Err("sign in first".into()));
    assert_eq!(cache.resolve(&*probe, "agy", None), Outcome::Failed("sign in first".into()));
    assert_eq!(cache.resolve(&*probe, "agy", None), Outcome::Failed("sign in first".into()));
    assert_eq!(probe.reads.load(Ordering::SeqCst), 1);
    // Later (and the agent works now) it is read again.
    probe.now.fetch_add(RETRY_MS + 1, Ordering::SeqCst);
    *probe.answer.lock() = Ok(vec![model(&["a", "b"])]);
    assert_eq!(cache.resolve(&*probe, "agy", None), Outcome::Found(model(&["a", "b"])));
}

#[test]
fn an_agent_with_no_model_setting_is_remembered_as_having_none() {
    let cache = ModelCache::at(temp_file());
    let probe = Fake::new("1.0.0", Ok(vec![json!({"id": "mode", "category": "mode", "type": "select", "options": []})]));
    assert_eq!(cache.resolve(&*probe, "agy", None), Outcome::NoList);
    assert_eq!(cache.resolve(&*probe, "agy", None), Outcome::NoList);
    assert_eq!(probe.reads.load(Ordering::SeqCst), 1);
}

// ---- the real session machinery, against the fake ACP agent ------------------------------------------------------------

struct Home(PathBuf);
impl HostEnv for Home {
    fn var(&self, name: &str) -> Option<std::ffi::OsString> {
        std::env::var_os(name)
    }
    fn which(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn adapters_dir(&self) -> PathBuf {
        self.0.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.0.join("homes")
    }
}

/// Starts a real fake-agent session, reads its config options, closes it: what `LiveProbe` does, minus the app's stores.
struct FakeAgentProbe;

impl Probe for FakeAgentProbe {
    fn version(&self, _: &str) -> Option<String> {
        Some("fake-1".into())
    }
    fn read(&self, _: &str) -> Result<Vec<Value>, String> {
        let _gate = crate::test_support::wait::process_permit();
        let dir = std::env::temp_dir().join(format!("pm-probe-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = fake_agent::agent_config("", &dir.join("store"));
        let session = AcpSession::new(Arc::new(cfg), Arc::new(Home(dir.clone())), SessionParams { key: "probe".into(), cwd: dir, resume_session_id: None });
        session.ensure_running().map_err(|e| e.to_string())?;
        let options = session.snapshot().config_options.clone();
        session.close();
        Ok(options)
    }
    fn now(&self) -> i64 {
        1
    }
}

#[test]
fn a_fake_agent_with_models_shows_them_on_the_very_first_look() {
    let cache = ModelCache::at(temp_file());
    let probe = FakeAgentProbe;
    // Before: nothing saved from chats, nothing cached. After: the agent's own list.
    match cache.resolve(&probe, "fake", None) {
        Outcome::Found(option) => {
            let values: Vec<&str> = option["options"].as_array().unwrap().iter().map(|o| o["value"].as_str().unwrap()).collect();
            assert_eq!(values, ["a", "b"]);
        }
        other => panic!("expected the agent's models, got {other:?}"),
    }
}
