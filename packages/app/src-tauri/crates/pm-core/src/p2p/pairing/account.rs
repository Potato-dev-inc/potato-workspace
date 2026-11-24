//! Pairing two PCs of one account: the "Open" button on a PC listed under My PCs.
//!
//! **The account only introduces the two PCs.** It says "a PC with this link id exists on your account"; it never sees
//! a code, a number or a key that unlocks anything, and nothing it says makes a PC trust anyone. What makes two PCs
//! trust each other is this exchange and the two people in front of it:
//!
//! 1. B dials A by the link id the account listed. The encrypted link proves which node answered.
//! 2. A turns the knock away early and cheaply: locked (that PC or overall), too many knocks from that node, no valid claim. B sends
//!    `hello` {binding} and a statement signed by its account key ("this node is mine"). A checks the signature BEFORE it takes the
//!    shared busy flag, then asks the account (`AccountIntro::who`) whether that device is on the account right now. If not, A
//!    answers "not yours" and **no sheet appears**. A PC without its tick never gets here: the door is closed.
//! 3. A `challenge` {binding}; B checks it is the node it dialed and the device key the account row names.
//! 4. Both sign this exact exchange with their NODE keys and verify the other's. The check number is made from both signatures and the
//!    transcript, so a different conversation on each side gives a different number.
//! 5. **The person at A TYPES the six digits that B shows** (1 chance in a million, not 1 in 3). A shows no number to pick from. B's
//!    person says "I typed it". Only after both said yes does each side add the other to its signed trust list, with every right off
//!    (A's sheet has no box: no right is ever turned on by this route).
//! 6. A wrong number or a No at A counts against the knocking PC and overall: two strikes lock that PC, and two lock everyone, for
//!    10 minutes, then 1 hour, then 24 hours, and the lock survives a restart. A sheet nobody answered counts nothing.
//!
//! A listed PC is therefore only a suggestion: somebody who got into the account can add a row and knock, but the digits are on the
//! other PC's screen and a person at A has to type them.

use super::*;
use std::collections::HashMap;

/// A PC of the person's own account, as the address book describes it (checked by the caller).
#[derive(Clone, Debug)]
pub struct AccountPc {
    /// The name from the PC's own signed statement.
    pub name: String,
    /// The account's id for that device.
    pub device_id: String,
    /// When the account first saw this PC (unix seconds; 0 when unknown): the sheet warns about a PC that joined only moments ago.
    pub first_seen: u64,
}

/// What a sheet knows of a PC of the person's own account.
#[derive(Clone, Debug)]
pub struct AccountMeta {
    pub first_seen: u64,
    pub device_id: String,
}

/// What a knocking PC says about itself: a statement "this node is mine" signed by its account key (`account::statement`). It is
/// never sent to the account; the PC knocked on checks it against the account's list.
#[derive(Clone, Debug)]
pub struct AccountClaim {
    pub statement: String,
    pub signature: String,
}

/// What the pairing manager asks the person's account. The answer is a suggestion about who is knocking, never trust.
pub trait AccountIntro: Send + Sync {
    /// Whether the claim is well formed, names `node` and is signed by the key it names. Local only, cheap, no network: it is asked
    /// before the shared busy flag is taken.
    fn claim_ok(&self, node: &NodeId, claim: &AccountClaim) -> bool;
    /// Whether `node`, with this claim, is a device that is signed in on this person's account right now. Blocking.
    fn who(&self, node: &NodeId, claim: &AccountClaim) -> Option<AccountPc>;
}

/// What the PC pressing Open knows of the PC it opens, from the address book row (checked by the caller).
#[derive(Clone, Debug)]
pub struct AccountExpect {
    /// "This node is mine", signed by this PC's account key. Sent to the PC being opened, so it can tell this PC is on the account.
    pub claim: AccountClaim,
    pub name: String,
    pub device_id: String,
    pub first_seen: u64,
    /// The device key the row's node record names; the PC that answers must present exactly this one.
    pub device_pub: [u8; 32],
}

/// Where the account route's lockouts are kept so a restart does not clear them (the app passes a file; tests memory).
pub trait AccountLockStore: Send + Sync {
    fn load(&self) -> Option<String>;
    fn save(&self, text: &str);
}

