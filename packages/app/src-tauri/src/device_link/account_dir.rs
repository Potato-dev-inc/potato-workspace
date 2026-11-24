//! My PCs from the account: the PCs that signed in with the same account list each other under Connect > My PCs, with one
//! "Open" button. This file is the seam between the account (`crate::account`, an address book) and the PC link
//! (`crate::p2p`, where trust is decided); neither side knows the other.
//!
//! - **Publish.** A PC with the tick "Let my other PCs open this PC" on tells the account its link id, its signed
//!   node record and the relay it can be reached through. A PC without the tick publishes nothing and lists as
//!   "Allow on that PC first". Signing out, or taking the tick off, withdraws it.
//! - **List.** The other PCs read the address book. A row is used only when the PC's own signed statement checks out
//!   (`account::directory`), and its node record is checked again here. A row says where to knock, never whom to trust.
//! - **Open.** First time: the two PCs talk to each other (`PairManager::join_account`), and both people pick the number
//!   that is on both screens. The account never sees it. After that the PCs are paired like any other pair, and Open
//!   just goes there.
//! - **The door.** `AccountIntro::who` answers the PC being opened: "is this node one of my account's PCs right now". It is
//!   asked only while the tick is on, at most once every few seconds, and a "no" shows nothing to the person.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::route::PrefsStore;
use crate::account::directory::{skeleton, Book, PcRow};
use crate::account::statement::verify_device_statement;
use crate::account::service::AccountService;
use crate::p2p::endpoint::NodeId;
use crate::p2p::identity::NodeBinding;
use crate::p2p::pairing::{AccountClaim, AccountIntro, AccountLockStore, AccountPc};

/// A PC added to the account less than this long ago is flagged on the sheet and in the list.
pub const RECENT_SECS: u64 = 24 * 3600;
/// The list is read again when it is older than this (the page asks every few seconds).
const LIST_FRESH_SECS: u64 = 5;
/// The door reads the book again for an unknown knock at most this often.
const DOOR_FRESH_SECS: u64 = 3;

/// The part of the account this module uses. The app passes the real service; tests pass one over a local server.
pub trait AccountPort: Send + Sync {
    /// My PCs (statements checked) and the devices signed out of the account. `Ok(None)`: not signed in.
    fn pcs(&self) -> Result<Option<Book>, String>;
    /// Whether this PC is signed in (no request).
    fn signed_in(&self) -> bool;
    fn publish(&self, node: &str, binding: &str, relay: Option<&str>) -> Result<(), String>;
    fn unpublish(&self) -> Result<(), String>;
    /// A statement signed by this device's account key naming `node` (for the PC this one knocks on). `Ok(None)`: not signed in.
    fn introduce(&self, node: &str) -> Result<Option<AccountClaim>, String>;
}

impl AccountPort for AccountService {
    fn pcs(&self) -> Result<Option<Book>, String> {
        AccountService::pcs(self)
    }
    fn signed_in(&self) -> bool {
        self.view().signed_in
    }
    fn publish(&self, node: &str, binding: &str, relay: Option<&str>) -> Result<(), String> {
        self.publish_pc(node, binding, relay)
    }
    fn unpublish(&self) -> Result<(), String> {
        self.unpublish_pc()
    }
    fn introduce(&self, node: &str) -> Result<Option<AccountClaim>, String> {
        Ok(self.introduction(node)?.map(|(statement, signature)| AccountClaim { statement, signature }))
    }
}

/// The app's own account.
pub struct ServicePort;

