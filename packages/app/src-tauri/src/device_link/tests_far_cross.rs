//! Two PCs of one person, each with its OWN relay (two Workers in one Cloudflare account, `pm-relay-xxxx` each), and
//! pairing between them: the link carries the host PC's relay address, so the other PC reaches it there without typing
//! anything, and its own relay is never touched. Same fake Workers as `tests_far.rs`; the PCs are on different networks.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;

use super::tests::{instance_with, real_now, until, Instance};
use super::tests_far::{both_sheets, id_of, matching};
use super::Options;
use crate::p2p::endpoint::TransportFactory;
use crate::p2p::far::{Creds, Delivered, PairRelay, RelayErr};
use crate::p2p::far_tests::FakeWorker;
use crate::p2p::memory::MemoryNet;
use crate::p2p::pairing::{parse_link, SystemClock};

/// What one PC's app sees of the internet: every Worker by its host name, and which one is its own. Like the real
/// client, only the PC's OWN Worker accepts a box from it (the owner key); anybody can claim, post and poll with a link.
struct Internet {
    mine: Option<String>,
    workers: HashMap<String, Arc<FakeWorker>>,
}

impl Internet {
    fn at(&self, host: &str) -> Result<&Arc<FakeWorker>, RelayErr> {
        self.workers.get(host).ok_or(RelayErr::Down)
    }
}

#[async_trait]
impl PairRelay for Internet {
    fn my_host(&self) -> Option<String> {
        self.mine.clone()
    }
    async fn create(&self, host: &str, rid: &str, pair_hash: &str, host_hash: &str, ttl_ms: u64) -> Result<(), RelayErr> {
        if self.mine.as_deref() != Some(host) {
            return Err(RelayErr::NoFeature);
        }
        self.at(host)?.create(host, rid, pair_hash, host_hash, ttl_ms).await
    }
    async fn claim(&self, host: &str, rid: &str, pair_token: &str) -> Result<String, RelayErr> {
        self.at(host)?.claim(host, rid, pair_token).await
    }
    async fn post(&self, host: &str, rid: &str, who: &Creds, dir: char, n: u32, ct: &str) -> Result<(), RelayErr> {
        self.at(host)?.post(host, rid, who, dir, n, ct).await
    }
    async fn poll(&self, host: &str, rid: &str, who: &Creds, for_dir: char, after: u64) -> Result<Vec<Delivered>, RelayErr> {
        self.at(host)?.poll(host, rid, who, for_dir, after).await
    }
    async fn delete(&self, host: &str, rid: &str, host_token: &str) -> Result<(), RelayErr> {
        self.at(host)?.delete(host, rid, host_token).await
    }
}

fn pc(name: &str, factory: Arc<dyn TransportFactory>, mine: Option<&str>, all: &[(&str, &Arc<FakeWorker>)]) -> Instance {
    let net = Internet { mine: mine.map(str::to_string), workers: all.iter().map(|(h, w)| (h.to_string(), (*w).clone())).collect() };
    let mut options = Options::memory();
    options.far_relay = Some(Arc::new(net));
    let i = instance_with(name, factory, false, Arc::new(SystemClock), Arc::new(real_now), options);
    // `far_pcs_enabled` is on by default now: the same settings a fresh install has.
    i.link.apply_settings(&json!({ "devices_enabled": true, "far_pcs_enabled": true }));
    i.link.mgr.set_far_poll(Duration::from_millis(20));
    i
}

fn names(i: &Instance) -> Vec<String> {
    i.link.view()["devices"].as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap().to_string()).collect()
}

async fn pair(host: &Instance, joiner: &Instance, link: String) {
    let (j, l) = (joiner.link.clone(), link);
    let task = tokio::spawn(async move { j.join_link(&l).await });
    both_sheets(host, joiner).await;
    let pick = matching(host, joiner);
    for side in [host, joiner] {
        side.link.pair_pick(id_of(side), &pick).unwrap();
    }
    task.await.unwrap().expect("the join finished");
}

