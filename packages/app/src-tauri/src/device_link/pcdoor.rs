//! The device door: a second way for an already-paired PC to reach this PC, through this PC's public tunnel address, for a small set of
//! read-only `/pclink` calls. The paired link (iroh) stays the first road; this is the fallback when it cannot connect.
//!
//! What it is NOT: the old web route (`web.rs`, `PC_WEB_ROUTE = false`). That one handed a PC a phone token (phone rights, phone routes,
//! alive after a lowered level). Here there is NO token of any kind. Every request carries its own proof:
//!
//! - **Signed per request.** The caller signs a fixed byte layout (see [`request_message`]) with its node key (Ed25519; a node id IS that
//!   public key, `p2p::identity::verify_node`). It covers the method, the target, the body hash, the target node id, the tunnel host, a
//!   timestamp (+-60 s) and a one-time nonce this PC remembers for that window (a bounded store).
//! - **The caller must be in the signed trust list** (`p2p::trust`) at the moment of the request. A removed device is a stranger again.
//! - **Rights are read from the trust list at every request**: the device's own "also through my web address" switch
//!   (`agents/remote/pcdoor`, set only by an app-window command), its run switch, and the Labs switch. Nothing is cached.
//! - **The answer is signed too** (same node key, bound to the request's nonce), because a quick-tunnel name rotates and an old address
//!   may now belong to a stranger.
//! - **One route** (`POST /bridge/pcdoor`), wrapping method + target + body. After the checks it calls the SAME `pclink::Door` the paired
//!   link uses, built with the level capped at Watch, so `pclink::need()` and the per-session rules still decide. It never goes through
//!   the phone's `authorize()` or route table, and `bridge::link::current_node()` is never set here (the routes allowed need no node
//!   from it; `pclink::Caller` carries the node, taken only from the verified signature).
//! - **Slice 1 allows only**: `GET /pclink/{me, sessions, sessions/<id>/transcript, projects, agents, usage, questions}`. Anything else
//!   is a signed 403. No lending, no starting agents, no terminal, no Answer or Full routes, no event or screen streams.
//! - **Every failure to prove who is asking gets the same flat 401** (same bytes, no reason, nothing shown to the person). Failures count
//!   per source address (`Throttle`), over the limit that address gets 429. Pairing and its lockout are never touched from here.
//!
//! Remoteness is not decided here: the caller (`pwa_server::handle_connection`) serves this route only on the tunnel listener
//! (`tunnel_listener.rs`, PROXY v2 header, host check), and hands in the host name that listener verified, never a header.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::pclink::{self, Level};
use super::serve::HostBridge;
use crate::p2p::endpoint::NodeId;
use crate::p2p::identity::{verify_node, DeviceIdentity};
use crate::p2p::trust::{RemoteLevel, TrustList};

/// The one path (as the visitor sees it, behind `/bridge`).
pub const PATH: &str = "/bridge/pcdoor";
/// How far a request's timestamp may be from this PC's clock, either way.
pub const WINDOW_MS: u64 = 60_000;
/// Nonces remembered at most (all devices), and per device. Past the cap a valid request gets 429: nothing is ever evicted early, because
/// an early eviction would make a replay possible.
pub const NONCE_MAX: usize = 2048;
pub const NONCE_PER_NODE: usize = 256;
/// The most bytes of one request envelope this door reads.
pub const ENVELOPE_MAX: usize = 8 * 1024;
const TARGET_MAX: usize = 512;
/// The Ed25519 base point B (discrete log 1): a valid public key, but ANYONE can sign for it, so it is NOT a secret-less key. It is safe
/// only because acceptance needs `trusted && checked` and this id is never in the trust list; it exists so a stranger costs the same one
/// verify as a trusted device.
pub(crate) const DUMMY_NODE: NodeId = NodeId([
    0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    0x66, 0x66, 0x66, 0x66,
]);
const REQ_PREFIX: &[u8] = b"pm/pcdoor/request/v1";
const RESP_PREFIX: &[u8] = b"pm/pcdoor/answer/v1";
/// What every refusal to know the caller says. One constant: no failure kind can differ by a byte.
pub const FLAT_401: &[u8] = br#"{"error":"unauthorized"}"#;