/// Strikes that lock one PC / everybody, and how long. Each lock raises the next one: 10 minutes, 1 hour, 24 hours.
pub const STRIKES_TO_LOCK: u32 = 2;
pub const LOCK_LEVELS_MS: [u64; 3] = [10 * 60_000, 60 * 60_000, 24 * 60 * 60_000];
/// Knocks from one node before it is let through the cheap checks: this many per window.
const KNOCKS_PER_WINDOW: usize = 6;
const KNOCK_WINDOW_MS: u64 = 10 * 60_000;
/// Before the claim is checked a knock gets this long to say its piece (a stranger cannot hold a stream open for 20 seconds).
const PRE_AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const KNOCK_MAP_MAX: usize = 256;
/// Sheets one account device may put on this PC's screen per window, and how many of them may go unanswered before that device is paused.
const SHEETS_PER_WINDOW: usize = 4;
const UNANSWERED_TO_LOCK: usize = 3;
const DEVICE_MAP_MAX: usize = 512;
/// Across ALL devices: a thief who adds devices to the account gets no fresh limits. At most this many sheets on this PC's screen per
/// window, and this many unanswered (or abandoned) ones pause the whole account route, with the same escalation.
const OVERALL_SHEETS_PER_WINDOW: usize = 6;
const OVERALL_UNANSWERED_TO_LOCK: usize = 5;

#[derive(Default, Clone, Copy)]
struct Gate {
    strikes: u32,
    level: u32,
    until: u64,
}

impl Gate {
    fn locked(&self, now: u64) -> Option<u64> {
        (self.until > now).then_some(self.until)
    }

    /// One strike; returns whether this one tripped the lock.
    fn strike(&mut self, now: u64) -> bool {
        self.strikes += 1;
        if self.strikes < STRIKES_TO_LOCK {
            return false;
        }
        self.strikes = 0;
        self.until = now + LOCK_LEVELS_MS[(self.level as usize).min(LOCK_LEVELS_MS.len() - 1)];
        self.level += 1;
        true
    }

    /// Locks at once (the next level up), whatever the strikes.
    fn trip(&mut self, now: u64) {
        self.strikes = STRIKES_TO_LOCK;
        self.strike(now);
    }

    fn json(&self) -> Value {
        json!({ "s": self.strikes, "l": self.level, "u": self.until })
    }

    /// What was kept. A lock can never reach further than the longest one from now (a clock set far ahead cannot lock for years).
    fn from_json(v: &Value, now: u64) -> Self {
        let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
        let longest = now.saturating_add(LOCK_LEVELS_MS[LOCK_LEVELS_MS.len() - 1]);
        Self { strikes: (n("s") as u32).min(STRIKES_TO_LOCK), level: (n("l") as u32).min(8), until: n("u").min(longest) }
    }
}

/// Drops the entries whose newest time is oldest until the map is under `cap` (an attacker cannot reset the limits by filling the map).
fn evict_oldest<K: Clone + Eq + std::hash::Hash>(map: &mut HashMap<K, Vec<u64>>, cap: usize) {
    while map.len() >= cap {
        let Some(oldest) = map.iter().min_by_key(|(_, t)| t.last().copied().unwrap_or(0)).map(|(k, _)| k.clone()) else { return };
        map.remove(&oldest);
    }
}

/// The account route's lockouts: one gate for everybody, one per ACCOUNT DEVICE (by its id, not by link id: one device key can sign for
/// any number of nodes), the sheets each device put on the screen, how many went unanswered, and a short memory of knocks per node.
#[derive(Default)]
pub(super) struct Locks {
    overall: Gate,
    devices: HashMap<String, Gate>,
    sheets: HashMap<String, Vec<u64>>,
    unanswered: HashMap<String, Vec<u64>>,
    /// Sheets shown / unanswered, whatever device they came from (kept on disk with the locks).
    overall_sheets: Vec<u64>,
    overall_unanswered: Vec<u64>,
    knocks: HashMap<NodeId, Vec<u64>>,
    store: Option<Arc<dyn AccountLockStore>>,
}

impl Locks {
    fn text(&self) -> String {
        let devices: serde_json::Map<String, Value> = self.devices.iter().filter(|(_, g)| g.level > 0 || g.strikes > 0).map(|(n, g)| (n.clone(), g.json())).collect();
        json!({ "overall": self.overall.json(), "devices": devices, "os": self.overall_sheets, "ou": self.overall_unanswered }).to_string()
    }

    fn persist(&self) {
        if let Some(store) = &self.store {
            store.save(&self.text());
        }
    }

