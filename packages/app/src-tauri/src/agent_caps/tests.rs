//! Acceptance tests of the capability table. Pure `build_at` tests plus a temp folder for the store.

use super::build::build_at;
use super::facts::def_facts;
use super::*;
use serde_json::json;

const NOW: &str = "2026-11-13T01:02:03Z";

fn dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("pm-agent-caps-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn def(id: &str) -> DefFacts {
    DefFacts { agent_id: id.into(), label: id.into(), ..Default::default() }
}

fn good_hs() -> HandshakeFacts {
    HandshakeFacts {
        at: NOW.into(),
        program_version: Some("1.2.0".into()),
        init_ok: true,
        protocol_version: Some(1),
        load_session: true,
        session_new_ok: true,
        models: vec!["a".into(), "b".into()],
        models_total: 2,
        ..Default::default()
    }
}

/// Definition proofs carry the time they were read, which differs by a second between two calls.
fn without_clock(mut v: serde_json::Value) -> serde_json::Value {
    if let Some(map) = v.as_object_mut() {
        for (_, inner) in map.iter_mut() {
            if let Some(o) = inner.as_object_mut() {
                o.remove("at");
            }
        }
    }
    v
}

fn ago(n: u32) -> String {
    format!("2026-11-13T02:00:{n:02}Z")
}

/// The four fakes of the spec: l0 good, l0 that never asks, l2, l5.
fn four_fakes() -> Vec<AgentCaps> {
    let l0 = build_at(&DefFacts { has_acp: true, ..def("fakenat") }, Some(&good_hs()), &[], NOW);
    let never_asks = build_at(
        &def("gptme"),
        Some(&good_hs()),
        &[SeenFact::EditDone { at: ago(1), asked: false }, SeenFact::ShellDone { at: ago(2), asked: false }],
        NOW,
    );
    let l2 = build_at(&DefFacts { shipped: true, has_headless: true, resumable_headless: true, ..def("fakeone") }, None, &[], NOW);
    let hs5 = HandshakeFacts { at: NOW.into(), no_chat_reason: Some("no chat way found".into()), ..Default::default() };
    let l5 = build_at(&def("faketerm"), Some(&hs5), &[], NOW);
    vec![l0, never_asks, l2, l5]
}

#[test]
fn caps_never_claim_without_source() {
    for caps in four_fakes() {
        assert!(caps.check().is_empty(), "{}: {:?}", caps.agent_id, caps.check());
    }
    // An empty build claims nothing at all.
    let empty = build_at(&def("x"), None, &[], NOW);
    for c in [&empty.chat, &empty.resume, &empty.shows_steps, &empty.edits_files, &empty.asks_before_edit, &empty.model_pick, &empty.stop, &empty.images, &empty.usage, &empty.read_only] {
        assert_eq!(c, &Cap::default());
    }
    // The checker itself catches a claim with no proof.
    let mut bad = empty.clone();
    bad.images = Cap { value: Tri::Yes, source: Source::Unknown, proof: String::new(), at: None };
    assert!(!bad.check().is_empty());
}

#[test]
fn caps_no_also_needs_proof() {
    for caps in four_fakes() {
        for c in [&caps.chat, &caps.resume, &caps.images, &caps.model_pick, &caps.asks_before_edit, &caps.asks_before_shell, &caps.read_only] {
            if c.value == Tri::No {
                assert_ne!(c.source, Source::Unknown);
                assert!(!c.proof.is_empty());
                assert!(c.at.is_some());
            }
        }
    }
    let mut bad = four_fakes().remove(0);
    bad.images = Cap { value: Tri::No, source: Source::Handshake, proof: String::new(), at: None };
    assert!(bad.check().iter().any(|m| m.contains("images")));
}

#[test]
fn caps_same_for_mcp_and_ui() {
    for caps in four_fakes() {
        let json = caps_to_json(&caps);
        let back: AgentCaps = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back, caps);
    }
    // The command and `caps_json` are one function, for a registered agent too.
    let id = crate::tui::registered_agent_ids().into_iter().next().unwrap();
    let via_command = crate::commands::agent_caps_for_test(&id).unwrap();
    assert_eq!(without_clock(via_command), without_clock(caps_json(&id)));
    assert!(crate::commands::agent_caps_for_test("  ").is_err());
}

#[test]
fn gptme_style_fake_shows_no_permission() {
    let caps = four_fakes().remove(1);
    assert_eq!(caps.asks_before_edit.value, Tri::No);
    assert_eq!(caps.asks_before_edit.source, Source::Seen);
    assert_eq!(caps.asks_before_shell.value, Tri::No);
    assert_eq!(caps.edits_files.value, Tri::Yes);
    // Nothing else leaks in: no tool card was seen.
    assert_eq!(caps.shows_steps.value, Tri::Unknown);
}

