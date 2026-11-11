//! The control wire on a real team (Maya, Leo and Sam, each with an in-memory key store, over a shared folder):
//! only the target device opens an item, replays and future-dated items are refused, impersonation is refused, and
//! an older build drops the new payload kind safely.

use super::link::handshake_mac;
use super::wire::{self, rules, Body, Guard, WireReject};
use crate::p2p::endpoint::NodeId;
use crate::team::secure::{CapacityIn, Opened, Payload, Reject, SeqTracker, Session};
use crate::team::tests_v1::{folder, temp_dir, world};

fn now() -> u64 {
    crate::team::transport::now_ms()
}

struct Three {
    maya: Session,
    leo: Session,
    sam: Session,
}

fn three() -> Three {
    let dir = temp_dir("lendwire");
    let t = folder(&dir);
    let w = world(&t, &["Leo", "Sam"], now());
    let maya = Session::new(w.roster.clone(), w.maya.clone());
    let leo = Session::new(w.others[0].2.clone(), w.others[0].1.clone());
    let sam = Session::new(w.others[1].2.clone(), w.others[1].1.clone());
    // Everyone has the latest roster (Sam joined after Leo).
    let maya = Session::new(maya.roster.clone(), maya.keys.clone());
    let leo = Session::new(maya.roster.clone(), leo.keys.clone());
    let sam = Session::new(maya.roster.clone(), sam.keys.clone());
    Three { maya, leo, sam }
}

fn request() -> Body {
    Body::Request {
        request_id: "lr_1".into(),
        agent_id: "claude".into(),
        mode: "proxy".into(),
        duration_ms: 3_600_000,
        reason: "fix the build".into(),
        device_name: "Maya's laptop".into(),
        node_hint: "ab".repeat(32),
    }
}

/// Seal from `from` to `to`'s device, pass it through the envelope checks of `reader`, return what came out.
fn send(from: &Session, to: &Session, reader: &Session, body: Body, sent: u64, tracker: &mut SeqTracker) -> CapacityIn {
    let to_device = to.my_device().unwrap();
    let (payload, _) = wire::seal(from, &to_device, body, sent).unwrap();
    let env = from.seal(&payload, 7, sent).unwrap();
    match reader.open(&env, tracker, now()) {
        Ok(Opened::Capacity(cin)) => cin,
        other => panic!("envelope did not pass: {other:?}"),
    }
}

#[test]
fn only_the_target_device_opens_an_item() {
    let t = three();
    let at = now();
    let cin = send(&t.maya, &t.leo, &t.leo, request(), at, &mut SeqTracker::default());
    let item = wire::open(&t.leo, &t.leo.keys.device_kem().unwrap(), &cin, now()).unwrap();
    assert_eq!(item.body, request());
    assert_eq!(item.from_member, t.maya.my_member().unwrap());
    // Sam's app gets the same envelope through the relay but can't read it.
    let cin_sam = send(&t.maya, &t.leo, &t.sam, request(), at, &mut SeqTracker::default());
    assert_eq!(wire::open(&t.sam, &t.sam.keys.device_kem().unwrap(), &cin_sam, now()), Err(WireReject::NotForMe));
    // Re-addressing it to Sam doesn't help: the HPKE info binds the receiver.
    let mut moved = cin_sam.clone();
    moved.to = t.sam.my_device().unwrap();
    assert_eq!(wire::open(&t.sam, &t.sam.keys.device_kem().unwrap(), &moved, now()), Err(WireReject::Undecryptable));
}

#[test]
fn a_replayed_item_is_refused() {
    let t = three();
    let mut tracker = SeqTracker::default();
    let to_device = t.leo.my_device().unwrap();
    let (payload, msg_id) = wire::seal(&t.maya, &to_device, request(), now()).unwrap();
    let env = t.maya.seal(&payload, 3, now()).unwrap();
    assert!(matches!(t.leo.open(&env, &mut tracker, now()), Ok(Opened::Capacity(_))));
    // The same envelope again: the team replay guard drops it.
    assert_eq!(t.leo.open(&env, &mut tracker, now()), Err(Reject::Replay));
    // And the lend guard remembers the msg id on its own (a second envelope carrying the same item).
    let mut guard = Guard::default();
    assert!(guard.fresh(&msg_id, now()).is_ok());
    assert_eq!(guard.fresh(&msg_id, now()), Err(WireReject::Replay));
    // A grant id is accepted once.
    assert!(guard.accept_grant("lg_1"));
    assert!(!guard.accept_grant("lg_1"));
}

