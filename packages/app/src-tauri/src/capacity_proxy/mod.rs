//! Share an agent: **Lend through my PC** (Labs `lend_enabled`, off by default; plan
//! `docs/plans/share-an-agent.md` sections 3 and 6 Phase 3).
//!
//! One PC (the lender) lets another (the borrower) use one of its agent sign-ins for a limited time. In this mode
//! the sign-in NEVER leaves the lender: the borrower's agent sends its model API calls to a local shim, the shim
//! carries them over the PC link (`p2p`, capability `agents/lend`, protocol `pm/lend/1`) to the lender, and the
//! lender adds its own auth and forwards them to the one upstream of the agent's spec. Like a personal API gateway.
//!
//! - `spec`: the per-agent proxy spec, as data (`tui/<agent>/lend_proxy.toml`).
//! - `gate`, `forward`, `meter`, `frame`: the lender's enforcement (time, limits, Revoke, counts) and forwarding.
//! - `shim`: the borrower's 127.0.0.1 server; `env`: the borrowed pane's environment.
//! - `wire`: request / grant / decline / revoke / return / ack items on the team relay, HPKE-sealed to one device.
//! - `link`: the PC link handshake (HMAC over both node ids).
//! - `service`: profiles, requests, grants and their live parts.
//!
//! Desktop only: Tauri commands (`commands/lend.rs`) and nothing else. No bridge route, MCP tool or phone route
//! reaches this module (`guard_tests.rs`), so an agent can never lend, accept or revoke.
//!
//! A borrowed grant is one more sign-in of its agent: account id `lend:<grant id>` (`accounts::Store::launch_env`
//! resolves it here for both the terminal and the chat lane).

pub mod env;
pub mod forward;
pub mod frame;
pub mod gate;
pub mod key_merge;
pub mod link;
pub mod meter;
pub mod ping;
pub mod refresh;
pub mod service;
pub mod shim;
pub mod signin;
pub mod signin_pane;
pub mod spec;
pub mod wire;

#[cfg(test)]
mod agents_e2e_tests;
#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
mod own_tests;
#[cfg(test)]
mod link_tests;
#[cfg(test)]
mod offer_tests;
#[cfg(test)]
mod wan_tests;
#[cfg(test)]
mod guard_tests;
#[cfg(test)]
mod proxy_tests;
#[cfg(test)]
mod wire_tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde_json::Value;

use self::service::{Deps, Lend};
use crate::secrets::SecretBackend;

pub use self::service::{ACCOUNT_PREFIX, NOT_IN_THIS_MODE};

pub const LABS_KEY: &str = "lend_enabled";
pub const OFF: &str = "Share an agent is off. Turn it on in Settings > General > Labs.";

static ENABLED: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static SERVICE: OnceLock<Arc<Lend>> = OnceLock::new();
static PINGER: OnceLock<Arc<ping::Pinger>> = OnceLock::new();
static LAST_SETTINGS: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// One line in `lib.rs` setup: keeps the handle for `lend://changed`. Builds nothing.
pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// Settings changed (effective settings, development override included).
pub fn apply_settings(public: &Value) {
    let on = public.get(LABS_KEY).and_then(Value::as_bool) == Some(true);
    ENABLED.store(on, Ordering::SeqCst);
    if let Ok(mut last) = LAST_SETTINGS.lock() {
        *last = Some(public.clone());
    }
    if let Some(svc) = SERVICE.get() {
        svc.apply_settings(public);
    } else if on && APP.get().is_some() {
        // Build the service now (not at the first click): a lender that restarted tells its borrowers at once, and a
        // borrower's shim comes back before its panes need it.
        tauri::async_runtime::spawn_blocking(|| {
            let _ = app_service();
        });
    }
}

/// The pinger of this app: answers pings and sends them. Works without Labs lend (it is a diagnostic).
pub fn pinger() -> Arc<ping::Pinger> {
    PINGER.get_or_init(|| ping::Pinger::new(Arc::new(service::AppTeam), Arc::new(now_ms))).clone()
}

/// Pings every other computer of the team (Settings > Team > People). The team relay round trip for each; where a PC
/// link to that computer exists (a lend from them), the link's own round trip and path replace it.
pub async fn ping_team() -> Result<Vec<ping::DevicePing>, String> {
    let pinger = pinger();
    let svc = if enabled() { SERVICE.get().cloned() } else { None };
    let probes = async {
        match &svc {
            Some(s) => s.probe_lenders(std::time::Duration::from_secs(10)).await,
            None => Default::default(),
        }
    };
    let (mailbox, probes) = tokio::join!(pinger.ping_all(), probes);
    let mut list = mailbox?;
    for p in &mut list {
        if let Some(pr) = probes.get(&p.device_id) {
            *p = ping::from_probe(p, pr.rtt, pr.path == crate::p2p::endpoint::PathKind::Direct);
        }
    }
    Ok(list)
}

struct AppSecrets;

