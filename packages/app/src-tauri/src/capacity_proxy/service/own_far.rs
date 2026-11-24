//! "Use my own agents" (P6.1): this PC lends its own sign-in to one of my OWN other PCs because the person clicked it here.
//!
//! The grant is made by `Lend::answer`, the same code as any lend. What is new is only who may start it:
//! - `far_offer` runs in this PC's own window (a Tauri command, never a bridge or far call). It checks there is a lend
//!   profile that can really be used for the agent and writes down ONE short-lived promise: this PC node, this agent,
//!   this profile, at most this long.
//! - The other PC asks (`ask_lender`) over the normal own-PC link, naming the promise. `answer_if_promised` says yes by itself
//!   only to a request that matches a promise (once, from that PC, no more time than promised). A request with no promise
//!   stays a card for the person here, exactly as before: nothing is ever minted because the far side asked.
//! - While a far chat lives the window renews the lend (`renew_far`, rolling 12 hours, an `Extend` item to the borrower),
//!   and the lend is taken back by itself when that PC stops being one of mine (`watch_peer`).

use super::*;

/// How long a lend of my own agent to another PC of mine rolls on at a time.
pub const ROLL_SECS: u64 = 12 * HOUR;
/// A promise is for the request that follows the click: a minute.
const PROMISE_MS: u64 = 60_000;
/// How long the other PC waits for the lend to come up (the grant and its local shim).
const ASK_WAIT: Duration = if cfg!(test) { Duration::from_secs(8) } else { Duration::from_secs(25) };
/// How often a lend to my own PC checks the PC is still one of mine.
const PEER_TICK: Duration = if cfg!(test) { Duration::from_millis(100) } else { Duration::from_secs(30) };
/// The start of the sentence the screen turns into "Sign in for lending first".
pub const NO_SIGNIN: &str = "LEND_NO_SIGNIN";

pub(in crate::capacity_proxy) struct Promise {
    offer_ref: String,
    node: String,
    agent_id: String,
    pub profile_id: String,
    secs: u64,
    until_ms: u64,
}

/// What the window needs to ask the other PC: the promise's name, and the lend already running for that PC and agent, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FarOffer {
    pub offer_ref: String,
    pub profile_id: String,
    pub profile_name: String,
    pub secs: u64,
    pub grant_id: Option<String>,
}

impl Lend {
    /// The click "Use my own <agent>" on another PC's New agent page. Writes down a promise, or names the lend that is already running.
    pub fn far_offer(&self, node_hex: &str, agent_id: &str) -> Result<FarOffer, String> {
        if !crate::own_lend::is_node_hex(node_hex) || !self.deps.own.peers().iter().any(|(n, _)| n == node_hex) {
            return Err("That PC is not one of yours.".into());
        }
        if !self.deps.own.same_account(node_hex) {
            return Err("Only a PC signed in to your account can use your sign-ins.".into());
        }
        let spec = self.spec(agent_id).ok_or_else(|| format!("{agent_id} can't be lent through this PC."))?.clone();
        let now = self.now();
        // One lend per PC and agent: a second chat on the same PC uses it.
        let running = {
            let inner = lock(&self.inner);
            inner
                .saved
                .grants
                .iter()
                .find(|g| g.view.direction == Direction::Out && g.view.state == GrantState::Active && g.view.peer_node == node_hex && g.view.agent_id.eq_ignore_ascii_case(agent_id) && g.view.ends_ms > now && inner.out.contains_key(&g.view.id))
                .map(|g| (g.view.id.clone(), g.view.profile_id.clone(), g.view.profile_name.clone(), g.view.ends_ms))
        };
        if let Some((grant_id, profile_id, profile_name, ends_ms)) = running {
            return Ok(FarOffer { offer_ref: String::new(), profile_id, profile_name, secs: ends_ms.saturating_sub(now) / 1000, grant_id: Some(grant_id) });
        }
        let profiles = lock(&self.inner).saved.profiles.clone();
        let profile = profiles
            .into_iter()
            .filter(|p| p.agent_ids.iter().any(|a| a.eq_ignore_ascii_case(agent_id)) && profile_allows(p, OWN_MEMBER, false))
            .find(|p| self.auth_for(p, &spec).is_ok())
            .ok_or_else(|| format!("{NO_SIGNIN}: Sign in for lending first, then try again."))?;
        let secs = ROLL_SECS.min(profile.max_secs);
        if secs < MIN_SECS {
            return Err("That lend profile is too short to use.".into());
        }
        let offer_ref = hex(&random_bytes::<16>());
        let mut promises = lock(&self.promises);
        promises.retain(|p| p.until_ms > now);
        promises.push(Promise { offer_ref: offer_ref.clone(), node: node_hex.to_string(), agent_id: agent_id.to_ascii_lowercase(), profile_id: profile.id.clone(), secs, until_ms: now + PROMISE_MS });
        Ok(FarOffer { offer_ref, profile_id: profile.id, profile_name: clean_profile_name(&profile.name), secs, grant_id: None })
    }

