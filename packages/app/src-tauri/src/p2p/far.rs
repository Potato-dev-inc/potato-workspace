//! Far-away pairing through the person's own Worker (Labs `far_pcs_enabled`).
//!
//! The Worker is only the MEETING PLACE. Two PCs that are not on the same network leave sealed messages in a small
//! box there (`relay/worker/src/pair.ts`); the exchange inside is the same pairing exchange as everywhere else
//! (`pairing.rs`). Once paired, data keeps using the PC link (direct, or the public relay) as before.
//!
//! **Keys.** The pairing link carries a 128-bit seed `s` (it travels from one person to the other, never to the
//! Worker). Everything else is derived from it with HKDF-SHA256 and a different label each:
//! - `rid`, the box's name (the Worker sees only this),
//! - the pair token (proves "I hold the link" when claiming the box; the Worker stores only its hash),
//! - one sealing key per direction.
//! The host also has a random host token that is NOT in the link, so a link holder cannot read the host's inbox,
//! write as the host, or close the box.
//!
//! **Sealing.** XChaCha20-Poly1305 (`secure_core::crypto`) with a fresh random 24-byte nonce for every message.
//! The associated data is the label, `rid`, the direction and the message's number, so a message cannot be moved to
//! another box, direction or place. The number is used only to catch a replayed, dropped or reordered message
//! (never as a nonce). Plaintexts are padded so every message is the same size on the wire.
//!
//! **No forward secrecy (written down on purpose).** Whoever later gets the link AND a recording of the box learns
//! the names, addresses and device records that were exchanged. They cannot pair (the box is used up, and both
//! people confirm). Forward secrecy with an ephemeral key exchange is a later step.
//!
//! **What the Worker learns:** the box name, when two PCs met, the IP addresses of both, and message sizes (all the
//! same). Never a name, an address, a key or a code.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use hkdf::Hkdf;
use rand::Rng;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::task::JoinHandle;

use super::endpoint::BiStream;
use crate::secure_core::crypto::{open_with_key, seal_with_key};

pub const SEED_LEN: usize = 16;
/// Every sealed message is at least this long before the cipher pads it to its bucket (4 KiB for any frame).
const MIN_PLAINTEXT: usize = 1100;
const FRAME_LIMIT: usize = 8 * 1024;
const MSG_LABEL: &[u8] = b"pm/pair/far/msg/v1";
/// The label of the node signatures (see `pairing.rs`): each side signs `NODE_SIG_LABEL | rid | role | transcript | meta`.
pub const NODE_SIG_LABEL: &[u8] = b"pm/pair/mailbox/v1";

// ----- keys -----

/// Everything both PCs derive from the link's seed.
#[derive(Clone)]
pub struct LinkKeys {
    pub rid: [u8; 32],
    pub pair_token: [u8; 32],
    host_to_joiner: [u8; 32],
    joiner_to_host: [u8; 32],
}

fn expand(seed: &[u8; SEED_LEN], label: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(b"pm/pair/far/v1"), seed);
    let mut out = [0u8; 32];
    hk.expand(label, &mut out).expect("32 bytes is a valid HKDF length");
    out
}

impl LinkKeys {
    pub fn derive(seed: &[u8; SEED_LEN]) -> Self {
        Self {
            rid: expand(seed, b"rid"),
            pair_token: expand(seed, b"pair-token"),
            host_to_joiner: expand(seed, b"seal-h2j"),
            joiner_to_host: expand(seed, b"seal-j2h"),
        }
    }

    pub fn rid_hex(&self) -> String {
        hex(&self.rid)
    }

    pub fn pair_token_b64(&self) -> String {
        b64(&self.pair_token)
    }

    fn send_key(&self, host: bool) -> &[u8; 32] {
        if host {
            &self.host_to_joiner
        } else {
            &self.joiner_to_host
        }
    }

}

/// The key for the pairing proof of a NEW link: the seed and the code together, salted with the host's node id. The
/// seed lifts the proof from the code's 40 bits to 128 bits on every route (iroh included).
pub fn proof_key_v2(code: &str, seed: &[u8; SEED_LEN], host_node: &[u8; 32]) -> [u8; 32] {
    let mut ikm = Vec::with_capacity(SEED_LEN + code.len());
    ikm.extend_from_slice(seed);
    ikm.extend_from_slice(code.as_bytes());
    let hk = Hkdf::<Sha256>::new(Some(host_node), &ikm);
    let mut out = [0u8; 32];
    hk.expand(b"pm/pair/kdf/2", &mut out).expect("32 bytes is a valid HKDF length");
    out
}