impl AccountPort for ServicePort {
    fn pcs(&self) -> Result<Option<Book>, String> {
        crate::account::service::service().pcs()
    }
    fn signed_in(&self) -> bool {
        crate::account::service::service().view().signed_in
    }
    fn publish(&self, node: &str, binding: &str, relay: Option<&str>) -> Result<(), String> {
        crate::account::service::service().publish_pc(node, binding, relay)
    }
    fn unpublish(&self) -> Result<(), String> {
        crate::account::service::service().unpublish_pc()
    }
    fn introduce(&self, node: &str) -> Result<Option<AccountClaim>, String> {
        Ok(crate::account::service::service().introduction(node)?.map(|(statement, signature)| AccountClaim { statement, signature }))
    }
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

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The node record as the text the account holds.
pub fn binding_text(b: &NodeBinding) -> String {
    json!({ "node": b.node_id.to_hex(), "device": hex(&b.device_pub), "issued": b.issued_at, "sig": hex(&b.signature) }).to_string()
}

/// The node record from the account's text. `None` unless it is well formed AND its signature holds (the device key it names
/// really made this node).
pub fn parse_binding(text: &str) -> Option<NodeBinding> {
    let v: Value = serde_json::from_str(text).ok()?;
    let b = NodeBinding {
        node_id: NodeId(unhex::<32>(v.get("node")?.as_str()?)?),
        device_pub: unhex::<32>(v.get("device")?.as_str()?)?,
        issued_at: v.get("issued")?.as_u64()?,
        signature: unhex::<64>(v.get("sig")?.as_str()?)?,
    };
    b.verify().then_some(b)
}

/// A row, once its node record also checked out: the node and the device key to expect.
pub fn usable(row: &PcRow) -> Option<(NodeId, NodeBinding)> {
    let node = row.node.as_deref().and_then(|h| unhex::<32>(h)).map(NodeId)?;
    let binding = parse_binding(row.binding.as_deref()?)?;
    // The node record must be about the node the statement names; a record for another node is somebody's copy.
    (binding.node_id == node).then_some((node, binding))
}

struct Cache {
    at: u64,
    book: Option<Book>,
}

/// Which of this PC's pairings came from the account: the account's id for the device -> the PC-link id it was paired as. Kept so a
/// device that is signed out of the account ("Not me", "Sign out") takes this PC's pairing with it.
pub struct Links(pub Arc<dyn PrefsStore>);

impl Links {
    pub fn all(&self) -> std::collections::BTreeMap<String, String> {
        self.0.load().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn set(&self, device_id: &str, node_hex: &str) {
        let mut all = self.all();
        all.insert(device_id.to_lowercase(), node_hex.to_string());
        let _ = self.0.save(&serde_json::to_string(&all).unwrap_or_default());
    }

    pub fn remove(&self, device_id: &str) -> Option<String> {
        let mut all = self.all();
        let node = all.remove(&device_id.to_lowercase());
        if node.is_some() {
            let _ = self.0.save(&serde_json::to_string(&all).unwrap_or_default());
        }
        node
    }
}

/// The lockouts of the account route, kept in a small file.
pub struct LockFile(pub Arc<dyn PrefsStore>);

impl AccountLockStore for LockFile {
    fn load(&self) -> Option<String> {
        self.0.load()
    }
    fn save(&self, text: &str) {
        let _ = self.0.save(text);
    }
}

pub struct AccountDir {
    port: Arc<dyn AccountPort>,
    /// The tick, and the Labs switch behind it: this PC lets its other PCs open it.
    open: AtomicBool,
    /// This PC told the account its link id since the tick went on.
    published: AtomicBool,
    cache: Mutex<Option<Cache>>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl AccountDir {
    pub fn new(port: Arc<dyn AccountPort>, now: Arc<dyn Fn() -> u64 + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { port, open: AtomicBool::new(false), published: AtomicBool::new(false), cache: Mutex::new(None), now })
    }

    pub fn port(&self) -> &Arc<dyn AccountPort> {
        &self.port
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Returns what it was.
    pub fn set_open(&self, on: bool) -> bool {
        self.open.swap(on, Ordering::SeqCst)
    }

    pub fn was_published(&self) -> bool {
        self.published.load(Ordering::SeqCst)
    }

    pub fn set_published(&self, on: bool) -> bool {
        self.published.swap(on, Ordering::SeqCst)
    }

    pub fn forget(&self) {
        *self.cache.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// The book, reused while it is at most `max_age` seconds old. Blocking (one signed request when it is read again).
    pub fn rows(&self, max_age: u64) -> Result<Option<Vec<PcRow>>, String> {
        let now = (self.now)();
        if let Some(c) = self.cache.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            if now.saturating_sub(c.at) <= max_age {
                return Ok(c.book.as_ref().map(|b| b.rows.clone()));
            }
        }
        let book = self.port.pcs()?;
        let rows = book.as_ref().map(|b| b.rows.clone());
        *self.cache.lock().unwrap_or_else(|p| p.into_inner()) = Some(Cache { at: now, book });
        Ok(rows)
    }

    /// The devices the account says were signed out, as of the last read.
    pub fn revoked(&self) -> Vec<String> {
        self.cache.lock().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|c| c.book.as_ref().map(|b| b.revoked.clone())).unwrap_or_default()
    }

    pub fn signed_in(&self) -> bool {
        self.port.signed_in()
    }

    pub fn list_rows(&self) -> Result<Option<Vec<PcRow>>, String> {
        self.rows(LIST_FRESH_SECS)
    }