/// Failed tries per source address per window before it gets 429, and all tries (a flood of valid ones too).
pub const FAILS_PER_WINDOW: usize = 8;
pub const HITS_PER_WINDOW: usize = 240;
const THROTTLE_TRACKED: usize = 1024;

// ----- node key -----

/// This PC's node key, for signing. The real one reads the keystore the first time it is needed (never while the door is off).
pub trait NodeSigner: Send + Sync {
    fn node_id(&self) -> Option<NodeId>;
    fn sign(&self, message: &[u8]) -> Option<[u8; 64]>;
}

pub struct KeyStoreNode {
    keys: crate::keys::KeyStore,
    identity: OnceLock<DeviceIdentity>,
    /// When the keystore last failed to load, so a stranger's hits do not make this PC hit the keystore again and again.
    failed_at: Mutex<Option<Instant>>,
}

/// How long a failed keystore load is remembered (the door answers the flat 401 meanwhile, without retrying).
const KEY_RETRY: Duration = Duration::from_secs(30);

impl KeyStoreNode {
    pub fn new(keys: crate::keys::KeyStore) -> Self {
        Self { keys, identity: OnceLock::new(), failed_at: Mutex::new(None) }
    }

    fn identity(&self) -> Option<&DeviceIdentity> {
        if let Some(i) = self.identity.get() {
            return Some(i);
        }
        let mut failed = self.failed_at.lock().unwrap_or_else(|p| p.into_inner());
        if failed.is_some_and(|t| t.elapsed() < KEY_RETRY) {
            return None;
        }
        match DeviceIdentity::load(&self.keys) {
            Ok(loaded) => {
                *failed = None;
                Some(self.identity.get_or_init(|| loaded))
            }
            Err(_) => {
                *failed = Some(Instant::now());
                None
            }
        }
    }
}

impl NodeSigner for KeyStoreNode {
    fn node_id(&self) -> Option<NodeId> {
        self.identity().map(DeviceIdentity::id)
    }
    fn sign(&self, message: &[u8]) -> Option<[u8; 64]> {
        self.identity().map(|i| i.sign_node(message))
    }
}

/// The old door behind the capped `Door`: it has nothing to give. (The two older PC-to-PC routes are not part of this door.)
pub struct NoLegacy;

#[async_trait]
impl HostBridge for NoLegacy {
    async fn call(&self, _: &str, _: &str, _: &str, _: Vec<u8>) -> (u16, Vec<u8>) {
        (404, br#"{"error":"not found"}"#.to_vec())
    }
    async fn poll(&self, _: &str, _: Option<u64>, _: std::time::Duration) -> Option<(u64, String)> {
        None
    }
}

/// The paired link's own `/pclink` door for the web address: its level is read from the trust list at EVERY request and capped at Watch
/// (`level_now`), it has no lend right, and the two older PC-to-PC routes are not behind it (`NoLegacy`).
pub fn build_door(services: Arc<dyn pclink::Services>, asks: Arc<pclink::Asks>, trust: Arc<TrustList>, devices_on: Arc<AtomicBool>, labs_on: Arc<AtomicBool>, now_ms: Arc<dyn Fn() -> u64 + Send + Sync>) -> Arc<dyn HostBridge> {
    let name_trust = trust.clone();
    Arc::new(pclink::Door {
        legacy: Arc::new(NoLegacy),
        services,
        asks,
        level_of: Arc::new(move |node: &str| level_now(&trust, &devices_on, &labs_on, &super::node_of(node).ok()?)),
        name_of: Arc::new(move |node: &str| super::node_of(node).ok().and_then(|n| name_trust.get(&n)).map(|d| d.name).unwrap_or_default()),
        // The web address never carries the own-PC marker: its level is capped at Watch and it asks nothing held.
        marked_of: Arc::new(|_: &str| false),
        lend_ok: Arc::new(|_: &str| false),
        now_ms,
    })
}

// ----- the signed layout -----

fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Appends one field: its length as 4 bytes (big endian), then its bytes. No field can run into the next.
fn put(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&(field.len() as u32).to_be_bytes());
    out.extend_from_slice(field);
}