    /// Reads what was kept. A file that cannot be read is not "no lock": it could have been damaged on purpose, so the route stays locked
    /// for everybody for 10 minutes (fail safe).
    fn load(&mut self, text: &str, now: u64) {
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            self.overall = Gate { until: now + LOCK_LEVELS_MS[0], ..Gate::default() };
            return;
        };
        self.overall = v.get("overall").map(|g| Gate::from_json(g, now)).unwrap_or_default();
        // The counters of the window: only times that are in the window and not in the future (a damaged file cannot fill them for good).
        let times = |k: &str| -> Vec<u64> {
            let mut t: Vec<u64> = v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).filter(|t| *t <= now && now - *t < KNOCK_WINDOW_MS).collect()).unwrap_or_default();
            t.truncate(64);
            t
        };
        self.overall_sheets = times("os");
        self.overall_unanswered = times("ou");
        self.devices.clear();
        if let Some(map) = v.get("devices").and_then(Value::as_object) {
            for (id, g) in map.iter().take(DEVICE_MAP_MAX).filter(|(id, _)| id.len() <= 64) {
                self.devices.insert(id.clone(), Gate::from_json(g, now));
            }
        }
    }

    /// Whether a sheet from `device_id` may be shown now. `Err(when)`: this device, or the account route as a whole, has put too many on
    /// the screen lately; `when` is when the oldest of the sheets that count leaves the window (unix ms). Spends nothing.
    fn sheet_room(&mut self, device_id: &str, now: u64) -> Result<(), u64> {
        self.overall_sheets.retain(|t| now.saturating_sub(*t) < KNOCK_WINDOW_MS);
        let free_at = |times: &[u64]| times.iter().min().map_or(now, |t| t + KNOCK_WINDOW_MS);
        if self.overall_sheets.len() >= OVERALL_SHEETS_PER_WINDOW {
            return Err(free_at(&self.overall_sheets));
        }
        if let Some(times) = self.sheets.get_mut(device_id) {
            times.retain(|t| now.saturating_sub(*t) < KNOCK_WINDOW_MS);
            if times.len() >= SHEETS_PER_WINDOW {
                return Err(free_at(times));
            }
        }
        Ok(())
    }

    /// A sheet from `device_id` is shown: one slot of its window and of the whole route's window is used.
    fn spend_sheet(&mut self, device_id: &str, now: u64) {
        if !self.sheets.contains_key(device_id) {
            evict_oldest(&mut self.sheets, DEVICE_MAP_MAX);
        }
        self.sheets.entry(device_id.to_string()).or_default().push(now);
        self.overall_sheets.push(now);
        self.persist();
    }

    /// A sheet nobody answered, or that the knocking PC walked away from. Counts against the device AND the whole route.
    fn sheet_unanswered(&mut self, device_id: &str, now: u64) {
        if !self.unanswered.contains_key(device_id) {
            evict_oldest(&mut self.unanswered, DEVICE_MAP_MAX);
        }
        let times = self.unanswered.entry(device_id.to_string()).or_default();
        times.retain(|t| now.saturating_sub(*t) < KNOCK_WINDOW_MS);
        times.push(now);
        let device_trips = times.len() >= UNANSWERED_TO_LOCK;
        if device_trips {
            times.clear();
            self.gate_for(device_id).trip(now);
        }
        self.overall_unanswered.retain(|t| now.saturating_sub(*t) < KNOCK_WINDOW_MS);
        self.overall_unanswered.push(now);
        if self.overall_unanswered.len() >= OVERALL_UNANSWERED_TO_LOCK {
            self.overall_unanswered.clear();
            self.overall.trip(now);
        }
        self.persist();
    }

    fn gate_for(&mut self, device_id: &str) -> &mut Gate {
        if !self.devices.contains_key(device_id) && self.devices.len() >= DEVICE_MAP_MAX {
            // Make room by dropping the entry that matters least: not locked, lowest level.
            if let Some(k) = self.devices.iter().min_by_key(|(_, g)| (g.until, g.level)).map(|(k, _)| k.clone()) {
                self.devices.remove(&k);
            }
        }
        self.devices.entry(device_id.to_string()).or_default()
    }
}

pub(super) struct AccountHandler(pub(super) Arc<PairManager>);

#[async_trait]
impl CapabilityHandler for AccountHandler {
    async fn serve(&self, peer: NodeId, link: Arc<dyn Link>) {
        let _ = self.0.clone().serve_account_host(peer, &link).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        link.close(0, "done");
    }
}

