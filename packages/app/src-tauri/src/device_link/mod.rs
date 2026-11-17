//! Devices (Labs `devices_enabled`): pair another PC that runs Potato Workspace, then run a chat or a terminal on it and
//! see it in the sidebar. Plan: `DEVICES-RUNTIMES-1115.md`, phase 1.
//!
//! **One idea.** One device list, one pairing, one link; the bridge's own rights decide what a device may do.
//!
//! - **Pairing and trust** are the PC link's own (`crate::p2p`): a short code, both people confirm, a signed trust list
//!   with every switch off. This module adds one switch, `Run agents and terminals here`, with a level (`Watch and
//!   answer` or `Full control`), kept in the same signed entry.
//! - **What travels** is the bridge API we already have, one request per stream (`wire.rs`), on the capability
//!   `agents/remote` (protocol name `pm/agents/1`; a relay may carry it, end to end encrypted).
//! - **Who enforces** is the far device. A request that arrives enters its bridge as a `Caller::Device` for that
//!   device's grant (`mobile_pairing::authorize_link`) and never as the local app; the grant is the level the person
//!   switched on there. Logins never cross: a request runs with the far device's own sign-ins.
//! - **No hops.** A device serves only its own local panes, never another device's.
//! - **The UI reaches this only through app-window commands** (`commands/devices.rs`); no agent, MCP tool, phone route
//!   or CLI names this module (`p2p/guard_tests.rs`).
//!
//! `DeviceLink` is the service the commands call. It owns the endpoint (`P2p`), the pairing manager, the signed trust
//! list, the client (`client.rs`) and the open inbound links (`serve.rs::Live`).

pub mod activity;
pub mod app;
pub mod client;
pub mod files;
pub mod far_http;
pub mod files_client;
pub mod route;
pub mod serve;
pub mod web;
pub mod wire;

#[cfg(test)]
mod files_tests;
#[cfg(test)]
mod local_net_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_far;
#[cfg(test)]
mod tests_p2;

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use self::activity::{ActivityLog, Dir, Kind};
use self::client::{AskError, Client, Reach, Timeouts};
use self::files::{Deny, Folders, FilesEnv, FilesHandler};
use self::files_client::{Files, FilesError, OnExists};
use self::route::{PrefsStore, RoutePref};
use self::serve::{AgentsHandler, Extras, HostBridge, Live, SelfInfo};
#[cfg(test)]
use self::web::{NoWebCall, NoWebGrant};
use self::web::{WebCall, WebGrant, WebStore};
use crate::keys::KeyStore;
use crate::mobile_pairing::{set_link_caps, Caps};
use crate::p2p::alpn;
use crate::p2p::capability::{self, Capability, Registry, RelayPolicy};
use crate::p2p::discovery::Discovery;
use crate::p2p::endpoint::{NodeId, PathKind, TransportFactory};
use crate::p2p::pairing::{Clock, PairManager};
use crate::p2p::trust::{KeyStoreSigner, RemoteLevel, TrustList, TrustStorage};
use crate::p2p::{labs_on_for, P2p};

/// Makes sure the paired PC has an identity record (its own name is the trust list's), and returns the name to show:
/// the person's own if they gave one.
fn observe_identity(node_hex: &str, own_name: &str) -> String {
    let id = crate::mobile_pairing::link_device_id(node_hex);
    let registry = crate::device_identity::global();
    registry.observe(&id, crate::device_identity::DeviceKind::Pc, own_name);
    registry.display_name(&id).unwrap_or_else(|| own_name.to_string())
}

pub const OFF: &str = "FEATURE_OFF: Devices is switched off in Labs";
const NOT_PAIRED: &str = "That device is not paired.";

/// How often every paired device is asked whether it answers.
const PROBE_EVERY: Duration = Duration::from_secs(20);

pub type ViewNotifier = Arc<dyn Fn(&Value) + Send + Sync>;

/// The parts of the service that reach outside it (files, the credential store, the web route, the app's own state).
/// The app passes real ones; `Options::memory()` is what tests start from.
pub struct Options {
    /// A device's own route choice (`{ "<node>": "own" }`).
    pub route_overrides: Arc<dyn PrefsStore>,
    /// The device activity log (kinds only, never text).
    pub activity_store: Arc<dyn PrefsStore>,
    /// Where the web addresses and tokens of other devices are kept.
    pub secrets: Arc<dyn crate::secrets::SecretBackend>,
    /// The far side of the web route: mints and revokes the token a device uses on this PC's web address.
    pub web_grant: Arc<dyn WebGrant>,
    /// This side of the web route: one request on a device's web address.
    pub web_call: Arc<dyn WebCall>,
    /// Whether this PC has a web address a device could use (a stable link or a tunnel).
    pub web_address: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// What only the person at this PC can fix: `{ signed_out, needs_person }`.
    pub health: Arc<dyn Fn() -> Value + Send + Sync>,
    /// Room left per sign-in on this PC, told to a paired device that asks "who are you" (numbers and labels only).
    pub room: Arc<dyn Fn() -> Value + Send + Sync>,
    /// Which paired devices agents on this PC may send work to (a JSON list of node hex; off for every device by default).
    pub send_work_store: Arc<dyn PrefsStore>,
    /// The folders the person chose to share with each device, besides the project folders.
    pub folders_store: Arc<dyn PrefsStore>,
    /// The project folders: what a device may open by default.
    pub project_folders: Arc<dyn Fn() -> Vec<std::path::PathBuf> + Send + Sync>,
    /// Where received files land.
    pub downloads: Arc<dyn Fn() -> std::path::PathBuf + Send + Sync>,
    /// Places that are never shared, besides the sign-in folders in the home folder (this app's own data).
    pub deny_paths: Vec<std::path::PathBuf>,
    /// The person's own Worker, for meeting far-away PCs (Labs far_pcs_enabled). None: no far-away route.
    pub far_relay: Option<Arc<dyn crate::p2p::far::PairRelay>>,
}