/// The exact bytes a request signature covers:
/// `REQ_PREFIX`, then, each as `put` (u32-be length + bytes): method, target (path and query as sent), SHA-256 of the body (32 bytes),
/// the target node id (32 bytes), the caller's node id (32 bytes), the tunnel host (lowercase text), the timestamp (u64 ms, 8 bytes big
/// endian), the nonce (16 bytes).
pub fn request_message(method: &str, target: &str, body: &[u8], to: &NodeId, from: &NodeId, host: &str, ts_ms: u64, nonce: &[u8; 16]) -> Vec<u8> {
    let mut m = REQ_PREFIX.to_vec();
    put(&mut m, method.as_bytes());
    put(&mut m, target.as_bytes());
    put(&mut m, &hash(body));
    put(&mut m, &to.0);
    put(&mut m, &from.0);
    put(&mut m, host.to_ascii_lowercase().as_bytes());
    put(&mut m, &ts_ms.to_be_bytes());
    put(&mut m, nonce);
    m
}

/// The exact bytes an answer signature covers: `RESP_PREFIX`, then, each as `put`: the answering node id (32), the caller's node id (32),
/// the tunnel host, the request's timestamp (8) and nonce (16) it answers, the status (u32 big endian, 4 bytes), SHA-256 of the answer body.
pub fn answer_message(from: &NodeId, to: &NodeId, host: &str, req_ts_ms: u64, nonce: &[u8; 16], status: u16, body: &[u8]) -> Vec<u8> {
    let mut m = RESP_PREFIX.to_vec();
    put(&mut m, &from.0);
    put(&mut m, &to.0);
    put(&mut m, host.to_ascii_lowercase().as_bytes());
    put(&mut m, &req_ts_ms.to_be_bytes());
    put(&mut m, nonce);
    put(&mut m, &u32::from(status).to_be_bytes());
    put(&mut m, &hash(body));
    m
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !s.is_ascii() {
        return None;
    }
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    v: u32,
    from: String,
    to: String,
    host: String,
    ts: u64,
    nonce: String,
    method: String,
    target: String,
    body: String,
    sig: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnswerEnvelope {
    v: u32,
    status: u16,
    body: String,
    sig: String,
}

// ----- the client side (minimal: build and sign a request, verify a signed answer) -----

/// A request built for one target, with what is needed to check its answer.
pub struct Prepared {
    /// The bytes to POST to `https://<host>/bridge/pcdoor`.
    pub body: Vec<u8>,
    from: NodeId,
    to: NodeId,
    host: String,
    ts_ms: u64,
    nonce: [u8; 16],
}

#[derive(Debug, PartialEq, Eq)]
pub enum AnswerError {
    /// Not a well-formed answer.
    Malformed,
    /// The signature does not check against the node the request was meant for: a stranger, or a stale address.
    NotTheNode,
}

/// Builds and signs one request. `now_ms` is this PC's clock; the far PC accepts it within +-60 s.
pub fn build_request(signer: &dyn NodeSigner, to: &NodeId, host: &str, method: &str, target: &str, body: &[u8], now_ms: u64) -> Result<Prepared, String> {
    build_request_with(signer, to, host, method, target, body, now_ms, rand::random::<[u8; 16]>())
}

pub fn build_request_with(signer: &dyn NodeSigner, to: &NodeId, host: &str, method: &str, target: &str, body: &[u8], now_ms: u64, nonce: [u8; 16]) -> Result<Prepared, String> {
    let from = signer.node_id().ok_or("This PC has no node key.")?;
    let host = host.to_ascii_lowercase();
    let message = request_message(method, target, body, to, &from, &host, now_ms, &nonce);
    let sig = signer.sign(&message).ok_or("Could not sign the request.")?;
    let envelope = Envelope {
        v: 1,
        from: from.to_hex(),
        to: to.to_hex(),
        host: host.clone(),
        ts: now_ms,
        nonce: hex(&nonce),
        method: method.to_string(),
        target: target.to_string(),
        body: String::from_utf8(body.to_vec()).map_err(|_| "The body must be text.")?,
        sig: hex(&sig),
    };
    let body = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
    Ok(Prepared { body, from, to: *to, host, ts_ms: now_ms, nonce })
}

impl Prepared {
    /// Checks an answer: it must be signed by the node the request was for, and bound to this request's nonce and time. Returns the inner
    /// status and body. Anything else (an unsigned 401, a stranger's reply, a tampered body) is an error: the caller trusts nothing in it.
    pub fn verify_answer(&self, answer: &[u8]) -> Result<(u16, Vec<u8>), AnswerError> {
        let env: AnswerEnvelope = serde_json::from_slice(answer).map_err(|_| AnswerError::Malformed)?;
        if env.v != 1 {
            return Err(AnswerError::Malformed);
        }
        let sig = unhex::<64>(&env.sig).ok_or(AnswerError::Malformed)?;
        let body = env.body.into_bytes();
        let message = answer_message(&self.to, &self.from, &self.host, self.ts_ms, &self.nonce, env.status, &body);
        if !verify_node(&self.to, &message, &sig) {
            return Err(AnswerError::NotTheNode);
        }
        Ok((env.status, body))
    }
}

// ----- the far side -----

/// Source address counters. Failed tries and all tries are counted apart, so a stranger's failures do not slow valid callers from
/// elsewhere. The throttle never touches the pairing lockout (a different thing, in `p2p::pairing`).
#[derive(Default)]
pub struct Throttle {
    seen: Mutex<HashMap<IpAddr, Bucket>>,
}

#[derive(Default)]
struct Bucket {
    hits: VecDeque<u64>,
    fails: VecDeque<u64>,
}

/// The throttle key: an IPv6 caller counts per /64 (its upper 64 bits), so one network cannot dodge the limit by rotating addresses.
fn key_of(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => IpAddr::V6((u128::from(v6) & (u128::MAX << 64)).into()),
        v4 => v4,
    }
}

