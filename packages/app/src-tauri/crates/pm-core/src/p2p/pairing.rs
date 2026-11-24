//! Pairing two computers. The result is an entry in the signed trust list (`trust.rs`) on both sides, with
//! every capability off.
//!
//! **Roles.** The computer that *shows* a code is the host; the one that *enters* it (or picks the host from the
//! "found nearby" list) is the joiner. The joiner dials the host's pairing capability (`pm/pair/1`), which the
//! link layer admits only while the host has a code on screen, and only on a direct (LAN) path.
//!
//! **How the code authenticates the exchange** (no PAKE; the code is short and single use, so the rules around it
//! carry the weight):
//! 1. J -> H `hello` {nonce_j, binding_j, name_j}. The host checks the signed `NodeBinding` and that its node id is
//!    the one the encrypted link was made with.
//! 2. H -> J `challenge` {nonce_h, binding_h, name_h}. The joiner checks the same, and that it is the node it dialed.
//! 3. Both derive `K` = stretched HMAC of the code, salted with the host's node id. The transcript is both bindings
//!    and both nonces. J -> H `proof` = HMAC(K, "join" | transcript). The host sends nothing derived from the code
//!    before this checks out, so a stranger who connects learns nothing to guess against offline.
//! 4. H -> J `accept` = HMAC(K, "host" | transcript): the host knew the code too. A wrong proof counts as a wrong
//!    code. The code is single use: a good proof consumes it.
//! 5. **Both people confirm on their own screen** ("<Name> wants to pair. Code 4F7Q-9K2M. Allow / No"). Only then
//!    each side sends `decision` {yes, HMAC(K, role | yes | transcript)}. A side trusts the other only after it said
//!    yes itself AND the other's yes arrived with a valid MAC. Until then nothing is trusted: the permission check
//!    of the link layer still refuses every other capability.
//!
//! **Limits.** A code lives 2 minutes. 3 wrong codes or 3 "No" answers lock pairing for 10 minutes (the shown code
//! is withdrawn, joining and inbound sessions are refused). One session at a time. The sheet only appears after a
//! correct proof, so a stranger without the code cannot pop it up. The answer comes only through
//! `PairManager::answer`, which the desktop window's command calls: agents, MCP and the phone have no route to it
//! (`guard_tests.rs`).
//!
//! **Far away through the Worker** (Labs `far_pcs_enabled`, see `far.rs`): a link made by a PC that has a Worker carries
//! `w` (the Worker host) and `s` (a 128-bit seed). The joiner tries the Worker first, then the direct or public route.
//! The same frames travel as sealed messages in a box. The encrypted link does not prove who is on the other end there,
//! so each side also signs the exchange with its NODE key, and the peer is accepted only after that verifies. The two
//! screens never show the typed code (a stolen link knows it): they show the peer's name, a short fingerprint of its
//! device key and three numbers, one of which is on both screens; the person picks it. Links made with the seed
//! (`"v":2`) also mix it into the proof key, which lifts the direct route from 40 to 128 bits; a joiner that sends a
//! code-only proof is still accepted on the direct route, never on the Worker route.
//!
//! **Weak spot, on purpose said out loud:** if the joiner picks a "nearby" computer, the node id it dials was
//! announced on the LAN and is not yet authenticated. A fake host could then collect the joiner's proof and try
//! codes offline (the stretch makes each try costly). The host person's sheet and the code shown on both sheets
//! are the defence: pairing never completes without both people saying yes.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use rand::Rng;
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

use super::alpn;
use super::capability::{self, Capability, CapabilityHandler, RelayPolicy};
use super::far::{self, Creds, FarEnd, FarHost, LinkKeys, PairRelay, RelayErr, SEED_LEN};
use super::discovery::{Announcement, Discovery};
use super::endpoint::{BiStream, Link, NodeId, P2pError, PeerAddr};
use super::identity::{verify_node, DeviceIdentity, NodeBinding};
use super::trust::{clean_name, TrustList};
use super::P2p;

mod account;
pub use self::account::{AccountClaim, AccountExpect, AccountIntro, AccountLockStore, AccountMeta, AccountPc};
use crate::keys::KeyStore;

pub const CODE_TTL_MS: u64 = 120_000;
/// A pairing link lives longer than a code read aloud: it is sent to the other device first.
pub const LINK_TTL_MS: u64 = 600_000;
pub const LOCKOUT_MS: u64 = 600_000;
pub const MAX_STRIKES: u32 = 3;
const CODE_LEN: usize = 8;
/// No 0/O/1/I: a code read off one screen and typed on another is not mixed up.
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STRETCH_ROUNDS: u32 = 5_000;
const STEP_TIMEOUT: Duration = Duration::from_secs(20);
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
const FRAME_MAX: usize = 4096;
const TICKET_PREFIX: &str = "pm1:";
const LINK_PREFIX: &str = "pm2:";

type HmacSha256 = Hmac<Sha256>;

// ----- clock -----

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
}

/// A clock a test moves by hand.
pub struct ManualClock(AtomicU64);

impl ManualClock {
    pub fn new(start_ms: u64) -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(start_ms)))
    }

    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

// ----- errors -----

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PairError {
    #[error("FEATURE_OFF: My computers is switched off in Labs")]
    Off,
    #[error("Pairing is paused until {0}. Too many wrong codes or answers.")]
    Locked(u64),
    #[error("Check the code: it has 8 letters and numbers.")]
    BadCode,
    #[error("Check the address from the other computer.")]
    BadTicket,
    #[error("That is not a pairing link. Paste the whole link.")]
    BadLink,
    #[error("That computer is not nearby any more.")]
    NotNearby,
    #[error("Could not reach that computer. Keep PM open on both and stay on the same network.")]
    Unreachable,
    #[error("The code was not accepted. Check it, or ask for a new one.")]
    WrongCode,
    #[error("The other computer could not prove who it is.")]
    BadIdentity,
    #[error("The other computer is busy or has no code open.")]
    Refused,
    #[error("The other computer said no.")]
    TheyDeclined,
    #[error("You said no.")]
    YouDeclined,
    #[error("Nobody answered in time.")]
    TimedOut,
    #[error("The other computer did not finish.")]
    Dropped,
    #[error("Already pairing.")]
    Busy,
    #[error("Could not save: {0}")]
    Save(String),
    #[error("No such question.")]
    NoSuchQuestion,
    #[error("Could not reach your relay.")]
    RelayDown,
    #[error("Update the other PC to the newest version, then try again.")]
    UpdateOther,
    #[error("This link was already used. If that wasn't you, press No on the other PC.")]
    LinkUsed,
    #[error("That was not the matching number. Pairing stopped.")]
    WrongNumber,
    #[error("That PC is not letting your other PCs open it. Turn on \"Let my other PCs open this PC\" there.")]
    NotYours,
    #[error("Opening PCs from your account is paused for a while. Too many wrong numbers or answers.")]
    AccountLocked(Option<u64>),
    #[error("Could not reach that PC. Check that Potato Workspace is open there and that it lets your other PCs open it.")]
    NotReachable,
    #[error("Pick the number that is on both screens.")]
    PickRequired,
    #[error("{0}")]
    Other(String),
}

impl From<P2pError> for PairError {
    fn from(e: P2pError) -> Self {
        match e {
            P2pError::Off => PairError::Off,
            P2pError::Identity(m) => PairError::Other(m),
            _ => PairError::Unreachable,
        }
    }
}

// ----- code, ticket, keys -----

/// "4F7Q-9K2M" -> "4F7Q9K2M". `None` when it is not a code.
pub fn normalize_code(raw: &str) -> Option<String> {
    let s: String = raw.chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| c.to_ascii_uppercase()).collect();
    if s.len() == CODE_LEN && s.bytes().all(|b| ALPHABET.contains(&b)) {
        Some(s)
    } else {
        None
    }
}