    /// A request from one of my PCs names `offer_ref`: the promise it matches is used up and returned. Anything else gets nothing.
    pub(in crate::capacity_proxy) fn claim_own_promise(&self, offer_ref: &str, from_device: &str, agent_id: &str, profile_id: Option<&str>, secs: u64) -> Option<Promise> {
        let node = own_node(from_device)?;
        let now = self.now();
        let mut promises = lock(&self.promises);
        promises.retain(|p| p.until_ms > now);
        let at = promises.iter().position(|p| p.offer_ref == offer_ref && p.node == node && p.agent_id == agent_id.to_ascii_lowercase() && profile_id.map_or(true, |id| id == p.profile_id) && secs <= p.secs)?;
        Some(promises.remove(at))
    }

    /// The promise was kept: make the grant the usual way (the same code as a yes on a card).
    pub(super) fn answer_promised_own(&self, request_id: &str, p: Promise, secs: u64) {
        let Some(me) = self.me.upgrade() else { return };
        let id = request_id.to_string();
        (self.deps.spawn)(Box::pin(async move {
            match me.answer(&id, true, Some(&p.profile_id), Some(secs)).await {
                Ok(Some(grant)) => {
                    me.audit_own_lend("lend.own.start", &grant);
                    me.watch_peer(&grant.id, &p.node);
                }
                Ok(None) => {}
                Err(why) => tracing::info!(why, "lend: the promised lend to my own PC could not start"),
            }
        }));
    }

    /// One audit line for starting or stopping a lend of my own sign-in to one of my PCs.
    pub(super) fn audit_own_lend(&self, event: &str, g: &Grant) {
        if g.peer_node.is_empty() {
            return;
        }
        let started = event.ends_with("start");
        crate::audit::record(
            crate::audit::Kind::Consent,
            crate::audit::Who::Desktop,
            &format!("{} my {} sign-in {} {}", if started { "Lent" } else { "Took back" }, g.agent_id, if started { "to" } else { "from" }, g.peer_device_name),
            serde_json::json!({ "event": event, "agent": g.agent_id, "grant": g.id, "pc": g.peer_device_name }),
        );
    }

    /// While the PC is one of mine the lend stands; when it leaves (the account dropped it) the lend is taken back.
    fn watch_peer(&self, grant_id: &str, node: &str) {
        let (me, id, node) = (self.me.clone(), grant_id.to_string(), node.to_string());
        (self.deps.spawn)(Box::pin(async move {
            loop {
                tokio::time::sleep(PEER_TICK).await;
                let Some(svc) = me.upgrade() else { return };
                if !lock(&svc.inner).out.contains_key(&id) {
                    return;
                }
                if !svc.deps.own.peers().iter().any(|(n, _)| *n == node) || !svc.deps.own.same_account(&node) {
                    let _ = svc.revoke(&id);
                    return;
                }
            }
        }));
    }

    /// A far chat on this lend is alive: roll the end 12 hours on from now and tell the other PC. Returns the new end.
    pub fn renew_far(&self, grant_id: &str) -> Result<u64, String> {
        let now = self.now();
        let (to, rec) = {
            let mut inner = lock(&self.inner);
            let live = inner.out.get(grant_id).ok_or("That lend is over.")?;
            let rec = inner.saved.grants.iter().find(|g| g.view.id == grant_id && g.view.direction == Direction::Out && g.view.state == GrantState::Active).cloned().ok_or("That lend is over.")?;
            if rec.view.peer_node.is_empty() {
                return Err("Only a lend to one of your own PCs rolls on.".into());
            }
            let ends = now + ROLL_SECS * 1000;
            live.gate.extend(tokio::time::Instant::now() + Duration::from_secs(ROLL_SECS));
            if let Some(g) = inner.saved.grants.iter_mut().find(|g| g.view.id == grant_id) {
                g.view.ends_ms = ends;
            }
            self.save(&inner);
            (ends, rec)
        };
        self.send_to(None, &rec.borrower_device, Body::Extend { grant_id: grant_id.into(), not_after_ms: to })?;
        self.changed();
        Ok(to)
    }

