//! The far side: this PC answering another Workspace that runs agents here (`agents/remote`).
//!
//! By the time `serve` runs, the link layer has already checked that the dialer is a paired device the person turned
//! `Run agents and terminals here` on for (`p2p::endpoint::admit`); a device that may not never gets this far. This
//! file then carries each request to the bridge as that device (`HostBridge`) and the bridge decides, from the
//! device's rights, whether it may do it. It knows nothing about agents or panes: a request is a method, a path and a
//! body.
//!
//! The rights are checked again for every request (`still_allowed`): a switch turned off closes the open link now.
//!
//! Besides requests there are two streams: `events` (the bridge's event lines; a terminal's output rides them as `app` frames) and
//! `web` (the web address and a token, only when the person allowed it).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use super::activity::{self, ActivityLog, Dir, Kind};
use super::wire::{self, Head, ReplyHead};
use super::web::WebGrant;
use crate::p2p::capability::CapabilityHandler;
use crate::p2p::endpoint::{BiStream, Link, NodeId, CLOSE_GOODBYE, CLOSE_NOT_ALLOWED};

/// The door into this PC's own routes. The app's implementation runs `bridge::link_call`; tests bring their own.
/// `node` is the dialer's node id in hex, the same string its grant is filed under.
#[async_trait]
pub trait HostBridge: Send + Sync {
    /// One request as that device. Returns the HTTP status and the JSON body.
    async fn call(&self, node: &str, method: &str, target: &str, body: Vec<u8>) -> (u16, Vec<u8>);
    /// Events after `cursor` (`None`: from now), waiting up to `wait`. `None`: the device has no grant any more.
    async fn poll(&self, node: &str, cursor: Option<u64>, wait: Duration) -> Option<(u64, String)>;
}

/// What this PC says about itself in answer to a `hello`.
pub trait SelfInfo: Send + Sync {
    fn name(&self) -> String;
    /// Where this computer can be reached on its network now, and its relay: the caller keeps them to dial again.
    fn addrs(&self) -> Vec<String>;
    fn relay(&self) -> Option<String>;
    /// `{ signed_out: [agent id], needs_person: [{ pane, what }] }`: what only the person at this PC can fix. Words
    /// only (no prompt text, no paths): the other side shows them as untrusted text.
    fn health(&self) -> Value {
        json!({ "signed_out": [], "needs_person": [] })
    }
    /// Room left per sign-in (`usage::room::payload`): numbers and labels only, never a login.
    fn room(&self) -> Value {
        json!([])
    }
}

/// The inbound links that are open, so a switch turned off (or a device removed) can close them at once.
#[derive(Default)]
pub struct Live {
    links: Mutex<HashMap<NodeId, Vec<Arc<dyn Link>>>>,
    seen: Mutex<HashMap<NodeId, u64>>,
    used: Mutex<HashMap<NodeId, u64>>,
    streams: Mutex<HashMap<NodeId, usize>>,
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

/// How long after its last request a device still counts as "connected" when it has no open stream.
const CONNECTED_FOR: u64 = 45;

impl Live {
    pub fn set_on_change(&self, f: Arc<dyn Fn() + Send + Sync>) {
        *self.on_change.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    fn changed(&self) {
        let f = self.on_change.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(f) = f {
            f();
        }
    }

    pub fn add(&self, peer: NodeId, link: Arc<dyn Link>) {
        self.links.lock().unwrap_or_else(|p| p.into_inner()).entry(peer).or_default().push(link);
    }

    pub fn forget(&self, peer: &NodeId, link: &Arc<dyn Link>) {
        let mut map = self.links.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(list) = map.get_mut(peer) {
            list.retain(|l| !Arc::ptr_eq(l, link));
            if list.is_empty() {
                map.remove(peer);
            }
        }
    }

    /// Closes every open link of the peers `keep` says no to. Returns how many were closed.
    pub fn close_where(&self, keep: impl Fn(&NodeId) -> bool) -> usize {
        let doomed: Vec<(NodeId, Arc<dyn Link>)> = {
            let map = self.links.lock().unwrap_or_else(|p| p.into_inner());
            map.iter().filter(|(peer, _)| !keep(peer)).flat_map(|(peer, links)| links.iter().map(|l| (*peer, l.clone()))).collect()
        };
        for (_, link) in &doomed {
            link.close(CLOSE_NOT_ALLOWED, "refused");
        }
        doomed.len()
    }

    /// The app is closing: every open link ends with the goodbye code, so the other side says "closed", not "gone".
    pub fn goodbye(&self) -> usize {
        let all: Vec<Arc<dyn Link>> = self.links.lock().unwrap_or_else(|p| p.into_inner()).values().flatten().cloned().collect();
        for link in &all {
            link.close(CLOSE_GOODBYE, "goodbye");
        }
        all.len()
    }

    /// A device that fell off the network without a word (a test stands in for sleep: the link ends with no reason).
    #[cfg(any(test, feature = "test-util"))]
    pub fn vanish(&self) {
        let all: Vec<Arc<dyn Link>> = self.links.lock().unwrap_or_else(|p| p.into_inner()).values().flatten().cloned().collect();
        for link in &all {
            link.close(0, "gone");
        }
    }

    pub fn touch(&self, peer: NodeId, now: u64) {
        self.seen.lock().unwrap_or_else(|p| p.into_inner()).insert(peer, now);
    }

    /// A device asked for something other than "who are you": it is using this PC.
    pub fn touch_use(&self, peer: NodeId, now: u64) {
        let before = self.in_use(&peer, now);
        self.used.lock().unwrap_or_else(|p| p.into_inner()).insert(peer, now);
        if !before {
            self.changed();
        }
    }

    /// The device has an open stream here, or asked for something a moment ago.
    pub fn in_use(&self, peer: &NodeId, now: u64) -> bool {
        if self.streams.lock().unwrap_or_else(|p| p.into_inner()).get(peer).is_some_and(|n| *n > 0) {
            return true;
        }
        self.used.lock().unwrap_or_else(|p| p.into_inner()).get(peer).is_some_and(|at| now.saturating_sub(*at) <= CONNECTED_FOR)
    }

    fn stream_open(&self, peer: NodeId) {
        *self.streams.lock().unwrap_or_else(|p| p.into_inner()).entry(peer).or_insert(0) += 1;
        self.changed();
    }

    fn stream_closed(&self, peer: NodeId) {
        {
            let mut map = self.streams.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(n) = map.get_mut(&peer) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    map.remove(&peer);
                }
            }
        }
        self.changed();
    }
}