pub fn display_code(code: &str) -> String {
    if code.len() < 8 || !code.is_char_boundary(4) {
        return String::new();
    }
    format!("{}-{}", &code[..4], &code[4..])
}

fn new_code() -> String {
    let mut rng = rand::rngs::OsRng;
    (0..CODE_LEN).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
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

/// What the host shows next to the code: its node id and the addresses to try.
pub fn make_ticket(node: &NodeId, addrs: &[SocketAddr]) -> String {
    let mut t = format!("{TICKET_PREFIX}{}", node.to_hex());
    for a in addrs {
        t.push('@');
        t.push_str(&a.to_string());
    }
    t
}

pub fn parse_ticket(raw: &str) -> Option<PeerAddr> {
    let rest = raw.trim().strip_prefix(TICKET_PREFIX)?;
    let mut parts = rest.split('@');
    let id = NodeId(unhex::<32>(parts.next()?)?);
    let mut direct = Vec::new();
    for p in parts {
        direct.push(SocketAddr::from_str(p).ok()?);
    }
    Some(PeerAddr { id, direct, relay: None })
}

/// What a pairing link says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLink {
    pub peer: PeerAddr,
    pub code: String,
    /// The seed of a link made with one (`"v":2`): the proof key mixes it in, and the Worker box is derived from it.
    pub seed: Option<[u8; SEED_LEN]>,
    /// The Worker host the host opened a box on.
    pub worker: Option<String>,
}

/// A pairing link (far away): the device id, where to reach it (addresses and relay) and the one-time code, in one
/// piece of text to paste. With a `seed` (Labs far_pcs_enabled) it is a version 2 link, and with a `worker` it also
/// names the Worker box to meet in. It gives no rights by itself: both people still confirm, on their own screen.
pub fn make_link(node: &NodeId, code: &str, addrs: &[SocketAddr], relay: Option<&str>, seed: Option<&[u8; SEED_LEN]>, worker: Option<&str>) -> String {
    use base64::Engine as _;
    let mut body = json!({ "n": node.to_hex(), "c": code, "a": addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>(), "r": relay });
    if let Some(seed) = seed {
        body["v"] = json!(2);
        body["s"] = json!(far::hex(seed));
        if let Some(w) = worker {
            body["w"] = json!(w);
        }
    }
    format!("{LINK_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body.to_string()))
}

/// The device to dial, the code, and the seed and Worker when the link has them. `None` when the text is not a link.
/// A link from another person is not trusted: a version 2 link with a broken seed, or a Worker host that is not a
/// plain public name, is refused whole.
pub fn parse_link(raw: &str) -> Option<ParsedLink> {
    use base64::Engine as _;
    let rest: String = raw.trim().strip_prefix(LINK_PREFIX)?.chars().filter(|c| !c.is_whitespace()).collect();
    if rest.len() > 4096 {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(rest).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let id = NodeId(unhex::<32>(v.get("n")?.as_str()?)?);
    let code = normalize_code(v.get("c")?.as_str()?)?;
    let direct: Vec<SocketAddr> = v.get("a").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().and_then(|t| SocketAddr::from_str(t).ok())).take(HELLO_ADDRS_MAX).collect()).unwrap_or_default();
    let relay = v.get("r").and_then(Value::as_str).filter(|r| !r.is_empty() && r.len() <= 256).map(str::to_string);
    let seed = match v.get("v").and_then(Value::as_u64) {
        None | Some(1) => None,
        Some(2) => Some(unhex::<SEED_LEN>(v.get("s")?.as_str()?)?),
        Some(_) => return None,
    };
    let worker = match v.get("w") {
        None | Some(Value::Null) => None,
        Some(w) => Some(far::link_worker_host(w.as_str()?)?),
    };
    Some(ParsedLink { peer: PeerAddr { id, direct, relay }, code, seed, worker: worker.filter(|_| seed.is_some()) })
}

fn mac(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac takes any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

fn mac_ok(key: &[u8; 32], parts: &[&[u8]], given: &[u8; 32]) -> bool {
    mac(key, parts).ct_eq(given).into()
}

/// The code is stretched so each offline try costs real work, and salted with the host's id.
fn derive_key(code: &str, host: &NodeId) -> [u8; 32] {
    let mut k = mac(&[0u8; 32], &[b"pm/pair/kdf/1", &host.0, code.as_bytes()]);
    for i in 0..STRETCH_ROUNDS {
        k = mac(&k, &[&i.to_be_bytes(), code.as_bytes()]);
    }
    k
}

struct Hello {
    nonce: [u8; 16],
    binding: NodeBinding,
    name: String,
    /// Where this computer can be reached on its network, and its relay: so the other one can dial it again later.
    /// Not part of the transcript and not trusted until both people said yes.
    addrs: Vec<SocketAddr>,
    relay: Option<String>,
}

const HELLO_ADDRS_MAX: usize = 8;

fn binding_bytes(b: &NodeBinding) -> Vec<u8> {
    let mut v = Vec::with_capacity(136);
    v.extend_from_slice(&b.node_id.0);
    v.extend_from_slice(&b.device_pub);
    v.extend_from_slice(&b.issued_at.to_be_bytes());
    v.extend_from_slice(&b.signature);
    v
}

fn transcript(joiner: &Hello, host: &Hello) -> Vec<u8> {
    let mut t = b"pm/pair/transcript/1".to_vec();
    t.extend_from_slice(&binding_bytes(&joiner.binding));
    t.extend_from_slice(&binding_bytes(&host.binding));
    t.extend_from_slice(&joiner.nonce);
    t.extend_from_slice(&host.nonce);
    t
}

fn hello_json(kind: &str, h: &Hello) -> Value {
    json!({
        "t": kind,
        "nonce": hex(&h.nonce),
        "name": h.name,
        "addrs": h.addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>(),
        "relay": h.relay,
        "binding": {
            "node": h.binding.node_id.to_hex(),
            "device": hex(&h.binding.device_pub),
            "issued": h.binding.issued_at,
            "sig": hex(&h.binding.signature),
        },
    })
}

fn parse_hello(v: &Value, kind: &str) -> Option<Hello> {
    if v.get("t")?.as_str()? != kind {
        return None;
    }
    let b = v.get("binding")?;
    let binding = NodeBinding {
        node_id: NodeId(unhex::<32>(b.get("node")?.as_str()?)?),
        device_pub: unhex::<32>(b.get("device")?.as_str()?)?,
        issued_at: b.get("issued")?.as_u64()?,
        signature: unhex::<64>(b.get("sig")?.as_str()?)?,
    };
    let addrs = v
        .get("addrs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().and_then(|t| SocketAddr::from_str(t).ok())).take(HELLO_ADDRS_MAX).collect())
        .unwrap_or_default();
    let relay = v.get("relay").and_then(Value::as_str).filter(|r| r.len() <= 256).map(str::to_string);
    Some(Hello { nonce: unhex::<16>(v.get("nonce")?.as_str()?)?, binding, name: clean_name(v.get("name")?.as_str()?), addrs, relay })
}

// ----- frames -----

async fn send_frame(s: &mut BiStream, v: &Value) -> Result<(), PairError> {
    let bytes = v.to_string().into_bytes();
    s.send.write_all(&(bytes.len() as u32).to_be_bytes()).await.map_err(|_| PairError::Dropped)?;
    s.send.write_all(&bytes).await.map_err(|_| PairError::Dropped)?;
    s.send.flush().await.map_err(|_| PairError::Dropped)
}

async fn recv_frame(s: &mut BiStream, wait: Duration) -> Result<Value, PairError> {
    let read = async {
        let mut len = [0u8; 4];
        s.recv.read_exact(&mut len).await.map_err(|_| PairError::Dropped)?;
        let len = u32::from_be_bytes(len) as usize;
        if len > FRAME_MAX {
            return Err(PairError::Dropped);
        }
        let mut buf = vec![0u8; len];
        s.recv.read_exact(&mut buf).await.map_err(|_| PairError::Dropped)?;
        serde_json::from_slice::<Value>(&buf).map_err(|_| PairError::Dropped)
    };
    tokio::time::timeout(wait, read).await.map_err(|_| PairError::TimedOut)?
}

// ----- state -----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// This computer showed the code.
    Host,
    /// This computer typed the code.
    Joiner,
}

#[derive(Default)]
struct Limiter {
    wrongs: u32,
    nos: u32,
    locked_until: u64,
}

struct HostCode {
    code: String,
    expires_at: u64,
    node: NodeId,
    /// A pairing link (far away) rather than a code read off the screen.
    link: Option<String>,
    /// The seed of a version 2 link (mixed into the proof key).
    seed: Option<[u8; SEED_LEN]>,
}

/// What a confirm sheet shows besides the name: the key's fingerprint and three numbers to pick from.
#[derive(Clone)]
struct CheckAsk {
    number: u32,
    choices: [u32; 3],
    fingerprint: String,
    kind: CheckKind,
}

/// How a number check is asked.
/// - `Pick`: three numbers on both screens, each person taps the one that is on both (the link flows).
/// - `Type`: the PC being opened by an account PC shows NO number; its person TYPES the six digits the other PC shows (1 in a million).
/// - `Show`: the PC pressing Open shows the six digits and waits for its person to say they typed them on the other PC.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CheckKind {
    Pick,
    Type,
    Show,
}