impl Options {
    /// Everything in memory, no web address: what the tests start from.
    #[cfg(test)]
    pub fn memory() -> Self {
        Self {
            route_overrides: route::MemoryPrefs::new(),
            activity_store: route::MemoryPrefs::new(),
            secrets: Arc::new(crate::secrets::MemoryBackend::new()),
            web_grant: Arc::new(NoWebGrant),
            web_call: Arc::new(NoWebCall),
            web_address: Arc::new(|| None),
            health: Arc::new(|| json!({ "signed_out": [], "needs_person": [] })),
            room: Arc::new(|| json!([])),
            send_work_store: route::MemoryPrefs::new(),
            folders_store: route::MemoryPrefs::new(),
            project_folders: Arc::new(Vec::new),
            downloads: Arc::new(|| std::env::temp_dir().join("pm-downloads")),
            deny_paths: Vec::new(),
            far_relay: None,
        }
    }
}

/// Everything the service is built from. The app passes real ones; tests pass memory ones.
pub struct Deps {
    pub keys: KeyStore,
    pub factory: Arc<dyn TransportFactory>,
    pub trust_storage: Arc<dyn TrustStorage>,
    /// The route choice ("How far-away devices connect").
    pub prefs: Arc<dyn PrefsStore>,
    /// Where reachable addresses are kept between runs (no secrets: addresses and relay names).
    pub addr_store: Arc<dyn PrefsStore>,
    pub bridge: Arc<dyn HostBridge>,
    pub clock: Arc<dyn Clock>,
    pub discovery: Arc<dyn Discovery>,
    pub name: String,
    pub loopback_only: bool,
    pub timeouts: Timeouts,
    pub now_secs: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub options: Options,
}

struct Info {
    p2p: Arc<P2p>,
    name: String,
    health: Arc<dyn Fn() -> Value + Send + Sync>,
    room: Arc<dyn Fn() -> Value + Send + Sync>,
}

impl SelfInfo for Info {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn addrs(&self) -> Vec<String> {
        self.p2p.local_addrs().iter().map(|a| a.to_string()).collect()
    }
    fn relay(&self) -> Option<String> {
        self.p2p.home_relay()
    }
    fn health(&self) -> Value {
        (self.health)()
    }
    fn room(&self) -> Value {
        (self.room)()
    }
}

pub struct DeviceLink {
    p2p: Arc<P2p>,
    mgr: Arc<PairManager>,
    trust: Arc<TrustList>,
    client: Arc<Client>,
    live: Arc<Live>,
    prefs: Arc<dyn PrefsStore>,
    addr_store: Arc<dyn PrefsStore>,
    overrides: Arc<dyn PrefsStore>,
    send_work: Arc<dyn PrefsStore>,
    activity: Arc<ActivityLog>,
    files: Arc<Files>,
    files_live: Arc<Live>,
    folders: Arc<Folders>,
    web_grant: Arc<dyn WebGrant>,
    web_address: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    route: Mutex<RoutePref>,
    name: String,
    enabled: Arc<AtomicBool>,
    granted: Mutex<BTreeSet<String>>,
    notifier: Mutex<Option<ViewNotifier>>,
    probe_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    last_probe: AtomicU64,
    last_addrs: Mutex<String>,
    now_secs: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// The rights a level stands for. `Watch and answer` is what a phone gets when it can only look and answer.
pub fn caps_of(level: RemoteLevel) -> Caps {
    match level {
        RemoteLevel::Watch => Caps::watch_and_answer(),
        RemoteLevel::Full => Caps::all(),
    }
}

pub fn node_of(hex: &str) -> Result<NodeId, String> {
    if hex.len() != 64 || !hex.is_ascii() {
        return Err(NOT_PAIRED.into());
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|_| NOT_PAIRED.to_string())?;
    }
    Ok(NodeId(out))
}