pub fn new_seed() -> [u8; SEED_LEN] {
    let mut s = [0u8; SEED_LEN];
    rand::rngs::OsRng.fill(&mut s);
    s
}

/// A random token that is not derived from anything (the host's own secret for its box).
pub fn new_token() -> String {
    let mut t = [0u8; 32];
    rand::rngs::OsRng.fill(&mut t);
    b64(&t)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn b64(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn unb64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

/// SHA-256 as hex: what the Worker stores of a token.
pub fn sha_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

// ----- what the people see: fingerprint and check number -----

/// A short look-alike-proof fingerprint of a device key, for the confirm sheet ("A1B2 C3D4").
pub fn fingerprint(device_pub: &[u8; 32]) -> String {
    let d = Sha256::digest([b"pm/pair/fingerprint/1".as_slice(), device_pub].concat());
    let h = hex(&d[..4]).to_uppercase();
    format!("{} {}", &h[..4], &h[4..])
}

/// The 6-digit check number both screens derive from the whole exchange (both bindings, both nonces and, on the
/// Worker route, both node signatures). It is NOT the typed code: someone who stole the link knows the code, but
/// cannot make the two screens show the same number unless they are the other end of the same exchange.
pub fn check_number(transcript: &[u8], sig_joiner: &[u8], sig_host: &[u8]) -> u32 {
    let mut h = Sha256::new();
    h.update(b"pm/pair/check/1");
    for part in [transcript, sig_joiner, sig_host] {
        h.update((part.len() as u32).to_be_bytes());
        h.update(part);
    }
    let d = h.finalize();
    (u64::from_be_bytes(d[..8].try_into().expect("8 bytes")) % 1_000_000) as u32
}

/// Three numbers to pick from: the true one and two others, in a random order. The person picks the one that is on
/// both screens. The decoys are fresh on each screen, so only the true number appears on both.
pub fn choices(true_number: u32) -> [u32; 3] {
    let mut rng = rand::thread_rng();
    let mut out = [true_number, true_number, true_number];
    for i in 1..3 {
        loop {
            let n = rng.gen_range(0..1_000_000u32);
            if out[..i].iter().all(|x| *x != n) {
                out[i] = n;
                break;
            }
        }
    }
    let at = rng.gen_range(0..3usize);
    out.swap(0, at);
    out
}

/// What each side signs with its node key: the exchange itself (so a signature cannot be reused for another
/// exchange or another box), plus a hash of the other fields that are remembered afterwards (name, addresses, relay).
pub fn node_sig_message(rid: &[u8; 32], role: u8, transcript: &[u8], meta: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(NODE_SIG_LABEL.len() + 33 + transcript.len() + 32);
    m.extend_from_slice(NODE_SIG_LABEL);
    m.extend_from_slice(rid);
    m.push(role);
    m.extend_from_slice(transcript);
    m.extend_from_slice(&Sha256::digest(meta));
    m
}

// ----- a Worker address from a pasted link -----

/// The Worker host from a pairing link, or `None`. A link comes from another person, so it is not trusted: a plain
/// public host name only (no scheme, address, credentials, port or path), so the app never calls an internal address.
/// `allow_loopback` is for tests that talk to a Worker on this PC.
pub fn clean_worker_host(raw: &str, allow_loopback: bool) -> Option<String> {
    let host = raw.trim().to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    if allow_loopback {
        if let Some((name, port)) = host.split_once(':') {
            if (name == "127.0.0.1" || name == "localhost") && !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit()) {
                return Some(host);
            }
        }
    }
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if labels.len() < 2 || !labels.iter().all(|l| label_ok(l)) {
        return None;
    }
    // A last label with no letter is an address (1.2.3.4, 0x7f.1, ...): not a name.
    let last = labels[labels.len() - 1];
    if !last.bytes().any(|b| b.is_ascii_lowercase()) {
        return None;
    }
    if matches!(last, "local" | "localhost" | "internal" | "lan" | "home" | "corp" | "invalid" | "test" | "example") {
        return None;
    }
    Some(host)
}

/// The Worker host a PAIRING LINK may name: a plain public name that ends in `.workers.dev` (the host of the person's own
/// Worker; an own-domain list is a later step). A test build also takes `127.0.0.1:<port>` for the local Worker.
pub fn link_worker_host(raw: &str) -> Option<String> {
    let host = clean_worker_host(raw, cfg!(test))?;
    (cfg!(test) || host.ends_with(".workers.dev")).then_some(host)
}

// ----- the Worker, as the pairing sees it -----

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayErr {
    /// Could not reach the Worker, or it did not answer in time.
    Down,
    /// The Worker does not have this feature (an older deploy), or the owner key is not set there.
    NoFeature,
    /// The box does not exist (any more): used, closed or ran out. The Worker answers alike for a wrong token.
    Gone,
    /// Somebody already took the box.
    Claimed,
    /// The Worker is full or out of quota; try later.
    Full,
    /// Any other answer.
    Refused(u16),
}

/// What a call proves it knows. The Worker keeps only hashes.
#[derive(Debug, Clone, Default)]
pub struct Creds {
    pub pair: Option<String>,
    pub host: Option<String>,
    pub claim: Option<String>,
}

/// One message from the Worker: its position, the sender's number and the sealed bytes (base64url).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivered {
    pub index: u64,
    pub n: u32,
    pub ct: String,
}

