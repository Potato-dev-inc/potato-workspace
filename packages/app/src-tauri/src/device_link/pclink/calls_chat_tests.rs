//! P1.7 chat feed rows: their levels, the press-and-hold rule for a marked (own) and an unmarked PC, the `app` frames of the feed,
//! and two real instances on the in-memory net sending a message and getting the items frame back.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::tests::{Fake, call_as, instance_with_services};
use super::*;
use crate::device_link::tests::{pair, until};
use crate::p2p::memory::MemoryNet;

/// This block's rows: `(command, least level)`, all naming a chat pane.
fn rows() -> Vec<(&'static str, Level)> {
    use Level::*;
    vec![
        ("session_chat_open", Watch),
        ("session_chat_close", Watch),
        ("chat_earlier", Watch),
        ("chat_picture", Watch),
        ("acp_chat_cancel", Answer),
        ("pane_message_send", Answer),
        ("pane_message_cancel", Answer),
        ("pane_message_hold", Answer),
        ("pane_message_edit", Answer),
        ("pane_messages_list", Answer),
        ("acp_chat_keep_waiting", Answer),
        ("acp_chat_take_back", Full),
        ("acp_chat_set_auto_allow", Full),
        ("acp_chat_set_agent_answering", Full),
        ("acp_chat_warm", Answer),
    ]
}

/// One body that carries every argument any row of this block reads.
fn body_of() -> Value {
    json!({ "paneId": "p1", "surface": "s1", "before": "i9", "path": "a.png", "text": "hi", "messageId": "m1", "hold": false, "kind": "edit", "on": false, "allowed": false })
}

#[test]
fn the_block_names_exactly_these_rows_at_these_levels() {
    let ours: Vec<_> = calls::TABLE.iter().filter(|(c, _, _)| calls_chat::CHAT_ROWS.contains(c)).map(|(c, l, p)| (*c, *l, *p)).collect();
    assert_eq!(ours, rows().into_iter().map(|(c, l)| (c, l, true)).collect::<Vec<_>>());
    assert_eq!(calls_chat::CHAT_ROWS, rows().iter().map(|(c, _)| *c).collect::<Vec<_>>().as_slice());
    // Nothing that reads or writes a login, a token or a key is among them.
    for (cmd, _) in rows() {
        assert!(!calls::refused(cmd), "{cmd}");
    }
}

#[test]
fn each_chat_row_needs_its_level_and_a_watch_pc_cannot_send_or_change_anything() {
    let asks = Asks::new();
    for (cmd, needs) in rows() {
        let target = format!("/pclink/call/{cmd}");
        let body = body_of();
        for level in [Level::Watch, Level::Answer, Level::Full] {
            let fake = Fake::default();
            let (status, answer) = call_as(Some(level), false, &fake, &asks, "POST", &target, &body);
            if level >= needs {
                assert_eq!(status, 200, "{level:?} {cmd}: {answer}");
                assert_eq!(fake.calls().len(), 1, "{level:?} {cmd}");
            } else {
                assert_eq!((status, answer["code"].as_str(), answer["needs"].as_str()), (403, Some("DEVICE_NOT_ALLOWED"), Some(needs.as_str())), "{level:?} must not {cmd}");
                assert!(fake.calls().is_empty(), "{level:?} {cmd} reached nothing");
            }
        }
        // Off: nothing. A chat its own PC shut for other PCs: nothing, even at Full. No pane named: refused before the app.
        let fake = Fake::default();
        assert_eq!(call_as(None, false, &fake, &asks, "POST", &target, &body).1["code"], "REMOTE_OFF", "{cmd}");
        fake.locked.lock().unwrap().push("p1".into());
        assert_eq!(call_as(Some(Level::Full), true, &fake, &asks, "POST", &target, &body).1["code"], "AGENT_LOCKED", "{cmd}");
        assert_eq!(call_as(Some(Level::Full), true, &Fake::default(), &asks, "POST", &target, &json!({})).1["code"], "INVALID_ARGUMENT", "{cmd}");
        assert!(fake.calls().is_empty());
    }
}

