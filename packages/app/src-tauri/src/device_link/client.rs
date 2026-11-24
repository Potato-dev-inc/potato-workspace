//! This side: asking another paired Workspace to do something, and keeping track of whether it can be reached.
//!
//! - One link per device, opened when first needed and kept. A request is one stream on it.
//! - `hello` is the cheap question that tells whether a device answers, over which path, where it can be reached, and
//!   what only the person at it can fix (signed out, a prompt waiting).
//! - The state words come from what actually happened: it answered (`Online`), it closed the door with the "not allowed"
//!   code (`NotAllowed`: its switch for this PC is off, or it removed this PC), it said goodbye (`Closed`: the app was
//!   closed there), it was online and vanished without a word (`Asleep`: asleep or off), or nothing ever answered
//!   (`Offline`).
//! - The route (`route.rs`): Automatic tries the link (direct, then the public relay) and then the device's own web
//!   address; Public relay only never uses the web address; My own route only never uses a public relay. A device can
//!   have its own choice.
//! - Nothing is retried in a loop here: the caller (the page, the sidebar) asks again, and the upkeep probes on a timer.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::activity::Kind;
use super::redial::{self, Why};
use super::route::RoutePref;
use super::web::{self, WebCall, WebStore};
use super::wire::{self, Head, ReplyHead};
use crate::p2p::capability;
use crate::p2p::endpoint::{Link, NodeId, P2pError, PathKind, CLOSE_GOODBYE, CLOSE_NOT_ALLOWED, CLOSE_UNKNOWN_ALPN};
use crate::p2p::P2p;

/// What this PC knows about reaching one device, from its own side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// Never asked.
    Unknown,
    Online,
    /// Never answered (or never since this app started).
    Offline,
    /// It was online and went away without a word: asleep or off.
    Asleep,
    /// The app said goodbye: it was closed there.
    Closed,
    /// The device closed the door on purpose: it does not let this PC run agents (or removed it).
    NotAllowed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    pub reach: Reach,
    /// Direct or through a relay, while online by the link.
    pub path: Option<PathKind>,
    /// Online through the device's own web address (the link could not connect).
    pub via_web: bool,
    /// Unix seconds of the last answer.
    pub last_seen: Option<u64>,
    /// The device runs an older Workspace (a different protocol version or no `agents/remote` at all).
    pub too_old: bool,
}

impl Default for Status {
    fn default() -> Self {
        Self { reach: Reach::Unknown, path: None, via_web: false, last_seen: None, too_old: false }
    }
}

/// What only the person at the device can fix, as the device said it in its last `hello`. Untrusted text, bounded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Health {
    pub signed_out: Vec<String>,
    pub needs_person: Vec<(String, String)>,
}

fn plain(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

impl Health {
    pub fn from_hello(value: &Value) -> Self {
        let h = &value["health"];
        let signed_out = h["signed_out"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| plain(s, 40)).filter(|s| !s.is_empty()).take(12).collect()).unwrap_or_default();
        let needs_person = h["needs_person"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| Some((plain(x["pane"].as_str()?, 80), plain(x["what"].as_str()?, 120))))
                    .filter(|(p, w)| !p.is_empty() && !w.is_empty())
                    .take(8)
                    .collect()
            })
            .unwrap_or_default();
        Self { signed_out, needs_person }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AskError {
    #[error("That device is not reachable right now.")]
    Offline,
    #[error("That device does not let this PC run agents. Turn it on there: Settings > Devices.")]
    NotAllowed,
    #[error("That device does not let this PC use its files. Turn it on there: Settings > Devices.")]
    FilesOff,
    #[error("That device runs an older Potato Workspace. Update it to connect.")]
    TooOld,
    #[error("{0}")]
    Other(String),
}

/// How long one dial, one header and one answer may take.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub dial: Duration,
    pub answer: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self { dial: Duration::from_secs(12), answer: Duration::from_secs(60) }
    }
}