#[async_trait]
pub trait PairRelay: Send + Sync {
    /// This PC's own Worker host (what goes into a link it makes), or `None` when none is set up.
    fn my_host(&self) -> Option<String>;
    /// Opens a box (only the Worker's owner can; the call is signed by the owner key).
    async fn create(&self, host: &str, rid: &str, pair_hash: &str, host_hash: &str, ttl_ms: u64) -> Result<(), RelayErr>;
    /// The first arrival takes the box and gets its claim token.
    async fn claim(&self, host: &str, rid: &str, pair_token: &str) -> Result<String, RelayErr>;
    async fn post(&self, host: &str, rid: &str, who: &Creds, dir: char, n: u32, ct: &str) -> Result<(), RelayErr>;
    /// What was sent TO `for_dir` after position `after`.
    async fn poll(&self, host: &str, rid: &str, who: &Creds, for_dir: char, after: u64) -> Result<Vec<Delivered>, RelayErr>;
    async fn delete(&self, host: &str, rid: &str, host_token: &str) -> Result<(), RelayErr>;
}

// ----- sealing one message -----

fn aad(rid: &[u8; 32], host_sent: bool, n: u32) -> Vec<u8> {
    let mut a = Vec::with_capacity(MSG_LABEL.len() + 37);
    a.extend_from_slice(MSG_LABEL);
    a.extend_from_slice(rid);
    a.push(if host_sent { b'h' } else { b'j' });
    a.extend_from_slice(&n.to_be_bytes());
    a
}

/// A frame, sealed for the box: `nonce(24) | ciphertext`, base64url. Always the same size on the wire for a frame
/// that fits one bucket.
pub fn seal_frame(keys: &LinkKeys, host_sends: bool, n: u32, frame: &[u8]) -> Result<String, String> {
    if frame.len() > FRAME_LIMIT {
        return Err("frame too large".into());
    }
    let mut plain = Vec::with_capacity(MIN_PLAINTEXT.max(frame.len() + 4));
    plain.extend_from_slice(&(frame.len() as u32).to_be_bytes());
    plain.extend_from_slice(frame);
    if plain.len() < MIN_PLAINTEXT {
        plain.resize(MIN_PLAINTEXT, 0);
    }
    let (nonce, ct) = seal_with_key(keys.send_key(host_sends), &aad(&keys.rid, host_sends, n), &plain).map_err(|e| e.to_string())?;
    let mut wire = nonce.to_vec();
    wire.extend_from_slice(&ct);
    Ok(b64(&wire))
}

/// The frame inside a sealed message that `host_sent` sent as its number `n`, or `None` when it does not open (wrong
/// key, another box, another direction, another number, changed bytes).
pub fn open_frame(keys: &LinkKeys, host_sent: bool, n: u32, wire_b64: &str) -> Option<Vec<u8>> {
    let wire = unb64(wire_b64)?;
    if wire.len() < 24 + 16 {
        return None;
    }
    let plain = open_with_key(keys.send_key(host_sent), &wire[..24], &aad(&keys.rid, host_sent, n), &wire[24..]).ok()?;
    if plain.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes([plain[0], plain[1], plain[2], plain[3]]) as usize;
    if len > plain.len() - 4 || len > FRAME_LIMIT {
        return None;
    }
    Some(plain[4..4 + len].to_vec())
}

// ----- the stream the pairing exchange runs on -----