    /// The other PC (the borrower) asks the lender `lender_node` for the lend its click promised, and waits until the grant and
    /// this PC's shim are up. Returns the grant id the chat starts on (`lend:<id>`).
    pub fn ask_lender(&self, lender_node: &str, agent_id: &str, offer_ref: &str, profile_id: Option<&str>, secs: u64) -> Result<String, String> {
        let since = self.now();
        self.request_own_ref(lender_node, agent_id, secs, "Use my own agents", profile_id, None, Some(offer_ref))?;
        let lender = format!("{OWN_PREFIX}{lender_node}");
        let until = std::time::Instant::now() + ASK_WAIT;
        loop {
            {
                let inner = lock(&self.inner);
                let up = inner.saved.grants.iter().find(|g| {
                    g.view.direction == Direction::In
                        && g.view.state == GrantState::Active
                        && g.view.agent_id.eq_ignore_ascii_case(agent_id)
                        && g.lender_device == lender
                        && g.view.started_ms + 2_000 >= since
                        && inner.inn.contains_key(&g.view.id)
                });
                if let Some(g) = up {
                    return Ok(g.view.id.clone());
                }
            }
            if std::time::Instant::now() >= until {
                return Err("The PC with your sign-in did not lend it in time.".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Whether a lend item from the PC `node_hex` is one this PC is part of: the lender wrote a promise for that PC (its click), or this
    /// PC asked that PC and waits, or a lend between them runs. The device link's door lets such items through from a PC of my account
    /// even when "Borrow my agent sign-ins" was never switched on for it: the click on the lender is the consent. Nothing else is let in.
    #[cfg(test)]
    pub fn expecting_from(&self, node_hex: &str) -> bool {
        let now = self.now();
        let device = format!("{OWN_PREFIX}{node_hex}");
        if lock(&self.promises).iter().any(|p| p.node == node_hex && p.until_ms > now) {
            return true;
        }
        let inner = lock(&self.inner);
        let asked = inner.saved.requests.iter().any(|r| r.view.direction == Direction::Out && r.view.state == RequestState::Open && r.devices.contains(&device) && r.view.at_ms + 2 * PROMISE_MS > now);
        asked || inner.saved.grants.iter().any(|g| g.view.state == GrantState::Active && ((g.view.direction == Direction::In && g.lender_device == device) || (g.view.direction == Direction::Out && g.view.peer_node == node_hex)))
    }

    /// Whether `grant_id` is an active lend of `agent_id` that `lender_node` (a PC of mine) made to this PC. The far start asks it,
    /// so another PC cannot start a chat on a lend that was made for someone else.
    /// The newest active lend of `agent_id` that `lender_node` made to this PC: what a far start with no sign-in named falls back on when this PC's own login is signed out.
    pub fn grant_from(&self, agent_id: &str, lender_node: &str) -> Option<String> {
        let now = self.now();
        let who = format!("{OWN_PREFIX}{lender_node}");
        lock(&self.inner).saved.grants.iter().filter(|g| g.view.direction == Direction::In && g.view.state == GrantState::Active && g.view.ends_ms > now && g.view.agent_id.eq_ignore_ascii_case(agent_id) && g.lender_device == who).max_by_key(|g| g.view.started_ms).map(|g| g.view.id.clone())
    }

    /// The newest active lend of `agent_id` made to this PC by anyone that a chat can run on: what a default start uses when this PC's own login is signed out.
    pub fn newest_borrow(&self, agent_id: &str) -> Option<String> {
        let now = self.now();
        let chat = self.spec(agent_id).is_some_and(|s| s.chat.is_some());
        lock(&self.inner).saved.grants.iter().filter(|g| chat && g.view.direction == Direction::In && g.view.state == GrantState::Active && g.view.ends_ms > now && g.view.agent_id.eq_ignore_ascii_case(agent_id)).max_by_key(|g| g.view.started_ms).map(|g| g.view.id.clone())
    }

    pub fn grant_lent_by(&self, grant_id: &str, agent_id: &str, lender_node: &str) -> bool {
        let now = self.now();
        lock(&self.inner).saved.grants.iter().any(|g| {
            g.view.id == grant_id && g.view.direction == Direction::In && g.view.state == GrantState::Active && g.view.ends_ms > now && g.view.agent_id.eq_ignore_ascii_case(agent_id) && g.lender_device == format!("{OWN_PREFIX}{lender_node}")
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