/// A knock is turned away with a reason, and its remaining words (it has already started to send them) are let in before the stream
/// closes, so the other PC reads the reason instead of a dropped link. It waits only a moment.
async fn turn_away(stream: &mut BiStream, why: &str) -> Result<(), PairError> {
    send_frame(stream, &json!({ "t": "refused", "why": why })).await?;
    let _ = recv_frame(stream, Duration::from_millis(300)).await;
    Ok(())
}

/// The lock (or the sheet cap) as a refusal of its own: "locked" and until when (unix ms), so the other PC can say when to try again.
async fn turn_away_locked(stream: &mut BiStream, until: u64) -> Result<(), PairError> {
    send_frame(stream, &json!({ "t": "refused", "why": "locked", "until": until })).await?;
    let _ = recv_frame(stream, Duration::from_millis(300)).await;
    Ok(())
}

/// What both ends sign into this conversation: only these two nodes and this protocol.
fn account_rid(host: &NodeId, joiner: &NodeId) -> [u8; 32] {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(b"pm/pair/acct/rid/v1");
    h.update(host.0);
    h.update(joiner.0);
    h.finalize().into()
}

/// The key of the two yes/no answers: made from this conversation only (both signatures), nothing the account holds.
fn account_key(transcript: &[u8], sig_joiner: &[u8], sig_host: &[u8]) -> [u8; 32] {
    mac(&[0u8; 32], &[b"pm/pair/acct/key/v1", transcript, sig_joiner, sig_host])
}

impl PairManager {
    pub fn set_account_intro(&self, intro: Arc<dyn AccountIntro>) {
        *self.account_intro.lock().unwrap_or_else(|p| p.into_inner()) = Some(intro);
    }

    /// Where the lockouts are kept. What was kept is read at once: a restart does not clear a lock.
    pub fn set_account_lock_store(&self, store: Arc<dyn AccountLockStore>) {
        let saved = store.load();
        let now = self.clock.now_ms();
        self.with(|s| {
            if let Some(text) = saved {
                s.account_locks.load(&text, now);
            }
            s.account_locks.store = Some(store);
        });
    }

    /// Called with the node of a PC that was just paired through the account and the account's id for that device. No right comes with
    /// it: the pairing has every right off, and the sheet offers no way to ask for one.
    pub fn set_on_account_paired(&self, hook: Arc<dyn Fn(NodeId, String) + Send + Sync>) {
        *self.on_account_paired.lock().unwrap_or_else(|p| p.into_inner()) = Some(hook);
    }

