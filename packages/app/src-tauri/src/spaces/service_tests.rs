//! Services talk to each other over the in-memory net (`MemoryHub`): join, send, catch up, refuse.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::frame::write_frame;
use super::ids::{BotId, ChannelId, NodeKey, SpaceId};
use super::log::{Body, Entry, EntryHeader, KIND_BOT};
use super::memnet::MemoryHub;
use super::net::{NetError, PeerHint, SpaceNet, SpacePermissions};
use super::service::SpacesService;
use super::sync;
use crate::secrets::MemoryBackend;
use crate::team::keystore::KeyStore;

const T0: u64 = 1_700_000_000_000;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!("pm-svc-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&p);
        Self(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

struct Node {
    svc: Arc<SpacesService>,
    key: NodeKey,
    keystore: KeyStore,
    dir: TempDir,
}

fn hint(n: NodeKey) -> PeerHint { PeerHint { node: n, relay: String::new(), lan: Vec::new() } }

fn make(hub: &Arc<MemoryHub>, n: u8, clock: &Arc<AtomicU64>, keystore: Option<KeyStore>, dir: Option<TempDir>) -> Node {
    let key = NodeKey([n; 32]);
    let perms = SpacePermissions::new();
    let net = hub.node(key, perms.clone());
    let keystore = keystore.unwrap_or_else(|| KeyStore::with_backend(Arc::new(MemoryBackend::new()), &format!("node{n}")));
    let dir = dir.unwrap_or_else(|| TempDir::new(&format!("n{n}")));
    let c = clock.clone();
    let svc = SpacesService::new(net, perms, keystore.clone(), dir.0.clone(), Arc::new(move || c.load(Ordering::SeqCst)));
    Node { svc, key, keystore, dir }
}

async fn node(hub: &Arc<MemoryHub>, n: u8, clock: &Arc<AtomicU64>) -> Node {
    let node = make(hub, n, clock, None, None);
    node.svc.start_with(false).await.unwrap();
    node
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() { return; }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for: {what}");
}

fn clock() -> Arc<AtomicU64> { Arc::new(AtomicU64::new(T0)) }

fn general(n: &Node, space: &SpaceId) -> ChannelId {
    n.svc.with_open(space, |sp| sp.roster.channels[0].id).unwrap()
}

fn texts(n: &Node, space: &SpaceId) -> Vec<String> {
    let ch = general(n, space);
    n.svc
        .with_open(space, |sp| sp.store.messages_page(&ch, None, 200).unwrap().into_iter().map(|m| m.text).collect())
        .unwrap_or_default()
}

fn entry_count(n: &Node, space: &SpaceId) -> i64 {
    n.svc.with_open(space, |sp| sp.store.conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0)).unwrap()).unwrap_or(0)
}

async fn say(n: &Node, space: &SpaceId, t: &str) {
    let ch = general(n, space);
    n.svc.send(space, &ch, Body::Text { text: t.into(), mentions: vec![] }, None).await.unwrap();
}

fn joining_state(n: &Node) -> String {
    n.svc.view()["joining"][0]["state"].as_str().unwrap_or("").to_string()
}

fn has_space(n: &Node) -> bool { !n.svc.view()["spaces"].as_array().unwrap().is_empty() }