type Changed = Arc<dyn Fn() + Send + Sync>;
type EventSink = Arc<dyn Fn(&str, &str) + Send + Sync>;
/// Looks a paired PC up on the account again: the relay the account names for it, if any. Blocking.
pub type Refresher = Arc<dyn Fn(&NodeId) -> Option<String> + Send + Sync>;
/// Says in the device activity log why a try failed (`Kind` is a closed list; the page has a sentence for each).
pub type DialLog = Arc<dyn Fn(&NodeId, Kind) + Send + Sync>;

#[derive(Default)]
struct Slot {
    /// Held while dialing, so two requests do not dial twice.
    link: tokio::sync::Mutex<Option<Arc<dyn Link>>>,
    /// The link for files (`pm/files/1`), kept apart from the agents link.
    files: tokio::sync::Mutex<Option<Arc<dyn Link>>>,
    status: Mutex<Status>,
    /// Dials that failed in a row; any working dial resets it.
    fails: Mutex<u32>,
    health: Mutex<Health>,
    /// The device's room left from its last `hello`, and when (unix seconds) it was told.
    room: Mutex<(Vec<crate::usage::room::Room>, Option<u64>)>,
}

#[derive(Default)]
struct Routes {
    global: RoutePref,
    per: HashMap<NodeId, RoutePref>,
}

pub struct Client {
    p2p: Arc<P2p>,
    slots: Mutex<HashMap<NodeId, Arc<Slot>>>,
    streams: Mutex<HashMap<NodeId, tokio::task::JoinHandle<()>>>,
    changed: Mutex<Option<Changed>>,
    events: Mutex<Option<EventSink>>,
    timeouts: Timeouts,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    routes: Mutex<Routes>,
    web_store: Arc<WebStore>,
    web_call: Arc<dyn WebCall>,
    /// When the web address was last asked for, per device (asked at most once a minute).
    web_asked: Mutex<HashMap<NodeId, u64>>,
    refresher: Mutex<Option<Refresher>>,
    dial_log: Mutex<Option<DialLog>>,
}

fn node_hex(node: &NodeId) -> String {
    node.to_hex()
}

impl Client {
    pub fn new(p2p: Arc<P2p>, timeouts: Timeouts, now: Arc<dyn Fn() -> u64 + Send + Sync>, web_store: Arc<WebStore>, web_call: Arc<dyn WebCall>) -> Arc<Self> {
        Arc::new(Self {
            p2p,
            slots: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            changed: Mutex::new(None),
            events: Mutex::new(None),
            timeouts,
            now,
            routes: Mutex::new(Routes::default()),
            web_store,
            web_call,
            web_asked: Mutex::new(HashMap::new()),
            refresher: Mutex::new(None),
            dial_log: Mutex::new(None),
        })
    }