/// Counts one open stream for as long as it lives.
struct StreamGuard(Arc<Live>, NodeId);

impl StreamGuard {
    fn new(live: &Arc<Live>, peer: NodeId) -> Self {
        live.stream_open(peer);
        Self(live.clone(), peer)
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.0.stream_closed(self.1);
    }
}

/// How long a header may take to arrive, and how long one event wait lasts.
const HEAD_WAIT: Duration = Duration::from_secs(15);
const EVENT_WAIT: Duration = Duration::from_secs(20);

/// What the far side needs for the web route and the log. All of it is read at the moment it is needed.
#[derive(Clone)]
pub struct Extras {
    pub activity: Arc<ActivityLog>,
    /// The person's name for a paired device.
    pub name_of: Arc<dyn Fn(&NodeId) -> String + Send + Sync>,
    pub web: Arc<dyn WebGrant>,
    /// Whether the person let this device also use the web address, and at which level.
    pub web_allowed: Arc<dyn Fn(&NodeId) -> Option<bool> + Send + Sync>,
}

pub struct AgentsHandler {
    pub bridge: Arc<dyn HostBridge>,
    pub info: Arc<dyn SelfInfo>,
    pub live: Arc<Live>,
    /// Whether the person still has the switch on for this peer (read from the trust list at every request).
    pub still_allowed: Arc<dyn Fn(&NodeId) -> bool + Send + Sync>,
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub extras: Extras,
}

#[async_trait]
impl CapabilityHandler for AgentsHandler {
    async fn serve(&self, peer: NodeId, link: Arc<dyn Link>) {
        self.live.add(peer, link.clone());
        let node = peer.to_hex();
        self.extras.activity.record((self.now)(), &node, &(self.extras.name_of)(&peer), Dir::In, Kind::Connected);
        loop {
            let Ok(stream) = link.accept_bi().await else { break };
            if !(self.still_allowed)(&peer) {
                link.close(CLOSE_NOT_ALLOWED, "refused");
                break;
            }
            let task = Stream {
                bridge: self.bridge.clone(),
                info: self.info.clone(),
                live: self.live.clone(),
                still_allowed: self.still_allowed.clone(),
                now: self.now.clone(),
                extras: self.extras.clone(),
                peer,
                node: node.clone(),
            };
            tokio::spawn(task.run(stream));
        }
        self.live.forget(&peer, &link);
    }
}

struct Stream {
    bridge: Arc<dyn HostBridge>,
    info: Arc<dyn SelfInfo>,
    live: Arc<Live>,
    still_allowed: Arc<dyn Fn(&NodeId) -> bool + Send + Sync>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    extras: Extras,
    peer: NodeId,
    node: String,
}

fn reply_json(status: u16, value: serde_json::Value) -> (ReplyHead, Vec<u8>) {
    let body = serde_json::to_vec(&value).unwrap_or_default();
    (ReplyHead { status, body_len: body.len() as u64, cursor: None }, body)
}

impl Stream {
    fn log(&self, kind: Kind) {
        self.extras.activity.record((self.now)(), &self.node, &(self.extras.name_of)(&self.peer), Dir::In, kind);
    }

