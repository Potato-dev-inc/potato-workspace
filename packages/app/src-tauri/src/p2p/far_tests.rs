//! Far-away pairing: the keys, the link, the sealed messages, the numbers and the node signature, plus `FakeWorker`
//! (an in-memory Worker with the same rules as `relay/worker/src/pair.ts`) that the screen-level tests in
//! `device_link/tests_far.rs` pair two PCs through.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::far::*;
use super::identity::verify_node;
use super::pairing::{make_link, parse_link};
use super::endpoint::NodeId;

// ----- the Worker, in memory -----

struct FakeBox {
    pair_hash: String,
    host_hash: String,
    claim_hash: Option<String>,
    msgs: Vec<(u64, char, u32, String)>,
}

/// A Worker with the rules of `pair.ts`: owner-only creation, the first claim wins, host and joiner tokens, one box
/// per rid, a full box refuses. Everything it stores is what a real Worker would see (hashes and sealed text).
pub(crate) struct FakeWorker {
    boxes: Mutex<HashMap<String, FakeBox>>,
    next: Mutex<u64>,
    /// When false, `create` answers like a Worker that has no `PAIR_OWNER` (404).
    pub(crate) feature: AtomicBool,
    /// When true, every call fails like an unreachable Worker.
    pub(crate) down: AtomicBool,
    /// Every sealed message that ever passed through (what an operator could read).
    pub(crate) seen: Mutex<Vec<String>>,
    pub(crate) host: String,
}

impl FakeWorker {
    pub(crate) fn new() -> Arc<Self> {
        Self::at("fake.workers.dev")
    }

    /// A Worker at its own host name (two PCs in one Cloudflare account each have one).
    pub(crate) fn at(host: &str) -> Arc<Self> {
        Arc::new(Self {
            boxes: Mutex::new(HashMap::new()),
            next: Mutex::new(0),
            feature: AtomicBool::new(true),
            down: AtomicBool::new(false),
            seen: Mutex::new(Vec::new()),
            host: host.into(),
        })
    }

    pub(crate) fn open_boxes(&self) -> usize {
        self.boxes.lock().unwrap().len()
    }

    fn check_up(&self) -> Result<(), RelayErr> {
        if self.down.load(Ordering::SeqCst) {
            Err(RelayErr::Down)
        } else {
            Ok(())
        }
    }
}

#[async_trait]
impl PairRelay for FakeWorker {
    fn my_host(&self) -> Option<String> {
        Some(self.host.clone())
    }

    async fn create(&self, _host: &str, rid: &str, pair_hash: &str, host_hash: &str, _ttl_ms: u64) -> Result<(), RelayErr> {
        self.check_up()?;
        if !self.feature.load(Ordering::SeqCst) {
            return Err(RelayErr::NoFeature);
        }
        let mut boxes = self.boxes.lock().unwrap();
        if boxes.contains_key(rid) {
            return Err(RelayErr::Refused(409));
        }
        boxes.insert(rid.into(), FakeBox { pair_hash: pair_hash.into(), host_hash: host_hash.into(), claim_hash: None, msgs: Vec::new() });
        Ok(())
    }

    async fn claim(&self, _host: &str, rid: &str, pair_token: &str) -> Result<String, RelayErr> {
        self.check_up()?;
        let mut boxes = self.boxes.lock().unwrap();
        let b = boxes.get_mut(rid).ok_or(RelayErr::Gone)?;
        if sha_hex(pair_token) != b.pair_hash {
            return Err(RelayErr::Gone);
        }
        if b.claim_hash.is_some() {
            return Err(RelayErr::Claimed);
        }
        let claim = new_token();
        b.claim_hash = Some(sha_hex(&claim));
        Ok(claim)
    }

