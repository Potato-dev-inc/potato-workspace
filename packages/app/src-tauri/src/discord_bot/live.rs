//! The bot over the real app: the only place that starts a thread. While the Labs switch is off nothing here
//! runs: no thread, no socket, no file.
//!
//! Each running bot has two threads: `discord-bot-<id>` (the gateway reader) and `discord-bot-turns-<id>` (the
//! worker that asks the models and posts). Both end when the stop flag is set.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;

use super::config::{self, BotSettings};
use super::gateway;
use super::rest::UreqRest;
use super::service::{Bot, Deps, Journal, PersonaSource, ARM_MS};
use super::token::{self, Token};
use super::{enabled, vault_on, Real, State};
use crate::companion::brain::assemble::Persona;
use crate::companion::brain::budget::{DailyCalls, DEFAULT_CAP};
use crate::companion::brain::openai::{read_service, OpenAiBrain};
use crate::companion::brain::Brain;
use crate::companion::model::MemoryFile;
use crate::companion::{body, persona as persona_files, personas, store};
use crate::secrets::{self, SecretBackend};

struct Running {
    bot: Arc<Bot>,
}

static RUNNING: Lazy<Mutex<HashMap<String, Running>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// One reconcile at a time, so the start-up chore and a settings change can never start the same bot twice.
static RECONCILE: Mutex<()> = Mutex::new(());

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn offset_secs() -> i32 {
    chrono::Local::now().offset().local_minus_utc()
}

/// The person's own AI service and key, read at the moment of use, so saving a key takes effect at once.
fn brain_now() -> Option<Arc<dyn Brain>> {
    let service = read_service(&crate::app_paths::app_data_dir().join(crate::settings_patch::SETTINGS_FILE))?;
    let key = secrets::read_secret(secrets::CUSTOM_AI_SECRET)?;
    OpenAiBrain::new(&service, &key).map(|b| Arc::new(b) as Arc<dyn Brain>)
}

/// What the companion is called, its approved soul, and (with the vault on) its rules, notes and mood. Read at
/// most every few seconds, so an edit is followed with no restart and a busy room does not hammer the disk.
struct LivePersona {
    root: PathBuf,
    id: String,
    cache: Mutex<Option<(i64, Persona)>>,
}

impl PersonaSource for LivePersona {
    fn persona(&self) -> Persona {
        let now = now_ms();
        if let Some((at, p)) = &*self.cache.lock() {
            if now - at < 5_000 {
                return p.clone();
            }
        }
        let profile = store::load_all(&self.root).ok().and_then(|(list, _)| list.into_iter().find(|p| p.id == self.id));
        let mut persona = Persona { name: "Companion".into(), ..Default::default() };
        if let Some(profile) = profile {
            persona.name = profile.name.clone();
            // The last text the person approved; the template when there is none yet. Never USER.md or MEMORY.md.
            persona.soul = store::approved_path(&self.root, &self.id, MemoryFile::Soul)
                .ok()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| personas::soul_template(&profile.persona).to_string());
            if vault_on() {
                let home = Path::new(&profile.folder);
                let extras = persona_files::load_extras(home);
                persona.rules = extras.rules;
                persona.notes = extras.notes;
                if let Ok(dir) = body::state_dir(&self.root, &self.id) {
                    let state = body::BodyState::open(&dir, now);
                    persona.mood = body::mood::render(&state.mood, now, offset_secs());
                }
            }
        }
        *self.cache.lock() = Some((now, persona.clone()));
        persona
    }
}

/// Heard and said lines go into the companion's journal, but only while the companion vault is on.
struct LiveJournal {
    home: PathBuf,
}

impl LiveJournal {
    fn write(&self, kind: crate::companion::vault::journal::Kind, who: &str, text: &str, at_ms: i64) {
        use crate::companion::vault::journal::{append, Entry};
        if !vault_on() {
            return;
        }
        let _ = append(&self.home, &Entry { at_ms, offset_secs: offset_secs(), kind, who, place: "discord", text });
    }
}

impl Journal for LiveJournal {
    fn heard(&self, who: &str, text: &str, at_ms: i64) {
        self.write(crate::companion::vault::journal::Kind::Heard, who, text, at_ms);
    }
    fn said(&self, who: &str, text: &str, at_ms: i64) {
        self.write(crate::companion::vault::journal::Kind::Said, who, text, at_ms);
    }
}