    async fn run(self, mut stream: BiStream) {
        let head = tokio::time::timeout(HEAD_WAIT, wire::read_head::<_, Head>(&mut stream.recv)).await;
        let Ok(Ok(head)) = head else { return };
        self.live.touch(self.peer, (self.now)());
        if head.v != wire::VERSION {
            let (rh, body) = reply_json(426, json!({ "error": "version", "code": "VERSION_TOO_OLD", "hint": "Update Potato Workspace on both computers." }));
            let _ = wire::write_frame(&mut stream.send, &rh, &body).await;
            let _ = stream.send.shutdown().await;
            return;
        }
        match head.op.as_str() {
            "hello" => {
                let (rh, body) = reply_json(
                    200,
                    json!({
                        "ok": true, "v": wire::VERSION, "name": self.info.name(), "addrs": self.info.addrs(), "relay": self.info.relay(),
                        "health": self.info.health(), "room": self.info.room(),
                    }),
                );
                let _ = wire::write_frame(&mut stream.send, &rh, &body).await;
                let _ = stream.send.shutdown().await;
            }
            "req" => {
                self.live.touch_use(self.peer, (self.now)());
                self.request(stream, head).await
            }
            "events" => {
                self.live.touch_use(self.peer, (self.now)());
                let _open = StreamGuard::new(&self.live, self.peer);
                self.events(stream, head).await
            }
            "web" => self.web(stream).await,
            _ => {
                let (rh, body) = reply_json(400, json!({ "error": "unknown operation" }));
                let _ = wire::write_frame(&mut stream.send, &rh, &body).await;
                let _ = stream.send.shutdown().await;
            }
        }
    }

    async fn request(self, mut stream: BiStream, head: Head) {
        let (rh, body) = if !wire::method_ok(&head.method) || !wire::target_ok(&head.target) {
            reply_json(400, json!({ "error": "bad request line", "code": "INVALID_ARGUMENT" }))
        } else if head.body_len > wire::body_max(&head.method, &head.target) as u64 {
            reply_json(413, json!({ "error": "request body too large", "code": "PAYLOAD_TOO_LARGE" }))
        } else {
            match wire::read_body(&mut stream.recv, head.body_len, wire::body_max(&head.method, &head.target)).await {
                Err(_) => return,
                Ok(body) => {
                    if !(self.still_allowed)(&self.peer) {
                        reply_json(403, json!({ "error": "not_allowed", "code": "DEVICE_NOT_ALLOWED" }))
                    } else {
                        let (status, bytes) = self.bridge.call(&self.node, &head.method, &head.target, body).await;
                        // The line holds a kind only: the body and the path are never copied into the log.
                        if let Some(kind) = activity::classify(&head.method, &head.target) {
                            if status == 403 {
                                self.log(Kind::Refused);
                            } else if status < 300 {
                                self.log(kind);
                            }
                        }
                        (ReplyHead { status, body_len: bytes.len() as u64, cursor: None }, bytes)
                    }
                }
            }
        };
        let _ = wire::write_frame(&mut stream.send, &rh, &body).await;
        let _ = stream.send.shutdown().await;
    }

    /// Writes event text as it arrives until the asker goes away or loses its right.
    async fn events(self, mut stream: BiStream, head: Head) {
        let mut cursor = head.cursor;
        loop {
            if !(self.still_allowed)(&self.peer) {
                break;
            }
            let Some((next, data)) = self.bridge.poll(&self.node, cursor, EVENT_WAIT).await else { break };
            cursor = Some(next);
            let rh = ReplyHead { status: 200, body_len: data.len() as u64, cursor: Some(next) };
            if wire::write_frame(&mut stream.send, &rh, data.as_bytes()).await.is_err() {
                return;
            }
        }
        let rh = ReplyHead { status: 410, body_len: 0, cursor: None };
        let _ = wire::write_frame(&mut stream.send, &rh, &[]).await;
        let _ = stream.send.shutdown().await;
    }

    /// The web address and a token, for a device the person allowed it for. Anything else is a plain 403.
    async fn web(self, mut stream: BiStream) {
        let (rh, body) = match (self.extras.web_allowed)(&self.peer) {
            Some(full) if (self.still_allowed)(&self.peer) => {
                let name = (self.extras.name_of)(&self.peer);
                match self.extras.web.mint(&self.node, &name, full) {
                    Ok((url, token)) => reply_json(200, json!({ "url": url, "token": token })),
                    Err(why) => reply_json(409, json!({ "error": why, "code": "NO_WEB_ADDRESS" })),
                }
            }
            _ => reply_json(403, json!({ "error": "not_allowed", "code": "DEVICE_NOT_ALLOWED" })),
        };
        let _ = wire::write_frame(&mut stream.send, &rh, &body).await;
        let _ = stream.send.shutdown().await;
    }
}