    async fn post(&self, _host: &str, rid: &str, who: &Creds, dir: char, n: u32, ct: &str) -> Result<(), RelayErr> {
        self.check_up()?;
        let mut boxes = self.boxes.lock().unwrap();
        let b = boxes.get_mut(rid).ok_or(RelayErr::Gone)?;
        let ok = match dir {
            'h' => who.host.as_deref().map(|h| sha_hex(h) == b.host_hash).unwrap_or(false),
            'j' => {
                who.pair.as_deref().map(|p| sha_hex(p) == b.pair_hash).unwrap_or(false)
                    && who.claim.as_deref().map(|c| Some(sha_hex(c)) == b.claim_hash).unwrap_or(false)
            }
            _ => false,
        };
        if !ok {
            return Err(RelayErr::Gone);
        }
        if b.msgs.len() >= 40 {
            return Err(RelayErr::Full);
        }
        if b.msgs.iter().any(|m| m.1 == dir && m.2 == n) {
            return Err(RelayErr::Refused(409));
        }
        let mut next = self.next.lock().unwrap();
        *next += 1;
        b.msgs.push((*next, dir, n, ct.into()));
        self.seen.lock().unwrap().push(ct.into());
        Ok(())
    }

    async fn poll(&self, _host: &str, rid: &str, who: &Creds, for_dir: char, after: u64) -> Result<Vec<Delivered>, RelayErr> {
        self.check_up()?;
        let boxes = self.boxes.lock().unwrap();
        let b = boxes.get(rid).ok_or(RelayErr::Gone)?;
        let ok = match for_dir {
            'h' => who.host.as_deref().map(|h| sha_hex(h) == b.host_hash).unwrap_or(false),
            'j' => {
                who.pair.as_deref().map(|p| sha_hex(p) == b.pair_hash).unwrap_or(false)
                    && who.claim.as_deref().map(|c| Some(sha_hex(c)) == b.claim_hash).unwrap_or(false)
            }
            _ => false,
        };
        if !ok {
            return Err(RelayErr::Gone);
        }
        let from = if for_dir == 'h' { 'j' } else { 'h' };
        Ok(b.msgs.iter().filter(|m| m.1 == from && m.0 > after).map(|m| Delivered { index: m.0, n: m.2, ct: m.3.clone() }).collect())
    }

    async fn delete(&self, _host: &str, rid: &str, host_token: &str) -> Result<(), RelayErr> {
        self.check_up()?;
        let mut boxes = self.boxes.lock().unwrap();
        match boxes.get(rid) {
            Some(b) if sha_hex(host_token) == b.host_hash => {
                boxes.remove(rid);
                Ok(())
            }
            _ => Err(RelayErr::Gone),
        }
    }
}

// ----- keys and links -----

#[test]
fn every_key_comes_from_the_seed_with_its_own_label() {
    let a = LinkKeys::derive(&[1u8; SEED_LEN]);
    let b = LinkKeys::derive(&[1u8; SEED_LEN]);
    let c = LinkKeys::derive(&[2u8; SEED_LEN]);
    assert_eq!(a.rid, b.rid, "the same seed gives the same box on both PCs");
    assert_ne!(a.rid, c.rid);
    assert_eq!(a.rid_hex().len(), 64);
    let parts = [a.rid, a.pair_token];
    assert_ne!(parts[0], parts[1], "the box name is not the token that opens it");
    let sealed_a = seal_frame(&a, true, 0, b"x").unwrap();
    assert!(open_frame(&a, true, 0, &sealed_a).is_some());
    assert!(open_frame(&c, true, 0, &sealed_a).is_none(), "another seed cannot open it");
}

#[test]
fn the_proof_key_mixes_the_seed_the_code_and_the_host_in() {
    let host = [7u8; 32];
    let k = proof_key_v2("ABCD2345", &[1u8; SEED_LEN], &host);
    assert_eq!(k, proof_key_v2("ABCD2345", &[1u8; SEED_LEN], &host));
    assert_ne!(k, proof_key_v2("ABCD2346", &[1u8; SEED_LEN], &host), "another code");
    assert_ne!(k, proof_key_v2("ABCD2345", &[2u8; SEED_LEN], &host), "another seed: a code alone proves nothing");
    assert_ne!(k, proof_key_v2("ABCD2345", &[1u8; SEED_LEN], &[8u8; 32]), "another host");
}

fn node() -> NodeId {
    NodeId([9u8; 32])
}