impl SecretBackend for AppSecrets {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        crate::secrets::backend().get(name)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        crate::secrets::backend().set(name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        crate::secrets::backend().delete(name)
    }
    fn label(&self) -> &'static str {
        crate::secrets::backend().label()
    }
    fn available(&self) -> bool {
        crate::secrets::backend().available()
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The app's service, built the first time it is needed while the switch is on. Never while it is off.
pub fn app_service() -> Result<Arc<Lend>, String> {
    if !enabled() {
        return Err(OFF.into());
    }
    if let Some(svc) = SERVICE.get() {
        return Ok(svc.clone());
    }
    let net = link::LendNet::app()?;
    let deps = Deps {
        dir: crate::app_paths::app_data_dir().join("lend"),
        secrets: Arc::new(AppSecrets),
        team: Arc::new(service::AppTeam),
        net,
        accounts: crate::accounts::Store::default_location(),
        specs: spec::all(),
        now: Arc::new(now_ms),
        awake: Arc::new(service::app_awake()),
        pinger: pinger(),
        changed: Arc::new(|| {
            if let Some(app) = APP.get() {
                use tauri::Emitter;
                let _ = app.emit("lend://changed", ());
            }
        }),
        spawn: Arc::new(|f| {
            tauri::async_runtime::spawn(f);
        }),
        refresh: refresh::app_refresh(),
        env_names: Arc::new(env::inherited_names),
        own: Arc::new(crate::device_link::app::AppOwn),
        #[cfg(test)]
        test_upstream: None,
    };
    let svc = Lend::new(deps);
    svc.set_offer_gate(crate::team::direct::offer_gate());
    if SERVICE.set(svc.clone()).is_err() {
        return SERVICE.get().cloned().ok_or_else(|| "Share an agent could not start.".to_string());
    }
    crate::own_lend::set_inbox(svc.clone());
    if let Some(public) = LAST_SETTINGS.lock().ok().and_then(|l| l.clone()) {
        svc.apply_settings(&public);
    }
    svc.prune_past();
    svc.resume();
    svc.sync_usage_view_now();
    start_usage_sharing(&svc);
    Ok(svc)
}

/// Every two minutes: old past lends go from the saved state, and a lender whose profile shows usage sends the
/// numbers to the borrower. Nothing is read or sent while no profile asks for it.
fn start_usage_sharing(svc: &Arc<Lend>) {
    let me = Arc::downgrade(svc);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            let Some(svc) = me.upgrade() else { return };
            let _ = tauri::async_runtime::spawn_blocking(move || {
                svc.prune_past();
                if svc.usage_view().profiles.iter().any(|p| p.show_usage) {
                    let _ = crate::usage::snapshot(crate::usage::Refresh::IfStale, false);
                    svc.share_usage(&crate::usage::lend_numbers);
                }
            })
            .await;
            tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        }
    });
}

impl Lend {
    /// Gives the usage bar the lend side as it is now (at start, before anything changed).
    pub fn sync_usage_view_now(&self) {
        self.sync_usage_view_pub();
    }

    pub fn apply_settings(&self, public: &Value) {
        self.net().apply_settings(public);
    }
}

/// The team relay delivered a lend item (`team::service`). Dropped while the switch is off.
pub fn on_team_item(item: crate::team::secure::CapacityIn) {
    // A ping is answered with Lend off too.
    if pinger().handle(&item) {
        return;
    }
    let Ok(svc) = app_service() else { return };
    if let Err(why) = svc.on_item(&item) {
        if why != wire::WireReject::NotForMe {
            tracing::info!(why = why.as_str(), "lend: item refused");
        }
    }
}

/// `accounts::Store::launch_env` for the sign-in `lend:<grant id>`.
pub fn borrowed_launch_env(agent_id: &str, grant_id: &str) -> Result<crate::tui::LaunchEnv, String> {
    app_service()?.borrowed_launch_env(agent_id, grant_id)
}

/// The chat (ACP) version of `borrowed_launch_env`: the adapter's env, extra arguments and `authenticate` method.
pub fn borrowed_chat(agent_id: &str, grant_id: &str) -> Result<service::BorrowedChat, String> {
    app_service()?.borrowed_chat(agent_id, grant_id)
}

/// A pane started on the sign-in `lend:<grant id>` (any way of starting one): listed on the grant.
pub fn note_pane(grant_id: &str, pane_id: &str) {
    if let Some(svc) = SERVICE.get() {
        svc.note_pane(grant_id, pane_id);
    }
}

/// The label of a borrowed sign-in ("Leo's PC (lent)").
pub fn borrowed_label(grant_id: &str) -> Option<String> {
    SERVICE.get().and_then(|s| s.borrowed_label(grant_id))
}

/// The lend side of the usage bar (empty while the switch is off).
pub fn usage_view() -> crate::usage::LendView {
    if !enabled() {
        return crate::usage::LendView::default();
    }
    SERVICE.get().map(|s| s.usage_view()).unwrap_or_default()
}

/// Renews an idle lend sign-in's token with the agent's own CLI (blocking; for the usage bar). False: not done.
pub fn renew_signin(account_id: &str) -> bool {
    SERVICE.get().map(|s| s.renew_signin_blocking(account_id)).unwrap_or(false)
}

/// The lend profile name that uses the lend sign-in `account_id` (for Settings > Sign in: "Work account", never "Lend Claude 3").
pub fn lend_profile_name(account_id: &str) -> Option<String> {
    let view = SERVICE.get()?.usage_view();
    view.profiles.iter().find(|p| p.account_id == account_id).map(|p| p.name.clone())
}

/// Who is signed in under `home` for `agent_id` (the signed-in identity from the lend spec; never shown, only compared).
/// The main login keeps its identity file next to its folder when the folder itself has none.
pub fn usage_identity(agent_id: &str, home: &std::path::Path, main: bool) -> Option<String> {
    let svc = SERVICE.get()?;
    let auth = svc.spec(agent_id)?.auth.account.as_ref()?;
    signin::identity(&home.to_string_lossy(), auth).or_else(|| if main { home.parent().and_then(|p| signin::identity(&p.to_string_lossy(), auth)) } else { None })
}

/// Active borrowed grants, as extra sign-ins for the account pickers (empty while the switch is off).
pub fn borrowed_rows() -> Vec<Value> {
    if !enabled() {
        return Vec::new();
    }
    SERVICE.get().map(|s| s.borrowed_rows()).unwrap_or_default()
}