#[test]
fn what_lets_the_agent_act_without_asking_needs_a_hold_from_a_pc_that_is_not_the_persons_own() {
    // An unmarked PC (another account, an invite): turning ON needs the hold; turning off and the hold itself are fine.
    for (cmd, on_key) in [("acp_chat_set_auto_allow", "on"), ("acp_chat_set_agent_answering", "allowed")] {
        let on = |extra: Value| {
            let mut body = json!({ "paneId": "p1", "kind": "edit", on_key: true });
            body.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            body
        };
        let held = calls_chat::gate(cmd, &on(json!({ "hold": true })));
        let none = calls_chat::gate(cmd, &on(json!({})));
        let off = calls_chat::gate(cmd, &json!({ "paneId": "p1", "kind": "edit", on_key: false }));
        assert!(held.is_none() && off.is_none(), "{cmd}: a hold, or turning off, passes");
        let refused = none.expect("no hold, no marker: refused");
        assert_eq!((refused.0, refused.1["code"].as_str()), (409, Some("NEEDS_HOLD")), "{cmd}");
        // The person's own PC (the marker, set by `handle`) is not asked.
        assert!(calls_chat::gate(cmd, &on(json!({ "_marked": true }))).is_none(), "{cmd}: marked");
        // A missing switch is a bad request, not a free pass.
        assert_eq!(calls_chat::gate(cmd, &json!({ "paneId": "p1" })).unwrap().0, 400, "{cmd}");
    }
    // The other rows are not gated here.
    assert!(calls_chat::gate("pane_message_send", &json!({ "paneId": "p1" })).is_none());
}

#[test]
fn a_feed_goes_out_as_frames_only_while_a_paired_pc_holds_it_open() {
    assert!(!calls_chat::watching("watched-pane"));
    // The one holder per (PC, surface): two surfaces of one PC are two holders, and the pane is watched until the last lets go.
    let (a, b) = (json!({ "surface": "s1" }), json!({ "surface": "s2" }));
    calls_chat::watch("watched-pane", &calls_chat::holder_of("n1", &a), true);
    calls_chat::watch("watched-pane", &calls_chat::holder_of("n1", &b), true);
    assert!(calls_chat::watching("watched-pane"));
    calls_chat::watch("watched-pane", &calls_chat::holder_of("n1", &a), false);
    assert!(calls_chat::watching("watched-pane"));
    calls_chat::watch("watched-pane", &calls_chat::holder_of("n1", &b), false);
    assert!(!calls_chat::watching("watched-pane"));
    // Another PC's holder is never the same one, even with the same surface name.
    assert_ne!(calls_chat::holder_of("n1", &a), calls_chat::holder_of("n2", &a));
}

#[test]
fn the_marker_and_the_level_reach_a_row_from_the_far_side_only_and_the_asker_cannot_set_them() {
    let asks = Asks::new();
    let fake = Fake::default();
    let body = json!({ "paneId": "p1", "text": "hi", "_marked": true, "_full": true });
    assert_eq!(call_as(Some(Level::Answer), false, &fake, &asks, "POST", "/pclink/call/pane_message_send", &body).0, 200);
    assert_eq!(call_as(Some(Level::Full), true, &fake, &asks, "POST", "/pclink/call/pane_message_send", &body).0, 200);
    let seen = fake.call_args.lock().unwrap().clone();
    assert_eq!((seen[0]["_marked"].clone(), seen[0]["_full"].clone()), (json!(false), json!(false)), "an unmarked Answer PC cannot claim either");
    assert_eq!((seen[1]["_marked"].clone(), seen[1]["_full"].clone()), (json!(true), json!(true)), "a marked Full PC is told both");
}