/// What is shown to make sure both people look at the same exchange.
enum Shown {
    /// The typed code (a code read off the screen: the person at the host read it aloud).
    Code(String),
    /// A link: the code is in the link, so a stolen link knows it. Numbers from the exchange are shown instead.
    Check(CheckAsk),
}

impl Shown {
    fn check(transcript: &[u8], sig_joiner: &[u8], sig_host: &[u8], device_pub: &[u8; 32]) -> Self {
        let number = far::check_number(transcript, sig_joiner, sig_host);
        Shown::Check(CheckAsk { number, choices: far::choices(number), fingerprint: far::fingerprint(device_pub), kind: CheckKind::Pick })
    }

    fn check_as(transcript: &[u8], sig_joiner: &[u8], sig_host: &[u8], device_pub: &[u8; 32], kind: CheckKind) -> Self {
        match Self::check(transcript, sig_joiner, sig_host, device_pub) {
            Shown::Check(c) => Shown::Check(CheckAsk { kind, ..c }),
            other => other,
        }
    }
}

/// What the person did on the sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reply {
    Yes,
    No,
    /// Picked a number that is not the matching one.
    Wrong,
    /// Nobody answered in time (never counted as a wrong answer on the account route).
    TimedOut,
}

/// What the Worker route needs while an exchange runs.
struct FarCtx {
    rid: [u8; 32],
}

/// What a link tells the joiner to use besides the device to dial.
#[derive(Default)]
struct JoinExtra {
    seed: Option<[u8; SEED_LEN]>,
    worker: Option<String>,
}

fn meta_of(h: &Hello) -> Vec<u8> {
    json!([h.name, h.addrs.iter().map(|a| a.to_string()).collect::<Vec<_>>(), h.relay]).to_string().into_bytes()
}

struct PendingAsk {
    id: u64,
    role: Role,
    name: String,
    code: String,
    check: Option<CheckAsk>,
    expires_at: u64,
    tx: Option<oneshot::Sender<Reply>>,
    /// A PC of the person's own account (found in its address book).
    account: Option<AccountMeta>,
}

#[derive(Default)]
struct State {
    host: Option<HostCode>,
    /// A session (inbound or outbound) is running.
    busy: bool,
    limiter: Limiter,
    pending: Option<PendingAsk>,
    joining: Option<String>,
    message: Option<String>,
    next_id: u64,
    /// Stops the Worker side of a shown link that nobody has joined yet.
    far_cancel: Option<Arc<tokio::sync::Notify>>,
    /// The account route has its own, stricter limits (per knocking PC and overall, escalating, kept on disk): see `pairing/account.rs`.
    account_locks: account::Locks,
}

/// Called with the new view whenever anything the sheets show changes.
pub type PairNotifier = Arc<dyn Fn(&Value) + Send + Sync>;

pub struct PairManager {
    p2p: Arc<P2p>,
    trust: Arc<TrustList>,
    keys: KeyStore,
    clock: Arc<dyn Clock>,
    discovery: Arc<dyn Discovery>,
    name: String,
    state: Mutex<State>,
    notifier: Mutex<Option<PairNotifier>>,
    /// The Worker (Labs far_pcs_enabled): set by the app. None = no far-away route, links are made as before.
    far_relay: Mutex<Option<Arc<dyn PairRelay>>>,
    /// How often a box is polled, milliseconds (tests make it short).
    far_poll_ms: std::sync::atomic::AtomicU64,
    /// What the account says about a PC that knocks on the account door. None: the door answers nobody.
    account_intro: Mutex<Option<Arc<dyn AccountIntro>>>,
    /// Called with the node of a PC that was just paired through the account, and the account's id for that device.
    on_account_paired: Mutex<Option<Arc<dyn Fn(NodeId, String) + Send + Sync>>>,
    /// How long a sheet waits for its person, milliseconds (tests make it short).
    confirm_ms: std::sync::atomic::AtomicU64,
    /// Tests only: 1 = this PC sends a changed node signature, 2 = it sends none.
    #[cfg(any(test, feature = "test-util"))]
    tamper_sig: std::sync::atomic::AtomicU8,
}

/// Resets `busy` however a session ends.
struct BusyGuard(Arc<PairManager>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.with(|s| s.busy = false);
        self.0.changed();
    }
}

/// `true`: the pairing link protocol (far away, a relay may carry it); `false`: a code read off the screen (direct only).
struct HostHandler(Arc<PairManager>, bool);

#[async_trait]
impl CapabilityHandler for HostHandler {
    async fn serve(&self, peer: NodeId, link: Arc<dyn Link>) {
        let _ = self.0.clone().serve_host(peer, &link, self.1).await;
        // Let the last frame arrive before the link goes away.
        tokio::time::sleep(Duration::from_millis(20)).await;
        link.close(0, "done");
    }
}

impl PairManager {
    /// Registers the pairing capability on the P2p service's registry. Starts nothing.
    pub fn new(
        p2p: Arc<P2p>,
        trust: Arc<TrustList>,
        keys: KeyStore,
        clock: Arc<dyn Clock>,
        discovery: Arc<dyn Discovery>,
        name: &str,
    ) -> Result<Arc<Self>, P2pError> {
        let m = Arc::new(Self {
            p2p,
            trust,
            keys,
            clock,
            discovery,
            name: clean_name(name),
            state: Mutex::new(State::default()),
            notifier: Mutex::new(None),
            far_relay: Mutex::new(None),
            far_poll_ms: std::sync::atomic::AtomicU64::new(1500),
            account_intro: Mutex::new(None),
            on_account_paired: Mutex::new(None),
            confirm_ms: std::sync::atomic::AtomicU64::new(CONFIRM_TIMEOUT.as_millis() as u64),
            #[cfg(any(test, feature = "test-util"))]
            tamper_sig: std::sync::atomic::AtomicU8::new(0),
        });
        m.p2p.registry().register(Capability::new(capability::PAIR, alpn::PAIR, RelayPolicy::Never, Arc::new(HostHandler(m.clone(), false))))?;
        m.p2p.registry().register(Capability::new(capability::PAIR_LINK, alpn::PAIR_LINK, RelayPolicy::Allowed, Arc::new(HostHandler(m.clone(), true))))?;
        m.p2p.registry().register(Capability::new(capability::PAIR_ACCOUNT, alpn::PAIR_ACCOUNT, RelayPolicy::Allowed, Arc::new(account::AccountHandler(m.clone()))))?;
        Ok(m)
    }