impl DeviceLink {
    /// Builds the service. Starts nothing, reads no key, opens no socket until `start`.
    pub fn new(deps: Deps) -> Result<Arc<Self>, String> {
        let trust = TrustList::open(deps.trust_storage, Arc::new(KeyStoreSigner::new(deps.keys.clone())));
        let registry = Arc::new(Registry::new());
        let p2p = Arc::new(P2p::new(deps.keys.clone(), deps.factory, registry.clone(), trust.clone()).loopback_only(deps.loopback_only));
        let mgr = PairManager::new(p2p.clone(), trust.clone(), deps.keys, deps.clock, deps.discovery, &deps.name).map_err(|e| e.to_string())?;
        if let Some(relay) = deps.options.far_relay.clone() {
            mgr.set_far_relay(relay);
        }
        let live = Arc::new(Live::default());
        let enabled = Arc::new(AtomicBool::new(false));
        let still = {
            let (trust, enabled) = (trust.clone(), enabled.clone());
            Arc::new(move |peer: &NodeId| enabled.load(Ordering::SeqCst) && trust.remote_level(peer).is_some())
        };
        let activity = ActivityLog::new(deps.options.activity_store.clone());
        let extras = Extras {
            activity: activity.clone(),
            name_of: {
                let trust = trust.clone();
                Arc::new(move |peer: &NodeId| trust.get(peer).map(|d| d.name).unwrap_or_default())
            },
            web: deps.options.web_grant.clone(),
            web_allowed: {
                let trust = trust.clone();
                Arc::new(move |peer: &NodeId| trust.web_allowed(peer).then(|| trust.remote_level(peer) == Some(RemoteLevel::Full)))
            },
        };
        let handler = AgentsHandler {
            bridge: deps.bridge,
            info: Arc::new(Info { p2p: p2p.clone(), name: deps.name.clone(), health: deps.options.health.clone(), room: deps.options.room.clone() }),
            live: live.clone(),
            still_allowed: still,
            now: deps.now_secs.clone(),
            extras,
        };
        registry
            .register(Capability::new(capability::AGENTS_REMOTE, alpn::AGENTS, RelayPolicy::Allowed, Arc::new(handler)))
            .map_err(|e| e.to_string())?;
        // Files (`pm/files/1`): its own switch per device, its own open links, its own folder choices.
        let folders = Folders::new(deps.options.folders_store.clone(), deps.options.project_folders.clone());
        let files_live = Arc::new(Live::default());
        let files_still: Arc<dyn Fn(&NodeId) -> bool + Send + Sync> = {
            let (trust, enabled) = (trust.clone(), enabled.clone());
            Arc::new(move |peer: &NodeId| enabled.load(Ordering::SeqCst) && crate::p2p::capability::Permissions::allowed(trust.as_ref(), peer, capability::FILES))
        };
        let name_of: Arc<dyn Fn(&NodeId) -> String + Send + Sync> = {
            let trust = trust.clone();
            Arc::new(move |peer: &NodeId| trust.get(peer).map(|d| d.name).unwrap_or_default())
        };
        let files_env = FilesEnv {
            folders: folders.clone(),
            deny: Deny::new(&deps.options.deny_paths),
            activity: activity.clone(),
            name_of: name_of.clone(),
            still_allowed: files_still,
            now: deps.now_secs.clone(),
        };
        registry
            .register(Capability::new(capability::FILES, alpn::FILES, RelayPolicy::Allowed, Arc::new(FilesHandler { env: files_env, live: files_live.clone() })))
            .map_err(|e| e.to_string())?;
        let web_store = Arc::new(WebStore::new(deps.options.secrets.clone()));
        let client = Client::new(p2p.clone(), deps.timeouts, deps.now_secs.clone(), web_store, deps.options.web_call.clone());
        let files = Files::new(client.clone(), activity.clone(), name_of, deps.now_secs.clone(), deps.options.downloads.clone(), &deps.name);
        let route = route::load(deps.prefs.as_ref());
        client.set_global_route(route);
        for (hex, pref) in load_overrides(deps.options.route_overrides.as_ref()) {
            if let Ok(node) = node_of(&hex) {
                client.set_device_route(&node, Some(pref));
            }
        }
        let me = Arc::new(Self {
            p2p,
            mgr,
            trust,
            client,
            live,
            prefs: deps.prefs,
            addr_store: deps.addr_store,
            overrides: deps.options.route_overrides,
            send_work: deps.options.send_work_store,
            activity,
            files,
            files_live,
            folders,
            web_grant: deps.options.web_grant,
            web_address: deps.options.web_address,
            route: Mutex::new(route),
            name: crate::p2p::trust::clean_name(&deps.name),
            enabled,
            granted: Mutex::new(BTreeSet::new()),
            notifier: Mutex::new(None),
            probe_task: Mutex::new(None),
            last_probe: AtomicU64::new(0),
            last_addrs: Mutex::new(String::new()),
            now_secs: deps.now_secs,
        });
        let weak = Arc::downgrade(&me);
        me.mgr.set_notifier(Arc::new({
            let weak = weak.clone();
            move |_| {
                if let Some(me) = weak.upgrade() {
                    me.changed();
                }
            }
        }));
        me.client.set_changed(Arc::new({
            let weak = weak.clone();
            move || {
                if let Some(me) = weak.upgrade() {
                    me.changed();
                }
            }
        }));
        me.files.set_changed(Arc::new({
            let weak = weak.clone();
            move || {
                if let Some(me) = weak.upgrade() {
                    me.changed();
                }
            }
        }));
        me.live.set_on_change(Arc::new(move || {
            if let Some(me) = weak.upgrade() {
                me.changed();
            }
        }));
        Ok(me)
    }

    pub fn set_notifier(&self, n: ViewNotifier) {
        *self.notifier.lock().unwrap_or_else(|p| p.into_inner()) = Some(n);
    }

    pub fn set_event_sink(&self, f: Arc<dyn Fn(&str, &str) + Send + Sync>) {
        self.client.set_event_sink(f);
    }

    /// Where a live terminal's screen text goes: `(node, pane id, text)`.
    pub fn set_screen_sink(&self, f: client::ScreenSink) {
        self.client.set_screen_sink(f);
    }

