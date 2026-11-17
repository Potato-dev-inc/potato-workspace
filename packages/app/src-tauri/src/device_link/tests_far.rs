//! Far-away pairing through the Worker, on the in-memory net with a fake Worker (the same rules as `pair.ts`).
//! The PCs are on DIFFERENT networks where it matters: no dial can reach the other, so only the Worker can bring
//! them together.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::tests::{instance_with, real_now, until, Instance};
use super::Options;
use crate::p2p::endpoint::TransportFactory;
use crate::p2p::far_tests::FakeWorker;
use crate::p2p::memory::MemoryNet;
use crate::p2p::pairing::{parse_link, SystemClock};

fn far_instance(name: &str, factory: Arc<dyn TransportFactory>, worker: &Arc<FakeWorker>, far_on: bool) -> Instance {
    let mut options = Options::memory();
    options.far_relay = Some(worker.clone());
    let i = instance_with(name, factory, false, Arc::new(SystemClock), Arc::new(real_now), options);
    i.link.apply_settings(&json!({ "devices_enabled": true, "far_pcs_enabled": far_on }));
    i.link.mgr.set_far_poll(Duration::from_millis(20));
    i
}

fn pending(side: &Instance) -> Value {
    side.link.view()["pending"].clone()
}

async fn both_sheets(a: &Instance, b: &Instance) {
    until("both sheets", || !pending(a).is_null() && !pending(b).is_null()).await;
}