    /// The list read fresh (a failed dial asks: the cached one may be what went stale).
    pub fn fresh_rows(&self) -> Result<Option<Vec<PcRow>>, String> {
        self.rows(0)
    }

    /// One row by the account's id for it, read fresh.
    pub fn fresh_row(&self, id: &str) -> Result<Option<PcRow>, String> {
        let rows = self.rows(0)?.unwrap_or_default();
        Ok(rows.into_iter().find(|r| !r.is_this && r.id == id))
    }
}

/// The door of the PC being opened.
pub struct Door(pub Arc<AccountDir>);

/// The knocking PC says: "this node is mine, a device that is signed in on this account", and proves it with a statement signed by
/// that device's account key. It needs to have published nothing: the tick is for being opened, not for opening. Returns the device's
/// id and key when the statement is well formed, names this node and verifies. Local only.
fn read_claim(node: &NodeId, claim: &AccountClaim) -> Option<(String, String)> {
    let st: Value = serde_json::from_str(&claim.statement).ok()?;
    let text = |k: &str| st.get(k).and_then(Value::as_str).map(str::to_string);
    let (device_id, device_pub) = (text("device_id")?.to_lowercase(), text("device_pub")?);
    if st.get("v").and_then(Value::as_u64) != Some(1) || text("kind").as_deref() != Some("pc") || text("node_id")? != node.to_hex() {
        return None;
    }
    verify_device_statement(&device_pub, &claim.statement, &claim.signature).then_some((device_id, device_pub))
}

impl AccountIntro for Door {
    fn claim_ok(&self, node: &NodeId, claim: &AccountClaim) -> bool {
        self.0.is_open() && read_claim(node, claim).is_some()
    }

    fn who(&self, node: &NodeId, claim: &AccountClaim) -> Option<AccountPc> {
        if !self.0.is_open() || !self.0.signed_in() {
            return None;
        }
        let (device_id, device_pub) = read_claim(node, claim)?;
        // And that device is on this account right now: a live row of the book (signed-out and stale ones are not in it). The
        // book is read again when it is more than a few seconds old, so a PC that was signed out stops being let in within
        // seconds, and a flood of knocks costs the account one request every few seconds.
        let rows = self.0.rows(DOOR_FRESH_SECS).ok().flatten()?;
        let row = rows.iter().find(|r| !r.is_this && r.id == device_id && r.account_pub == device_pub)?;
        // Not when its name cannot be told from another PC's of this account.
        if flagged_names(&rows).contains(&row.id) {
            return None;
        }
        Some(AccountPc { name: row.name.clone(), device_id: row.id.clone(), first_seen: row.created_at })
    }
}

/// The ids of the entries whose name is the same as, or looks like, another entry's of the account (this PC's own included): they
/// cannot be told apart by name, so none of them is offered.
pub fn flagged_names(rows: &[PcRow]) -> std::collections::HashSet<String> {
    let mut by: std::collections::HashMap<String, Vec<&str>> = std::collections::HashMap::new();
    for r in rows {
        by.entry(skeleton(&r.name)).or_default().push(r.id.as_str());
    }
    by.into_values().filter(|ids| ids.len() > 1).flatten().map(str::to_string).collect()
}

/// An entry that is listed but never offered: `conflict` (another entry names the same link id) or `lookalike` (another entry has a
/// name that looks the same).
pub fn flag_json(row: &PcRow, now: u64, status: &str) -> Value {
    json!({
        "id": row.id,
        "name": row.name,
        "status": status,
        "online": row.online,
        "last_seen_at": row.last_seen_at,
        "created_at": row.created_at,
        "recent": now.saturating_sub(row.created_at) < RECENT_SECS,
        "node": None::<String>,
    })
}

/// One line of the list for the page. `trusted`: this PC trusts that node already with that device key.
pub fn row_json(row: &PcRow, now: u64, paired: Option<&str>, reach: Option<&str>) -> Value {
    let ready = usable(row).is_some();
    let status = if !ready {
        "allow_there"
    } else {
        match (paired, reach) {
            (Some(_), Some("online")) => "online",
            (Some(_), Some("not_allowed")) => "not_allowed",
            (Some(_), _) => "away",
            (None, _) => "new",
        }
    };
    json!({
        "id": row.id,
        "name": row.name,
        "status": status,
        "online": row.online,
        "last_seen_at": row.last_seen_at,
        "created_at": row.created_at,
        "recent": now.saturating_sub(row.created_at) < RECENT_SECS,
        "node": if ready { row.node.clone() } else { None },
    })
}
