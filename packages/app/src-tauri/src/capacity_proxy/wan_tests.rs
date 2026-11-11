//! Lending across the world, with no internet: a borrower in India and a lender in Taiwan on a simulated WAN.
//! The network is the p2p memory net wrapped in `Wan`: every dial and stream open costs round trips, some dials are
//! lost, the direct path can be blocked so only the relay works, and every open link can be cut.
//!
//! What this proves is OUR side of the rules: the lender's hint carries its relay, the lend endpoint is bound with
//! relays on, a blocked direct path is crossed through the relay, a dropped link is redialed by itself, lost dials
//! are retried, and the default waits are long enough for slow paths. That iroh itself falls back to its relay
//! (hole punching failing, different NATs) is iroh's own behaviour and cannot be shown without the real internet.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;

use super::e2e_tests::{lend_one, post, world2_with, World2};
use super::link::Timeouts;
use super::proxy_tests::{sse_script, SSE_TEXT};
use crate::p2p::endpoint::{BiStream, BindSpec, Link, NodeId, P2pError, PathKind, PeerAddr, Transport, TransportFactory};
use crate::p2p::identity::DeviceIdentity;
use crate::p2p::memory::MemoryNet;

const RELAY: &str = "https://relay-ap.sim.invalid";

/// The simulated WAN between the borrowers and the lender.
pub(super) struct Wan {
    /// One round trip between the two countries.
    rtt: Mutex<Duration>,
    /// No packet gets through directly (different NATs): only a relay carries traffic.
    direct_blocked: AtomicBool,
    /// The next this many dials are lost (a handshake that never completes).
    lose_dials: AtomicUsize,
    dials: AtomicUsize,
    relayed_dials: AtomicUsize,
    direct_dials: AtomicUsize,
    links: Mutex<Vec<Arc<dyn Link>>>,
}

impl Wan {
    fn new(rtt: Duration, direct_blocked: bool) -> Arc<Self> {
        Arc::new(Self {
            rtt: Mutex::new(rtt),
            direct_blocked: AtomicBool::new(direct_blocked),
            lose_dials: AtomicUsize::new(0),
            dials: AtomicUsize::new(0),
            relayed_dials: AtomicUsize::new(0),
            direct_dials: AtomicUsize::new(0),
            links: Mutex::new(Vec::new()),
        })
    }

    fn rtt(&self) -> Duration {
        *self.rtt.lock().unwrap()
    }

    /// Every open link drops (a router reboot, a train in a tunnel).
    fn cut_all_links(&self) {
        for link in self.links.lock().unwrap().drain(..) {
            link.close(0x0bad, "cut");
        }
    }

    fn dials(&self) -> usize {
        self.dials.load(Ordering::SeqCst)
    }
}

struct WanNet {
    inner: MemoryNet,
    wan: Arc<Wan>,
}

#[async_trait]
impl TransportFactory for WanNet {
    async fn bind(&self, identity: &DeviceIdentity, spec: &BindSpec) -> Result<Arc<dyn Transport>, P2pError> {
        let inner = self.inner.factory().bind(identity, spec).await?;
        Ok(Arc::new(WanTransport { inner, net: self.inner.clone(), wan: self.wan.clone(), relays: spec.relays }))
    }
}

struct WanTransport {
    inner: Arc<dyn Transport>,
    net: MemoryNet,
    wan: Arc<Wan>,
    relays: bool,
}

#[async_trait]
impl Transport for WanTransport {
    fn id(&self) -> NodeId {
        self.inner.id()
    }
    async fn set_alpns(&self, alpns: Vec<Vec<u8>>) {
        self.inner.set_alpns(alpns).await
    }
    async fn dial(&self, peer: &PeerAddr, alpn: &[u8]) -> Result<Arc<dyn Link>, P2pError> {
        let wan = &self.wan;
        wan.dials.fetch_add(1, Ordering::SeqCst);
        // Finding the peer through the relay and the QUIC handshake: a few round trips.
        tokio::time::sleep(wan.rtt() * 3).await;
        if wan.lose_dials.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
            return Err(P2pError::Net("connection reset".into()));
        }
        let kind = if wan.direct_blocked.load(Ordering::SeqCst) {
            // Only the peer's relay can carry it: needs the relay in the address and relays on in this bind.
            if peer.relay.is_none() || !self.relays {
                return Err(P2pError::Net("no route to host".into()));
            }
            wan.relayed_dials.fetch_add(1, Ordering::SeqCst);
            PathKind::Relayed
        } else {
            wan.direct_dials.fetch_add(1, Ordering::SeqCst);
            PathKind::Direct
        };
        self.net.set_path(self.inner.id(), peer.id, kind);
        let link = self.inner.dial(peer, alpn).await?;
        wan.links.lock().unwrap().push(link.clone());
        Ok(Arc::new(WanLink { inner: link, rtt: wan.rtt() }))
    }
    async fn accept(&self) -> Option<Arc<dyn Link>> {
        self.inner.accept().await
    }
    async fn close(&self) {
        self.inner.close().await
    }
    fn home_relay(&self) -> Option<String> {
        self.inner.home_relay()
    }
}

struct WanLink {
    inner: Arc<dyn Link>,
    rtt: Duration,
}