fn trim(q: &mut VecDeque<u64>, now: u64) {
    while q.front().is_some_and(|t| now.saturating_sub(*t) >= WINDOW_MS) {
        q.pop_front();
    }
}

impl Throttle {
    /// Counts one try. False: this address has used up its window (failures or all tries).
    /// An IPv6 address counts per /64. A hit with NO address is not tracked (the door refuses those before it gets here). When the table
    /// is full of locked-out addresses, a new address is let through untracked (it still faces the full signature checks).
    /// stranger could then lock out the paired PC by filling it. They still must pass every signature check, and the body is capped.
    pub fn allow(&self, who: Option<IpAddr>, now: u64) -> bool {
        let Some(ip) = who.map(key_of) else { return true };
        let mut seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
        if seen.len() >= THROTTLE_TRACKED && !seen.contains_key(&ip) {
            let live = |q: &VecDeque<u64>| q.back().is_some_and(|t| now.saturating_sub(*t) < WINDOW_MS);
            seen.retain(|_, b| live(&b.hits) || live(&b.fails));
            if seen.len() >= THROTTLE_TRACKED {
                // Still full of live addresses. Drop the least recently seen one with NO recent failures; else the least recent one not
                // yet over its failure limit. A locked-out address is never evicted (that would clear its counter): when only those are
                // left, a NEW address is refused instead. Memory stays bounded either way.
                let live_fails = |b: &Bucket| b.fails.iter().filter(|t| now.saturating_sub(**t) < WINDOW_MS).count();
                let last = |b: &Bucket| b.hits.back().copied().unwrap_or(0);
                let victim = seen
                    .iter()
                    .filter(|(_, b)| live_fails(b) == 0)
                    .min_by_key(|(_, b)| last(b))
                    .or_else(|| seen.iter().filter(|(_, b)| live_fails(b) < FAILS_PER_WINDOW).min_by_key(|(_, b)| last(b)))
                    .map(|(k, _)| *k);
                match victim {
                    Some(old) => {
                        seen.remove(&old);
                    }
                    // Only locked-out addresses are tracked: this one goes untracked to the normal signature checks (the owner on a
                    // new address still works). Memory stays bounded.
                    None => return true,
                }
            }
        }
        let b = seen.entry(ip).or_default();
        trim(&mut b.hits, now);
        trim(&mut b.fails, now);
        if b.hits.len() >= HITS_PER_WINDOW || b.fails.len() >= FAILS_PER_WINDOW {
            return false;
        }
        b.hits.push_back(now);
        true
    }