#[test]
fn the_feed_frames_are_allowlisted_one_per_event_and_dropped_for_a_session_with_no_name() {
    let items = events::app_frame("session-chat-items", &json!({ "paneId": "p1", "items": [], "reset": true }));
    let status = events::app_frame("session-chat-status", &json!({ "paneId": "p1", "waitingFor": null }));
    let source = events::app_frame("session-chat-source", &json!({ "paneId": "p1", "source": "file" }));
    for frame in [&items, &status, &source] {
        for level in [Level::Watch, Level::Answer, Level::Full] {
            assert_eq!(events::view(level, frame).as_deref(), Some(frame.as_str()), "{level:?}");
        }
        assert_eq!(events::app_pane(frame).as_deref(), Some("p1"));
    }
    // The message box's queue is Answer's to read (as its route is); a Watch PC sees no frame of it.
    let queue = events::app_frame("pane-outbox", &json!({ "paneId": "p1", "messages": [] }));
    assert!(events::view(Level::Watch, &queue).is_none());
    assert_eq!(events::view(Level::Answer, &queue).as_deref(), Some(queue.as_str()));
    // A frame with no session is held to no session's rule, so it is dropped.
    for dropped in [
        events::app_frame("session-chat-items", &json!({ "items": [] })),
        events::app_frame("pane-outbox", &json!({ "messages": [] })),
        events::app_frame("session-chat-items-extra", &json!({ "paneId": "p1" })),
    ] {
        assert!(events::view(Level::Full, &dropped).is_none(), "{dropped}");
    }
    // The window's old `pane-outbox` log line becomes the same frame, at Answer and above only.
    let line = "event: pane-outbox\ndata: {\"paneId\":\"p1\",\"messages\":[]}\n\n";
    assert!(events::view(Level::Watch, line).is_none());
    assert_eq!(events::view(Level::Answer, line).as_deref(), Some(queue.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_instances_one_sends_a_message_and_the_items_frame_comes_back_and_a_watch_pc_cannot() {
    let net = MemoryNet::new();
    let (fake_a, fake_b) = (Arc::new(Fake::default()), Arc::new(Fake::default()));
    let a = instance_with_services("alpha", &net, fake_a);
    let b = instance_with_services("beta", &net, fake_b.clone());
    pair(&b, &a).await;
    let (a_node, b_node) = (a.node(), b.node());
    let got: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = got.clone();
    a.link.set_event_sink(Arc::new(move |_, f| sink.lock().unwrap().push(f.to_string())));
    a.link.subscribe(&b_node).unwrap();
    let send = json!({ "paneId": "p1", "text": "go on" });

    // Watch reads the feed but cannot send.
    b.link.set_permission(&a_node, true, Some("watch")).unwrap();
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/session_chat_open", Some(json!({ "paneId": "p1", "surface": "s" }))).await.unwrap().0, 200);
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/pane_message_send", Some(send.clone())).await.unwrap().0, 403);
    assert!(!fake_b.calls().iter().any(|c| c.starts_with("call pane_message_send")));

    // Answer: the message goes, the far PC was told "not marked, not full", and the items frame arrives.
    b.link.set_permission(&a_node, true, Some("answer")).unwrap();
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/pane_message_send", Some(send.clone())).await.unwrap().0, 200);
    until("the items frame", || got.lock().unwrap().iter().any(|f| f.starts_with("event: app") && f.contains("session-chat-items") && f.contains("go on"))).await;
    let told = fake_b.call_args.lock().unwrap().last().cloned().unwrap();
    assert_eq!((told["_marked"].clone(), told["_full"].clone()), (json!(false), json!(false)));

    // The person's own PC (the account marker): Full by default, and the far side tells the row so (no hold asked).
    b.link.trust.grant_account_default(&crate::device_link::node_of(&a_node).unwrap()).unwrap();
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/acp_chat_set_auto_allow", Some(json!({ "paneId": "p1", "kind": "edit", "on": true }))).await.unwrap().0, 200);
    let told = fake_b.call_args.lock().unwrap().last().cloned().unwrap();
    assert_eq!((told["_marked"].clone(), told["_full"].clone()), (json!(true), json!(true)));
    // Lowered by the person: still marked, but only Answer: a Full row is refused at the door.
    b.link.set_permission(&a_node, true, Some("answer")).unwrap();
    assert_eq!(a.link.request(&b_node, "POST", "/pclink/call/acp_chat_set_auto_allow", Some(json!({ "paneId": "p1", "kind": "edit", "on": true }))).await.unwrap().0, 403);
    a.link.unsubscribe(&b_node).unwrap();
}
