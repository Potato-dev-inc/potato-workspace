//! Pings for the Team page (Settings > Team > People): "is this teammate's computer there, and how far away?".
//!
//! A ping is one `Body::Ping` sealed to one device, like every lend item, and answered by that device's app with a
//! `Body::Pong` carrying the same nonce. The round trip is timed on this side. It travels through the team relay,
//! so it measures what team messages (and lend requests) really go through: the mailbox, not the PC link. Where a
//! PC link exists to that device (a lend from them to me) the service measures that link too and prefers it
//! (`Lend::probe_lenders`): the same `pm/lend/1` handshake Test link uses, with "direct" or "via relay".
//!
//! Answering needs no switch: this is a diagnostic. It is kept apart from the lend service, which only exists while
//! Labs lend is on. A reply is rate-limited per device, and only devices of the team can be answered (`wire::open`
//! checks the roster and the sealed sender). Pings are not remembered in the lend replay guard, so they never grow
//! the saved state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::oneshot;

use super::service::TeamPort;
use super::wire::{self, Body};
use crate::team::secure::CapacityIn;

/// How long a ping waits for the answer. A relay hop across continents plus a polling teammate needs seconds.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(8);
/// One answer per device at most this often.
const MIN_REPLY_GAP: Duration = Duration::from_secs(2);

pub const VIA_DIRECT: &str = "direct";
pub const VIA_RELAY: &str = "relay";
pub const VIA_MAILBOX: &str = "mailbox";

/// One device's result, as the Team page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DevicePing {
    pub member_id: String,
    pub device_id: String,
    pub device_name: String,
    pub ok: bool,
    pub ms: Option<u64>,
    /// `direct` and `relay`: measured on the PC link (the path iroh chose). `mailbox`: the team relay's round trip.
    pub via: Option<String>,
    /// The plain reason when `ok` is false.
    pub message: Option<String>,
}

type Waiting = (String, oneshot::Sender<()>);

pub struct Pinger {
    team: Arc<dyn TeamPort>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    waiting: Mutex<HashMap<String, Waiting>>,
    answered: Mutex<HashMap<String, Instant>>,
    timeout: Mutex<Duration>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Pinger {
    pub fn new(team: Arc<dyn TeamPort>, now: Arc<dyn Fn() -> u64 + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { team, now, waiting: Mutex::new(HashMap::new()), answered: Mutex::new(HashMap::new()), timeout: Mutex::new(REPLY_TIMEOUT) })
    }

    /// Tests wait less.
    #[cfg(test)]
    pub fn set_timeout(&self, t: Duration) {
        *lock(&self.timeout) = t;
    }

    /// A lend item from the team relay: true when it was a ping or a pong (taken here, the lend service never sees it).
    pub fn handle(&self, cin: &CapacityIn) -> bool {
        let Ok(session) = self.team.session() else { return false };
        let Ok(kem) = session.keys.device_kem() else { return false };
        let now = (self.now)();
        let Ok(item) = wire::open(&session, &kem, cin, now) else { return false };
        match item.body {
            Body::Ping { nonce } => {
                {
                    let mut answered = lock(&self.answered);
                    answered.retain(|_, at| at.elapsed() < MIN_REPLY_GAP * 8);
                    if answered.get(&item.from_device).is_some_and(|at| at.elapsed() < MIN_REPLY_GAP) {
                        return true;
                    }
                    answered.insert(item.from_device.clone(), Instant::now());
                }
                if let Ok((payload, _)) = wire::seal(&session, &item.from_device, Body::Pong { nonce }, now) {
                    let team = self.team.clone();
                    // The relay send blocks on the network; the receive loop must not wait for it.
                    std::thread::spawn(move || {
                        let _ = team.send(&payload);
                    });
                }
                true
            }
            Body::Pong { nonce } => {
                let waiting = lock(&self.waiting).remove(&nonce);
                if let Some((device, tx)) = waiting {
                    // Only the pinged device can answer its own ping.
                    if device == item.from_device {
                        let _ = tx.send(());
                    }
                }
                true
            }
            _ => false,
        }
    }

    /// Pings one device of the team through the relay and times the answer.
    pub async fn ping_device(self: &Arc<Self>, device_id: &str) -> DevicePing {
        let (member_id, device_name, sealed) = match self.team.session() {
            Err(e) => return failed("", device_id, "", e),
            Ok(session) => {
                let Some((member, device)) = session.roster.device(device_id) else {
                    return failed("", device_id, "", "That computer is not on the team.".into());
                };
                let nonce = wire::new_msg_id((self.now)());
                let sealed = wire::seal(&session, device_id, Body::Ping { nonce: nonce.clone() }, (self.now)()).map(|(p, _)| (p, nonce));
                (member.id.clone(), device.name.clone(), sealed)
            }
        };
        let (payload, nonce) = match sealed {
            Ok(v) => v,
            Err(e) => return failed(&member_id, device_id, &device_name, e),
        };
        let (tx, rx) = oneshot::channel();
        lock(&self.waiting).insert(nonce.clone(), (device_id.to_string(), tx));
        let started = Instant::now();
        let team = self.team.clone();
        let sent = tokio::task::spawn_blocking(move || team.send(&payload)).await;
        if !matches!(sent, Ok(Ok(()))) {
            lock(&self.waiting).remove(&nonce);
            return failed(&member_id, device_id, &device_name, "The team relay didn't take the ping.".into());
        }
        let wait = *lock(&self.timeout);
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(())) => DevicePing {
                member_id,
                device_id: device_id.to_string(),
                device_name,
                ok: true,
                ms: Some(started.elapsed().as_millis() as u64),
                via: Some(VIA_MAILBOX.into()),
                message: None,
            },
            _ => {
                lock(&self.waiting).remove(&nonce);
                failed(&member_id, device_id, &device_name, "Not reachable".into())
            }
        }
    }

    /// Every other computer on the team (teammates' and my own other ones), pinged at the same time.
    pub async fn ping_all(self: &Arc<Self>) -> Result<Vec<DevicePing>, String> {
        let session = self.team.session()?;
        let me = session.my_device()?;
        let ids: Vec<String> = session.roster.members.iter().flat_map(|m| m.devices.iter().map(|d| d.id.clone())).filter(|d| *d != me).collect();
        let mut tasks = Vec::new();
        for id in ids {
            let pinger = self.clone();
            tasks.push(tokio::spawn(async move { pinger.ping_device(&id).await }));
        }
        let mut out = Vec::new();
        for t in tasks {
            if let Ok(r) = t.await {
                out.push(r);
            }
        }
        Ok(out)
    }
}

fn failed(member_id: &str, device_id: &str, device_name: &str, message: String) -> DevicePing {
    DevicePing { member_id: member_id.into(), device_id: device_id.into(), device_name: device_name.into(), ok: false, ms: None, via: None, message: Some(message) }
}

/// A PC link measurement as a ping result (it replaces the mailbox figure for that device).
pub fn from_probe(base: &DevicePing, rtt: Duration, direct: bool) -> DevicePing {
    DevicePing {
        ok: true,
        ms: Some(rtt.as_millis() as u64),
        via: Some(if direct { VIA_DIRECT } else { VIA_RELAY }.into()),
        message: None,
        ..base.clone()
    }
}
