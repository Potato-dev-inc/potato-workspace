//! The model list of a chat agent, known before any chat exists.
//!
//! The list the chat's model picker shows is the agent's own `configOptions` entry (category `model`), sent when a session
//! starts. A New agent card has no session yet, so for an agent nobody has chatted with the list used to be empty until a
//! chat had been saved. Here the list is read once by a short probe session (`initialize` + `session/new`, no prompt, so no
//! model tokens are spent), then kept per agent and adapter version in `acp/model_cache.json`:
//!
//! * a cached list for the version the adapter runs now is used as it is (no process starts);
//! * a different version, or no list yet, starts one probe and replaces the entry;
//! * a list an old chat saved is moved into the cache (no probe) the first time it is asked for;
//! * a probe that fails is not cached for long (`RETRY_MS`), and the page says so quietly.
//!
//! Nothing here names an agent. The real probe (`LiveProbe`) is the warm pool's own start, so a blocked adapter or a missing
//! add-on is refused the same way, and the session is closed at once.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::Value;

/// A failed probe is not repeated sooner than this (the page shows its quiet line meanwhile).
pub const RETRY_MS: i64 = 5 * 60_000;

/// A cached list is read again after this long even when no version changed (an adapter with no readable version).
pub const MAX_AGE_MS: i64 = 7 * 24 * 3_600_000;

/// What the cache needs from the machine.
pub trait Probe: Send + Sync {
    /// The adapter's version as known without a chat. `None`: unknown.
    fn version(&self, agent: &str) -> Option<String>;
    /// Starts a session, reads its `configOptions`, closes it. Never sends a prompt.
    fn read(&self, agent: &str) -> Result<Vec<Value>, String>;
    fn now(&self) -> i64;
}

/// The newest model setting (a `select` with at least two plain choices) among `options`.
pub fn model_option(options: &[Value]) -> Option<Value> {
    options
        .iter()
        .find(|o| {
            o["category"] == "model"
                && o["type"] == "select"
                && o["options"].as_array().is_some_and(|l| l.len() >= 2 && l.iter().all(|c| c["value"].is_string() && c["name"].is_string()))
        })
        .cloned()
}

/// How a look at an agent's list ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The list (from the cache, from an old chat, or from a fresh probe).
    Found(Value),
    /// The agent reported no model setting of its own.
    NoList,
    /// The probe could not read it. The page falls back to Default and says so.
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct Entry {
    /// The adapter version the list was read on (`None`: not known then).
    version: Option<String>,
    /// The model setting; `None`: the agent has none (remembered, so nobody asks again).
    option: Option<Value>,
    at_ms: i64,
}

pub struct ModelCache {
    path: PathBuf,
    entries: Mutex<Option<HashMap<String, Entry>>>,
    /// One probe per agent at a time; a second asker waits and then finds the answer cached.
    flights: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// agent -> (version, retry after). In memory only: a restart tries again.
    failures: Mutex<HashMap<String, (Option<String>, i64, String)>>,
}

impl ModelCache {
    pub fn at(path: PathBuf) -> Self {
        Self { path, entries: Mutex::new(None), flights: Mutex::new(HashMap::new()), failures: Mutex::new(HashMap::new()) }
    }

    fn with_entries<T>(&self, f: impl FnOnce(&mut HashMap<String, Entry>) -> T) -> T {
        let mut guard = self.entries.lock();
        let map = guard.get_or_insert_with(|| std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default());
        f(map)
    }

    fn put(&self, agent: &str, entry: Entry) {
        self.with_entries(|map| {
            map.insert(agent.to_string(), entry);
            if let Some(dir) = self.path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = self.path.with_extension("json.tmp");
            if serde_json::to_string(map).ok().is_some_and(|text| std::fs::write(&tmp, text).is_ok()) {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        });
    }

    /// The cached entry when it was read on `version` and is not too old.
    fn fresh(&self, agent: &str, version: &Option<String>, now: i64) -> Option<Entry> {
        self.with_entries(|map| map.get(agent).filter(|e| &e.version == version && now - e.at_ms < MAX_AGE_MS).cloned())
    }

    /// The agent's list for the adapter version that runs now.
    ///
    /// `from_chats` is the list an earlier chat saved, if any: used (and cached) without a probe.
    pub fn resolve(&self, probe: &dyn Probe, agent: &str, from_chats: Option<Value>) -> Outcome {
        let agent = agent.trim().to_ascii_lowercase();
        let version = probe.version(&agent);
        let now = probe.now();
        let found = |e: Entry| e.option.map_or(Outcome::NoList, Outcome::Found);
        if let Some(entry) = self.fresh(&agent, &version, now) {
            return found(entry);
        }
        let flight = self.flights.lock().entry(agent.clone()).or_default().clone();
        let _turn = flight.lock();
        // Someone else may have finished while this waited.
        if let Some(entry) = self.fresh(&agent, &version, now) {
            return found(entry);
        }
        if let Some(option) = from_chats {
            self.put(&agent, Entry { version, option: Some(option.clone()), at_ms: now });
            return Outcome::Found(option);
        }
        if let Some((v, until, why)) = self.failures.lock().get(&agent).cloned() {
            if v == version && now < until {
                return Outcome::Failed(why);
            }
        }
        match probe.read(&agent) {
            Ok(options) => {
                self.failures.lock().remove(&agent);
                let option = model_option(&options);
                self.put(&agent, Entry { version, option: option.clone(), at_ms: now });
                option.map_or(Outcome::NoList, Outcome::Found)
            }
            Err(why) => {
                self.failures.lock().insert(agent, (version, now + RETRY_MS, why.clone()));
                Outcome::Failed(why)
            }
        }
    }
}

static GLOBAL: Lazy<ModelCache> = Lazy::new(|| ModelCache::at(crate::app_paths::app_data_dir().join("acp").join("model_cache.json")));

pub fn global() -> &'static ModelCache {
    &GLOBAL
}

/// The real probe: the warm pool's start, read, closed.
pub struct LiveProbe;

impl Probe for LiveProbe {
    fn version(&self, agent: &str) -> Option<String> {
        super::adapter_health::adapter_version(agent)
    }

    fn read(&self, agent: &str) -> Result<Vec<Value>, String> {
        use super::warm::{LiveHost, WarmHost, WarmKey};
        let folder = probe_folder();
        let host = LiveHost { conversations: super::conversations::global().clone() };
        let chat = host.start(&WarmKey::new(agent, &folder.to_string_lossy(), None), &folder).map_err(|f| f.message)?;
        let options = chat.session.snapshot().config_options.clone();
        host.close(chat);
        Ok(options)
    }

    fn now(&self) -> i64 {
        crate::event_log::now_ms()
    }
}

/// A folder of our own, so a probe session never lands in the person's project history.
fn probe_folder() -> PathBuf {
    let dir = crate::app_paths::app_data_dir().join("acp").join("probe");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