    pub fn tracked(&self) -> usize {
        self.seen.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    pub fn fail(&self, who: Option<IpAddr>, now: u64) {
        let Some(ip) = who.map(key_of) else { return };
        let mut seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(b) = seen.get_mut(&ip) {
            trim(&mut b.fails, now);
            b.fails.push_back(now);
        }
    }
}

/// Nonces seen in the window, bounded.
#[derive(Default)]
pub struct NonceStore {
    seen: Mutex<NonceState>,
    /// Wall clock (ms) when this store was built. The nonces are in memory only, so a request signed before this moment may have been
    /// accepted by an earlier run: any request with `ts <= boot_ms` is refused (a replay of a capture across a restart).
    boot_ms: u64,
}

#[derive(Default)]
struct NonceState {
    entries: HashMap<(NodeId, [u8; 16]), u64>,
    /// The latest `until` of any entry forgotten so far. A request whose own `until` is not past it could replay a forgotten nonce (the
    /// clock went back), so it is refused. In normal running this never matters: such a request is already outside the window.
    forgotten_until: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum NonceError {
    Replay,
    Full,
}

impl NonceStore {
    /// A store for a run that starts at `boot_ms` (this PC's clock).
    pub fn booted(boot_ms: u64) -> Self {
        Self { seen: Mutex::default(), boot_ms }
    }