#[test]
fn a_version_2_link_round_trips_and_an_old_one_still_parses() {
    let seed = [5u8; SEED_LEN];
    let v2 = make_link(&node(), "ABCD2345", &[], Some("https://relay.test"), Some(&seed), Some("me.workers.dev"));
    let parsed = parse_link(&v2).unwrap();
    assert_eq!(parsed.seed, Some(seed));
    assert_eq!(parsed.worker.as_deref(), Some("me.workers.dev"));
    assert_eq!(parsed.code, "ABCD2345");
    let v1 = make_link(&node(), "ABCD2345", &[], None, None, Some("me.workers.dev"));
    let old = parse_link(&v1).unwrap();
    assert_eq!((old.seed, old.worker), (None, None), "no seed, no Worker route: an old link is dialed as before");
}

fn link_with(body: serde_json::Value) -> String {
    use base64::Engine as _;
    format!("pm2:{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body.to_string()))
}

#[test]
fn a_link_with_a_broken_seed_or_a_hostile_worker_is_refused_whole() {
    let base = |extra: serde_json::Value| {
        let mut v = serde_json::json!({ "n": node().to_hex(), "c": "ABCD2345", "a": [], "r": null });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        link_with(v)
    };
    assert!(parse_link(&base(serde_json::json!({ "v": 2, "s": "00ff" }))).is_none(), "a short seed");
    assert!(parse_link(&base(serde_json::json!({ "v": 2 }))).is_none(), "version 2 needs a seed");
    assert!(parse_link(&base(serde_json::json!({ "v": 3, "s": "00".repeat(16) }))).is_none(), "an unknown version");
    let s = "ab".repeat(16);
    for bad in ["10.0.0.1", "localhost", "a", "x.local", "https://x.com", "u@x.com", "x.com/p", "x.com:99", "-a.com", "192.168.0.1", "x.internal", ""] {
        assert!(clean_worker_host(bad, false).is_none(), "{bad}");
    }
    assert_eq!(clean_worker_host("Me.Workers.Dev", false).as_deref(), Some("me.workers.dev"));
    assert_eq!(clean_worker_host("127.0.0.1:8787", true).as_deref(), Some("127.0.0.1:8787"));
    assert!(clean_worker_host("127.0.0.1:8787", false).is_none());
    assert!(parse_link(&base(serde_json::json!({ "v": 2, "s": s, "w": "https://x.com" }))).is_none(), "a scheme in the host is refused");
}

// ----- sealing -----

#[test]
fn a_sealed_message_opens_only_in_its_own_place() {
    let keys = LinkKeys::derive(&[3u8; SEED_LEN]);
    let ct = seal_frame(&keys, true, 4, b"{\"t\":\"hello\"}").unwrap();
    assert_eq!(open_frame(&keys, true, 4, &ct).unwrap(), b"{\"t\":\"hello\"}");
    assert!(open_frame(&keys, false, 4, &ct).is_none(), "not as the other direction");
    assert!(open_frame(&keys, true, 5, &ct).is_none(), "not as another number (a replay moved forward)");
    let other = LinkKeys::derive(&[4u8; SEED_LEN]);
    assert!(open_frame(&other, true, 4, &ct).is_none(), "not in another box");
    let mut bytes = ct.clone().into_bytes();
    let last = bytes.len() - 2;
    bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
    assert!(open_frame(&keys, true, 4, &String::from_utf8(bytes).unwrap()).is_none(), "a changed byte is caught");
}

#[test]
fn every_message_has_its_own_nonce_and_the_same_size() {
    let keys = LinkKeys::derive(&[3u8; SEED_LEN]);
    let a = seal_frame(&keys, true, 0, b"{\"t\":\"decision\"}").unwrap();
    let b = seal_frame(&keys, true, 0, b"{\"t\":\"decision\"}").unwrap();
    assert_ne!(a, b, "the same frame at the same number is sealed with a fresh nonce");
    let big = seal_frame(&keys, false, 1, &vec![b'x'; 900]).unwrap();
    assert_eq!(a.len(), big.len(), "a short answer and a long hello look alike on the Worker");
    let mut nonces = std::collections::HashSet::new();
    for n in 0..200u32 {
        let ct = seal_frame(&keys, true, n, b"x").unwrap();
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(ct).unwrap();
        assert!(nonces.insert(raw[..24].to_vec()), "a nonce repeated");
    }
}

// ----- the numbers and the signature -----

#[test]
fn both_screens_get_the_same_check_number_from_the_same_exchange() {
    let t = b"transcript";
    let one = check_number(t, b"sig-j", b"sig-h");
    assert_eq!(one, check_number(t, b"sig-j", b"sig-h"));
    assert_ne!(one, check_number(t, b"sig-j", b"sig-x"), "another host signature");
    assert_ne!(one, check_number(b"other", b"sig-j", b"sig-h"), "another exchange");
    assert!(one < 1_000_000);
}

#[test]
fn the_choices_hold_the_true_number_once_and_differ_between_screens() {
    let mut differ = false;
    for _ in 0..40 {
        let c = choices(123_456);
        assert_eq!(c.iter().filter(|n| **n == 123_456).count(), 1);
        assert!(c[0] != c[1] && c[1] != c[2] && c[0] != c[2]);
        differ |= c != choices(123_456);
    }
    assert!(differ, "the decoys are fresh each time");
    assert_eq!(fingerprint(&[1u8; 32]).len(), 9);
    assert_ne!(fingerprint(&[1u8; 32]), fingerprint(&[2u8; 32]));
}

#[test]
fn a_node_signature_binds_the_box_the_role_and_the_exchange() {
    use ed25519_dalek::Signer;
    let key = ed25519_dalek::SigningKey::from_bytes(&[11u8; 32]);
    let id = NodeId(key.verifying_key().to_bytes());
    let rid = [1u8; 32];
    let message = node_sig_message(&rid, b'j', b"transcript", b"meta");
    let sig = key.sign(&message).to_bytes();
    assert!(verify_node(&id, &message, &sig));
    assert!(!verify_node(&id, &node_sig_message(&[2u8; 32], b'j', b"transcript", b"meta"), &sig), "another box");
    assert!(!verify_node(&id, &node_sig_message(&rid, b'h', b"transcript", b"meta"), &sig), "the other role");
    assert!(!verify_node(&id, &node_sig_message(&rid, b'j', b"other", b"meta"), &sig), "another exchange");
    assert!(!verify_node(&id, &node_sig_message(&rid, b'j', b"transcript", b"renamed"), &sig), "a changed name or address");
    assert!(!verify_node(&NodeId([12u8; 32]), &message, &sig), "another node");
}

// ----- the Worker's rules, through the fake -----

#[tokio::test]
async fn the_first_claim_wins_and_the_link_alone_cannot_act_as_the_host() {
    let w = FakeWorker::new();
    let keys = LinkKeys::derive(&[6u8; SEED_LEN]);
    let host_token = new_token();
    w.create("h", &keys.rid_hex(), &sha_hex(&keys.pair_token_b64()), &sha_hex(&host_token), 1000).await.unwrap();
    let first = w.claim("h", &keys.rid_hex(), &keys.pair_token_b64()).await.unwrap();
    assert_eq!(w.claim("h", &keys.rid_hex(), &keys.pair_token_b64()).await, Err(RelayErr::Claimed));
    let thief = Creds { pair: Some(keys.pair_token_b64()), host: None, claim: None };
    assert!(w.post("h", &keys.rid_hex(), &thief, 'h', 0, "x").await.is_err(), "the link cannot write as the host");
    assert!(w.poll("h", &keys.rid_hex(), &thief, 'h', 0).await.is_err(), "nor read the host's inbox");
    assert!(w.delete("h", &keys.rid_hex(), &keys.pair_token_b64()).await.is_err(), "nor close the box");
    let joiner = Creds { pair: Some(keys.pair_token_b64()), host: None, claim: Some(first) };
    assert!(w.post("h", &keys.rid_hex(), &joiner, 'j', 0, "x").await.is_ok());
}
