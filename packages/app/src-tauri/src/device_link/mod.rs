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
pub mod route;
pub mod serve;
pub mod web;
pub mod wire;

#[cfg(test)]
mod local_net_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_p2;

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use self::activity::{ActivityLog, Dir, Kind};
use self::client::{AskError, Client, Reach, Timeouts};
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
    activity: Arc<ActivityLog>,
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
            info: Arc::new(Info { p2p: p2p.clone(), name: deps.name.clone(), health: deps.options.health.clone() }),
            live: live.clone(),
            still_allowed: still,
            now: deps.now_secs.clone(),
            extras,
        };
        registry
            .register(Capability::new(capability::AGENTS_REMOTE, alpn::AGENTS, RelayPolicy::Allowed, Arc::new(handler)))
            .map_err(|e| e.to_string())?;
        let web_store = Arc::new(WebStore::new(deps.options.secrets.clone()));
        let client = Client::new(p2p.clone(), deps.timeouts, deps.now_secs.clone(), web_store, deps.options.web_call.clone());
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
            activity,
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

    #[cfg(test)]
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
                if let Some(level) = self.trust.remote_level(&d.node) {
                    set_link_caps(&d.node.to_hex(), Some(caps_of(level)));
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
        self.live.close_where(|peer| self.enabled() && self.trust.remote_level(peer).is_some());
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
                    "web_ready": self.client.web_ready(&d.node),
                    "route_override": self.client.device_route(&d.node).map(|p| p.as_str()),
                    "signed_out": health.signed_out,
                    "needs_person": health.needs_person.iter().map(|(pane, what)| json!({ "pane": pane, "what": what })).collect::<Vec<_>>(),
                    "connected": level.is_some() && self.live.in_use(&d.node, now),
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
        self.client.set_device_route(&id, None);
        self.save_overrides();
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