/// `owner` invites, `joiner` joins, the owner lets them in. Returns the space id.
async fn join(owner: &Node, joiner: &Node, space_hex: &str) {
    let invite = owner.svc.create_invite(space_hex).await.unwrap();
    let words: Vec<String> = invite["words"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect();
    joiner.svc.start_join(invite["link"].as_str().unwrap(), &words.join(" ")).await.unwrap();
    eventually("a join request", || !owner.svc.view()["requests"].as_array().unwrap().is_empty()).await;
    let id = owner.svc.view()["requests"][0]["id"].as_i64().unwrap();
    owner.svc.answer_join(space_hex, id, true).await.unwrap();
    eventually("the joiner is in", || has_space(joiner) && joining_state(joiner) == "joined").await;
}

async fn pair() -> (Arc<MemoryHub>, Arc<AtomicU64>, Node, Node, SpaceId) {
    let (hub, clk) = (MemoryHub::new(), clock());
    let (a, b) = (node(&hub, 1, &clk).await, node(&hub, 2, &clk).await);
    let hex = a.svc.create_space("Book club").await.unwrap();
    join(&a, &b, &hex).await;
    eventually("a link", || a.svc.link_count() == 1 && b.svc.link_count() == 1).await;
    (hub, clk, a, b, SpaceId::from_hex(&hex).unwrap())
}

async fn trio() -> (Arc<MemoryHub>, Arc<AtomicU64>, Node, Node, Node, SpaceId) {
    let (hub, clk, a, b, space) = pair().await;
    let c = node(&hub, 3, &clk).await;
    join(&a, &c, &space.to_hex()).await;
    eventually("b knows c", || b.svc.with_open(&space, |sp| sp.roster.members.len()) == Some(3)).await;
    // c's first dial may have come before b knew c: let the backoff pass, then dial again.
    clk.fetch_add(10 * 60 * 1000, Ordering::SeqCst);
    c.svc.dial_round().await;
    eventually("c linked to a and b", || c.svc.link_count() == 2 && b.svc.link_count() == 2).await;
    (hub, clk, a, b, c, space)
}

#[tokio::test]
async fn create_space_makes_owner_and_general() {
    let (hub, clk) = (MemoryHub::new(), clock());
    let a = node(&hub, 1, &clk).await;
    assert_eq!(a.svc.create_space("   ").await.err().as_deref(), Some("Give the space a name."));
    let hex = a.svc.create_space("Book club").await.unwrap();
    let v = a.svc.view();
    assert_eq!(v["spaces"].as_array().unwrap().len(), 1);
    assert_eq!(v["spaces"][0]["isOwner"], true);
    assert_eq!(v["spaces"][0]["name"], "Book club");
    let space = SpaceId::from_hex(&hex).unwrap();
    assert_eq!(a.svc.with_open(&space, |sp| sp.store.control_ops().unwrap().len()), Some(1));
    assert_eq!(a.svc.with_open(&space, |sp| sp.roster.channels[0].name.clone()).as_deref(), Some("general"));
}

#[tokio::test]
async fn full_join_through_services() {
    let (_hub, _clk, a, b, space) = pair().await;
    assert_eq!(joining_state(&b), "joined");
    assert_eq!(b.svc.view()["spaces"][0]["members"], 2);
    assert_eq!(b.svc.view()["spaces"][0]["isOwner"], false);
    assert_eq!(b.svc.with_open(&space, |sp| sp.store.control_ops().unwrap().len()), Some(2));
    assert_eq!(a.svc.view()["spaces"][0]["members"], 2);
    // The invite is used up and the request answered.
    assert!(a.svc.view()["requests"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn two_members_see_each_others_messages() {
    let (_hub, _clk, a, b, space) = pair().await;
    say(&a, &space, "hi").await;
    say(&b, &space, "yo").await;
    eventually("both messages on both", || texts(&a, &space).len() == 2 && texts(&b, &space).len() == 2).await;
    for n in [&a, &b] {
        let mut t = texts(n, &space);
        t.sort();
        assert_eq!(t, vec!["hi".to_string(), "yo".to_string()]);
    }
}

#[tokio::test]
async fn a_member_who_was_offline_catches_up_including_what_was_sent_while_away() {
    let (hub, _clk, a, b, space) = pair().await;
    say(&a, &space, "before").await;
    eventually("b has before", || texts(&b, &space).len() == 1).await;
    // b goes offline.
    hub.cut(a.key, b.key, true);
    eventually("links gone", || a.svc.link_count() == 0 && b.svc.link_count() == 0).await;
    say(&a, &space, "while you were away").await;
    say(&b, &space, "typed offline").await;
    assert_eq!(texts(&b, &space).len(), 2);
    assert_eq!(texts(&a, &space).len(), 2);
    // b comes back and dials.
    hub.cut(a.key, b.key, false);
    b.svc.dial_round().await;
    eventually("both caught up", || texts(&a, &space).len() == 3 && texts(&b, &space).len() == 3).await;
    let mut t = texts(&b, &space);
    t.sort();
    assert_eq!(t, vec!["before".to_string(), "typed offline".to_string(), "while you were away".to_string()]);
}

#[tokio::test]
async fn offline_member_catches_up_from_a_third_member() {
    let (hub, _clk, a, b, c, space) = trio().await;
    // c goes offline from both; b stays with a.
    hub.cut(a.key, c.key, true);
    hub.cut(b.key, c.key, true);
    eventually("c has no links", || c.svc.link_count() == 0).await;
    for i in 0..20 {
        say(&a, &space, &format!("m{i}")).await;
    }
    eventually("b has 20", || texts(&b, &space).len() == 20).await;
    assert_eq!(texts(&c, &space).len(), 0);
    // a goes away for good; c can only reach b.
    a.svc.stop().await;
    hub.cut(b.key, c.key, false);
    c.svc.dial_round().await;
    eventually("c has 20 from a", || texts(&c, &space).len() == 20).await;
}

#[tokio::test]
async fn push_is_forwarded_once() {
    let (hub, _clk, a, b, c, space) = trio().await;
    hub.cut(a.key, c.key, true);
    eventually("chain a-b-c", || a.svc.link_count() == 1 && c.svc.link_count() == 1 && b.svc.link_count() == 2).await;
    let before = b.svc.pushes_written();
    say(&a, &space, "one").await;
    eventually("c has it", || texts(&c, &space).len() == 1).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(texts(&c, &space).len(), 1);
    assert_eq!(entry_count(&c, &space), 1);
    assert_eq!(b.svc.pushes_written() - before, 1);
}

#[tokio::test]
async fn stranger_first_frame_must_be_join_request() {
    let (hub, clk) = (MemoryHub::new(), clock());
    let a = node(&hub, 1, &clk).await;
    let hex = a.svc.create_space("Book club").await.unwrap();
    let space = SpaceId::from_hex(&hex).unwrap();
    a.svc.create_invite(&hex).await.unwrap();
    let d = hub.node(NodeKey([9; 32]), SpacePermissions::new());
    let link = d.dial(&hint(a.key)).await.expect("an open invite lets a stranger knock");
    let mut s = link.open().await.unwrap();
    write_frame(&mut s.send, sync::HELLO, &[1, 2, 3]).await.unwrap();
    let code = tokio::time::timeout(Duration::from_secs(2), link.closed()).await.unwrap();
    assert_eq!(code, 2);
    assert_eq!(entry_count(&a, &space), 0);
    assert_eq!(a.svc.view()["spaces"][0]["members"], 1);
}

#[tokio::test]
async fn permissions_follow_roster_and_invites() {
    let (hub, clk) = (MemoryHub::new(), clock());
    let a = node(&hub, 1, &clk).await;
    let hex = a.svc.create_space("Book club").await.unwrap();
    let d = hub.node(NodeKey([9; 32]), SpacePermissions::new());
    assert_eq!(d.dial(&hint(a.key)).await.err(), Some(NetError::Refused));
    let invite = a.svc.create_invite(&hex).await.unwrap();
    assert!(d.dial(&hint(a.key)).await.is_ok());
    a.svc.cancel_invite(&hex, invite["id"].as_str().unwrap()).unwrap();
    assert_eq!(d.dial(&hint(a.key)).await.err(), Some(NetError::Refused));
}

#[tokio::test]
async fn owner_no_answer_expires_after_thirty_minutes() {
    let (hub, clk) = (MemoryHub::new(), clock());
    let (a, b) = (node(&hub, 1, &clk).await, node(&hub, 2, &clk).await);
    let hex = a.svc.create_space("Book club").await.unwrap();
    let invite = a.svc.create_invite(&hex).await.unwrap();
    let words: Vec<String> = invite["words"].as_array().unwrap().iter().map(|w| w.as_str().unwrap().to_string()).collect();
    b.svc.start_join(invite["link"].as_str().unwrap(), &words.join(" ")).await.unwrap();
    eventually("a request", || !a.svc.view()["requests"].as_array().unwrap().is_empty()).await;
    eventually("b waits", || joining_state(&b) == "waiting").await;
    clk.fetch_add(30 * 60 * 1000 + 61_000, Ordering::SeqCst);
    a.svc.tick();
    eventually("b hears no answer", || joining_state(&b) == "noAnswer").await;
    assert_eq!(a.svc.view()["invites"][0]["state"], "dead");
    assert!(a.svc.view()["requests"].as_array().unwrap().is_empty());
    assert!(!has_space(&b));
}

#[tokio::test]
async fn duplicate_links_keep_one() {
    let (hub, _clk, a, b, space) = pair().await;
    hub.cut(a.key, b.key, true);
    eventually("links gone", || a.svc.link_count() == 0 && b.svc.link_count() == 0).await;
    hub.cut(a.key, b.key, false);
    tokio::join!(a.svc.dial_round(), b.svc.dial_round());
    eventually("one link each", || a.svc.link_count() == 1 && b.svc.link_count() == 1).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!((a.svc.link_count(), b.svc.link_count()), (1, 1));
    // The link that stayed works.
    say(&a, &space, "still here").await;
    eventually("b hears a", || texts(&b, &space) == vec!["still here".to_string()]).await;
}

#[tokio::test]
async fn restart_reloads_spaces() {
    let (hub, clk) = (MemoryHub::new(), clock());
    let a = node(&hub, 1, &clk).await;
    let hex = a.svc.create_space("Book club").await.unwrap();
    let space = SpaceId::from_hex(&hex).unwrap();
    say(&a, &space, "kept").await;
    a.svc.stop().await;
    let Node { keystore, dir, .. } = a;
    let a2 = make(&hub, 1, &clk, Some(keystore), Some(dir));
    a2.svc.start_with(false).await.unwrap();
    let v = a2.svc.view();
    assert_eq!(v["spaces"].as_array().unwrap().len(), 1);
    assert_eq!(v["spaces"][0]["name"], "Book club");
    assert_eq!(a2.svc.with_open(&space, |sp| sp.roster.members.len()), Some(1));
    assert_eq!(texts(&a2, &space), vec!["kept".to_string()]);
    // The key came back too: it can still write.
    say(&a2, &space, "and more").await;
    assert_eq!(texts(&a2, &space).len(), 2);
}

/// A bot answer from a bot that is not on the roster, signed by a real member.
fn bad_bot_entry(n: &Node, space: &SpaceId) -> Entry {
    let ch = general(n, space);
    n.svc
        .with_open(space, |sp| {
            let device = sp.me.device_key();
            let header = EntryHeader {
                space: *space, channel: ch, device, seq: sp.store.next_seq(&device).unwrap(),
                lamport: sp.store.next_lamport().unwrap(), created_ms: T0, epoch: sp.roster.epoch, kind: KIND_BOT,
                refers: None, bot: Some(BotId([5; 8])),
            };
            let body = Body::BotText { text: "I am a bot".into(), called_by: None, hops: 0 };
            Entry::seal(&sp.me, header, &body, &sp.keys.0[&sp.roster.epoch]).unwrap()
        })
        .unwrap()
}

#[tokio::test]
async fn bot_text_from_a_bot_not_on_the_roster_is_refused() {
    let (_hub, _clk, a, b, space) = pair().await;
    // 1. It arrives as a live push: the other side stores nothing, and the link keeps working.
    let bad = bad_bot_entry(&a, &space);
    a.svc.forward(&space, None, &bad.to_bytes());
    say(&a, &space, "after the push").await;
    eventually("b has the normal one", || texts(&b, &space) == vec!["after the push".to_string()]).await;
    let device = a.svc.with_open(&space, |sp| sp.me.device_key()).unwrap();
    assert!(b.svc.with_open(&space, |sp| sp.store.conn
        .query_row("SELECT COUNT(*) FROM messages WHERE bot IS NOT NULL", [], |r| r.get::<_, i64>(0)).unwrap()) == Some(0));

    // 2. It sits in a's log (put there past the checks) and b asks for it while catching up: refused, no loop.
    let hole = bad_bot_entry(&a, &space);
    let hole_seq = hole.header.seq;
    a.svc.with_open(&space, |sp| sp.store.insert_entry(&hole, &hole.id(), &hole.to_bytes(), T0).unwrap());
    say(&a, &space, "after the hole").await;
    eventually("b has both normal ones", || texts(&b, &space).len() == 2).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(b.svc.with_open(&space, |sp| sp.store.has_seq(&device, hole_seq).unwrap()), Some(false));
    // The stream is still healthy.
    say(&a, &space, "and one more").await;
    eventually("b still receives", || texts(&b, &space).len() == 3).await;
    let ch = general(&b, &space);
    assert_eq!(b.svc.with_open(&space, |sp| sp.store.messages_page(&ch, None, 50).unwrap().iter().all(|m| m.bot.is_none())), Some(true));
}

/// A text from `n`'s own device that is `age_ms` old, put in its log past the receive checks (as if it had been
/// stored when it was young).
fn put_old_text(n: &Node, space: &SpaceId, age_ms: u64) {
    let ch = general(n, space);
    n.svc
        .with_open(space, |sp| {
            let device = sp.me.device_key();
            let seq = sp.store.next_seq(&device).unwrap();
            let header = EntryHeader {
                space: *space, channel: ch, device, seq, lamport: seq, created_ms: T0 - age_ms, epoch: sp.roster.epoch,
                kind: super::log::KIND_TEXT, refers: None, bot: None,
            };
            let body = Body::Text { text: "ancient".into(), mentions: vec![] };
            let e = Entry::seal(&sp.me, header, &body, &sp.keys.0[&sp.roster.epoch]).unwrap();
            sp.store.insert_entry(&e, &e.id(), &e.to_bytes(), T0).unwrap();
        })
        .unwrap();
}

const NINETY_ONE_DAYS: u64 = 91 * 24 * 60 * 60 * 1000;

#[tokio::test]
async fn old_entries_are_pruned_when_the_service_starts() {
    let (hub, clk) = (MemoryHub::new(), clock());
    let a = node(&hub, 1, &clk).await;
    let hex = a.svc.create_space("Book club").await.unwrap();
    let space = SpaceId::from_hex(&hex).unwrap();
    put_old_text(&a, &space, NINETY_ONE_DAYS);
    assert_eq!(entry_count(&a, &space), 1);
    a.svc.stop().await;
    let Node { keystore, dir, .. } = a;
    let a2 = make(&hub, 1, &clk, Some(keystore), Some(dir));
    a2.svc.start_with(false).await.unwrap();
    assert_eq!(entry_count(&a2, &space), 0);
    let device = a2.svc.with_open(&space, |sp| sp.me.device_key()).unwrap();
    assert_eq!(a2.svc.with_open(&space, |sp| sp.store.author_floor(&device).unwrap()), Some(1));
}

#[tokio::test]
async fn prune_runs_after_every_thousand_stored_entries() {
    let (hub, clk) = (MemoryHub::new(), clock());
    let a = node(&hub, 1, &clk).await;
    let hex = a.svc.create_space("Book club").await.unwrap();
    let space = SpaceId::from_hex(&hex).unwrap();
    put_old_text(&a, &space, NINETY_ONE_DAYS);
    for i in 0..999 {
        say(&a, &space, &format!("m{i}")).await;
    }
    assert_eq!(entry_count(&a, &space), 1000, "999 new ones and the old one");
    say(&a, &space, "the thousandth").await;
    assert_eq!(entry_count(&a, &space), 1000, "the old one went");
}