#[test]
fn seen_overrides_definition() {
    let d = DefFacts { shipped: true, read_only_mapped: true, resumable_headless: true, has_acp: true, ..def("shipped") };
    let before = build_at(&d, None, &[], NOW);
    assert_eq!(before.chat.source, Source::Definition);
    // A seen No beats a definition Yes; a handshake No beats it too.
    let hs = HandshakeFacts { at: NOW.into(), init_ok: true, protocol_version: Some(1), ..Default::default() };
    let with_hs = build_at(&d, Some(&hs), &[], NOW);
    assert_eq!(with_hs.resume.value, Tri::No);
    assert_eq!(with_hs.resume.source, Source::Handshake);
    let seen = build_at(&d, Some(&good_hs()), &[SeenFact::StopIgnored { at: ago(3) }, SeenFact::StopWorked { at: ago(4), ms: 900 }], NOW);
    assert_eq!(seen.stop.value, Tri::Yes);
    assert_eq!(seen.stop.proof, "Stop ended the turn in 900 ms");
    let seen_no = build_at(&d, None, &[SeenFact::StopWorked { at: ago(3), ms: 900 }, SeenFact::StopIgnored { at: ago(4) }], NOW);
    assert_eq!((seen_no.stop.value, seen_no.stop.source), (Tri::No, Source::Seen));
}

#[test]
fn handshake_false_flags_are_no_not_unknown() {
    let hs = HandshakeFacts { at: NOW.into(), init_ok: true, protocol_version: Some(1), session_new_ok: true, ..Default::default() };
    let caps = build_at(&def("quiet"), Some(&hs), &[], NOW);
    assert_eq!((caps.resume.value, caps.resume.source), (Tri::No, Source::Handshake));
    assert_eq!((caps.images.value, caps.images.source), (Tri::No, Source::Handshake));
    assert_eq!((caps.model_pick.value, caps.model_pick.source), (Tri::No, Source::Handshake));
    assert!(caps.models.is_empty());
    // Auth needed: session/new did not answer, so models stay unknown (not No).
    let auth = HandshakeFacts { session_new_ok: false, ..hs };
    assert_eq!(build_at(&def("quiet"), Some(&auth), &[], NOW).model_pick.value, Tri::Unknown);
}

#[test]
fn terminal_only_chat_is_no_with_check_proof() {
    let caps = four_fakes().remove(3);
    assert_eq!((caps.chat.value, caps.chat.source), (Tri::No, Source::Check));
    assert!(caps.chat.proof.contains("no chat way"));
    assert_eq!(caps.level, Level::L5);
    assert_eq!(caps.level_proof.value, Tri::Yes);
    assert!(caps.check().is_empty());
}

#[test]
fn models_capped_at_50_total_kept() {
    let hs = HandshakeFacts {
        models: (0..450).map(|i| format!("m{i}")).collect(),
        models_total: 450,
        ..good_hs()
    };
    let caps = build_at(&def("kilo"), Some(&hs), &[], NOW);
    assert_eq!(caps.models.len(), MAX_MODELS);
    assert_eq!(caps.models[0], "m0");
    assert_eq!(caps.models_total, 450);
    assert_eq!(caps.model_pick.value, Tri::Yes);
}

#[test]
fn broken_store_file_reads_as_empty() {
    let d = dir("broken");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("fakenat.json"), "{ not json").unwrap();
    let empty = store::load(&d, "fakenat");
    assert!(empty.handshake.is_none() && empty.seen.is_empty());
    // A missing file and a bad id read as empty too, and writing over a broken file works.
    assert!(store::load(&d, "nope").handshake.is_none());
    assert!(store::load(&d, "../x").seen.is_empty());
    assert!(record_handshake_in(&d, "../x", &good_hs()).is_err());
    record_handshake_in(&d, "fakenat", &good_hs()).unwrap();
    assert_eq!(store::load(&d, "fakenat").handshake, Some(good_hs()));
    // Seen facts are kept once per kind, newest kept.
    for i in 0..60u32 {
        record_seen_in(&d, "fakenat", SeenFact::ToolCall { at: format!("t{i}") }).unwrap();
    }
    let kept = store::load(&d, "fakenat").seen;
    assert_eq!(kept.len(), 1);
    assert_eq!(kept.last(), Some(&SeenFact::ToolCall { at: "t59".into() }));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn caps_json_shape_is_pinned() {
    let caps = build_at(&DefFacts { has_acp: true, ..def("fakenat") }, Some(&good_hs()), &[], "2026-11-13T01:02:03Z");
    let mut caps = caps;
    caps.label = "Fakenat".into();
    let hs_cap = |proof: &str, value: &str| json!({"value": value, "source": "handshake", "proof": proof, "at": NOW});
    let none = json!({"value": "unknown", "source": "unknown", "proof": "", "at": null});
    let expected = json!({
        "schema": 1,
        "agent_id": "fakenat",
        "label": "Fakenat",
        "level": "l0",
        "level_proof": hs_cap("answered initialize, protocol 1", "yes"),
        "program_version": "1.2.0",
        "chat": hs_cap("answered initialize, protocol 1", "yes"),
        "resume": hs_cap("said it can load or resume a chat", "yes"),
        "shows_steps": none,
        "edits_files": none,
        "asks_before_edit": none,
        "asks_before_shell": none,
        "model_pick": hs_cap("new-chat reply listed 2 models", "yes"),
        "models": ["a", "b"],
        "models_total": 2,
        "stop": none,
        "images": hs_cap("said it does not take pictures", "no"),
        "usage": none,
        "read_only": none,
        "needs_repair": false,
    });
    assert_eq!(caps_to_json(&caps), expected);
}