#[test]
fn an_item_dated_more_than_ten_minutes_ahead_is_refused() {
    let t = three();
    let kem = t.leo.keys.device_kem().unwrap();
    let ahead = now() + 11 * 60_000;
    let cin = send(&t.maya, &t.leo, &t.leo, request(), ahead, &mut SeqTracker::default());
    assert_eq!(wire::open(&t.leo, &kem, &cin, now()), Err(WireReject::Future));
    let close = now() + 9 * 60_000;
    let cin = send(&t.maya, &t.leo, &t.leo, request(), close, &mut SeqTracker::default());
    assert!(wire::open(&t.leo, &kem, &cin, now()).is_ok());
}

#[test]
fn an_item_naming_someone_else_is_refused() {
    let t = three();
    let kem = t.leo.keys.device_kem().unwrap();
    let mut cin = send(&t.maya, &t.leo, &t.leo, request(), now(), &mut SeqTracker::default());
    // The envelope says Sam signed it, the sealed item says Maya: refused.
    cin.member = t.sam.my_member().unwrap();
    assert_eq!(wire::open(&t.leo, &kem, &cin, now()), Err(WireReject::Impersonation));
}

#[test]
fn a_long_reason_is_refused() {
    let t = three();
    let kem = t.leo.keys.device_kem().unwrap();
    let mut body = request();
    if let Body::Request { reason, .. } = &mut body {
        *reason = "x".repeat(281);
    }
    let cin = send(&t.maya, &t.leo, &t.leo, body, now(), &mut SeqTracker::default());
    assert_eq!(wire::open(&t.leo, &kem, &cin, now()), Err(WireReject::BadItem));
}

#[test]
fn revoke_and_return_come_only_from_the_right_device() {
    assert!(rules::revoke_allowed("dev-lender", "dev-lender"));
    assert!(!rules::revoke_allowed("dev-lender", "dev-other"));
    assert!(rules::return_allowed("dev-borrower", "dev-borrower"));
    assert!(!rules::return_allowed("dev-borrower", "dev-lender"));
    let asked = vec!["dev-a".to_string()];
    assert!(rules::grant_matches(true, "m", &asked, "m", "dev-a"));
    assert!(!rules::grant_matches(false, "m", &asked, "m", "dev-a"), "the request is no longer open");
    assert!(!rules::grant_matches(true, "m", &asked, "other", "dev-a"), "another member");
    assert!(!rules::grant_matches(true, "m", &asked, "m", "dev-b"), "a device I didn't ask");
}

/// An older build has no `Capacity` kind: its `Payload` doesn't parse the item, which `Session::open` turns into
/// `BadPayload` (after the replay guard has recorded the envelope), so the item is dropped and nothing else happens.
#[test]
fn an_older_build_drops_the_new_payload_safely() {
    #[derive(serde::Deserialize, Debug)]
    #[serde(tag = "t", rename_all = "snake_case")]
    #[allow(dead_code)]
    enum OldPayload {
        Event { event: serde_json::Value },
        RosterChanged { seq: u64 },
    }
    let payload = Payload::Capacity { msg_id: "m".into(), to: "d".into(), enc: "e".into(), ct: "c".into() };
    let json = serde_json::to_vec(&payload).unwrap();
    assert!(serde_json::from_slice::<OldPayload>(&json).is_err());
    // The kinds an older build knows still parse the same way.
    let old = serde_json::to_vec(&Payload::RosterChanged { seq: 4 }).unwrap();
    assert!(serde_json::from_slice::<OldPayload>(&old).is_ok());
    // The current code checks the replay guard before it parses the payload, so a dropped item is still "seen".
    let secure = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/team/secure.rs")).unwrap();
    let observe = secure.find("tracker.observe(").unwrap();
    let parse = secure.find("let payload: Payload = serde_json::from_slice").unwrap();
    assert!(observe < parse);
}

#[test]
fn the_link_mac_binds_the_grant_and_both_nodes() {
    let (a, b, c) = (NodeId([1; 32]), NodeId([2; 32]), NodeId([3; 32]));
    let secret = [9u8; 32];
    let good = handshake_mac(&secret, "lg_1", &a, &b);
    assert_ne!(good, handshake_mac(&secret, "lg_2", &a, &b), "another grant");
    assert_ne!(good, handshake_mac(&secret, "lg_1", &a, &c), "another borrower node");
    assert_ne!(good, handshake_mac(&secret, "lg_1", &c, &b), "another lender node");
    assert_ne!(good, handshake_mac(&[8u8; 32], "lg_1", &a, &b), "another secret");
    assert_eq!(good, handshake_mac(&secret, "lg_1", &a, &b));
}