#[async_trait]
impl Link for WanLink {
    fn peer(&self) -> NodeId {
        self.inner.peer()
    }
    fn alpn(&self) -> Vec<u8> {
        self.inner.alpn()
    }
    fn path(&self) -> PathKind {
        self.inner.path()
    }
    async fn wait_path_change(&self, from: PathKind) -> Option<PathKind> {
        self.inner.wait_path_change(from).await
    }
    async fn open_bi(&self) -> Result<BiStream, P2pError> {
        tokio::time::sleep(self.rtt).await;
        self.inner.open_bi().await
    }
    async fn accept_bi(&self) -> Result<BiStream, P2pError> {
        self.inner.accept_bi().await
    }
    async fn send_datagram(&self, data: Vec<u8>) -> Result<(), P2pError> {
        self.inner.send_datagram(data).await
    }
    async fn recv_datagram(&self) -> Result<Vec<u8>, P2pError> {
        self.inner.recv_datagram().await
    }
    fn close(&self, code: u32, reason: &str) {
        self.inner.close(code, reason)
    }
    async fn closed(&self) -> u32 {
        self.inner.closed().await
    }
}

/// India (the borrowers) to Taiwan (the lender): the lender has a home relay, the borrowers cross the WAN.
async fn india_to_taiwan(rtt: Duration, direct_blocked: bool, lender_has_relay: bool) -> (World2, Arc<Wan>) {
    let wan = Wan::new(rtt, direct_blocked);
    let w2 = wan.clone();
    let w = world2_with(sse_script(), move |mem, _| Arc::new(WanNet { inner: mem.clone(), wan: w2.clone() })).await;
    w.mem().set_home_relay(lender_has_relay.then_some(RELAY));
    (w, wan)
}

async fn ok_request(base: &str) {
    let reply = post(base, "/v1/messages?beta=true").await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert!(reply.complete);
    assert_eq!(reply.body, SSE_TEXT.as_bytes(), "the SSE stream is byte-identical");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_the_direct_path_blocked_only_the_relay_carries_the_lend() {
    let (w, wan) = india_to_taiwan(Duration::from_millis(350), true, true).await;
    let (_grant, base) = lend_one(&w, 3600).await;

    // The lender's hint names its relay, and its endpoint was bound with relays on.
    let hint = w.maya.lend.net().start().await.unwrap();
    assert_eq!(hint.relay, RELAY);
    let node = super::link::node_from_hex(&hint.id).unwrap();
    assert!(w.mem().spec_of(&node).unwrap().relays, "the lend endpoint is bound with relays allowed");

    let t0 = Instant::now();
    ok_request(&base).await;
    assert!(t0.elapsed() >= Duration::from_millis(1000), "the 350 ms path really was slow: {:?}", t0.elapsed());
    assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
    assert_eq!(wan.direct_dials.load(Ordering::SeqCst), 0, "nothing went directly");
    assert!(wan.relayed_dials.load(Ordering::SeqCst) >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lender_with_no_relay_in_its_hint_cannot_be_reached_and_the_words_say_so() {
    // The direct path is blocked and the hint has no relay: this is the case start() waits for the relay to avoid.
    let (w, _wan) = india_to_taiwan(Duration::from_millis(50), true, false).await;
    let (_grant, base) = lend_one(&w, 3600).await;
    let reply = post(&base, "/v1/messages?beta=true").await;
    assert_ne!(reply.status, 200);
    assert!(reply.text().contains("isn't answering"), "{}", reply.text());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_link_that_drops_is_redialed_by_itself_and_the_next_request_works() {
    let (w, wan) = india_to_taiwan(Duration::from_millis(120), true, true).await;
    let (_grant, base) = lend_one(&w, 3600).await;
    ok_request(&base).await;
    assert_eq!(wan.dials(), 1);

    wan.cut_all_links();
    ok_request(&base).await;
    assert_eq!(wan.dials(), 2, "one fresh dial, no more");

    // And again, to be sure it is not a one-time thing.
    wan.cut_all_links();
    ok_request(&base).await;
    assert_eq!(wan.dials(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_dial_is_retried_once_within_the_same_request() {
    let (w, wan) = india_to_taiwan(Duration::from_millis(100), true, true).await;
    let (_grant, base) = lend_one(&w, 3600).await;
    wan.lose_dials.store(1, Ordering::SeqCst);
    ok_request(&base).await;
    assert_eq!(wan.dials(), 2, "the first dial was lost, the retry got through");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_long_outage_fails_in_words_and_the_lend_recovers_when_the_network_does() {
    let (w, wan) = india_to_taiwan(Duration::from_millis(100), true, true).await;
    let (_grant, base) = lend_one(&w, 3600).await;
    ok_request(&base).await;
    wan.cut_all_links();
    wan.lose_dials.store(2, Ordering::SeqCst); // the dial and its retry are both lost

    let down = post(&base, "/v1/messages?beta=true").await;
    assert_ne!(down.status, 200);
    assert!(down.text().contains("isn't answering"), "{}", down.text());

    // No action by the person: once the short memory of the failure has passed, the next request goes through.
    tokio::time::sleep(Timeouts::default().fail_memory + Duration::from_millis(300)).await;
    ok_request(&base).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_two_second_round_trip_still_works_with_the_default_waits() {
    // A crowded relay on a bad night: 2 s per round trip, so a dial takes 6 s.
    let (w, wan) = india_to_taiwan(Duration::from_secs(2), true, true).await;
    let (_grant, base) = lend_one(&w, 3600).await;
    let t0 = Instant::now();
    ok_request(&base).await;
    assert!(t0.elapsed() >= Duration::from_secs(6), "{:?}", t0.elapsed());
    assert_eq!(wan.dials(), 1, "no needless retry on a slow but working path");
}

#[test]
fn the_default_waits_fit_the_slowest_realistic_path() {
    let t = Timeouts::default();
    // A dial is about three round trips on a relay; leave room for 3 s round trips and one retry inside a request.
    assert!(t.connect >= Duration::from_secs(3) * 3 * 2);
    assert!(t.hello >= Duration::from_secs(5));
    assert!(t.open >= t.connect + t.pause + t.hello);
}
