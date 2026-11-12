//! The Discord alerts service: the saved link (credential store), which alerts are on (a small json file), the
//! rate limit and the send. Nothing here names an agent.

use super::client::{Post, SendError};
use super::webhook::{UrlError, Webhook};
use crate::secrets::SecretBackend;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// The name of the link in the OS credential store.
pub const SECRET_NAME: &str = "discord_webhook_url";
/// At most this many alerts leave in one window. The rest are dropped, not queued.
pub const MAX_PER_WINDOW: usize = 10;
pub const WINDOW_MS: u64 = 60_000;
/// The same alert (same card, same words) is posted once in this long.
pub const DEDUPE_MS: u64 = 60_000;
/// "Test" can be pressed again after this long.
pub const TEST_GAP_MS: u64 = 2_000;
const MAX_SEEN: usize = 256;
const BOT_NAME: &str = "Potato Workspace";

/// The three kinds of alert a person can choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AlertKind {
    NeedsYou,
    Finished,
    Failed,
}

impl AlertKind {
    /// Which alert a push kind is, if any. Companion replies and the Night Shift morning push are not alerts.
    pub fn of(kind: crate::push::triggers::Kind) -> Option<Self> {
        use crate::push::triggers::Kind;
        match kind {
            Kind::WaitingInput | Kind::Error | Kind::Question | Kind::TrustGate | Kind::Consent | Kind::Budget | Kind::Limit => Some(Self::NeedsYou),
            Kind::RunFinished => Some(Self::Finished),
            Kind::RunFailed => Some(Self::Failed),
            Kind::CompanionReply | Kind::NightShift => None,
        }
    }
}

/// Which alerts are on. Needs you and failed are on, finished is off, until the person chooses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Kinds {
    pub needs_you: bool,
    pub finished: bool,
    pub failed: bool,
}

impl Default for Kinds {
    fn default() -> Self {
        Self { needs_you: true, finished: false, failed: true }
    }
}

impl Kinds {
    pub fn on(&self, kind: AlertKind) -> bool {
        match kind {
            AlertKind::NeedsYou => self.needs_you,
            AlertKind::Finished => self.finished,
            AlertKind::Failed => self.failed,
        }
    }
    pub fn any(&self) -> bool {
        self.needs_you || self.finished || self.failed
    }
}

/// What Settings shows. The link itself is never in it: only whether one is saved, and its last four characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub saved: bool,
    pub tail: Option<String>,
    pub kinds: Kinds,
    /// Alerts are posted: a link is saved and at least one kind is on.
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TestOutcome {
    pub ok: bool,
    pub message: String,
}

/// What `send_alert` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Sent,
    /// No link saved, or that kind is off.
    Off,
    Duplicate,
    RateLimited,
    Failed(SendError),
}

#[derive(Default)]
struct Cache {
    loaded: bool,
    hook: Option<Webhook>,
    kinds: Kinds,
}

#[derive(Default)]
struct Limiter {
    sent: VecDeque<u64>,
    seen: HashMap<u64, u64>,
    last_test: Option<u64>,
}

pub struct Service {
    backend: &'static dyn SecretBackend,
    prefs_path: PathBuf,
    post: Box<dyn Post>,
    cache: Mutex<Cache>,
    limiter: Mutex<Limiter>,
}

impl Service {
    pub fn new(backend: &'static dyn SecretBackend, prefs_path: PathBuf, post: Box<dyn Post>) -> Self {
        Self { backend, prefs_path, post, cache: Mutex::new(Cache::default()), limiter: Mutex::new(Limiter::default()) }
    }

    /// Reads the saved link and the choices once, and keeps them. Later reads are memory only.
    fn with_cache<T>(&self, f: impl FnOnce(&mut Cache) -> T) -> T {
        let mut cache = self.cache.lock();
        if !cache.loaded {
            cache.loaded = true;
            cache.kinds = load_kinds(&self.prefs_path);
            cache.hook = self.backend.get(SECRET_NAME).ok().flatten().and_then(|raw| Webhook::parse(&raw).ok());
            if let Some(hook) = &cache.hook {
                mask_everywhere(hook);
            }
        }
        f(&mut cache)
    }

    /// Tests only: a link to a fake server on this PC (the strict check would refuse it).
    #[cfg(test)]
    pub(crate) fn use_hook_for_test(&self, hook: Webhook) {
        self.with_cache(|c| c.hook = Some(hook));
    }

    /// Loads the saved state and masks the link wherever text is redacted. Call once at start-up.
    pub fn init(&self) {
        self.with_cache(|_| ());
    }

    /// Posting is on: a link is saved and at least one kind is on. Cheap: memory only after the first call.
    pub fn listening(&self) -> bool {
        self.with_cache(|c| c.hook.is_some() && c.kinds.any())
    }