#[test]
fn read_only_matches_run_table() {
    let ids = crate::tui::registered_agent_ids();
    assert!(!ids.is_empty());
    for id in &ids {
        let table = crate::agent_runs::read_only_run_table(id);
        let caps = for_agent_in(&dir("ro"), id);
        let facts = def_facts(id);
        if facts.shipped {
            assert_eq!(caps.read_only.value == Tri::Yes, table, "{id}: caps and run table disagree");
            assert_ne!(caps.read_only.value, Tri::Unknown, "{id}");
        }
        // A terminal or headless run's own answer is a part of the table: never more than it.
        if crate::agent_runs::read_only_supported(id, false) {
            assert!(table, "{id}");
        }
    }
}

#[test]
fn ladder_written_definition_is_not_a_definition_proof() {
    // The ladder just wrote this file: it has a chat table and a headless table, but it is not shipped.
    let d = DefFacts {
        has_acp: true,
        has_headless: true,
        resumable_headless: true,
        read_only_mapped: true,
        definition_models: vec!["m".into()],
        ..def("written")
    };
    let caps = build_at(&d, None, &[], NOW);
    for c in [&caps.chat, &caps.resume, &caps.model_pick, &caps.read_only] {
        assert_eq!(c.source, Source::Unknown);
        assert_eq!(c.value, Tri::Unknown);
    }
    assert!(caps.models.is_empty());
    assert_eq!(caps.level, Level::L5);
    // Once the agent answers, the proof is the handshake, not the file.
    let with = build_at(&d, Some(&good_hs()), &[], NOW);
    assert_eq!(with.chat.source, Source::Handshake);
}

// ---- checkpoint-1 fixes -------------------------------------------------------------------------------------------

#[test]
fn shipped_chat_table_alone_leaves_chat_unknown_with_a_definition_note() {
    let d = DefFacts { shipped: true, has_acp: true, ..def("shipped") };
    let caps = build_at(&d, None, &[], NOW);
    assert_eq!((caps.chat.value, caps.chat.source), (Tri::Unknown, Source::Definition));
    assert!(caps.chat.proof.contains("not checked"), "{}", caps.chat.proof);
    assert_eq!(caps.level, Level::L5);
    assert!(caps.check().is_empty(), "{:?}", caps.check());
    // The hello is what makes it a yes.
    let hs = build_at(&d, Some(&good_hs()), &[], NOW);
    assert_eq!((hs.chat.value, hs.chat.source), (Tri::Yes, Source::Handshake));
    // A shipped one-task table still counts (spec 1.3, l2).
    let l2 = build_at(&DefFacts { shipped: true, has_headless: true, ..def("one") }, None, &[], NOW);
    assert_eq!((l2.chat.value, l2.chat.source, l2.level), (Tri::Yes, Source::Definition, Level::L2));
}

#[test]
fn definition_proofs_carry_one_fixed_time() {
    let d = DefFacts { shipped: true, has_headless: true, read_only_mapped: true, ..def("fixed") };
    let a = build(&d, None, &[]);
    let b = build(&d, None, &[]);
    assert_eq!(a, b, "two reads of the same table agree");
}

#[test]
fn terminal_only_leaves_chat_unknown_in_the_table() {
    let hs = HandshakeFacts { at: NOW.into(), terminal_only: true, ..Default::default() };
    let caps = build_at(&def("termonly"), Some(&hs), &[], NOW);
    assert_eq!((caps.chat.value, caps.chat.source), (Tri::Unknown, Source::Unknown));
    assert!(caps.level_proof.proof.contains("chat not checked"), "{}", caps.level_proof.proof);
    assert!(caps.check().is_empty());
}