fn choices_of(i: &Instance) -> Vec<String> {
    pending(i)["choices"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect()
}

/// The matching number, as the person would pick it: the one that is on both screens.
fn matching(a: &Instance, b: &Instance) -> String {
    let (x, y) = (choices_of(a), choices_of(b));
    let both: Vec<&String> = x.iter().filter(|n| y.contains(n)).collect();
    assert_eq!(both.len(), 1, "exactly one number is on both screens: {x:?} {y:?}");
    both[0].clone()
}

fn id_of(side: &Instance) -> u64 {
    pending(side)["id"].as_u64().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_pcs_on_different_networks_pair_through_the_worker_and_the_worker_sees_only_sealed_text() {
    let (net_a, net_b) = (MemoryNet::new(), MemoryNet::new());
    let w = FakeWorker::new();
    let host = far_instance("host-beta", net_a.factory(), &w, true);
    let joiner = far_instance("alpha-join", net_b.factory(), &w, true);
    let shown = host.link.make_link().await.unwrap();
    let link = shown["hosting"]["link"].as_str().unwrap().to_string();
    let parsed = parse_link(&link).unwrap();
    assert_eq!(parsed.worker.as_deref(), Some("fake.workers.dev"));
    assert!(parsed.seed.is_some());
    assert_eq!(w.open_boxes(), 1);
    let (j, l) = (joiner.link.clone(), link.clone());
    let task = tokio::spawn(async move { j.join_link(&l).await });
    both_sheets(&host, &joiner).await;
    for side in [&host, &joiner] {
        let p = pending(side);
        assert_eq!(p["mode"], "check");
        assert_eq!(p["code"], "", "the typed code is never shown for a link");
        assert_eq!(p["choices"].as_array().unwrap().len(), 3);
        assert!(p["fingerprint"].as_str().unwrap().len() >= 9);
    }
    // Pressing a plain Yes does not skip the check.
    assert!(host.link.pair_answer(id_of(&host), true).unwrap_err().contains("Pick the number"));
    let pick = matching(&host, &joiner);
    for side in [&host, &joiner] {
        side.link.pair_pick(id_of(side), &pick).unwrap();
    }
    task.await.unwrap().expect("the join finished");
    until("host lists the joiner", || host.link.view()["devices"].as_array().is_some_and(|d| d.len() == 1)).await;
    for (me, other) in [(&joiner, &host), (&host, &joiner)] {
        let v = me.link.view();
        assert_eq!(v["devices"][0]["node"], other.node());
        assert_eq!(v["devices"][0]["lets_run"], false, "a new device can do nothing");
    }
    until("the box is closed", || w.open_boxes() == 0).await;
    // Nothing an operator could read: no name, no code, no key in the clear.
    use base64::Engine as _;
    let seen = w.seen.lock().unwrap().clone();
    assert!(seen.len() >= 6, "the whole exchange went through the box");
    for ct in seen {
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&ct).unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(!text.contains("host-beta") && !text.contains("alpha-join") && !text.contains(&parsed.code) && !text.contains("binding"));
        assert!(raw.len() > 4000, "every message is padded to the same size");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wrong_pick_counts_as_no_and_nobody_is_trusted() {
    let (net_a, net_b) = (MemoryNet::new(), MemoryNet::new());
    let w = FakeWorker::new();
    let host = far_instance("host", net_a.factory(), &w, true);
    let joiner = far_instance("joiner", net_b.factory(), &w, true);
    let link = host.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    let (j, l) = (joiner.link.clone(), link);
    let task = tokio::spawn(async move { j.join_link(&l).await });
    both_sheets(&host, &joiner).await;
    let right = matching(&host, &joiner);
    let wrong = choices_of(&host).into_iter().find(|c| *c != right).unwrap();
    host.link.pair_pick(id_of(&host), &wrong).unwrap();
    let _ = joiner.link.pair_pick(id_of(&joiner), &right);
    assert!(task.await.unwrap().is_err());
    assert!(host.link.view()["devices"].as_array().unwrap().is_empty());
    assert!(joiner.link.view()["devices"].as_array().unwrap().is_empty());
    assert!(host.link.view()["message"].as_str().unwrap_or("").contains("not the matching number"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_arrival_with_the_same_link_is_told_it_was_used_and_the_host_can_say_no() {
    let (net_a, net_b, net_c) = (MemoryNet::new(), MemoryNet::new(), MemoryNet::new());
    let w = FakeWorker::new();
    let host = far_instance("host", net_a.factory(), &w, true);
    let thief = far_instance("thief", net_b.factory(), &w, true);
    let legit = far_instance("legit", net_c.factory(), &w, true);
    let link = host.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    let (t, l) = (thief.link.clone(), link.clone());
    let thief_task = tokio::spawn(async move { t.join_link(&l).await });
    both_sheets(&host, &thief).await;
    // The person it was meant for arrives second.
    let err = legit.link.join_link(&link).await.unwrap_err();
    assert!(err.contains("already used") && err.contains("press No"), "{err}");
    // The host sees a name it does not know and says No.
    host.link.pair_answer(id_of(&host), false).unwrap();
    let _ = thief.link.pair_pick(id_of(&thief), "000000");
    assert!(thief_task.await.unwrap().is_err());
    for side in [&host, &thief, &legit] {
        assert!(side.link.view()["devices"].as_array().unwrap().is_empty(), "nobody was trusted");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_worker_that_cannot_open_a_box_still_gives_a_link_that_pairs_on_the_same_network_with_numbers() {
    let net = MemoryNet::new();
    let w = FakeWorker::new();
    w.feature.store(false, Ordering::SeqCst);
    let host = far_instance("host", net.factory(), &w, true);
    let joiner = far_instance("joiner", net.factory(), &w, true);
    let shown = host.link.make_link().await.unwrap();
    let link = shown["hosting"]["link"].as_str().unwrap().to_string();
    let parsed = parse_link(&link).unwrap();
    assert!(parsed.worker.is_none() && parsed.seed.is_some(), "no Worker in the link, but the seed still strengthens the proof");
    assert!(host.link.view()["message"].as_str().unwrap_or("").contains("needs an update"));
    let (j, l) = (joiner.link.clone(), link);
    let task = tokio::spawn(async move { j.join_link(&l).await });
    both_sheets(&host, &joiner).await;
    assert_eq!(pending(&host)["mode"], "check");
    let pick = matching(&host, &joiner);
    for side in [&host, &joiner] {
        side.link.pair_pick(id_of(side), &pick).unwrap();
    }
    task.await.unwrap().expect("paired on the direct route");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn when_the_worker_goes_down_after_the_link_was_made_the_joiner_falls_back_to_the_direct_route() {
    let net = MemoryNet::new();
    let w = FakeWorker::new();
    let host = far_instance("host", net.factory(), &w, true);
    let joiner = far_instance("joiner", net.factory(), &w, true);
    let link = host.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    assert!(parse_link(&link).unwrap().worker.is_some());
    w.down.store(true, Ordering::SeqCst);
    let (j, l) = (joiner.link.clone(), link);
    let task = tokio::spawn(async move { j.join_link(&l).await });
    both_sheets(&host, &joiner).await;
    let pick = matching(&host, &joiner);
    for side in [&host, &joiner] {
        side.link.pair_pick(id_of(side), &pick).unwrap();
    }
    task.await.unwrap().expect("paired without the Worker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_the_switch_off_a_link_is_exactly_what_it_was_and_the_worker_is_never_called() {
    let net = MemoryNet::new();
    let w = FakeWorker::new();
    let host = far_instance("host", net.factory(), &w, false);
    let joiner = far_instance("joiner", net.factory(), &w, false);
    let link = host.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    let parsed = parse_link(&link).unwrap();
    assert!(parsed.seed.is_none() && parsed.worker.is_none());
    assert_eq!(w.open_boxes(), 0);
    let (j, l) = (joiner.link.clone(), link);
    let task = tokio::spawn(async move { j.join_link(&l).await });
    both_sheets(&host, &joiner).await;
    assert_eq!(pending(&host)["mode"], "code", "the sheet is the old one");
    for side in [&host, &joiner] {
        side.link.pair_answer(id_of(side), true).unwrap();
    }
    task.await.unwrap().expect("paired as before");
}

/// The same link with its seed, version and Worker taken out: what an old app (or a thief who wants the old sheet) sends.
fn stripped(link: &str) -> String {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut v: Value = serde_json::from_slice(&engine.decode(link.trim_start_matches("pm2:")).unwrap()).unwrap();
    for k in ["v", "s", "w"] {
        v.as_object_mut().unwrap().remove(k);
    }
    format!("pm2:{}", engine.encode(v.to_string()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_code_only_proof_on_a_link_with_a_seed_is_refused_and_never_gets_the_plain_sheet() {
    let net = MemoryNet::new();
    let w = FakeWorker::new();
    let host = far_instance("host", net.factory(), &w, true);
    let thief = far_instance("thief", net.factory(), &w, false);
    let link = host.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    assert!(parse_link(&link).unwrap().seed.is_some());
    // Somebody who knows the link takes the seed out so the host falls back to the old code-only sheet.
    let err = thief.link.join_link(&stripped(&link)).await.unwrap_err();
    assert!(err.contains("Update the other PC"), "{err}");
    assert!(pending(&host).is_null(), "the host never shows a sheet for it");
    for side in [&host, &thief] {
        assert!(side.link.view()["devices"].as_array().unwrap().is_empty(), "nobody was trusted");
    }
}

/// One side sends a changed (mode 1) or no (mode 2) node signature on the Worker route.
async fn forged_signature(bad_side_is_joiner: bool, mode: u8) {
    let (net_a, net_b) = (MemoryNet::new(), MemoryNet::new());
    net_a.set_home_relay(Some("https://relay-a.test"));
    net_b.set_home_relay(Some("https://relay-b.test"));
    let w = FakeWorker::new();
    let host = far_instance("host", net_a.factory(), &w, true);
    let joiner = far_instance("joiner", net_b.factory(), &w, true);
    let liar = if bad_side_is_joiner { &joiner } else { &host };
    liar.link.mgr.set_tamper_sig(mode);
    let link = host.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    let (j, l) = (joiner.link.clone(), link);
    let task = tokio::spawn(async move { j.join_link(&l).await });
    let result = tokio::time::timeout(Duration::from_secs(20), task).await.expect("the exchange ended").unwrap();
    assert!(result.is_err(), "a forged or missing signature ends the exchange");
    // No sheet was ever shown, nothing was trusted and nothing about the other PC was remembered.
    for (me, other) in [(&host, &joiner), (&joiner, &host)] {
        // The side that lied (a test hook) does not know it did and waits for its own person: that is its own sheet.
        // The honest side never shows a sheet for a peer it could not verify.
        if std::ptr::eq(me, liar) {
            if !pending(me).is_null() {
                me.link.pair_answer(id_of(me), false).unwrap();
            }
        } else {
            assert!(pending(me).is_null());
        }
        assert!(me.link.view()["devices"].as_array().unwrap().is_empty());
        let node = crate::device_link::node_of(&other.node()).unwrap();
        let known = me.link.p2p().addrs().peer(node);
        assert!(known.direct.is_empty() && known.relay.is_none(), "{known:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_forged_or_missing_node_signature_on_the_worker_route_leaves_no_trust_and_no_remembered_address() {
    for (joiner_lies, mode) in [(true, 1), (true, 2), (false, 1), (false, 2)] {
        forged_signature(joiner_lies, mode).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn closing_the_sheet_closes_the_box() {
    let net = MemoryNet::new();
    let w = FakeWorker::new();
    let host = far_instance("host", net.factory(), &w, true);
    host.link.make_link().await.unwrap();
    assert_eq!(w.open_boxes(), 1);
    host.link.cancel_code().unwrap();
    until("the box is closed", || w.open_boxes() == 0).await;
}

/// The real Worker, on this PC: two PCs on different networks pair through `wrangler dev` with the app's own HTTP
/// client (`HttpPairRelay`) and the real owner signature. Runs only when `PM_PAIR_URL` names a Worker started with
/// `PAIR_OWNER` = the public key of the 32-byte seed `[21; 32]` (`relay/worker/scripts/run-tests.mjs --pair-app`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn far_worker_loopback_pairs_two_pcs_through_the_real_worker() {
    let Ok(url) = std::env::var("PM_PAIR_URL") else {
        return;
    };
    let host = url.trim_start_matches("http://").trim_end_matches('/').to_string();
    let relay = |name: &str| -> Arc<dyn crate::p2p::far::PairRelay> {
        let _ = name;
        let h = host.clone();
        Arc::new(super::far_http::HttpPairRelay::for_loopback(
            Arc::new(|| Some(ed25519_dalek::SigningKey::from_bytes(&[21u8; 32]))),
            Arc::new(move || Some(h.clone())),
        ))
    };
    let (net_a, net_b) = (MemoryNet::new(), MemoryNet::new());
    let make = |name: &str, factory: Arc<dyn TransportFactory>| {
        let mut options = Options::memory();
        options.far_relay = Some(relay(name));
        let i = instance_with(name, factory, false, Arc::new(SystemClock), Arc::new(real_now), options);
        i.link.apply_settings(&json!({ "devices_enabled": true, "far_pcs_enabled": true }));
        i.link.mgr.set_far_poll(Duration::from_millis(150));
        i
    };
    let (host_pc, joiner) = (make("host-pc", net_a.factory()), make("far-pc", net_b.factory()));
    let link = host_pc.link.make_link().await.unwrap()["hosting"]["link"].as_str().unwrap().to_string();
    let parsed = parse_link(&link).unwrap();
    assert_eq!(parsed.worker.as_deref(), Some(host.as_str()), "the box was opened on the real Worker");
    let (j, l) = (joiner.link.clone(), link);
    let task = tokio::spawn(async move { j.join_link(&l).await });
    until("both sheets", || !pending(&host_pc).is_null() && !pending(&joiner).is_null()).await;
    let pick = matching(&host_pc, &joiner);
    for side in [&host_pc, &joiner] {
        side.link.pair_pick(id_of(side), &pick).unwrap();
    }
    task.await.unwrap().expect("paired through the real Worker");
    until("host lists the joiner", || host_pc.link.view()["devices"].as_array().is_some_and(|d| d.len() == 1)).await;
}