    fn account_intro(&self) -> Option<Arc<dyn AccountIntro>> {
        self.account_intro.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Until when the account route is locked for everybody.
    pub fn account_locked_until(&self) -> Option<u64> {
        let now = self.clock.now_ms();
        self.with(|s| s.account_locks.overall.locked(now))
    }

    /// Until when this account device may not knock (it, or everybody, is locked).
    pub fn account_locked_for(&self, device_id: &str) -> Option<u64> {
        let now = self.clock.now_ms();
        self.with(|s| {
            let overall = s.account_locks.overall.locked(now);
            let one = s.account_locks.devices.get(device_id).and_then(|g| g.locked(now));
            overall.max(one)
        })
    }

    /// A wrong number or a No at the PC being opened: counted against the knocking PC and overall. Two lock it (10 minutes, then 1 hour,
    /// then 24 hours), and the lock is kept on disk.
    pub(super) fn strike_account(&self, device_id: &str) {
        let now = self.clock.now_ms();
        self.with(|s| {
            let locks = &mut s.account_locks;
            locks.gate_for(device_id).strike(now);
            locks.overall.strike(now);
            locks.persist();
        });
        self.changed();
    }

    /// A sheet that went unanswered (the person did not type anything before it ran out). Three within the window pause that device, with
    /// the same escalation, so a device cannot wear the person down with sheets they ignore.
    pub(super) fn account_unanswered(&self, device_id: &str) {
        let now = self.clock.now_ms();
        self.with(|s| s.account_locks.sheet_unanswered(device_id, now));
        self.changed();
    }

    /// One sheet slot for this device: `Err(when)` (unix ms) when it, or the route as a whole, has put too many on the screen lately
    /// (the oldest of them leaves the window at that time); otherwise the slot is used.
    fn take_sheet(&self, device_id: &str) -> Result<(), u64> {
        let now = self.clock.now_ms();
        self.with(|s| {
            let locks = &mut s.account_locks;
            locks.sheet_room(device_id, now)?;
            locks.spend_sheet(device_id, now);
            Ok(())
        })
    }

    /// A pairing worked: that PC's record is cleared (and the overall strikes), so a person who slipped once is not held back for good.
    pub(super) fn account_success(&self, device_id: &str) {
        self.with(|s| {
            let locks = &mut s.account_locks;
            locks.devices.remove(device_id);
            locks.unanswered.remove(device_id);
            locks.overall.strikes = 0;
            locks.persist();
        });
    }

    /// Counts a knock from `node`; false when it knocked too often lately. Bounded memory.
    fn note_knock(&self, node: &NodeId) -> bool {
        let now = self.clock.now_ms();
        self.with(|s| {
            let knocks = &mut s.account_locks.knocks;
            if !knocks.contains_key(node) {
                // Old entries go first; a flood of new nodes cannot reset the limit of the others.
                knocks.retain(|_, t| t.last().is_some_and(|l| now.saturating_sub(*l) < KNOCK_WINDOW_MS));
                evict_oldest(knocks, KNOCK_MAP_MAX);
            }
            let times = knocks.entry(*node).or_default();
            times.retain(|t| now.saturating_sub(*t) < KNOCK_WINDOW_MS);
            if times.len() >= KNOCKS_PER_WINDOW {
                return false;
            }
            times.push(now);
            true
        })
    }

    /// The PC being opened. `peer` is the node the encrypted link proved.
    async fn serve_account_host(self: Arc<Self>, peer: NodeId, link: &Arc<dyn Link>) -> Result<(), PairError> {
        let mut stream = link.accept_bi().await.map_err(|_| PairError::Dropped)?;
        // Cheap turn-aways first: too many knocks, nobody to ask. (A lock is told only to a PC that the account vouches for, below: an
        // unknown dialer learns nothing about when the route opens again.)
        if !self.note_knock(&peer) {
            return turn_away(&mut stream, "busy").await;
        }
        let Some(intro) = self.account_intro() else {
            return turn_away(&mut stream, "not_yours").await;
        };

        // The knock says its piece within a few seconds, and its statement is checked BEFORE the shared busy flag is taken.
        let first = recv_frame(&mut stream, PRE_AUTH_TIMEOUT).await?;
        let Some(mut joiner) = parse_hello(&first, "hello") else {
            return turn_away(&mut stream, "binding").await;
        };
        if !joiner.binding.verify() || joiner.binding.node_id != peer {
            return turn_away(&mut stream, "binding").await;
        }
        let second = recv_frame(&mut stream, PRE_AUTH_TIMEOUT).await?;
        let claim = match (second.get("t").and_then(Value::as_str), second.get("statement").and_then(Value::as_str), second.get("sig").and_then(Value::as_str)) {
            (Some("intro"), Some(statement), Some(sig)) if statement.len() <= 2048 && sig.len() <= 128 => AccountClaim { statement: statement.to_string(), signature: sig.to_string() },
            _ => return turn_away(&mut stream, "not_yours").await,
        };
        if !intro.claim_ok(&peer, &claim) {
            return turn_away(&mut stream, "not_yours").await;
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
            return turn_away(&mut stream, "busy").await;
        }
        let _busy = BusyGuard(self.clone());

        // Is it one of my account's PCs? Asked before anything is shown: a stranger gets no sheet and no time of the person.
        let node = joiner.binding.node_id;
        let found = tokio::task::spawn_blocking(move || intro.who(&node, &claim)).await.ok().flatten();
        let Some(pc) = found else {
            return turn_away(&mut stream, "not_yours").await;
        };
        // From here the knocker is an account DEVICE, whatever node it signed for: its lock and its sheet limit are kept by device id.
        if let Some(until) = self.account_locked_for(&pc.device_id) {
            return turn_away_locked(&mut stream, until).await;
        }
        // The slot is spent NOW, when the challenge goes out, whatever happens next: a knocker that answers with a bad signature, or never
        // answers, is holding the busy flag for up to 20 seconds, and that costs it a slot (a device key can sign for any number of nodes,
        // so the per-node limit alone does not stop it).
        if let Err(free_at) = self.take_sheet(&pc.device_id) {
            return turn_away_locked(&mut stream, free_at).await;
        }
        let identity = self.identity()?;
        let mut nonce = [0u8; 16];
        rand::thread_rng().fill(&mut nonce);
        let me = Hello { nonce, binding: identity.binding(), name: self.name.clone(), addrs: self.p2p.local_addrs(), relay: self.p2p.home_relay() };
        send_frame(&mut stream, &hello_json("challenge", &me)).await?;
        let transcript = transcript(&joiner, &me);

        // Each side signs this exact exchange with its node key; the other's signature is checked before anything is shown.
        let rid = account_rid(&identity.id(), &joiner.binding.node_id);
        let frame = recv_frame(&mut stream, STEP_TIMEOUT).await?;
        let theirs = frame.get("sig").and_then(Value::as_str).and_then(unhex::<64>);
        let message = far::node_sig_message(&rid, b'j', &transcript, &meta_of(&joiner));
        let proven = frame.get("t").and_then(Value::as_str) == Some("nsig") && theirs.map(|g| verify_node(&joiner.binding.node_id, &message, &g)).unwrap_or(false);
        let Some(theirs) = theirs.filter(|_| proven) else {
            let _ = turn_away(&mut stream, "binding").await;
            return Err(PairError::BadIdentity);
        };
        let mine = identity.sign_node(&far::node_sig_message(&rid, b'h', &transcript, &meta_of(&me)));
        send_frame(&mut stream, &self.nsig_frame(mine)).await?;

        // The person here types the six digits the other PC shows. The name on the sheet is the one the account shows for that PC.
        joiner.name = clean_name(&pc.name);
        let key = account_key(&transcript, &theirs, &mine);
        let shown = Shown::check_as(&transcript, &theirs, &mine, &joiner.binding.device_pub, CheckKind::Type);
        let meta = AccountMeta { first_seen: pc.first_seen, device_id: pc.device_id };
        // If the knocking PC walks away while the sheet is still waiting for its person, that counts as an unanswered sheet (against the
        // device and the whole route) and the sheet goes. A sheet already answered is let finish.
        let device = meta.device_id.clone();
        let confirm = self.confirm_and_finish_as(Role::Host, &mut stream, &key, &transcript, &joiner, shown, Some(meta));
        tokio::pin!(confirm);
        let outcome = tokio::select! {
            o = &mut confirm => o,
            _ = link.closed() => {
                if self.with(|s| s.pending.as_ref().is_some_and(|p| p.tx.is_some())) {
                    self.account_unanswered(&device);
                    Err(PairError::Dropped)
                } else {
                    confirm.await
                }
            }
        };
        if let Err(e) = &outcome {
            self.say(&e.to_string());
        }
        outcome
    }

    /// Opens a PC of the person's own account that is not paired yet: dials it by the link id the address book listed, shows the six
    /// digits, and waits for the person at the other PC to type them. Returns the PC's name once both said yes.
    pub async fn join_account(self: &Arc<Self>, peer: PeerAddr, expect: AccountExpect) -> Result<String, PairError> {
        if !self.p2p.labs_for(capability::PAIR_ACCOUNT) {
            return Err(PairError::Off);
        }
        if self.account_locked_for(&expect.device_id).is_some() {
            return Err(PairError::AccountLocked(self.account_locked_for(&expect.device_id)));
        }
        let claimed = self.with(|s| {
            if s.busy {
                false
            } else {
                s.busy = true;
                s.joining = Some(format!("Looking for {}… Keep Potato Workspace open on both PCs.", expect.name));
                s.message = None;
                true
            }
        });
        if !claimed {
            return Err(PairError::Busy);
        }
        let _busy = BusyGuard(self.clone());
        self.changed();
        let result = self.run_join_account(&peer, &expect).await;
        self.with(|s| s.joining = None);
        match &result {
            Ok(name) => self.say(&format!("Paired with {name}. Nothing is shared yet unless you chose it on the other PC.")),
            Err(e) => self.say(&e.to_string()),
        }
        result
    }

    async fn run_join_account(self: &Arc<Self>, peer: &PeerAddr, expect: &AccountExpect) -> Result<String, PairError> {
        let link = self.p2p.dial(peer, capability::PAIR_ACCOUNT).await.map_err(|e| match e {
            P2pError::Off => PairError::Off,
            _ => PairError::NotReachable,
        })?;
        let result = self.account_join_stream(&link, peer, expect).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        link.close(0, "done");
        result
    }

    async fn account_join_stream(self: &Arc<Self>, link: &Arc<dyn Link>, peer: &PeerAddr, expect: &AccountExpect) -> Result<String, PairError> {
        if link.peer() != peer.id {
            return Err(PairError::BadIdentity);
        }
        let mut stream = link.open_bi().await.map_err(|_| PairError::NotReachable)?;
        let identity = self.identity()?;
        let mut nonce = [0u8; 16];
        rand::thread_rng().fill(&mut nonce);
        let me = Hello { nonce, binding: identity.binding(), name: self.name.clone(), addrs: self.p2p.local_addrs(), relay: self.p2p.home_relay() };
        // A PC that turns this knock away may close before these words are sent: the reason it gave is still read below.
        let _ = send_frame(&mut stream, &hello_json("hello", &me)).await;
        let _ = send_frame(&mut stream, &json!({ "t": "intro", "statement": expect.claim.statement, "sig": expect.claim.signature })).await;

        let reply = recv_frame(&mut stream, STEP_TIMEOUT).await?;
        if reply.get("t").and_then(Value::as_str) == Some("refused") {
            return Err(self.account_refusal(&reply));
        }
        let mut host = parse_hello(&reply, "challenge").ok_or(PairError::BadIdentity)?;
        // It must be the node that was dialed, and the device key the address book row names: a row cannot be bent to point at
        // somebody else's key.
        if !host.binding.verify() || host.binding.node_id != peer.id || host.binding.device_pub != expect.device_pub {
            return Err(PairError::BadIdentity);
        }
        let transcript = transcript(&me, &host);
        let rid = account_rid(&peer.id, &identity.id());
        let mine = identity.sign_node(&far::node_sig_message(&rid, b'j', &transcript, &meta_of(&me)));
        send_frame(&mut stream, &self.nsig_frame(mine)).await?;
        let frame = recv_frame(&mut stream, STEP_TIMEOUT).await?;
        if frame.get("t").and_then(Value::as_str) == Some("refused") {
            return Err(self.account_refusal(&frame));
        }
        let theirs = frame.get("sig").and_then(Value::as_str).and_then(unhex::<64>);
        let message = far::node_sig_message(&rid, b'h', &transcript, &meta_of(&host));
        let proven = frame.get("t").and_then(Value::as_str) == Some("nsig") && theirs.map(|g| verify_node(&peer.id, &message, &g)).unwrap_or(false);
        let Some(theirs) = theirs.filter(|_| proven) else {
            return Err(PairError::BadIdentity);
        };
        self.with(|s| s.joining = Some(format!("Waiting for {} to confirm…", expect.name)));
        self.changed();
        host.name = clean_name(&expect.name);
        let key = account_key(&transcript, &mine, &theirs);
        let shown = Shown::check_as(&transcript, &mine, &theirs, &host.binding.device_pub, CheckKind::Show);
        let meta = AccountMeta { first_seen: expect.first_seen, device_id: expect.device_id.clone() };
        self.confirm_and_finish_as(Role::Joiner, &mut stream, &key, &transcript, &host, shown, Some(meta)).await?;
        Ok(host.name)
    }

    fn account_refusal(&self, frame: &Value) -> PairError {
        match frame.get("why").and_then(Value::as_str) {
            Some("not_yours") => PairError::NotYours,
            Some("locked") => PairError::AccountLocked(frame.get("until").and_then(Value::as_u64)),
            Some("busy") | Some("expired") => PairError::Refused,
            _ => PairError::BadIdentity,
        }
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    #[test]
    fn a_gate_locks_on_the_second_strike_for_longer_each_time_and_stays_at_a_day() {
        let mut g = Gate::default();
        assert!(!g.strike(0));
        assert!(g.locked(0).is_none());
        assert!(g.strike(0));
        assert_eq!(g.locked(1), Some(10 * 60_000));
        // The next lock (after the first ran out) is an hour, then a day, then a day again.
        let mut now = 10 * 60_000 + 1;
        assert!(g.locked(now).is_none());
        g.strike(now);
        assert!(g.strike(now));
        assert_eq!(g.until, now + 60 * 60_000);
        now = g.until + 1;
        g.strike(now);
        g.strike(now);
        assert_eq!(g.until, now + 24 * 60 * 60_000);
        now = g.until + 1;
        g.strike(now);
        g.strike(now);
        assert_eq!(g.until, now + 24 * 60 * 60_000);
    }

    #[test]
    fn the_locks_survive_being_written_and_read_back_per_pc_and_overall() {
        let mut locks = Locks::default();
        let (a, b) = ("device-a", "device-b");
        locks.gate_for(a).strike(0);
        locks.gate_for(a).strike(0);
        locks.overall.strike(0);
        locks.gate_for(b).strike(0);
        let text = locks.text();
        let mut back = Locks::default();
        back.load(&text, 0);
        assert_eq!(back.devices.get(a).and_then(|g| g.locked(1)), Some(10 * 60_000));
        assert!(back.devices.get(b).is_some_and(|g| g.strikes == 1 && g.locked(1).is_none()));
        assert_eq!(back.overall.strikes, 1);
    }

    #[test]
    fn a_file_that_cannot_be_read_locks_everybody_for_ten_minutes_and_no_lock_reaches_past_a_day() {
        // Damaged (or damaged on purpose): fail safe, not "no lock".
        let mut junk = Locks::default();
        junk.load("not json", 5);
        assert_eq!(junk.overall.locked(6), Some(5 + 10 * 60_000));
        assert!(junk.devices.is_empty());
        // A far-future time in the file (or a clock set ahead) cannot lock for years.
        let mut far = Locks::default();
        far.load("{\"overall\":{\"s\":0,\"l\":3,\"u\":99999999999999},\"devices\":{\"d\":{\"s\":0,\"l\":3,\"u\":99999999999999}}}", 1000);
        let day = 24 * 60 * 60_000;
        assert_eq!(far.overall.locked(2000), Some(1000 + day));
        assert_eq!(far.devices.get("d").and_then(|g| g.locked(2000)), Some(1000 + day));
    }

    #[test]
    fn sheets_from_any_device_share_one_cap_and_unanswered_ones_pause_the_whole_route_and_survive_a_restart() {
        let mut l = Locks::default();
        let now = 1_000_000;
        // Six sheets in the window, from six different devices: the seventh, from yet another, is refused.
        let show = |l: &mut Locks, d: &str, t: u64| {
            let room = l.sheet_room(d, t);
            if room.is_ok() {
                l.spend_sheet(d, t);
            }
            room
        };
        for i in 0..6 {
            assert!(show(&mut l, &format!("dev-{i}"), now + i).is_ok());
        }
        assert_eq!(show(&mut l, "dev-new", now + 7), Err(now + KNOCK_WINDOW_MS), "a fresh device gets no fresh allowance; the oldest sheet says when");
        assert!(show(&mut l, "dev-new", now + KNOCK_WINDOW_MS + 7).is_ok(), "the window moves on");
        // Looking spends nothing, however often it is done.
        let mut look = Locks::default();
        for _ in 0..20 {
            assert!(look.sheet_room("dev-x", now).is_ok());
        }
        assert!(look.overall_sheets.is_empty() && look.sheets.is_empty());
        // One device's own cap (4) says when ITS oldest sheet leaves.
        for i in 0..4 {
            look.spend_sheet("dev-x", now + i);
        }
        assert_eq!(look.sheet_room("dev-x", now + 10), Err(now + KNOCK_WINDOW_MS));
        // Five unanswered, each from a different device (none reaches its own limit): the whole route is paused, 10 minutes first.
        let mut u = Locks::default();
        for i in 0..4 {
            u.sheet_unanswered(&format!("dev-{i}"), now);
        }
        assert!(u.overall.locked(now + 1).is_none());
        // Written to disk and read back by a restart: the counters did not reset.
        let mut back = Locks::default();
        back.load(&u.text(), now + 5);
        assert_eq!(back.overall_unanswered.len(), 4);
        back.sheet_unanswered("dev-4", now + 6);
        assert_eq!(back.overall.locked(now + 7), Some(now + 6 + 10 * 60_000));
        // And the next pause is longer.
        let later = now + 6 + 10 * 60_000 + 1;
        for i in 0..5 {
            back.sheet_unanswered(&format!("x-{i}"), later);
        }
        assert_eq!(back.overall.until, later + 60 * 60_000);
    }

    #[test]
    fn filling_the_maps_drops_the_oldest_entries_and_never_resets_the_rest() {
        let mut map: HashMap<u32, Vec<u64>> = HashMap::new();
        for i in 0..10u32 {
            evict_oldest(&mut map, 5);
            map.insert(i, vec![u64::from(i)]);
        }
        assert_eq!(map.len(), 5);
        assert!((5..10).all(|i| map.contains_key(&i)), "the newest five stay: {:?}", map.keys());
    }
}