    fn changed(&self) {
        let n = self.notifier.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(n) = n {
            n(&self.view());
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn p2p(&self) -> &Arc<P2p> {
        &self.p2p
    }

    pub fn route_pref(&self) -> RoutePref {
        *self.route.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ----- settings and start -----

    /// The effective public settings changed. Turning the switch off ends everything now: grants withdrawn, inbound
    /// links closed, outbound links and streams dropped, the code withdrawn, the endpoint closed.
    pub fn apply_settings(self: &Arc<Self>, public: &Value) {
        let on = labs_on_for(public, capability::AGENTS_REMOTE);
        self.p2p.apply_settings(public);
        let was = self.enabled.swap(on, Ordering::SeqCst);
        if on == was {
            return;
        }
        if on {
            self.sync_grants();
            return;
        }
        self.sync_grants();
        self.live.close_where(|_| false);
        self.files_live.close_where(|_| false);
        self.mgr.cancel_hosting();
        if let Some(h) = self.probe_task.lock().unwrap_or_else(|p| p.into_inner()).take() {
            h.abort();
        }
        let me = self.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                me.client.shutdown().await;
                me.p2p.stop();
            });
        } else {
            self.p2p.stop();
        }
    }

    /// Opens the endpoint (this PC can now be reached by the devices that may) and starts asking after the others.
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        if !self.enabled() {
            return Err(OFF.into());
        }
        self.sync_relay().await;
        self.p2p.want(capability::AGENTS_REMOTE).await.map_err(|e| e.to_string())?;
        // Files is a second protocol name on the same endpoint; it needs no extra switch of its own to be listening, because every
        // device's own `files` switch is checked at the door.
        let _ = self.p2p.want(capability::FILES).await;
        self.load_addrs();
        self.sync_grants();
        self.start_probing();
        Ok(())
    }

    fn start_probing(self: &Arc<Self>) {
        let mut slot = self.probe_task.lock().unwrap_or_else(|p| p.into_inner());
        if slot.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let me = Arc::downgrade(self);
        *slot = Some(tokio::spawn(async move {
            loop {
                let Some(this) = me.upgrade() else { return };
                if !this.enabled() {
                    return;
                }
                this.probe_all().await;
                drop(this);
                tokio::time::sleep(PROBE_EVERY).await;
            }
        }));
    }

    /// Asks every paired device whether it answers, all at once.
    pub async fn probe_all(&self) {
        self.last_probe.store((self.now_secs)(), Ordering::SeqCst);
        let nodes: Vec<NodeId> = self.trust.list().iter().map(|d| d.node).collect();
        let probes = nodes.iter().map(|n| async move {
            let _ = self.client.hello(n).await;
        });
        futures_util_join(probes).await;
        self.save_addrs();
        self.changed();
    }

    /// `probe_all` in the background when the last one is older than `max_age` seconds.
    pub fn probe_if_stale(self: &Arc<Self>, max_age: u64) {
        if !self.enabled() {
            return;
        }
        let age = (self.now_secs)().saturating_sub(self.last_probe.load(Ordering::SeqCst));
        if age >= max_age {
            let me = self.clone();
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                rt.spawn(async move { me.probe_all().await });
            }
        }
    }

    /// The endpoint binds a public relay when any paired device (or this PC's own choice, with none paired) may use one.
    async fn sync_relay(&self) {
        let nodes: Vec<NodeId> = self.trust.list().iter().map(|d| d.node).collect();
        self.p2p.set_relays_allowed(self.client.any_relay_wanted(&nodes)).await;
    }

    // ----- grants -----

    /// Makes the far side's rights match the trust list: what the person switched on, and nothing else.
    pub fn sync_grants(&self) {
        let on = self.enabled();
        let mut now = BTreeSet::new();
        if on {
            for d in self.trust.list() {
                let level = self.trust.remote_level(&d.node);
                let lend = self.trust.lend_allowed(&d.node);
                if level.is_some() || lend {
                    // What the person switched on, and nothing else: a device that may only borrow holds `lend` alone.
                    let base = level.map(caps_of).unwrap_or_else(Caps::none);
                    set_link_caps(&d.node.to_hex(), Some(base.with(crate::mobile_pairing::Cap::Lend, lend)));
                    observe_identity(&d.node.to_hex(), &d.name);
                    now.insert(d.node.to_hex());
                }
            }
        }
        let mut granted = self.granted.lock().unwrap_or_else(|p| p.into_inner());
        for gone in granted.difference(&now) {
            set_link_caps(gone, None);
        }
        *granted = now;
    }

    /// A switch changed: rights follow at once, and a link whose switch is off is closed now.
    fn rights_changed(&self) {
        self.sync_grants();
        self.live.close_where(|peer| self.enabled() && (self.trust.remote_level(peer).is_some() || self.trust.lend_allowed(peer)));
        self.files_live.close_where(|peer| self.enabled() && self.files_allowed(peer));
        // A device that may not use the web address any more loses its token now.
        for d in self.trust.list() {
            if !self.trust.web_allowed(&d.node) {
                self.web_grant.revoke(&d.node.to_hex());
            }
        }
        self.changed();
    }

    // ----- addresses -----

    fn load_addrs(&self) {
        let Some(text) = self.addr_store.load() else { return };
        let Ok(map) = serde_json::from_str::<serde_json::Map<String, Value>>(&text) else { return };
        for (hex, entry) in map {
            let Ok(node) = node_of(&hex) else { continue };
            if !self.trust.is_trusted(&node) {
                continue;
            }
            let addrs: Vec<std::net::SocketAddr> =
                entry["addrs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().and_then(|t| t.parse().ok())).collect()).unwrap_or_default();
            self.p2p.addrs().remember(node, &addrs);
            if let Some(relay) = entry["relay"].as_str() {
                self.p2p.addrs().remember_relay(node, relay);
            }
        }
    }

    fn save_addrs(&self) {
        let mut map = serde_json::Map::new();
        for (node, addrs, relay) in self.p2p.addrs().snapshot() {
            if self.trust.is_trusted(&node) {
                map.insert(node.to_hex(), json!({ "addrs": addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>(), "relay": relay }));
            }
        }
        let text = Value::Object(map).to_string();
        let mut last = self.last_addrs.lock().unwrap_or_else(|p| p.into_inner());
        if *last != text && self.addr_store.save(&text).is_ok() {
            *last = text;
        }
    }

    // ----- the page's view -----

    pub fn view(&self) -> Value {
        let pair = self.mgr.view();
        let hosting = pair["hosting"].as_object().map(|h| {
            json!({ "kind": h["kind"], "code": h["code"], "address": h["ticket"], "link": h["link"], "expires_at": h["expires_at"] })
        });
        let now = (self.now_secs)();
        let devices: Vec<Value> = self
            .trust
            .list()
            .iter()
            .map(|d| {
                let st = self.client.status(&d.node);
                let level = self.trust.remote_level(&d.node);
                let name = observe_identity(&d.node.to_hex(), &d.name);
                let health = self.client.health(&d.node);
                let (room, room_at) = self.client.room(&d.node);
                json!({
                    "node": d.node.to_hex(),
                    "name": name,
                    "added_at": d.added_at,
                    "state": match st.reach {
                        Reach::Unknown => "unknown",
                        Reach::Online => "online",
                        Reach::Offline => "offline",
                        Reach::Asleep => "asleep",
                        Reach::Closed => "closed",
                        Reach::NotAllowed => "not_allowed",
                    },
                    "path": match (st.reach, st.path, st.via_web) {
                        (Reach::Online, _, true) => json!("own"),
                        (Reach::Online, Some(PathKind::Direct), _) => json!("direct"),
                        (Reach::Online, Some(PathKind::Relayed), _) => json!("relay"),
                        _ => Value::Null,
                    },
                    "last_seen": st.last_seen,
                    "too_old": st.too_old,
                    "lets_run": level.is_some(),
                    "level": if level == Some(RemoteLevel::Full) { "full" } else { "watch" },
                    "lets_web": self.trust.web_allowed(&d.node),
                    "lets_lend": self.trust.lend_allowed(&d.node),
                    "agents_may_send": self.agents_may_send(&d.node.to_hex()),
                    "web_ready": self.client.web_ready(&d.node),
                    "route_override": self.client.device_route(&d.node).map(|p| p.as_str()),
                    "room": crate::usage::room::payload(&room),
                    "room_at": room_at,
                    "signed_out": health.signed_out,
                    "needs_person": health.needs_person.iter().map(|(pane, what)| json!({ "pane": pane, "what": what })).collect::<Vec<_>>(),
                    "connected": level.is_some() && self.live.in_use(&d.node, now),
                    "lets_files": self.files_allowed(&d.node),
                })
            })
            .collect();
        json!({
            "enabled": self.enabled(),
            "name": self.name,
            "route_pref": self.route_pref().as_str(),
            // Whether this PC has a web address (a stable link or a tunnel) that a device can reach it through.
            "own_route_ready": (self.web_address)().is_some(),
            "hosting": hosting,
            "pending": pair["pending"],
            "joining": pair["joining"],
            "message": pair["message"],
            "locked_until": pair["locked_until"],
            "tampered": pair["tampered"],
            "devices": devices,
            "transfers": self.files.rows_json(),
        })
    }

    // ----- pairing (the person's, at this screen) -----

    pub async fn show_code(self: &Arc<Self>) -> Result<Value, String> {
        self.require_on()?;
        self.start().await?;
        self.mgr.start_hosting().await.map_err(|e| e.to_string())?;
        Ok(self.view())
    }

    pub fn cancel_code(&self) -> Result<Value, String> {
        self.require_on()?;
        self.mgr.cancel_hosting();
        Ok(self.view())
    }

    /// A pairing link for a device that is far away: single use, 10 minutes, a public relay may carry it. It gives no
    /// rights by itself; both people still confirm.
    pub async fn make_link(self: &Arc<Self>) -> Result<Value, String> {
        self.require_on()?;
        if !self.route_pref().relay_allowed() {
            return Err("A pairing link needs the public relay. Pick Automatic or Public relay only for a moment.".into());
        }
        self.start().await?;
        self.mgr.start_hosting_link().await.map_err(|e| e.to_string())?;
        Ok(self.view())
    }

    pub async fn join_link(self: &Arc<Self>, link: &str) -> Result<Value, String> {
        self.require_on()?;
        self.start().await?;
        self.mgr.join_link(link).await.map_err(|e| e.to_string())?;
        self.save_addrs();
        Ok(self.view())
    }

    pub async fn join(self: &Arc<Self>, address: &str, code: &str) -> Result<Value, String> {
        self.require_on()?;
        self.start().await?;
        self.mgr.join(address, code).await.map_err(|e| e.to_string())?;
        self.save_addrs();
        Ok(self.view())
    }

    /// The person's answer to the "wants to pair" sheet. Only an app window may call this.
    pub fn pair_answer(&self, id: u64, allow: bool) -> Result<Value, String> {
        self.require_on()?;
        self.mgr.answer(id, allow).map_err(|e| e.to_string())?;
        Ok(self.view())
    }

    /// The person's pick on a sheet that shows numbers. Only an app window may call this.
    pub fn pair_pick(&self, id: u64, pick: &str) -> Result<Value, String> {
        self.require_on()?;
        self.mgr.answer_pick(id, pick).map_err(|e| e.to_string())?;
        Ok(self.view())
    }

    pub fn rename(&self, node: &str, name: &str) -> Result<Value, String> {
        self.require_on()?;
        self.mgr.rename(&node_of(node)?, name).map_err(|e| e.to_string())?;
        // The one identity record keeps the person's name, so "from <name>" under a message follows the rename.
        observe_identity(node, &self.trust.list().iter().find(|d| d.node.to_hex() == node).map(|d| d.name.clone()).unwrap_or_default());
        crate::device_identity::global().rename(&crate::mobile_pairing::link_device_id(node), name);
        Ok(self.view())
    }

    /// What this PC lets `node` do when it runs agents here. `level` is `"watch"` or `"full"` (default `"watch"`).
    /// A new device has nothing on; only the person at this screen turns it on.
    pub fn set_permission(&self, node: &str, on: bool, level: Option<&str>) -> Result<Value, String> {
        self.require_on()?;
        let node = node_of(node)?;
        if !self.trust.is_trusted(&node) {
            return Err(NOT_PAIRED.into());
        }
        if on {
            let full = match level {
                Some("full") => true,
                Some("watch") | None => false,
                Some(_) => return Err("Pick Watch and answer, or Full control.".into()),
            };
            self.mgr.set_permission(&node, capability::AGENTS_REMOTE, true).map_err(|e| e.to_string())?;
            self.mgr.set_permission(&node, capability::AGENTS_REMOTE_FULL, full).map_err(|e| e.to_string())?;
        } else {
            self.mgr.set_permission(&node, capability::AGENTS_REMOTE, false).map_err(|e| e.to_string())?;
        }
        self.rights_changed();
        Ok(self.view())
    }

    pub async fn remove(&self, node: &str) -> Result<Value, String> {
        self.require_on()?;
        let id = node_of(node)?;
        self.mgr.remove(&id).map_err(|e| e.to_string())?;
        crate::device_identity::global().forget(&crate::mobile_pairing::link_device_id(node));
        self.rights_changed();
        self.web_grant.revoke(&id.to_hex());
        self.activity.forget(&id.to_hex());
        self.files.forget(&id.to_hex());
        self.folders.forget(&id.to_hex());
        self.client.set_device_route(&id, None);
        self.save_overrides();
        self.forget_send_work(&id.to_hex());
        self.client.forget_all_of(&id).await;
        self.save_addrs();
        self.sync_relay().await;
        Ok(self.view())
    }

    /// The person at this screen ends a device's access now: its switch goes off and its link closes.
    pub fn disconnect(&self, node: &str) -> Result<Value, String> {
        self.set_permission(node, false, None)
    }

    pub async fn set_route(&self, pref: &str) -> Result<Value, String> {
        self.require_on()?;
        let pref = RoutePref::parse(pref).ok_or_else(|| "Pick Automatic, Public relay only, or My own route only.".to_string())?;
        self.prefs.save(pref.as_str())?;
        *self.route.lock().unwrap_or_else(|p| p.into_inner()) = pref;
        self.client.set_global_route(pref);
        self.sync_relay().await;
        self.changed();
        Ok(self.view())
    }

    /// One device's own route choice (`None`: follow this PC's choice).
    pub async fn set_device_route(&self, node: &str, pref: Option<&str>) -> Result<Value, String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        let parsed = match pref {
            Some(p) => Some(RoutePref::parse(p).ok_or_else(|| "Pick Automatic, Public relay only, or My own route only.".to_string())?),
            None => None,
        };
        self.client.set_device_route(&id, parsed);
        self.save_overrides();
        self.sync_relay().await;
        self.changed();
        Ok(self.view())
    }

    fn save_overrides(&self) {
        let mut map = serde_json::Map::new();
        for d in self.trust.list() {
            if let Some(p) = self.client.device_route(&d.node) {
                map.insert(d.node.to_hex(), json!(p.as_str()));
            }
        }
        let _ = self.overrides.save(&Value::Object(map).to_string());
    }

    /// Lets (or stops letting) a device also reach this PC through its web address. Only with the run switch on.
    pub fn set_web(&self, node: &str, on: bool) -> Result<Value, String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        if on && self.trust.remote_level(&id).is_none() {
            return Err("Turn on Run agents and terminals here first.".into());
        }
        self.mgr.set_permission(&id, capability::AGENTS_REMOTE_WEB, on).map_err(|e| e.to_string())?;
        if !on {
            self.web_grant.revoke(&id.to_hex());
        }
        self.changed();
        Ok(self.view())
    }

    // ----- agents sending work to another device (MCP `run_agent`, account `device:<name>`) -----

    fn send_work_set(&self) -> BTreeSet<String> {
        self.send_work
            .load()
            .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
            .map(|v| v.into_iter().collect())
            .unwrap_or_default()
    }

    fn save_send_work(&self, set: &BTreeSet<String>) -> Result<(), String> {
        self.send_work.save(&serde_json::to_string(&set.iter().collect::<Vec<_>>()).map_err(|e| e.to_string())?)
    }

    /// Whether agents on this PC may send work to that device. Off for every device until the person turns it on.
    pub fn agents_may_send(&self, node_hex: &str) -> bool {
        self.trust.list().iter().any(|d| d.node.to_hex() == node_hex) && self.send_work_set().contains(node_hex)
    }

    fn forget_send_work(&self, node_hex: &str) {
        let mut set = self.send_work_set();
        if set.remove(node_hex) {
            let _ = self.save_send_work(&set);
        }
    }

    /// The person's switch: "Agents may send work to this device". It is this PC's own choice, so it is not in the trust
    /// list; the far device still needs to have given Full control, and it decides at its end.
    pub fn set_agents_send(&self, node: &str, on: bool) -> Result<Value, String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        let mut set = self.send_work_set();
        if on {
            set.insert(id.to_hex());
        } else {
            set.remove(&id.to_hex());
        }
        self.save_send_work(&set)?;
        self.changed();
        Ok(self.view())
    }

    /// A paired device by its name (any case) or by the start of its node id: `(node hex, name)`.
    pub fn resolve_device(&self, wanted: &str) -> Result<(String, String), String> {
        let wanted = wanted.trim();
        if wanted.is_empty() {
            return Err("Name a device, for example account \"device:Mac mini\".".into());
        }
        let lower = wanted.to_lowercase();
        let all = self.trust.list();
        let by_name: Vec<_> = all.iter().filter(|d| d.name.to_lowercase() == lower).collect();
        let found: Vec<_> = if by_name.is_empty() {
            all.iter().filter(|d| lower.len() >= 6 && d.node.to_hex().starts_with(&lower)).collect()
        } else {
            by_name
        };
        match found.as_slice() {
            [] => Err(format!("No paired device is called \"{wanted}\".")),
            [one] => Ok((one.node.to_hex(), one.name.clone())),
            many => Err(format!(
                "More than one device matches \"{wanted}\": {}. Use the start of its id instead.",
                many.iter().map(|d| format!("{} ({})", d.name, &d.node.to_hex()[..8])).collect::<Vec<_>>().join(", ")
            )),
        }
    }

    /// The paired PCs as `(node hex, name)`, for lending between my own PCs.
    pub fn own_peers(&self) -> Vec<(String, String)> {
        if !self.enabled() {
            return Vec::new();
        }
        self.trust.list().iter().map(|d| (d.node.to_hex(), observe_identity(&d.node.to_hex(), &d.name))).collect()
    }

    /// This PC's own name on the link.
    pub fn self_name(&self) -> String {
        self.name.clone()
    }

    /// Lets (or stops letting) a device ask to borrow this PC's agent sign-ins. Independent of the run switch. Nothing is copied: a
    /// borrowed sign-in only ever works through this PC (the lend proxy).
    pub fn set_lend(&self, node: &str, on: bool) -> Result<Value, String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        self.mgr.set_permission(&id, capability::LEND_CONTROL, on).map_err(|e| e.to_string())?;
        self.rights_changed();
        Ok(self.view())
    }

    /// The device activity log, newest first (`node`: only that device's lines).
    pub fn activity(&self, node: Option<&str>) -> Result<Value, String> {
        self.require_on()?;
        Ok(Value::Array(self.activity.list(node)))
    }

    // ----- using another device -----

    /// One bridge request on a paired device, as this PC. The far device enforces what this PC may do: a refusal comes
    /// back as its own status and words. An unreachable device is an error.
    pub async fn request(&self, node: &str, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        let bytes = match body {
            Some(v) => serde_json::to_vec(&v).map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        match self.client.request(&id, method, path, &bytes).await {
            Ok(answer) => {
                // The mirror line: a kind only, never the body or the path.
                if let Some(kind) = activity::classify(method, path) {
                    let line = if answer.0 == 403 { Some(Kind::Refused) } else if answer.0 < 300 { Some(kind) } else { None };
                    if let Some(kind) = line {
                        let name = self.trust.get(&id).map(|d| d.name).unwrap_or_default();
                        self.activity.record((self.now_secs)(), &id.to_hex(), &name, Dir::Out, kind);
                    }
                }
                Ok(answer)
            }
            Err(AskError::NotAllowed) => Ok((
                403,
                json!({
                    "error": "not_allowed",
                    "code": "REMOTE_OFF",
                    "hint": "That device does not let this PC run agents. Turn it on there: Settings > Devices.",
                }),
            )),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn subscribe(self: &Arc<Self>, node: &str) -> Result<(), String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        self.client.start_events(id);
        Ok(())
    }

    pub fn unsubscribe(&self, node: &str) -> Result<(), String> {
        let id = node_of(node)?;
        self.client.stop_events(&id);
        Ok(())
    }

    /// Starts a live view of one terminal on a device (its screen text arrives at the screen sink the moment it changes).
    pub fn screen_start(self: &Arc<Self>, node: &str, pane: &str) -> Result<(), String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        if pane.is_empty() || pane.len() > 128 || pane.chars().any(|c| c.is_control() || c == '/' || c == '?' || c == '#' || c == '\\' || c == ' ') {
            return Err("That is not a terminal.".into());
        }
        self.client.start_screen(id, pane.to_string());
        Ok(())
    }

    pub fn screen_stop(&self, node: &str, pane: &str) -> Result<(), String> {
        let id = node_of(node)?;
        self.client.stop_screen(&id, pane);
        Ok(())
    }

    // ----- files (phase 4) -----

    /// Whether this PC lets `node` open its shared folders (its own switch, apart from running agents).
    fn files_allowed(&self, node: &NodeId) -> bool {
        crate::p2p::capability::Permissions::allowed(self.trust.as_ref(), node, capability::FILES)
    }

    /// The person's switch: may that device look in this PC's shared folders and copy files to and from it? Off after pairing.
    pub fn set_files(&self, node: &str, on: bool) -> Result<Value, String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        self.mgr.set_permission(&id, capability::FILES, on).map_err(|e| e.to_string())?;
        self.rights_changed();
        Ok(self.view())
    }

    /// The folders this PC shares with a device: the project folders and the ones the person added for it.
    pub fn files_folders(&self, node: &str) -> Result<Value, String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        let hex = id.to_hex();
        let shared: Vec<String> = self.folders.roots(&hex).into_iter().map(|r| r.name).collect();
        Ok(json!({ "shared": shared, "chosen": self.folders.chosen(&hex) }))
    }

    /// Only the person at this screen decides which folders a device may open here.
    pub fn files_set_folders(&self, node: &str, folders: &[String]) -> Result<Value, String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        self.folders.set_chosen(&id.to_hex(), folders)?;
        self.files_folders(node)
    }

    fn trusted(&self, node: &str) -> Result<NodeId, String> {
        self.require_on()?;
        let id = node_of(node)?;
        if !self.trust.is_trusted(&id) {
            return Err(NOT_PAIRED.into());
        }
        Ok(id)
    }

    fn files_say(e: FilesError) -> Value {
        json!({ "ok": false, "error": e.to_string(), "code": e.code() })
    }

    /// The shared folders of a far device, as it answers.
    pub async fn far_roots(&self, node: &str) -> Result<Value, String> {
        let id = self.trusted(node)?;
        Ok(self.files.roots(&id).await.unwrap_or_else(Self::files_say))
    }

    pub async fn far_list(&self, node: &str, root: &str, path: &str) -> Result<Value, String> {
        let id = self.trusted(node)?;
        Ok(self.files.list(&id, root, path).await.unwrap_or_else(Self::files_say))
    }

    pub async fn far_preview(&self, node: &str, root: &str, path: &str) -> Result<Value, String> {
        let id = self.trusted(node)?;
        Ok(self.files.preview(&id, root, path).await.unwrap_or_else(Self::files_say))
    }

    /// Copies from a far device to this PC (Downloads, or `dest`). `on_exists`: `ask`, `replace` or `both`.
    pub async fn far_copy(self: &Arc<Self>, node: &str, root: &str, paths: &[String], dest: Option<&str>, on_exists: &str) -> Result<Value, String> {
        let id = self.trusted(node)?;
        let on_exists = OnExists::parse(on_exists).ok_or_else(|| "Pick ask, replace or keep both.".to_string())?;
        Ok(self.files.copy_here(id, root, paths, dest.map(std::path::PathBuf::from), on_exists).await.unwrap_or_else(Self::files_say))
    }

    /// Sends files or folders of this PC into a far device's shared folder.
    pub async fn far_send(self: &Arc<Self>, node: &str, root: &str, dir: &str, local: &[String], on_exists: &str) -> Result<Value, String> {
        let id = self.trusted(node)?;
        let on_exists = OnExists::parse(on_exists).ok_or_else(|| "Pick ask, replace or keep both.".to_string())?;
        let local: Vec<std::path::PathBuf> = local.iter().map(std::path::PathBuf::from).collect();
        Ok(self.files.send_to(id, root, dir, &local, on_exists).await.unwrap_or_else(Self::files_say))
    }

    pub fn transfer_cancel(&self, id: u64) -> Result<(), String> {
        self.require_on()?;
        self.files.cancel(id);
        Ok(())
    }

    pub fn transfers_clear(&self) -> Result<Value, String> {
        self.require_on()?;
        self.files.clear_done();
        Ok(self.view())
    }

    #[cfg(test)]
    pub fn files_retry_wait_for_tests(&self, wait: Duration) {
        self.files.set_retry_wait(wait);
    }

    fn require_on(&self) -> Result<(), String> {
        if self.enabled() {
            Ok(())
        } else {
            Err(OFF.into())
        }
    }

    /// App quit: nothing is left open, and every device that is connected is told goodbye (so it says "closed", not
    /// "asleep or off").
    pub fn shutdown(&self) {
        self.mgr.cancel_hosting();
        if self.live.goodbye() > 0 {
            // Let the goodbye leave before the endpoint is torn down.
            std::thread::sleep(Duration::from_millis(150));
        }
        self.live.close_where(|_| false);
        self.files_live.goodbye();
        self.files_live.close_where(|_| false);
        for g in self.granted.lock().unwrap_or_else(|p| p.into_inner()).iter() {
            set_link_caps(g, None);
        }
        self.p2p.stop();
    }
}

/// `{ "<node hex>": "own" }` -> the choices that are valid.
fn load_overrides(store: &dyn PrefsStore) -> Vec<(String, RoutePref)> {
    let Some(text) = store.load() else { return Vec::new() };
    let Ok(map) = serde_json::from_str::<serde_json::Map<String, Value>>(&text) else { return Vec::new() };
    map.into_iter().filter_map(|(hex, v)| Some((hex, RoutePref::parse(v.as_str()?)?))).collect()
}

/// Runs the futures together and waits for all (the crate has no `futures`; this is all that is needed).
async fn futures_util_join<F: std::future::Future<Output = ()>>(futures: impl IntoIterator<Item = F>) {
    let mut set = Vec::new();
    for f in futures {
        set.push(Box::pin(f));
    }
    let mut pending = set;
    std::future::poll_fn(move |cx| {
        pending.retain_mut(|f| f.as_mut().poll(cx).is_pending());
        if pending.is_empty() {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await
}