#[test]
fn a_recorded_no_is_not_dropped_by_later_facts() {
    let d = dir("fifo");
    record_seen_in(&d, "busy", SeenFact::EditDone { at: ago(1), asked: false }).unwrap();
    for n in 0..120 {
        record_seen_in(&d, "busy", SeenFact::ToolCall { at: ago(2 + n % 50) }).unwrap();
        record_seen_in(&d, "busy", SeenFact::Usage { at: ago(2 + n % 50) }).unwrap();
    }
    let caps = for_agent_in(&d, "busy");
    assert_eq!((caps.asks_before_edit.value, caps.asks_before_edit.source), (Tri::No, Source::Seen));
    assert_eq!(caps.edits_files.value, Tri::Yes);
    // One fact per kind: the log stays tiny.
    assert!(store::load(&d, "busy").seen.len() <= 6);
    // A later "asked" edit does not turn the No into a Yes.
    record_seen_in(&d, "busy", SeenFact::EditDone { at: ago(9), asked: true }).unwrap();
    assert_eq!(for_agent_in(&d, "busy").asks_before_edit.value, Tri::No);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn newest_fact_per_kind_wins() {
    let d = dir("latest");
    record_seen_in(&d, "a", SeenFact::StopWorked { at: ago(1), ms: 100 }).unwrap();
    record_seen_in(&d, "a", SeenFact::StopWorked { at: ago(2), ms: 200 }).unwrap();
    let file = store::load(&d, "a");
    assert_eq!(file.seen, vec![SeenFact::StopWorked { at: ago(2), ms: 200 }]);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn parallel_writes_lose_no_fact() {
    let d = dir("parallel");
    let kinds = |n: usize| match n % 3 {
        0 => SeenFact::ToolCall { at: ago(1) },
        1 => SeenFact::EditDone { at: ago(2), asked: true },
        _ => SeenFact::Usage { at: ago(3) },
    };
    let threads: Vec<_> = (0..12)
        .map(|n| {
            let d = d.clone();
            std::thread::spawn(move || {
                for _ in 0..5 {
                    record_seen_in(&d, "par", kinds(n)).expect("a write never fails on the shared temp file");
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    assert_eq!(store::load(&d, "par").seen.len(), 3);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn forgetting_an_agent_clears_its_entry_and_a_new_hello_clears_what_was_seen() {
    let d = dir("forget");
    record_handshake_in(&d, "foo", &good_hs()).unwrap();
    record_seen_in(&d, "foo", SeenFact::ToolCall { at: ago(1) }).unwrap();
    assert_eq!(for_agent_in(&d, "foo").chat.value, Tri::Yes);
    record_handshake_in(&d, "foo", &good_hs()).unwrap();
    assert!(store::load(&d, "foo").seen.is_empty(), "a new add is a new program");
    forget_in(&d, "foo");
    let caps = for_agent_in(&d, "foo");
    assert_eq!(caps.chat.value, Tri::Unknown);
    forget_in(&d, "foo");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn live_turn_facts_come_once_and_know_if_the_agent_asked() {
    use crate::acp::types::{SessionUpdate, ToolCall, ToolCallUpdate, ToolStatus};
    let mut seen = live::TurnSeen::default();
    let call = |id: &str, kind: &str| SessionUpdate::ToolCall(ToolCall { tool_call_id: id.into(), kind: kind.into(), ..Default::default() });
    let done = |id: &str| SessionUpdate::ToolCallUpdate(ToolCallUpdate { tool_call_id: id.into(), status: Some(ToolStatus::Completed), ..Default::default() });
    let first = seen.on_update(&call("w1", "edit"));
    assert!(matches!(first.as_slice(), [SeenFact::ToolCall { .. }]));
    assert!(seen.on_update(&call("w2", "edit")).is_empty(), "the same fact is not reported twice in a turn");
    // w1 was never asked about: the edit finished without a question.
    let facts = seen.on_update(&done("w1"));
    assert!(matches!(facts.as_slice(), [SeenFact::EditDone { asked: false, .. }]), "{facts:?}");
    seen.asked("w2");
    let facts = seen.on_update(&done("w2"));
    assert!(matches!(facts.as_slice(), [SeenFact::EditDone { asked: true, .. }]), "{facts:?}");
    seen.on_update(&call("c1", "execute"));
    assert!(matches!(seen.on_update(&done("c1")).as_slice(), [SeenFact::ShellDone { asked: false, .. }]));
    seen.reset();
    assert!(!seen.on_update(&call("x", "read")).is_empty(), "a new turn reports again");
}