    /// Remembers `nonce` of `node` until its request could no longer be accepted (`ts + WINDOW_MS`). Called only after the signature
    /// checked out, so only a trusted device can fill the store.
    pub fn take(&self, node: NodeId, nonce: [u8; 16], ts_ms: u64, now: u64) -> Result<(), NonceError> {
        let mut state = self.seen.lock().unwrap_or_else(|p| p.into_inner());
        let NonceState { entries: seen, forgotten_until } = &mut *state;
        // An entry lives until one millisecond past the last moment its request could still pass the timestamp check, so a replay is
        // never possible after it is forgotten.
        seen.retain(|_, until| {
            let keep = *until > now;
            if !keep {
                *forgotten_until = (*forgotten_until).max(*until);
            }
            keep
        });
        if ts_ms <= self.boot_ms || ts_ms.saturating_add(WINDOW_MS + 1) <= *forgotten_until {
            return Err(NonceError::Replay);
        }
        if seen.contains_key(&(node, nonce)) {
            return Err(NonceError::Replay);
        }
        if seen.len() >= NONCE_MAX || seen.keys().filter(|(n, _)| *n == node).count() >= NONCE_PER_NODE {
            return Err(NonceError::Full);
        }
        seen.insert((node, nonce), ts_ms.saturating_add(WINDOW_MS + 1));
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.seen.lock().unwrap_or_else(|p| p.into_inner()).entries.len()
    }
}

/// What one HTTP hit hands in. `host` is the name the TUNNEL LISTENER verified (from the PROXY header), `peer` its visitor address
/// (throttle and log only). Nothing here is read from a header the visitor wrote.
pub struct Hit<'a> {
    pub host: &'a str,
    pub peer: Option<IpAddr>,
    pub method: &'a str,
    /// The request target as sent, with any query. Must be exactly [`PATH`].
    pub target: &'a str,
    pub body: &'a [u8],
}

/// What goes back on the wire: the HTTP status and the body (JSON).
pub type Reply = (u16, Vec<u8>);

fn flat() -> Reply {
    (401, FLAT_401.to_vec())
}

pub struct PcDoor {
    pub trust: Arc<TrustList>,
    /// Labs `devices_enabled` (the run switch of the whole feature), as `DeviceLink` keeps it.
    pub devices_on: Arc<AtomicBool>,
    /// Labs `pcdoor_enabled`.
    pub labs_on: Arc<AtomicBool>,
    /// The paired link's own door, with its level capped at Watch and its legacy routes removed. `None`: no services (the door is shut).
    pub door: Option<Arc<dyn HostBridge>>,
    pub signer: Arc<dyn NodeSigner>,
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub nonces: NonceStore,
    pub throttle: Throttle,
}

/// The level a device has on this door NOW: `None` unless the Labs switches are on, the device is in the trust list, its run switch and
/// its own "also through my web address" switch are on. Capped at Watch in slice 1.
pub fn level_now(trust: &TrustList, devices_on: &AtomicBool, labs_on: &AtomicBool, node: &NodeId) -> Option<Level> {
    if !devices_on.load(Ordering::SeqCst) || !labs_on.load(Ordering::SeqCst) || !trust.pcdoor_allowed(node) {
        return None;
    }
    let level: Option<RemoteLevel> = trust.remote_level(node);
    Level::of(level).map(|l| l.min(Level::Watch))
}

/// The routes slice 1 serves over the web address: read-only, Watch level, no streams, no pictures.
pub fn slice1_ok(method: &str, target: &str) -> bool {
    let path = target.split('?').next().unwrap_or("");
    let raw: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let Some((&"pclink", segs)) = raw.split_first() else { return false };
    method == "GET"
        && matches!(segs, ["me"] | ["sessions"] | ["sessions", _, "transcript"] | ["projects"] | ["agents"] | ["usage"] | ["questions"])
        && pclink::need(method, segs) == Some(Level::Watch)
}

fn target_ok(target: &str) -> bool {
    super::wire::target_ok(target) && target.len() <= TARGET_MAX && target.starts_with("/pclink/") && target.is_ascii()
}

impl PcDoor {
    fn on(&self) -> bool {
        self.devices_on.load(Ordering::SeqCst) && self.labs_on.load(Ordering::SeqCst) && self.door.is_some()
    }

    /// Everything that proves who is asking. `Err(())`: any reason at all (the caller answers the same flat 401).
    fn verify(&self, hit: &Hit<'_>, now: u64) -> Result<(NodeId, Envelope, [u8; 16]), ()> {
        if hit.method != "POST" || hit.target != PATH || hit.body.len() > ENVELOPE_MAX {
            return Err(());
        }
        let env: Envelope = serde_json::from_slice(hit.body).map_err(|_| ())?;
        if env.v != 1 || env.host != hit.host.to_ascii_lowercase() || !target_ok(&env.target) {
            return Err(());
        }
        let (from, to) = (NodeId(unhex::<32>(&env.from).ok_or(())?), NodeId(unhex::<32>(&env.to).ok_or(())?));
        let nonce = unhex::<16>(&env.nonce).ok_or(())?;
        let sig = unhex::<64>(&env.sig).ok_or(())?;
        if Some(to) != self.signer.node_id() {
            return Err(());
        }
        if now.abs_diff(env.ts) > WINDOW_MS {
            return Err(());
        }
        // Exactly one signature check for everyone: a stranger is checked against a fixed dummy key, so the time taken does not tell
        // whether an id is in the trust list.
        let trusted = self.trust.is_trusted(&from);
        let message = request_message(&env.method, &env.target, env.body.as_bytes(), &to, &from, &env.host, env.ts, &nonce);
        let checked = verify_node(if trusted { &from } else { &DUMMY_NODE }, &message, &sig);
        if !(trusted && checked) {
            return Err(());
        }
        Ok((from, env, nonce))
    }