    pub fn wants(&self, kind: AlertKind) -> bool {
        self.with_cache(|c| c.hook.is_some() && c.kinds.on(kind))
    }

    pub fn status(&self) -> Status {
        self.with_cache(|c| Status { saved: c.hook.is_some(), tail: c.hook.as_ref().map(Webhook::tail), kinds: c.kinds, active: c.hook.is_some() && c.kinds.any() })
    }

    /// Checks and keeps a pasted link in the credential store. The refusal says what to paste, never what was pasted.
    pub fn set_url(&self, raw: &str) -> Result<Status, String> {
        let hook = Webhook::parse(raw).map_err(|e: UrlError| e.to_string())?;
        self.backend.set(SECRET_NAME, hook.as_str()).map_err(|_| "Could not save the link in the secure store.".to_string())?;
        match self.backend.get(SECRET_NAME) {
            Ok(Some(back)) if back == hook.as_str() => {}
            _ => return Err("The secure store did not keep the link.".to_string()),
        }
        mask_everywhere(&hook);
        self.with_cache(|c| c.hook = Some(hook));
        Ok(self.status())
    }

    /// Removes the link. Nothing is posted after this.
    pub fn clear(&self) -> Result<Status, String> {
        self.backend.delete(SECRET_NAME).map_err(|_| "Could not remove the link from the secure store.".to_string())?;
        self.with_cache(|c| c.hook = None);
        Ok(self.status())
    }

    pub fn set_kinds(&self, kinds: Kinds) -> Result<Status, String> {
        save_kinds(&self.prefs_path, &kinds).map_err(|_| "Could not save your choice.".to_string())?;
        self.with_cache(|c| c.kinds = kinds);
        Ok(self.status())
    }

    /// Posts one alert if its kind is on, it is not a repeat and the rate limit has room.
    pub fn send_alert(&self, kind: AlertKind, key: &str, text: &str, now_ms: u64) -> Outcome {
        let Some(hook) = self.with_cache(|c| c.hook.clone().filter(|_| c.kinds.on(kind))) else { return Outcome::Off };
        {
            let mut lim = self.limiter.lock();
            let id = fingerprint(kind, key, text);
            lim.seen.retain(|_, at| now_ms.saturating_sub(*at) < DEDUPE_MS);
            if lim.seen.contains_key(&id) {
                return Outcome::Duplicate;
            }
            while lim.sent.front().is_some_and(|at| now_ms.saturating_sub(*at) >= WINDOW_MS) {
                lim.sent.pop_front();
            }
            if lim.sent.len() >= MAX_PER_WINDOW {
                return Outcome::RateLimited;
            }
            if lim.seen.len() >= MAX_SEEN {
                lim.seen.clear();
            }
            lim.seen.insert(id, now_ms);
            lim.sent.push_back(now_ms);
        }
        match self.post.post(&hook, &body_for(text)) {
            Ok(()) => Outcome::Sent,
            Err(e) => Outcome::Failed(e),
        }
    }

    /// The Test button: one message to the saved link, whatever the kinds say. Pressing it again at once is refused.
    pub fn test(&self, now_ms: u64) -> TestOutcome {
        let Some(hook) = self.with_cache(|c| c.hook.clone()) else {
            return TestOutcome { ok: false, message: "Paste a webhook link and save it first.".into() };
        };
        {
            let mut lim = self.limiter.lock();
            if lim.last_test.is_some_and(|at| now_ms.saturating_sub(at) < TEST_GAP_MS) {
                return TestOutcome { ok: false, message: "Wait a moment before testing again.".into() };
            }
            lim.last_test = Some(now_ms);
        }
        match self.post.post(&hook, &body_for("Potato Workspace test: Discord alerts are connected.")) {
            Ok(()) => TestOutcome { ok: true, message: "Sent. Look for the message in your Discord channel.".into() },
            Err(e) => TestOutcome { ok: false, message: e.to_string() },
        }
    }
}

/// The JSON body: plain text, no embeds, and no mention can ping anyone (`allowed_mentions` is empty).
fn body_for(text: &str) -> String {
    serde_json::json!({
        "content": text,
        "username": BOT_NAME,
        "allowed_mentions": { "parse": [] },
        "flags": 4,
    })
    .to_string()
}

fn fingerprint(kind: AlertKind, key: &str, text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    (kind, key, text).hash(&mut h);
    h.finish()
}

fn mask_everywhere(hook: &Webhook) {
    for piece in hook.secret_pieces() {
        crate::redact::known::register(piece);
    }
}

fn load_kinds(path: &Path) -> Kinds {
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn save_kinds(path: &Path, kinds: &Kinds) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(kinds)?)
}