const R1: &str = "pm-relay-aaaa.me.workers.dev";
const R2: &str = "pm-relay-bbbb.me.workers.dev";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pc_2_pairs_to_pc_1_through_pc_1s_relay_and_never_touches_its_own_and_both_list_each_other() {
    let (net_a, net_b) = (MemoryNet::new(), MemoryNet::new());
    let (w1, w2) = (FakeWorker::at(R1), FakeWorker::at(R2));
    let all = [(R1, &w1), (R2, &w2)];
    let pc1 = pc("Desk PC", net_a.factory(), Some(R1), &all);
    let pc2 = pc("Laptop", net_b.factory(), Some(R2), &all);
    // PC 1 makes the link: one tap, no address typed anywhere.
    let shown = pc1.link.make_link().await.unwrap();
    assert_eq!(shown["hosting"]["worker"], true, "the page is told the link goes through the relay");
    let link = shown["hosting"]["link"].as_str().unwrap().to_string();
    let parsed = parse_link(&link).unwrap();
    assert_eq!(parsed.worker.as_deref(), Some(R1), "the link carries PC 1's relay address");
    assert_eq!((w1.open_boxes(), w2.open_boxes()), (1, 0), "the box is on PC 1's relay");
    // PC 2 pastes it. Its own relay is a different Worker.
    pair(&pc1, &pc2, link).await;
    until("both list each other", || names(&pc1) == ["Laptop"] && names(&pc2) == ["Desk PC"]).await;
    assert!(!w1.seen.lock().unwrap().is_empty(), "the exchange went through PC 1's relay");
    assert!(w2.seen.lock().unwrap().is_empty(), "PC 2's own relay saw nothing");
    assert_eq!(w2.open_boxes(), 0);
    until("the box is closed", || w1.open_boxes() == 0).await;
    // Nothing is shared by pairing alone.
    for side in [&pc1, &pc2] {
        assert_eq!(side.link.view()["devices"][0]["lets_run"], false);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_other_direction_works_too_and_a_pc_with_no_relay_of_its_own_can_still_join() {
    let (net_a, net_b, net_c) = (MemoryNet::new(), MemoryNet::new(), MemoryNet::new());
    let (w1, w2) = (FakeWorker::at(R1), FakeWorker::at(R2));
    let all = [(R1, &w1), (R2, &w2)];
    let pc1 = pc("Desk PC", net_a.factory(), Some(R1), &all);
    let pc2 = pc("Laptop", net_b.factory(), Some(R2), &all);
    let guest = pc("Mini", net_c.factory(), None, &all);
    // PC 2 hosts this time: its link names ITS relay, and PC 1 joins there.
    let link = pc2.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    assert_eq!(parse_link(&link).unwrap().worker.as_deref(), Some(R2));
    pair(&pc2, &pc1, link).await;
    until("listed", || names(&pc2) == ["Desk PC"] && names(&pc1) == ["Laptop"]).await;
    assert!(w1.seen.lock().unwrap().is_empty(), "PC 1's relay was not used when PC 2 hosted");
    // A PC with no relay at all joins through the host's relay.
    let link = pc1.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    pair(&pc1, &guest, link).await;
    until("guest listed", || names(&guest) == ["Desk PC"] && names(&pc1).contains(&"Mini".to_string())).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pc_with_no_relay_makes_a_link_without_a_relay_address_and_the_page_is_told() {
    let net = MemoryNet::new();
    let w = FakeWorker::at(R1);
    let lonely = pc("Desk PC", net.factory(), None, &[(R1, &w)]);
    let shown = lonely.link.make_link().await.unwrap();
    assert_eq!(shown["hosting"]["worker"], false);
    assert!(parse_link(shown["hosting"]["link"].as_str().unwrap()).unwrap().worker.is_none());
    assert_eq!(w.open_boxes(), 0, "nothing was opened anywhere");
    assert!(shown["message"].as_str().unwrap_or("").contains("Set up your relay"), "{:?}", shown["message"]);
}