    fn signed(&self, from: &NodeId, host: &str, env: &Envelope, nonce: &[u8; 16], status: u16, body: Vec<u8>) -> Reply {
        // The body is JSON text. What is signed is exactly the text that is sent.
        let text = String::from_utf8_lossy(&body).into_owned();
        let me = self.signer.node_id();
        let sig = me.and_then(|me| self.signer.sign(&answer_message(&me, from, host, env.ts, nonce, status, text.as_bytes())));
        match sig {
            Some(sig) => (status, serde_json::to_vec(&AnswerEnvelope { v: 1, status, body: text, sig: hex(&sig) }).unwrap_or_default()),
            None => flat(),
        }
    }

    /// One hit on `POST /bridge/pcdoor`.
    pub async fn handle(&self, hit: Hit<'_>) -> Reply {
        // No visitor address: refused with the flat 401 before anything is verified (real callers always carry one).
        if hit.peer.is_none() {
            return flat();
        }
        let now = (self.now_ms)();
        // The same per-address throttle runs whether the door is on or off, so the order of replies does not tell which it is.
        if !self.throttle.allow(hit.peer, now) {
            return (429, br#"{"error":"too many requests"}"#.to_vec());
        }
        if !self.on() {
            self.throttle.fail(hit.peer, now);
            return flat();
        }
        let (from, env, nonce) = match self.verify(&hit, now) {
            Ok(ok) => ok,
            Err(()) => {
                self.throttle.fail(hit.peer, now);
                return flat();
            }
        };
        match self.nonces.take(from, nonce, env.ts, now) {
            Ok(()) => {}
            Err(NonceError::Replay) => {
                self.throttle.fail(hit.peer, now);
                return flat();
            }
            Err(NonceError::Full) => return (429, br#"{"error":"too many requests"}"#.to_vec()),
        }
        let host = hit.host.to_ascii_lowercase();
        // From here the caller is proven. What it may do is read now, from the trust list, on every request.
        let refuse = |code: &str| self.signed(&from, &host, &env, &nonce, 403, serde_json::to_vec(&json!({ "error": "not_allowed", "code": code })).unwrap_or_default());
        if level_now(&self.trust, &self.devices_on, &self.labs_on, &from).is_none() {
            return refuse("DEVICE_NOT_ALLOWED");
        }
        if !env.body.is_empty() || !slice1_ok(&env.method, &env.target) {
            return refuse("NOT_OVER_THE_WEB_ADDRESS");
        }
        let Some(door) = &self.door else { return flat() };
        let (status, bytes) = door.call(&from.to_hex(), &env.method, &env.target, Vec::new()).await;
        self.signed(&from, &host, &env, &nonce, status, bytes)
    }
}

static UNBUILT: OnceLock<Throttle> = OnceLock::new();

/// The answer while the door's service is not built at all (the app has no device link): the flat 401, with the same per-address throttle
/// a built door runs, so the replies come in the same order.
pub fn handle_unbuilt(peer: Option<IpAddr>) -> Reply {
    if peer.is_none() {
        return flat();
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let throttle = UNBUILT.get_or_init(Throttle::default);
    if !throttle.allow(peer, now) {
        return (429, br#"{"error":"too many requests"}"#.to_vec());
    }
    throttle.fail(peer, now);
    flat()
}

/// The Labs switch in a settings value.
pub fn parse_labs(public: &Value) -> bool {
    public.get(LABS_KEY).and_then(Value::as_bool).unwrap_or(false)
}

/// The Labs switch key (off by default).
pub const LABS_KEY: &str = "pcdoor_enabled";