    pub fn set_refresher(&self, f: Refresher) {
        *self.refresher.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    pub fn set_dial_log(&self, f: DialLog) {
        *self.dial_log.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    fn log_dial(&self, node: &NodeId, kind: Kind) {
        if let Some(f) = self.dial_log.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            f(node, kind);
        }
    }

    pub fn set_changed(&self, f: Changed) {
        *self.changed.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    pub fn set_event_sink(&self, f: EventSink) {
        *self.events.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    // ----- the route choice -----

    pub fn set_global_route(&self, pref: RoutePref) {
        self.routes.lock().unwrap_or_else(|p| p.into_inner()).global = pref;
    }

    /// A device's own choice (`None`: follow this PC's choice).
    pub fn set_device_route(&self, node: &NodeId, pref: Option<RoutePref>) {
        let mut r = self.routes.lock().unwrap_or_else(|p| p.into_inner());
        match pref {
            Some(p) => r.per.insert(*node, p),
            None => r.per.remove(node),
        };
    }

    pub fn device_route(&self, node: &NodeId) -> Option<RoutePref> {
        self.routes.lock().unwrap_or_else(|p| p.into_inner()).per.get(node).copied()
    }

    /// The choice that applies to one device: its own, or this PC's.
    pub fn route_for(&self, node: &NodeId) -> RoutePref {
        let r = self.routes.lock().unwrap_or_else(|p| p.into_inner());
        r.per.get(node).copied().unwrap_or(r.global)
    }

    /// Whether any paired device may use a public relay (the endpoint needs one bound for it).
    pub fn any_relay_wanted(&self, nodes: &[NodeId]) -> bool {
        if nodes.is_empty() {
            return self.routes.lock().unwrap_or_else(|p| p.into_inner()).global.relay_allowed();
        }
        nodes.iter().any(|n| self.route_for(n).relay_allowed())
    }

    fn web_usable(&self, node: &NodeId) -> bool {
        web::PC_WEB_ROUTE && self.route_for(node) != RoutePref::Public && self.web_store.has(&node_hex(node))
    }

    pub fn web_ready(&self, node: &NodeId) -> bool {
        web::PC_WEB_ROUTE && self.web_store.has(&node_hex(node))
    }

    fn slot(&self, node: &NodeId) -> Arc<Slot> {
        self.slots.lock().unwrap_or_else(|p| p.into_inner()).entry(*node).or_default().clone()
    }

    pub fn status(&self, node: &NodeId) -> Status {
        *self.slot(node).status.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn health(&self, node: &NodeId) -> Health {
        self.slot(node).health.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// What the device last said about its room left, and when (unix seconds). Kept while it is offline.
    pub fn room(&self, node: &NodeId) -> (Vec<crate::usage::room::Room>, Option<u64>) {
        self.slot(node).room.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set_room(&self, node: &NodeId, rooms: Vec<crate::usage::room::Room>) {
        let slot = self.slot(node);
        let changed = {
            let mut r = slot.room.lock().unwrap_or_else(|p| p.into_inner());
            let changed = r.0 != rooms;
            *r = (rooms, Some((self.now)()));
            changed
        };
        if changed {
            self.notify();
        }
    }

    fn notify(&self) {
        if let Some(cb) = self.changed.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            cb();
        }
    }

    fn set_status(&self, node: &NodeId, f: impl FnOnce(&mut Status)) {
        let slot = self.slot(node);
        let (before, after) = {
            let mut s = slot.status.lock().unwrap_or_else(|p| p.into_inner());
            let before = *s;
            f(&mut s);
            (before, *s)
        };
        // `last_seen` moves on every answer; only a change the person can see is announced.
        if (before.reach, before.path, before.via_web, before.too_old) != (after.reach, after.path, after.via_web, after.too_old) {
            self.notify();
        }
    }

    fn set_health(&self, node: &NodeId, health: Health) {
        let slot = self.slot(node);
        let changed = {
            let mut h = slot.health.lock().unwrap_or_else(|p| p.into_inner());
            let changed = *h != health;
            *h = health;
            changed
        };
        if changed {
            self.notify();
        }
    }

    /// Forgets a device (removed, or the feature is off): its link is closed and its status is gone.
    pub async fn forget(&self, node: &NodeId) {
        self.stop_events(node);
        let slot = self.slots.lock().unwrap_or_else(|p| p.into_inner()).remove(node);
        if let Some(slot) = slot {
            if let Some(link) = slot.link.lock().await.take() {
                link.close(0, "done");
            }
            if let Some(link) = slot.files.lock().await.take() {
                link.close(0, "done");
            }
        }
    }

    /// The device is not paired any more: also forget its web address and token.
    pub async fn forget_all_of(&self, node: &NodeId) {
        self.web_store.forget(&node_hex(node));
        self.web_asked.lock().unwrap_or_else(|p| p.into_inner()).remove(node);
        self.forget(node).await;
    }

    /// Everything off: every link closed, every stream stopped.
    pub async fn shutdown(&self) {
        let nodes: Vec<NodeId> = self.slots.lock().unwrap_or_else(|p| p.into_inner()).keys().copied().collect();
        for node in nodes {
            self.forget(&node).await;
        }
    }

    async fn is_closed(link: &Arc<dyn Link>) -> bool {
        tokio::time::timeout(Duration::ZERO, link.closed()).await.is_ok()
    }

    /// The device went away (a failed dial, or a link that ended without a word): was it online, it is asleep or off;
    /// had it said goodbye, it stays closed; otherwise it is simply offline.
    fn mark_gone(&self, node: &NodeId) {
        self.set_status(node, |s| {
            s.reach = match s.reach {
                Reach::Online | Reach::Asleep => Reach::Asleep,
                Reach::Closed => Reach::Closed,
                _ => Reach::Offline,
            };
            s.path = None;
            s.via_web = false;
        });
    }

    fn mark_closed_by(&self, node: &NodeId, code: u32) -> AskError {
        match code {
            CLOSE_NOT_ALLOWED => {
                self.set_status(node, |s| {
                    s.reach = Reach::NotAllowed;
                    s.path = None;
                    s.via_web = false;
                });
                AskError::NotAllowed
            }
            CLOSE_GOODBYE => {
                self.set_status(node, |s| {
                    s.reach = Reach::Closed;
                    s.path = None;
                    s.via_web = false;
                });
                AskError::Offline
            }
            CLOSE_UNKNOWN_ALPN => {
                self.set_status(node, |s| {
                    s.reach = Reach::Offline;
                    s.too_old = true;
                    s.via_web = false;
                });
                AskError::TooOld
            }
            // Their Labs switch is off, or something we cannot tell: the device went away.
            _ => {
                self.mark_gone(node);
                AskError::Offline
            }
        }
    }

    /// The open link to a device, dialing when there is none. A refusal at the door is remembered as such.
    async fn link_to(self: &Arc<Self>, node: &NodeId) -> Result<Arc<dyn Link>, AskError> {
        let slot = self.slot(node);
        let mut guard = slot.link.lock().await;
        if let Some(link) = guard.as_ref() {
            if !Self::is_closed(link).await {
                return Ok(link.clone());
            }
            *guard = None;
        }
        // After a failure that asked for a fresh look at the account, one more try at once with what it found.
        for _ in 0..2 {
            let mut peer = self.p2p.addrs().peer(*node);
            if self.route_for(node) == RoutePref::Own {
                // "My own route only": no outside relay is ever used.
                peer.relay = None;
            }
            match tokio::time::timeout(self.timeouts.dial, self.p2p.dial(&peer, capability::AGENTS_REMOTE)).await {
                Ok(Ok(link)) => {
                    *slot.fails.lock().unwrap_or_else(|p| p.into_inner()) = 0;
                    *guard = Some(link.clone());
                    self.watch_closed(*node, slot.clone(), link.clone());
                    return Ok(link);
                }
                failed => {
                    self.mark_gone(node);
                    let error = match failed {
                        Ok(Err(e)) => Some(e.to_string()),
                        _ => None,
                    };
                    if !self.dial_failed(node, &slot, error.as_deref()).await {
                        break;
                    }
                }
            }
        }
        Err(AskError::Offline)
    }

    /// A dial failed: count it, say why, and on every few failures look the PC up on the account again (its saved addresses may be
    /// stale for good). True when something new was found and another try is worth making now.
    async fn dial_failed(&self, node: &NodeId, slot: &Slot, error: Option<&str>) -> bool {
        let fails = {
            let mut f = slot.fails.lock().unwrap_or_else(|p| p.into_inner());
            *f = f.saturating_add(1);
            *f
        };
        self.log_dial(node, if redial::why(error) == Why::NoAnswer { Kind::NoAnswer } else { Kind::CouldNotConnect });
        if !redial::refresh_due(fails) {
            return false;
        }
        let Some(refresher) = self.refresher.lock().unwrap_or_else(|p| p.into_inner()).clone() else { return false };
        let id = *node;
        let relay = tokio::task::spawn_blocking(move || refresher(&id)).await.ok().flatten();
        let saved = self.p2p.addrs().peer(*node);
        let was = redial::Hints { direct: saved.direct, relay: saved.relay };
        let now = redial::refreshed(&was, relay.as_deref());
        if now == was {
            return false;
        }
        self.p2p.addrs().forget_direct(node);
        if let Some(r) = &now.relay {
            self.p2p.addrs().remember_relay(*node, r);
        }
        self.log_dial(node, Kind::Refreshed);
        true
    }

    /// The open link for files to a device, dialing when there is none. It does not change the device's state words:
    /// those are about running agents.
    pub async fn files_link(self: &Arc<Self>, node: &NodeId) -> Result<Arc<dyn Link>, AskError> {
        let slot = self.slot(node);
        let mut guard = slot.files.lock().await;
        if let Some(link) = guard.as_ref() {
            if !Self::is_closed(link).await {
                return Ok(link.clone());
            }
            *guard = None;
        }
        let mut peer = self.p2p.addrs().peer(*node);
        if self.route_for(node) == RoutePref::Own {
            peer.relay = None;
        }
        match tokio::time::timeout(self.timeouts.dial, self.p2p.dial(&peer, capability::FILES)).await {
            Err(_) | Ok(Err(_)) => Err(AskError::Offline),
            Ok(Ok(link)) => {
                *guard = Some(link.clone());
                Ok(link)
            }
        }
    }

    /// A files link failed: forget it, and say why from its close code.
    pub async fn files_failed(&self, node: &NodeId, link: &Arc<dyn Link>) -> AskError {
        let code = tokio::time::timeout(Duration::from_millis(500), link.closed()).await.unwrap_or(0);
        let slot = self.slot(node);
        let mut guard = slot.files.lock().await;
        if guard.as_ref().is_some_and(|l| Arc::ptr_eq(l, link)) {
            *guard = None;
        }
        match code {
            CLOSE_NOT_ALLOWED => AskError::FilesOff,
            CLOSE_UNKNOWN_ALPN => AskError::TooOld,
            _ => AskError::Offline,
        }
    }

    /// How long one files answer header may take.
    pub fn answer_timeout(&self) -> Duration {
        self.timeouts.answer
    }

    /// When the link ends, say why at once (a goodbye is "closed", a refusal is "not allowed", silence is "asleep").
    fn watch_closed(self: &Arc<Self>, node: NodeId, slot: Arc<Slot>, link: Arc<dyn Link>) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let code = link.closed().await;
            let Some(me) = me.upgrade() else { return };
            // A forgotten device (removed, or everything shut down) is not news.
            let current = me.slots.lock().unwrap_or_else(|p| p.into_inner()).get(&node).cloned();
            if !current.is_some_and(|c| Arc::ptr_eq(&c, &slot)) {
                return;
            }
            {
                let mut guard = slot.link.lock().await;
                if guard.as_ref().is_some_and(|l| Arc::ptr_eq(l, &link)) {
                    *guard = None;
                }
            }
            // Our own `close(0)` after a request that gave up is not the device's doing.
            if code != 0 || me.status(&node).reach == Reach::Online {
                let _ = me.mark_closed_by(&node, code);
            }
        });
    }

    /// The door was closed on us: say why, from the close code.
    async fn why_closed(&self, node: &NodeId, link: &Arc<dyn Link>) -> AskError {
        let code = tokio::time::timeout(Duration::from_millis(500), link.closed()).await.unwrap_or(0);
        let slot = self.slot(node);
        *slot.link.lock().await = None;
        self.mark_closed_by(node, code)
    }

    fn answered(&self, node: &NodeId, link: &Arc<dyn Link>) {
        let now = (self.now)();
        let path = link.path();
        self.set_status(node, |s| {
            s.reach = Reach::Online;
            s.path = Some(path);
            s.via_web = false;
            s.last_seen = Some(now);
            s.too_old = false;
        });
    }

    fn answered_by_web(&self, node: &NodeId) {
        let now = (self.now)();
        self.set_status(node, |s| {
            s.reach = Reach::Online;
            s.path = None;
            s.via_web = true;
            s.last_seen = Some(now);
        });
    }

    /// One exchange: a header (and body), one answer.
    async fn exchange(self: &Arc<Self>, node: &NodeId, head: Head, body: &[u8]) -> Result<(ReplyHead, Vec<u8>), AskError> {
        let link = self.link_to(node).await?;
        let run = async {
            let mut stream = link.open_bi().await.map_err(|_| ())?;
            wire::write_frame(&mut stream.send, &head, body).await.map_err(|_| ())?;
            // The asker is done writing; the answer follows.
            let _ = tokio::io::AsyncWriteExt::shutdown(&mut stream.send).await;
            let rh: ReplyHead = wire::read_head(&mut stream.recv).await.map_err(|_| ())?;
            let bytes = wire::read_body(&mut stream.recv, rh.body_len, wire::REPLY_MAX).await.map_err(|_| ())?;
            Ok::<_, ()>((rh, bytes))
        };
        match tokio::time::timeout(self.timeouts.answer, run).await {
            Ok(Ok((rh, bytes))) => {
                if rh.status == 426 {
                    self.set_status(node, |s| s.too_old = true);
                    return Err(AskError::TooOld);
                }
                self.answered(node, &link);
                Ok((rh, bytes))
            }
            Ok(Err(())) | Err(_) => Err(self.why_closed(node, &link).await),
        }
    }

    /// "Who are you": the cheap probe. Keeps where the device says it can be reached, and what only a person there can
    /// fix. When the link cannot connect, the device's own web address is tried (if the route choice allows it).
    pub async fn hello(self: &Arc<Self>, node: &NodeId) -> Result<Value, AskError> {
        match self.exchange(node, Head::hello(), &[]).await {
            Ok((rh, body)) => {
                let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                if rh.status == 200 {
                    let addrs: Vec<std::net::SocketAddr> =
                        value["addrs"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().and_then(|t| t.parse().ok())).collect()).unwrap_or_default();
                    self.p2p.addrs().remember(*node, &addrs);
                    if let Some(relay) = value["relay"].as_str() {
                        self.p2p.addrs().remember_relay(*node, relay);
                    }
                    self.set_health(node, Health::from_hello(&value));
                    self.set_room(node, crate::usage::room::parse(&value["room"]));
                    self.fetch_web(node).await;
                }
                Ok(value)
            }
            Err(AskError::Offline) if self.web_usable(node) => match self.web_request(node, "GET", "/panes", &[]).await {
                Ok(_) => Ok(json!({ "ok": true, "via": "web" })),
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        }
    }

    /// Asks the device for its web address and a token (it answers only when the person turned that on there). Asked at
    /// most once a minute. An answer of "no" forgets what was held.
    async fn fetch_web(self: &Arc<Self>, node: &NodeId) {
        if !web::PC_WEB_ROUTE {
            // Off: ask for nothing, and drop anything an older version kept.
            self.web_store.forget(&node_hex(node));
            return;
        }
        if self.route_for(node) == RoutePref::Public {
            return;
        }
        let now = (self.now)();
        {
            let mut asked = self.web_asked.lock().unwrap_or_else(|p| p.into_inner());
            if asked.get(node).is_some_and(|at| now.saturating_sub(*at) < 60) {
                return;
            }
            asked.insert(*node, now);
        }
        let Ok((rh, body)) = self.exchange(node, Head::web(), &[]).await else { return };
        match rh.status {
            200 => {
                let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let (Some(url), Some(token)) = (v["url"].as_str(), v["token"].as_str()) else { return };
                if web::address_ok(url) && !token.is_empty() && token.len() <= 200 && self.web_store.set(&node_hex(node), url, token).is_ok() {
                    self.notify();
                }
            }
            403 => {
                if self.web_store.has(&node_hex(node)) {
                    self.web_store.forget(&node_hex(node));
                    self.notify();
                }
            }
            _ => {}
        }
    }

    /// One request on the device's web address, with the token it gave this PC. A refused token is forgotten.
    async fn web_request(&self, node: &NodeId, method: &str, target: &str, body: &[u8]) -> Result<(u16, Value), AskError> {
        let hex = node_hex(node);
        let Some((base, token)) = self.web_store.get(&hex) else { return Err(AskError::Offline) };
        let done = tokio::time::timeout(self.timeouts.answer, self.web_call.call(&base, &token, method, target, body.to_vec())).await;
        match done {
            Ok(Ok((401, _))) => {
                self.web_store.forget(&hex);
                self.mark_gone(node);
                Err(AskError::Offline)
            }
            Ok(Ok((status, bytes))) => {
                self.answered_by_web(node);
                let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
                Ok((status, value))
            }
            Ok(Err(_)) | Err(_) => {
                self.mark_gone(node);
                Err(AskError::Offline)
            }
        }
    }

    /// One bridge request on the device. The answer is whatever its routes said, with the status they gave.
    pub async fn request(self: &Arc<Self>, node: &NodeId, method: &str, target: &str, body: &[u8]) -> Result<(u16, Value), AskError> {
        if !wire::method_ok(method) || !wire::target_ok(target) {
            return Err(AskError::Other("That is not a request a device can send.".into()));
        }
        if body.len() > wire::body_max(method, target) {
            return Err(AskError::Other("That request is too large.".into()));
        }
        match self.exchange(node, Head::request(method, target, body.len()), body).await {
            Ok((rh, bytes)) => {
                let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
                Ok((rh.status, value))
            }
            Err(AskError::Offline) if self.web_usable(node) => self.web_request(node, method, target, body).await,
            Err(e) => Err(e),
        }
    }

    // ----- events -----

    /// Starts reading the device's event stream; each batch of event text is handed to the sink as its own frames.
    /// A second call for the same device replaces the first. Reconnects with a growing pause until stopped.
    pub fn start_events(self: &Arc<Self>, node: NodeId) {
        self.stop_events(&node);
        let me = self.clone();
        let handle = tokio::spawn(async move { me.event_loop(node).await });
        self.streams.lock().unwrap_or_else(|p| p.into_inner()).insert(node, handle);
    }

    pub fn stop_events(&self, node: &NodeId) {
        if let Some(h) = self.streams.lock().unwrap_or_else(|p| p.into_inner()).remove(node) {
            h.abort();
        }
    }

    async fn event_loop(self: Arc<Self>, node: NodeId) {
        let mut misses = 0u32;
        let mut cursor: Option<u64> = None;
        loop {
            let ended_after_data = self.read_events_once(&node, &mut cursor).await;
            misses = if ended_after_data { 0 } else { misses.saturating_add(1) };
            // A PC that stays away is tried again every 30 seconds at most, for as long as it stays away.
            tokio::time::sleep(redial::pause(misses)).await;
        }
    }

    /// One event connection. True when it delivered something before it ended.
    async fn read_events_once(self: &Arc<Self>, node: &NodeId, cursor: &mut Option<u64>) -> bool {
        let Ok(link) = self.link_to(node).await else { return false };
        let Ok(mut stream) = link.open_bi().await else { return false };
        if wire::write_frame(&mut stream.send, &Head::events(*cursor), &[]).await.is_err() {
            return false;
        }
        let mut got = false;
        loop {
            let rh: ReplyHead = match wire::read_head(&mut stream.recv).await {
                Ok(rh) => rh,
                Err(_) => return got,
            };
            if rh.status != 200 {
                return got;
            }
            let mut buf = vec![0u8; rh.body_len.min(wire::REPLY_MAX as u64) as usize];
            if stream.recv.read_exact(&mut buf).await.is_err() {
                return got;
            }
            if let Some(c) = rh.cursor {
                *cursor = Some(c);
            }
            got = true;
            self.answered(node, &link);
            let text = String::from_utf8_lossy(&buf).to_string();
            let sink = self.events.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some(sink) = sink {
                // Each event is one block ending in a blank line; the page gets them one at a time.
                for block in text.split_inclusive("\n\n").filter(|b| !b.trim().is_empty()) {
                    sink(&node_hex(node), block);
                }
            }
        }
    }
}

impl From<P2pError> for AskError {
    fn from(e: P2pError) -> Self {
        AskError::Other(e.to_string())
    }
}