/// One end of a box, ready to run the pairing exchange on. Dropping the guard stops the background work.
pub struct FarEnd {
    pub relay: Arc<dyn PairRelay>,
    pub host: String,
    pub keys: LinkKeys,
    pub creds: Creds,
    /// `true`: this PC made the link.
    pub is_host: bool,
    pub poll_every: Duration,
    /// How long the exchange may last (the link's life).
    pub lifetime: Duration,
}

pub struct FarGuard {
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for FarGuard {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl FarEnd {
    /// A byte stream with the pairing frames on it (length-prefixed, like on the link). Under it: one sealed message
    /// in the box per frame, numbered per direction; messages that are replayed, out of order or do not open end the
    /// stream. The returned receiver fires when the first message from the other side has arrived.
    pub fn stream(self) -> (BiStream, FarGuard, tokio::sync::oneshot::Receiver<()>) {
        let (app_out, mut pump_in) = tokio::io::duplex(64 * 1024);
        let (mut pump_out, app_in) = tokio::io::duplex(64 * 1024);
        let (first_tx, first_rx) = tokio::sync::oneshot::channel::<()>();
        let me = Arc::new(self);
        let sender = {
            let me = me.clone();
            tokio::spawn(async move {
                let mut n: u32 = 0;
                loop {
                    let mut len = [0u8; 4];
                    if pump_in.read_exact(&mut len).await.is_err() {
                        return;
                    }
                    let len = u32::from_be_bytes(len) as usize;
                    if len > FRAME_LIMIT {
                        return;
                    }
                    let mut frame = vec![0u8; len];
                    if pump_in.read_exact(&mut frame).await.is_err() {
                        return;
                    }
                    let Ok(ct) = seal_frame(&me.keys, me.is_host, n, &frame) else { return };
                    let dir = if me.is_host { 'h' } else { 'j' };
                    let mut tries = 0;
                    loop {
                        match me.relay.post(&me.host, &me.keys.rid_hex(), &me.creds, dir, n, &ct).await {
                            Ok(()) => break,
                            Err(RelayErr::Down) if tries < 3 => {
                                tries += 1;
                                tokio::time::sleep(me.poll_every).await;
                            }
                            Err(_) => return,
                        }
                    }
                    n += 1;
                }
            })
        };
        let receiver = {
            let me = me.clone();
            tokio::spawn(async move {
                let started = tokio::time::Instant::now();
                let mut first = Some(first_tx);
                let mut after = 0u64;
                let mut expect: u32 = 0;
                let mut down = 0u32;
                let for_dir = if me.is_host { 'h' } else { 'j' };
                loop {
                    if started.elapsed() > me.lifetime {
                        return;
                    }
                    match me.relay.poll(&me.host, &me.keys.rid_hex(), &me.creds, for_dir, after).await {
                        Ok(msgs) => {
                            down = 0;
                            for m in msgs {
                                // Numbers must come exactly in order: a replayed, repeated or missing one ends it.
                                if m.n != expect {
                                    return;
                                }
                                let Some(frame) = open_frame(&me.keys, !me.is_host, m.n, &m.ct) else { return };
                                let mut out = (frame.len() as u32).to_be_bytes().to_vec();
                                out.extend_from_slice(&frame);
                                if pump_out.write_all(&out).await.is_err() {
                                    return;
                                }
                                let _ = pump_out.flush().await;
                                expect += 1;
                                after = m.index;
                                if let Some(tx) = first.take() {
                                    let _ = tx.send(());
                                }
                            }
                        }
                        Err(RelayErr::Down) => {
                            down += 1;
                            if down > 10 {
                                return;
                            }
                        }
                        Err(_) => return,
                    }
                    tokio::time::sleep(me.poll_every).await;
                }
            })
        };
        (BiStream { send: Box::new(app_out), recv: Box::new(app_in) }, FarGuard { tasks: vec![sender, receiver] }, first_rx)
    }
}

/// The host's side of a live box: what `PairManager` keeps while a link with a Worker route is shown.
pub struct FarHost {
    pub relay: Arc<dyn PairRelay>,
    pub host: String,
    pub keys: LinkKeys,
    pub host_token: String,
    pub seed: [u8; SEED_LEN],
}

impl FarHost {
    pub fn creds(&self) -> Creds {
        Creds { pair: None, host: Some(self.host_token.clone()), claim: None }
    }

    pub async fn close(&self) {
        let _ = self.relay.delete(&self.host, &self.keys.rid_hex(), &self.host_token).await;
    }
}