    pub fn set_notifier(&self, n: PairNotifier) {
        *self.notifier.lock().unwrap_or_else(|p| p.into_inner()) = Some(n);
    }

    pub fn trust(&self) -> &Arc<TrustList> {
        &self.trust
    }

    /// Gives the manager the Worker it may meet far-away PCs through. Nothing is used until Labs `far_pcs_enabled` is on.
    pub fn set_far_relay(&self, relay: Arc<dyn PairRelay>) {
        *self.far_relay.lock().unwrap_or_else(|p| p.into_inner()) = Some(relay);
    }

    #[cfg(any(test, feature = "test-util"))]
    pub fn set_tamper_sig(&self, mode: u8) {
        self.tamper_sig.store(mode, Ordering::SeqCst);
    }

    /// The node-signature frame. (Tests can make it wrong or missing.)
    fn nsig_frame(&self, sig: [u8; 64]) -> Value {
        #[cfg(any(test, feature = "test-util"))]
        match self.tamper_sig.load(Ordering::SeqCst) {
            1 => {
                let mut bad = sig;
                bad[0] ^= 1;
                return json!({ "t": "nsig", "sig": hex(&bad) });
            }
            2 => return json!({ "t": "nsig" }),
            _ => {}
        }
        json!({ "t": "nsig", "sig": hex(&sig) })
    }

    pub fn set_far_poll(&self, every: Duration) {
        self.far_poll_ms.store(every.as_millis().max(1) as u64, Ordering::SeqCst);
    }

    fn far_relay(&self) -> Option<Arc<dyn PairRelay>> {
        self.far_relay.lock().unwrap_or_else(|p| p.into_inner()).clone().filter(|_| self.p2p.far_pcs_on())
    }

    fn far_poll(&self) -> Duration {
        Duration::from_millis(self.far_poll_ms.load(Ordering::SeqCst))
    }

    fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().unwrap_or_else(|p| p.into_inner()))
    }

    fn changed(&self) {
        let n = self.notifier.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(n) = n {
            n(&self.view());
        }
    }

    fn say(&self, text: &str) {
        self.with(|s| s.message = Some(text.to_string()));
        self.changed();
    }

    fn identity(&self) -> Result<DeviceIdentity, PairError> {
        DeviceIdentity::load(&self.keys).map_err(PairError::from)
    }

    fn locked_until(&self) -> Option<u64> {
        let now = self.clock.now_ms();
        self.with(|s| {
            if s.limiter.locked_until > now {
                Some(s.limiter.locked_until)
            } else {
                if s.limiter.locked_until != 0 {
                    s.limiter = Limiter::default();
                }
                None
            }
        })
    }

    /// Counts a wrong code (`wrong`) or a "No" and trips the lockout at the third. A trip withdraws the shown code.
    fn strike(&self, wrong: bool) {
        let now = self.clock.now_ms();
        let tripped = self.with(|s| {
            let n = if wrong { &mut s.limiter.wrongs } else { &mut s.limiter.nos };
            *n += 1;
            if *n >= MAX_STRIKES {
                s.limiter.locked_until = now + LOCKOUT_MS;
                true
            } else {
                false
            }
        });
        if tripped {
            self.cancel_hosting();
        }
        self.changed();
    }

    // ----- the view the sheets draw -----

    pub fn view(&self) -> Value {
        let now = self.clock.now_ms();
        let (host, pending, joining, message, lock) = self.with(|s| {
            let host = s.host.as_ref().filter(|h| h.expires_at > now).map(|h| (h.code.clone(), h.expires_at, h.node, h.link.clone()));
            let pending = s.pending.as_ref().map(|p| {
                let mut v = json!({ "id": p.id, "role": if p.role == Role::Host { "host" } else { "joiner" }, "name": p.name, "code": display_code(&p.code), "expires_at": p.expires_at, "mode": "code" });
                if let Some(c) = &p.check {
                    // The true number is not in the view of a sheet that asks for a pick: it shows three, and the person picks the
                    // one on both screens. A `type` sheet shows no number at all (the person types the six digits the other PC shows);
                    // a `show` sheet is the other PC's, which shows them.
                    v["mode"] = json!(match c.kind {
                        CheckKind::Pick => "check",
                        CheckKind::Type => "type",
                        CheckKind::Show => "show",
                    });
                    v["code"] = json!("");
                    v["fingerprint"] = json!(c.fingerprint);
                    match c.kind {
                        CheckKind::Pick => v["choices"] = json!(c.choices.iter().map(|n| format!("{n:06}")).collect::<Vec<_>>()),
                        CheckKind::Type => {}
                        CheckKind::Show => v["number"] = json!(format!("{:06}", c.number)),
                    }
                }
                if let Some(meta) = &p.account {
                    // Both PCs are on the person's account. That is only who the account says they are: the number decides.
                    v["account"] = json!({ "first_seen": meta.first_seen });
                }
                v
            });
            let lock = (s.limiter.locked_until > now).then_some(s.limiter.locked_until);
            (host, pending, s.joining.clone(), s.message.clone(), lock)
        });
        let hosting = host.map(|(code, expires_at, node, link)| match link {
            // A pairing link carries the code inside it: the page shows the link, not a code to read out.
            Some(link) => {
                let worker = parse_link(&link).map(|p| p.worker.is_some()).unwrap_or(false);
                json!({ "kind": "link", "code": "", "ticket": "", "link": link, "expires_at": expires_at, "worker": worker })
            }
            None => json!({ "kind": "code", "code": display_code(&code), "ticket": make_ticket(&node, &self.p2p.local_addrs()), "link": Value::Null, "expires_at": expires_at }),
        });
        json!({
            "hosting": hosting,
            "pending": pending,
            "joining": joining,
            "message": message,
            "locked_until": lock,
            "account_locked_until": self.account_locked_until(),
            "tampered": self.trust.tampered(),
            "key_changed": self.trust.key_changed(),
            "devices": self.devices_view(),
        })
    }

    pub fn devices_view(&self) -> Value {
        Value::Array(
            self.trust
                .list()
                .iter()
                .map(|d| {
                    json!({
                        "node": d.node.to_hex(),
                        "name": d.name,
                        "added_at": d.added_at,
                        // Whether it is reachable is the desk link's to say (DL-7). Until then: unknown.
                        "online": Value::Null,
                        "allowed": d.allowed.iter().collect::<Vec<_>>(),
                    })
                })
                .collect(),
        )
    }

    /// Computers showing a code on this network now, minus this one and the ones already paired.
    pub fn nearby(&self) -> Value {
        let me = self.p2p.node_id();
        Value::Array(
            self.discovery
                .nearby()
                .into_iter()
                .filter(|a| Some(a.node) != me && !self.trust.is_trusted(&a.node))
                .map(|a| json!({ "node": a.node.to_hex(), "name": a.name }))
                .collect(),
        )
    }

    // ----- host side -----

    /// Shows a code. Opens pairing for strangers until it is used, cancelled or 2 minutes pass.
    pub async fn start_hosting(self: &Arc<Self>) -> Result<Value, PairError> {
        if let Some(until) = self.locked_until() {
            return Err(PairError::Locked(until));
        }
        let transport = self.p2p.want(capability::PAIR).await?;
        let now = self.clock.now_ms();
        let code = new_code();
        let node = transport.id();
        self.with(|s| {
            s.host = Some(HostCode { code, expires_at: now + CODE_TTL_MS, node, link: None, seed: None });
            s.message = None;
        });
        self.trust.set_link_pairing_open(false);
        self.trust.set_pairing_open(true);
        self.discovery.announce(Announcement { node, name: self.name.clone(), addrs: self.p2p.local_addrs() });
        self.changed();
        Ok(self.view())
    }

    /// Makes a pairing link for a device that is far away: single use, 10 minutes, and the other device may reach this
    /// one through a relay. It is not announced on the network. Both people still confirm on their own screen.
    ///
    /// With Labs `far_pcs_enabled` the link also carries a seed and, when this PC's own Worker accepts a box, the
    /// Worker's host: the other PC then meets this one there first (see `far.rs`). If the Worker cannot be used the link
    /// is still made, and says so on the sheet.
    pub async fn start_hosting_link(self: &Arc<Self>) -> Result<Value, PairError> {
        if let Some(until) = self.locked_until() {
            return Err(PairError::Locked(until));
        }
        let transport = self.p2p.want(capability::PAIR_LINK).await?;
        // The relay is only known a moment after the endpoint started; a link without it cannot cross the internet.
        let relay = self.p2p.home_relay_within(Duration::from_secs(4)).await;
        let now = self.clock.now_ms();
        let code = new_code();
        let node = transport.id();
        let mut seed = None;
        let mut box_host: Option<FarHost> = None;
        let mut note: Option<&str> = None;
        if self.p2p.far_pcs_on() {
            let fresh = far::new_seed();
            seed = Some(fresh);
            if let Some(worker) = self.far_relay() {
                if let Some(host) = worker.my_host() {
                    let keys = LinkKeys::derive(&fresh);
                    let host_token = far::new_token();
                    match worker.create(&host, &keys.rid_hex(), &far::sha_hex(&keys.pair_token_b64()), &far::sha_hex(&host_token), LINK_TTL_MS).await {
                        Ok(()) => box_host = Some(FarHost { relay: worker, host, keys, host_token, seed: fresh }),
                        Err(e) => note = Some(relay_note(&e)),
                    }
                } else {
                    note = Some("Set up your relay in Connect first. This link works on the direct and public route only.");
                }
            }
        }
        let link = make_link(&node, &code, &self.p2p.local_addrs(), relay.as_deref(), seed.as_ref(), box_host.as_ref().map(|b| b.host.as_str()));
        let cancel = box_host.as_ref().map(|_| Arc::new(tokio::sync::Notify::new()));
        self.with(|s| {
            s.host = Some(HostCode { code, expires_at: now + LINK_TTL_MS, node, link: Some(link), seed });
            s.message = None;
            if let Some(old) = s.far_cancel.take() {
                old.notify_one();
            }
            s.far_cancel = cancel.clone();
        });
        self.trust.set_pairing_open(false);
        self.trust.set_link_pairing_open(true);
        if let (Some(b), Some(cancel)) = (box_host, cancel) {
            tokio::spawn(self.clone().run_far_host(b, cancel));
        }
        match note {
            Some(text) => self.say(text),
            None => self.changed(),
        }
        Ok(self.view())
    }

    /// The Worker side of a shown link: waits for the first message, runs the same exchange on it, then closes the box.
    async fn run_far_host(self: Arc<Self>, far: FarHost, cancel: Arc<tokio::sync::Notify>) {
        let poll = self.far_poll();
        let end = FarEnd {
            relay: far.relay.clone(),
            host: far.host.clone(),
            keys: far.keys.clone(),
            creds: far.creds(),
            is_host: true,
            poll_every: poll,
            lifetime: Duration::from_millis(LINK_TTL_MS),
        };
        let rid = far.keys.rid;
        let (stream, _guard, first) = end.stream();
        tokio::select! {
            _ = cancel.notified() => {}
            got = tokio::time::timeout(Duration::from_millis(LINK_TTL_MS), first) => {
                if matches!(got, Ok(Ok(()))) {
                    if let Err(e) = self.clone().host_session(None, stream, true, Some(&FarCtx { rid })).await {
                        self.say(&e.to_string());
                    }
                    // The last frame (an answer, or a refusal) must reach the other side before the box goes.
                    tokio::time::sleep(poll * 2 + Duration::from_millis(200)).await;
                }
            }
        }
        far.close().await;
    }

    /// Withdraws the code (or link) and closes pairing. A Worker box nobody has joined yet is closed too.
    pub fn cancel_hosting(&self) {
        if let Some(n) = self.with(|s| s.far_cancel.take()) {
            n.notify_one();
        }
        self.close_code();
    }

    /// Closes pairing without touching a Worker exchange that is running (a good proof closes the code, and the answers
    /// still have to travel).
    fn close_code(&self) {
        let node = self.with(|s| s.host.take().map(|h| h.node));
        self.trust.set_pairing_open(false);
        self.trust.set_link_pairing_open(false);
        if let Some(n) = node {
            self.discovery.withdraw(&n);
        }
        self.changed();
    }

    async fn serve_host(self: Arc<Self>, peer: NodeId, link: &Arc<dyn Link>, via_link: bool) -> Result<(), PairError> {
        let stream = link.accept_bi().await.map_err(|_| PairError::Dropped)?;
        self.host_session(Some(peer), stream, via_link, None).await
    }

    /// The host's side of one exchange on a stream. `peer` is the node the encrypted link proved (the direct and public
    /// routes); `None` on the Worker route, where `far` is set and the peer is proven by its signature instead.
    async fn host_session(self: Arc<Self>, peer: Option<NodeId>, mut stream: BiStream, via_link: bool, far: Option<&FarCtx>) -> Result<(), PairError> {
        let refuse = |why: &'static str| json!({ "t": "refused", "why": why });

        // Gate: locked, no code, expired, busy.
        if self.locked_until().is_some() {
            return send_frame(&mut stream, &refuse("locked")).await;
        }
        let now = self.clock.now_ms();
        // A code shown on the screen is answered only on the direct protocol, a pairing link only on the link protocol.
        let open = self.with(|s| s.host.as_ref().map(|h| h.expires_at > now && h.link.is_some() == via_link).unwrap_or(false));
        if !open {
            self.cancel_hosting();
            return send_frame(&mut stream, &refuse("expired")).await;
        }
        let claimed = self.with(|s| {
            if s.busy {
                false
            } else {
                s.busy = true;
                true
            }
        });
        if !claimed {
            return send_frame(&mut stream, &refuse("busy")).await;
        }
        let _busy = BusyGuard(self.clone());

        // 1-2: hellos and bindings.
        let first = recv_frame(&mut stream, STEP_TIMEOUT).await?;
        let Some(joiner) = parse_hello(&first, "hello") else {
            return send_frame(&mut stream, &refuse("binding")).await;
        };
        if !joiner.binding.verify() || peer.map(|p| joiner.binding.node_id != p).unwrap_or(false) {
            return send_frame(&mut stream, &refuse("binding")).await;
        }
        let identity = self.identity()?;
        let mut nonce = [0u8; 16];
        rand::thread_rng().fill(&mut nonce);
        let me = Hello { nonce, binding: identity.binding(), name: self.name.clone(), addrs: self.p2p.local_addrs(), relay: self.p2p.home_relay() };
        send_frame(&mut stream, &hello_json("challenge", &me)).await?;
        let transcript = transcript(&joiner, &me);

        // 3-4: the proof. The code is read only now, and a good proof consumes it.
        let proof = recv_frame(&mut stream, STEP_TIMEOUT).await?;
        let given = proof.get("mac").and_then(Value::as_str).and_then(unhex::<32>);
        let now = self.clock.now_ms();
        let code = self.with(|s| s.host.as_ref().filter(|h| h.expires_at > now).map(|h| (h.code.clone(), h.seed)));
        let Some((code, seed)) = code else {
            return send_frame(&mut stream, &refuse("expired")).await;
        };
        // The host's OWN link decides how it is proven and what the sheet shows, never what the joiner sends. A link
        // made with a seed is proven with the seed mixed in, and nothing else is accepted for it: a code-only proof
        // (an older app, or someone who stole the link and left the seed out to get the old sheet) is refused. A link
        // without a seed (switch off) is proven by the code alone, as it always was.
        let is_proof = proof.get("t").and_then(Value::as_str) == Some("proof");
        let key = match (seed, given, is_proof) {
            (Some(seed), Some(g), true) => {
                let k2 = far::proof_key_v2(&code, &seed, &identity.id().0);
                if mac_ok(&k2, &[b"join", &transcript], &g) {
                    Some(k2)
                } else {
                    // A code-only proof that would have been right is an old app: it is told to update (not a wrong code
                    // as such, but it counts the same: it is also what a stripped stolen link looks like).
                    let k1 = derive_key(&code, &identity.id());
                    if mac_ok(&k1, &[b"join", &transcript], &g) {
                        self.strike(true);
                        return send_frame(&mut stream, &refuse("update")).await;
                    }
                    None
                }
            }
            (None, Some(g), true) => {
                let k1 = derive_key(&code, &identity.id());
                mac_ok(&k1, &[b"join", &transcript], &g).then_some(k1)
            }
            _ => None,
        };
        let Some(key) = key else {
            self.strike(true);
            return send_frame(&mut stream, &refuse("wrong")).await;
        };
        let v2 = seed.is_some();
        self.close_code();
        let accept = mac(&key, &[b"host", &transcript]);
        send_frame(&mut stream, &json!({ "t": "accept", "mac": hex(&accept) })).await?;

        // The Worker route: nothing proved the node yet. Each side signs this exact exchange with its node key; the
        // peer counts only after its signature verifies (and before anything is shown or remembered).
        let mut sigs: (Vec<u8>, Vec<u8>) = (Vec::new(), Vec::new());
        if let Some(ctx) = far {
            let frame = recv_frame(&mut stream, STEP_TIMEOUT).await?;
            let theirs = frame.get("sig").and_then(Value::as_str).and_then(unhex::<64>);
            let message = far::node_sig_message(&ctx.rid, b'j', &transcript, &meta_of(&joiner));
            let proven = frame.get("t").and_then(Value::as_str) == Some("nsig") && theirs.map(|g| verify_node(&joiner.binding.node_id, &message, &g)).unwrap_or(false);
            let Some(theirs) = theirs.filter(|_| proven) else {
                let _ = send_frame(&mut stream, &refuse("binding")).await;
                return Err(PairError::BadIdentity);
            };
            let mine = identity.sign_node(&far::node_sig_message(&ctx.rid, b'h', &transcript, &meta_of(&me)));
            send_frame(&mut stream, &self.nsig_frame(mine)).await?;
            sigs = (theirs.to_vec(), mine.to_vec());
        }
        // A link's code is in the link, so a stolen link knows it: links show numbers from the exchange instead.
        let shown = if via_link && v2 { Shown::check(&transcript, &sigs.0, &sigs.1, &joiner.binding.device_pub) } else { Shown::Code(code.clone()) };

        // 5: both people decide.
        let outcome = self.confirm_and_finish(Role::Host, &mut stream, &key, &transcript, &joiner, shown).await;
        if let Err(e) = &outcome {
            self.say(&e.to_string());
        }
        outcome
    }

    // ----- joiner side -----

    /// Enters a code for a computer given by its ticket (hex of the id is looked up in the nearby list).
    pub async fn join(self: &Arc<Self>, target: &str, code: &str) -> Result<String, PairError> {
        if !self.p2p.labs_for(capability::PAIR) {
            return Err(PairError::Off);
        }
        if let Some(until) = self.locked_until() {
            return Err(PairError::Locked(until));
        }
        let code = normalize_code(code).ok_or(PairError::BadCode)?;
        let peer = if let Some(id) = unhex::<32>(target.trim()) {
            let a = self.discovery.nearby().into_iter().find(|a| a.node.0 == id).ok_or(PairError::NotNearby)?;
            PeerAddr { id: a.node, direct: a.addrs, relay: None }
        } else {
            parse_ticket(target).ok_or(PairError::BadTicket)?
        };
        self.join_peer(peer, code, false, JoinExtra::default()).await
    }

    /// Joins with a pairing link (far away): the link names the device, so there is no "nearby" announcement to trust, and
    /// a relay may carry the exchange. A link with a Worker is tried through the Worker first (when Labs
    /// `far_pcs_enabled` is on and a Worker is set), then the direct or public route.
    pub async fn join_link(self: &Arc<Self>, text: &str) -> Result<String, PairError> {
        if !self.p2p.labs_for(capability::PAIR_LINK) {
            return Err(PairError::Off);
        }
        if let Some(until) = self.locked_until() {
            return Err(PairError::Locked(until));
        }
        let link = parse_link(text).ok_or(PairError::BadLink)?;
        self.join_peer(link.peer, link.code, true, JoinExtra { seed: link.seed, worker: link.worker }).await
    }

    async fn join_peer(self: &Arc<Self>, peer: PeerAddr, code: String, via_link: bool, extra: JoinExtra) -> Result<String, PairError> {
        let claimed = self.with(|s| {
            if s.busy {
                false
            } else {
                s.busy = true;
                s.joining = Some("Looking for the other computer… Keep PM open on both computers.".into());
                s.message = None;
                true
            }
        });
        if !claimed {
            return Err(PairError::Busy);
        }
        let _busy = BusyGuard(self.clone());
        self.changed();
        let result = self.run_join(&peer, &code, via_link, &extra).await;
        if result.is_ok() {
            self.p2p.addrs().remember(peer.id, &peer.direct);
        }
        self.with(|s| s.joining = None);
        match &result {
            Ok(name) => self.say(&format!("Paired with {name}. Nothing is shared yet: turn on what you want below.")),
            Err(e) => self.say(&e.to_string()),
        }
        result
    }

    async fn run_join(self: &Arc<Self>, peer: &PeerAddr, code: &str, via_link: bool, extra: &JoinExtra) -> Result<String, PairError> {
        if let (Some(host), Some(seed), Some(relay)) = (extra.worker.as_ref(), extra.seed, self.far_relay()) {
            match self.run_join_worker(relay, host, peer, code, seed).await {
                // The Worker could not be used (down, no such feature, full, or no such box): the direct and public
                // route still can. A box somebody else took, or an exchange that began, is final.
                Err(PairError::RelayDown) => {}
                other => return other,
            }
        }
        let link = self.p2p.dial(peer, if via_link { capability::PAIR_LINK } else { capability::PAIR }).await?;
        let result = self.run_join_on(&link, peer, code, extra.seed).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        link.close(0, "done");
        result
    }

    async fn run_join_worker(self: &Arc<Self>, relay: Arc<dyn PairRelay>, host: &str, peer: &PeerAddr, code: &str, seed: [u8; SEED_LEN]) -> Result<String, PairError> {
        let keys = LinkKeys::derive(&seed);
        let token = keys.pair_token_b64();
        let claim = relay.claim(host, &keys.rid_hex(), &token).await.map_err(|e| match e {
            RelayErr::Claimed => PairError::LinkUsed,
            _ => PairError::RelayDown,
        })?;
        let rid = keys.rid;
        let end = FarEnd {
            relay,
            host: host.to_string(),
            keys,
            creds: Creds { pair: Some(token), host: None, claim: Some(claim) },
            is_host: false,
            poll_every: self.far_poll(),
            lifetime: Duration::from_millis(LINK_TTL_MS),
        };
        let (stream, _guard, _first) = end.stream();
        let result = self.join_stream(stream, peer, code, Some(seed), Some(&FarCtx { rid }), true).await;
        // The last frame must reach the host before the stream goes.
        tokio::time::sleep(self.far_poll() + Duration::from_millis(100)).await;
        result
    }

    async fn run_join_on(self: &Arc<Self>, link: &Arc<dyn Link>, peer: &PeerAddr, code: &str, seed: Option<[u8; SEED_LEN]>) -> Result<String, PairError> {
        if link.peer() != peer.id {
            return Err(PairError::BadIdentity);
        }
        let stream = link.open_bi().await.map_err(|_| PairError::Unreachable)?;
        self.join_stream(stream, peer, code, seed, None, seed.is_some()).await
    }

    /// The joiner's side of one exchange on a stream. `far` is set on the Worker route (the peer is then proven by a node
    /// signature). `links_numbers`: this exchange came from a version 2 link, so numbers are shown instead of the code.
    async fn join_stream(self: &Arc<Self>, mut stream: BiStream, peer: &PeerAddr, code: &str, seed: Option<[u8; SEED_LEN]>, far: Option<&FarCtx>, links_numbers: bool) -> Result<String, PairError> {
        let identity = self.identity()?;
        let mut nonce = [0u8; 16];
        rand::thread_rng().fill(&mut nonce);
        let me = Hello { nonce, binding: identity.binding(), name: self.name.clone(), addrs: self.p2p.local_addrs(), relay: self.p2p.home_relay() };
        send_frame(&mut stream, &hello_json("hello", &me)).await?;

        let reply = recv_frame(&mut stream, STEP_TIMEOUT).await?;
        if reply.get("t").and_then(Value::as_str) == Some("refused") {
            return Err(self.refusal(&reply));
        }
        let host = parse_hello(&reply, "challenge").ok_or(PairError::BadIdentity)?;
        if !host.binding.verify() || host.binding.node_id != peer.id {
            return Err(PairError::BadIdentity);
        }
        let transcript = transcript(&me, &host);
        let key = match seed {
            Some(seed) => far::proof_key_v2(code, &seed, &peer.id.0),
            None => derive_key(code, &peer.id),
        };
        let proof = mac(&key, &[b"join", &transcript]);
        send_frame(&mut stream, &json!({ "t": "proof", "mac": hex(&proof) })).await?;

        let answer = recv_frame(&mut stream, STEP_TIMEOUT).await?;
        if answer.get("t").and_then(Value::as_str) == Some("refused") {
            return Err(self.refusal(&answer));
        }
        let given = answer.get("mac").and_then(Value::as_str).and_then(unhex::<32>);
        if answer.get("t").and_then(Value::as_str) != Some("accept") || !given.map(|g| mac_ok(&key, &[b"host", &transcript], &g)).unwrap_or(false) {
            return Err(PairError::BadIdentity);
        }
        let mut sigs: (Vec<u8>, Vec<u8>) = (Vec::new(), Vec::new());
        if let Some(ctx) = far {
            let mine = identity.sign_node(&far::node_sig_message(&ctx.rid, b'j', &transcript, &meta_of(&me)));
            send_frame(&mut stream, &self.nsig_frame(mine)).await?;
            let frame = recv_frame(&mut stream, STEP_TIMEOUT).await?;
            if frame.get("t").and_then(Value::as_str) == Some("refused") {
                return Err(self.refusal(&frame));
            }
            let theirs = frame.get("sig").and_then(Value::as_str).and_then(unhex::<64>);
            let message = far::node_sig_message(&ctx.rid, b'h', &transcript, &meta_of(&host));
            let proven = frame.get("t").and_then(Value::as_str) == Some("nsig") && theirs.map(|g| verify_node(&peer.id, &message, &g)).unwrap_or(false);
            let Some(theirs) = theirs.filter(|_| proven) else {
                return Err(PairError::BadIdentity);
            };
            sigs = (mine.to_vec(), theirs.to_vec());
        }
        self.with(|s| s.joining = Some(format!("Waiting for {} to confirm…", host.name)));
        self.changed();
        let shown = if links_numbers && seed.is_some() { Shown::check(&transcript, &sigs.0, &sigs.1, &host.binding.device_pub) } else { Shown::Code(code.to_string()) };
        self.confirm_and_finish(Role::Joiner, &mut stream, &key, &transcript, &host, shown).await?;
        Ok(host.name)
    }

    fn refusal(&self, frame: &Value) -> PairError {
        match frame.get("why").and_then(Value::as_str) {
            Some("wrong") => {
                self.strike(true);
                PairError::WrongCode
            }
            Some("update") => PairError::UpdateOther,
            Some("locked") | Some("expired") | Some("busy") => PairError::Refused,
            _ => PairError::BadIdentity,
        }
    }

    // ----- both sides: the two answers -----

    async fn confirm_and_finish(
        self: &Arc<Self>,
        role: Role,
        stream: &mut BiStream,
        key: &[u8; 32],
        transcript: &[u8],
        other: &Hello,
        shown: Shown,
    ) -> Result<(), PairError> {
        self.confirm_and_finish_as(role, stream, key, transcript, other, shown, None).await
    }

    /// `account`: the other PC is one of the person's own (its address book entry, when it was added). Its sheet says so, a
    /// A wrong number or a No at the PC being opened counts against that account device (and overall); a sheet nobody answered counts
    /// against its device limit and the overall one. No right is ever turned on by this route.
    #[allow(clippy::too_many_arguments)]
    async fn confirm_and_finish_as(
        self: &Arc<Self>,
        role: Role,
        stream: &mut BiStream,
        key: &[u8; 32],
        transcript: &[u8],
        other: &Hello,
        shown: Shown,
        account: Option<AccountMeta>,
    ) -> Result<(), PairError> {
        let mine: &[u8] = if role == Role::Host { b"h" } else { b"j" };
        let theirs: &[u8] = if role == Role::Host { b"j" } else { b"h" };
        let reply = self.ask_with(role, &other.name, shown, account.clone()).await;
        // On the account route nobody answering is not a wrong answer: it counts nothing against the knocking PC.
        let reply = if reply == Reply::TimedOut && account.is_none() { Reply::No } else { reply };
        let yes = reply == Reply::Yes;
        let tag = |who: &[u8], yes: bool| mac(key, &[b"decision", who, &[yes as u8], transcript]);
        // Best effort: the other side may already have said no and gone. Its answer is still read below.
        let _sent = send_frame(stream, &json!({ "t": "decision", "yes": yes, "mac": hex(&tag(mine, yes)) })).await;
        if !yes {
            // A wrong number or a No at the PC being opened counts against the PC that knocked (and overall). The PC pressing Open
            // locks nobody out by cancelling, and a sheet nobody answered counts nothing.
            if let Some(meta) = &account {
                if role == Role::Host {
                    // A sheet nobody answered counts against the device's sheet limit; a wrong number or a No is a strike.
                    if reply == Reply::TimedOut {
                        self.account_unanswered(&meta.device_id);
                    } else {
                        self.strike_account(&meta.device_id);
                    }
                }
            } else {
                self.strike(false);
            }
            return Err(match reply {
                Reply::Wrong => PairError::WrongNumber,
                Reply::TimedOut => PairError::TimedOut,
                _ => PairError::YouDeclined,
            });
        }
        let frame = recv_frame(stream, CONFIRM_TIMEOUT).await?;
        let their_yes = frame.get("yes").and_then(Value::as_bool).ok_or(PairError::Dropped)?;
        let given = frame.get("mac").and_then(Value::as_str).and_then(unhex::<32>).ok_or(PairError::Dropped)?;
        if frame.get("t").and_then(Value::as_str) != Some("decision") || !mac_ok(key, &[b"decision", theirs, &[their_yes as u8], transcript], &given) {
            return Err(PairError::BadIdentity);
        }
        if !their_yes {
            return Err(PairError::TheyDeclined);
        }
        // Both said yes, both MACs hold: now, and only now, the other computer is trusted (every capability off).
        let now_secs = self.clock.now_ms() / 1000;
        self.trust
            .add(other.binding.node_id, other.binding.device_pub, &other.name, now_secs)
            .map_err(|e| PairError::Save(e.to_string()))?;
        self.with(|s| s.limiter = Limiter::default());
        if let Some(meta) = &account {
            self.account_success(&meta.device_id);
        }
        // A PC of the person's own account was paired: Full by default, with the account marker (plan 2.2). Only this route does it; the
        // person can lower it any time in Connect, and a level they lowered stays lowered (the marker is already there).
        if let Some(meta) = &account {
            let _ = self.trust.grant_account_default(&other.binding.node_id);
            let hook = self.on_account_paired.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some(hook) = hook {
                hook(other.binding.node_id, meta.device_id.clone());
            }
        }
        // Both said yes: remember where the other one can be reached, so this computer can dial it later.
        self.p2p.addrs().remember(other.binding.node_id, &other.addrs);
        if let Some(relay) = other.relay.as_deref() {
            self.p2p.addrs().remember_relay(other.binding.node_id, relay);
        }
        Ok(())
    }

    /// Puts the question on this computer's screen and waits for the person.
    async fn ask(self: &Arc<Self>, role: Role, name: &str, shown: Shown) -> Reply {
        self.ask_with(role, name, shown, None).await
    }

    /// `ask`, for a PC of the person's own account when `account` is set.
    async fn ask_with(self: &Arc<Self>, role: Role, name: &str, shown: Shown, account: Option<AccountMeta>) -> Reply {
        let (tx, rx) = oneshot::channel();
        let wait = Duration::from_millis(self.confirm_ms.load(Ordering::SeqCst));
        let now = self.clock.now_ms();
        let (code, check) = match shown {
            Shown::Code(c) => (c, None),
            Shown::Check(c) => (String::new(), Some(c)),
        };
        self.with(|s| {
            s.next_id += 1;
            let id = s.next_id;
            s.joining = None;
            s.pending = Some(PendingAsk {
                id,
                role,
                name: name.to_string(),
                code,
                check,
                expires_at: now + wait.as_millis() as u64,
                tx: Some(tx),
                account,
            });
        });
        self.changed();
        // If this wait is dropped (the other computer left, the session was aborted) the question must not stay on
        // screen with an Allow that can no longer reach anyone.
        struct ClearOnDrop(Arc<PairManager>);
        impl Drop for ClearOnDrop {
            fn drop(&mut self) {
                self.0.with(|s| s.pending = None);
                self.0.changed();
            }
        }
        let _clear = ClearOnDrop(self.clone());
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Reply::No,
            Err(_) => Reply::TimedOut,
        }
    }

    /// How long a sheet waits for its person (tests only: they cannot wait two minutes).
    #[cfg(any(test, feature = "test-util"))]
    pub fn set_confirm_timeout(&self, wait: Duration) {
        self.confirm_ms.store(wait.as_millis().max(1) as u64, Ordering::SeqCst);
    }

    /// The person's answer to a sheet that shows a code. The only way such a question is answered; the desktop window's
    /// command is the only caller (see `guard_tests.rs`). A sheet that shows numbers is answered by `answer_pick`: a
    /// plain Yes is refused there, so pressing a button cannot skip the check.
    pub fn answer(&self, id: u64, allow: bool) -> Result<(), PairError> {
        let tx = self.with(|s| match s.pending.as_mut() {
            Some(p) if p.id == id => {
                // A sheet that asks for a pick or typed digits is never answered by a plain Yes. A `show` sheet (the PC pressing Open) is: it
                // only says "I typed it on the other PC"; the trust still needs the other PC's person to type the right six digits.
                if allow && p.check.as_ref().is_some_and(|c| c.kind != CheckKind::Show) {
                    Err(PairError::PickRequired)
                } else {
                    Ok(p.tx.take())
                }
            }
            _ => Ok(None),
        })?;
        tx.ok_or(PairError::NoSuchQuestion)?.send(if allow { Reply::Yes } else { Reply::No }).map_err(|_| PairError::NoSuchQuestion)
    }

    /// The person's pick on a sheet that shows numbers ("123456"): the matching one is Yes, any other is a No that is
    /// counted like one.
    pub fn answer_pick(&self, id: u64, pick: &str) -> Result<(), PairError> {
        let tx = self.with(|s| match s.pending.as_mut() {
            Some(p) if p.id == id && p.check.as_ref().is_some_and(|c| c.kind != CheckKind::Show) => p.check.as_ref().map(|c| (p.tx.take(), c.number)),
            _ => None,
        });
        let (tx, number) = tx.ok_or(PairError::NoSuchQuestion)?;
        // Typed digits may come with a space or a dash in the middle ("482 913").
        let pick: String = pick.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
        let right = pick.parse::<u32>().map(|n| n == number).unwrap_or(false) && pick.len() == 6;
        tx.ok_or(PairError::NoSuchQuestion)?.send(if right { Reply::Yes } else { Reply::Wrong }).map_err(|_| PairError::NoSuchQuestion)
    }

    /// The true check number of the sheet that is open now (tests only: the view never carries it).
    #[cfg(any(test, feature = "test-util"))]
    pub fn pending_number(&self) -> Option<u32> {
        self.with(|s| s.pending.as_ref().and_then(|p| p.check.as_ref().map(|c| c.number)))
    }

    /// Removes a paired computer. The person confirms in the UI first.
    pub fn remove(&self, node: &NodeId) -> Result<(), PairError> {
        self.trust.remove(node).map_err(|e| PairError::Save(e.to_string()))?;
        self.changed();
        Ok(())
    }

    /// The person's own label for a paired computer.
    pub fn rename(&self, node: &NodeId, name: &str) -> Result<(), PairError> {
        self.trust.rename(node, name).map_err(|e| PairError::Save(e.to_string()))?;
        self.changed();
        Ok(())
    }

    pub fn set_permission(&self, node: &NodeId, capability: &str, on: bool) -> Result<(), PairError> {
        self.trust.set_permission(node, capability, on).map_err(|e| PairError::Save(e.to_string()))?;
        self.changed();
        Ok(())
    }
}

/// Capability ids the page may switch, for the command layer.
pub fn permissionable() -> BTreeSet<&'static str> {
    capability::PERMISSIONABLE.iter().copied().collect()
}

/// A plain sentence for the sheet when a link could not use the Worker (the link still works on the other routes).
fn relay_note(e: &RelayErr) -> &'static str {
    match e {
        RelayErr::NoFeature => "Your relay needs an update to add PCs on other networks. Press Update on the relay card at the top of Connect. This link works on the direct and public route only.",
        RelayErr::Down => "Could not reach your relay. This link works on the direct and public route only.",
        RelayErr::Full => "Your relay is busy. This link works on the direct and public route only.",
        _ => "Your relay did not accept the link. It works on the direct and public route only.",
    }
}