fn start(id: &str, settings: BotSettings, token: Token) {
    let root = crate::app_paths::app_data_dir();
    let home = store::load_all(&root).ok().and_then(|(list, _)| list.into_iter().find(|p| p.id == id)).map(|p| PathBuf::from(p.folder));
    let Some(home) = home else { return };
    let calls_path = store::companion_dir(&root, id).ok().map(|d| d.join("discord-calls.json"));
    let deps = Deps {
        brain: Arc::new(brain_now),
        rest: Arc::new(UreqRest::new(token.clone(), Arc::new(Real))),
        journal: Arc::new(LiveJournal { home }),
        persona: Arc::new(LivePersona { root: root.clone(), id: id.to_string(), cache: Mutex::new(None) }),
        calls: Arc::new(DailyCalls::open(calls_path, DEFAULT_CAP, offset_secs())),
        clock: Arc::new(now_ms),
        sleep: Arc::new(std::thread::sleep),
        arm_ms: ARM_MS,
    };
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let bot = Bot::new(settings, deps, stop.clone());
    let gateway_bot = bot.clone();
    let gateway_stop = stop.clone();
    let spawned = std::thread::Builder::new().name(format!("discord-bot-{id}")).spawn(move || {
        let end = gateway::run(&token, &Real, &gateway_stop, &*gateway_bot, &gateway::Config::default());
        // Whatever the reason, the worker has nothing left to do.
        gateway_stop.store(true, Ordering::SeqCst);
        gateway_bot.wake();
        tracing::info!(end = ?end, "discord bot gateway ended");
    });
    if spawned.is_err() {
        return;
    }
    let worker_bot = bot.clone();
    let worker = std::thread::Builder::new().name(format!("discord-bot-turns-{id}")).spawn(move || worker_bot.run_worker());
    if worker.is_err() {
        stop.store(true, Ordering::SeqCst);
        return;
    }
    RUNNING.lock().insert(id.to_string(), Running { bot });
}

fn stop_one(id: &str) {
    if let Some(running) = RUNNING.lock().remove(id) {
        running.bot.stop_flag().store(true, Ordering::SeqCst);
        running.bot.wake();
    }
}

fn stop_all() {
    let ids: Vec<String> = RUNNING.lock().keys().cloned().collect();
    for id in ids {
        stop_one(&id);
    }
}

#[cfg(test)]
/// Is this id running right now (a thread started and not stopped)?
pub fn running(id: &str) -> bool {
    RUNNING.lock().get(id).is_some_and(|r| !r.bot.stop_flag().load(Ordering::SeqCst))
}

/// Brings one companion's bot in line with the switch, its settings and its token. With `restart_if_ended`, a
/// bot that stopped by itself (a refused token, Message Content off) is started again.
pub fn reconcile_one(id: &str, restart_if_ended: bool) {
    let _one_at_a_time = RECONCILE.lock();
    let root = crate::app_paths::app_data_dir();
    let settings = config::load(&root, id);
    let token = token::read_with(secrets::backend(), id).ok().flatten();
    let want = enabled() && settings.on && token.is_some();
    let existing = RUNNING.lock().get(id).map(|r| (r.bot.clone(), r.bot.stop_flag().load(Ordering::SeqCst)));
    match (want, existing, token) {
        (true, Some((bot, false)), _) => bot.set_settings(settings),
        (true, Some((_, true)), Some(token)) => {
            if restart_if_ended {
                stop_one(id);
                start(id, settings, token);
            }
        }
        (true, None, Some(token)) => start(id, settings, token),
        (false, Some(_), _) => stop_one(id),
        _ => {}
    }
}

/// Restarts the bot of one companion whatever state it is in (a new token was saved).
pub fn restart(id: &str) {
    stop_one(id);
    reconcile_one(id, false);
}

pub fn reconcile_all() {
    if !enabled() {
        stop_all();
        return;
    }
    let root = crate::app_paths::app_data_dir();
    let ids: Vec<String> = store::load_all(&root).map(|(list, _)| list.into_iter().map(|p| p.id).collect()).unwrap_or_default();
    for id in ids {
        reconcile_one(&id, false);
    }
}

/// The switch or the settings changed. Does the work on its own short thread, so a settings patch never waits
/// for the credential store. Not in unit tests (they call `reconcile_one` themselves).
pub fn settings_changed() {
    #[cfg(not(test))]
    {
        let _ = std::thread::Builder::new().name("discord-bot-reconcile".into()).spawn(reconcile_all);
    }
}

/// The live part of the card's status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveStatus {
    pub state: State,
    pub bot_name: Option<String>,
}

pub fn live_status(id: &str, set: bool, on: bool) -> LiveStatus {
    let bot = RUNNING.lock().get(id).map(|r| r.bot.clone());
    let state = if !enabled() || !on {
        State::Off
    } else if !set {
        State::NoToken
    } else {
        bot.as_ref().map_or(State::Stopped, |b| b.state())
    };
    LiveStatus { state, bot_name: bot.and_then(|b| b.bot_name()) }
}

/// What the Discord card gets. No token in it, ever: whether one is saved and its last four characters.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotStatus {
    pub enabled: bool,
    pub store_available: bool,
    pub set: bool,
    pub last4: Option<String>,
    pub bot_name: Option<String>,
    pub state: State,
    pub calls_today: u32,
    pub calls_cap: u32,
    pub settings: BotSettings,
}

/// Builds the status from the files and the store. Nothing is written or created.
pub fn status(root: &Path, backend: &dyn SecretBackend, id: &str, enabled_now: bool, now: i64) -> BotStatus {
    let settings = config::load(root, id);
    let (set, last4) = token::mask_with(backend, id);
    let live = live_status(id, set, settings.on);
    let calls_path = store::companion_dir(root, id).ok().map(|d| d.join("discord-calls.json"));
    let calls = DailyCalls::open(calls_path, DEFAULT_CAP, offset_secs());
    BotStatus {
        enabled: enabled_now,
        store_available: backend.available(),
        set,
        last4,
        bot_name: live.bot_name,
        state: if enabled_now { live.state } else { State::Off },
        calls_today: calls.used(now),
        calls_cap: calls.cap(),
        settings,
    }
}

