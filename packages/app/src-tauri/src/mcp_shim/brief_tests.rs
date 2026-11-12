use super::*;

fn terminal_run() -> Value {
    json!({
        "handle": "h1", "operation_id": "op", "turn_id": "turn-0", "status": "completed",
        "stage": null, "result": "done", "result_capture": "authoritative", "acceptance_status": "not_checked",
        "verified": null, "verified_reason": "No checks were configured.", "prompt": null, "error": null,
        "pane_id": null, "duration_ms": 5, "revision": 3, "next_cursor": 3, "name": null,
        "requested_model": null, "resolved_model": "m1", "model_mismatch": false, "warnings": [],
        "guarantees": {
            "read_only": {"requested": false, "enforcement": "none", "proof": null, "proof_reason": "not_requested"},
            "isolation": {"mode": "project_folder"}, "checks": {"state": "none", "ran": [], "by": "app"},
            "model": {"asked": null, "confirmed": false}
        },
        "receipt": {"build_id": "b", "structured_result": {"summary": "all good"}, "timing": {"total_ms": 9, "warm": false}}
    })
}

fn no_nulls(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Object(o) => o.values().all(no_nulls),
        Value::Array(a) => a.iter().all(no_nulls),
        _ => true,
    }
}

#[test]
fn brief_keeps_what_the_caller_reads_next_and_leaves_out_nulls_and_ids() {
    let mut value = terminal_run();
    apply(&mut value, Shape { brief: true, max_result_chars: None });
    assert_eq!(value["handle"], "h1");
    assert_eq!(value["summary"], "all good");
    assert_eq!(value["model"], "m1");
    assert_eq!(value["next"], json!(["followup_task", "close_agent"]));
    for gone in ["operation_id", "turn_id", "receipt", "build_id", "prompt", "error", "guarantees", "duration_ms"] {
        assert!(value.get(gone).is_none(), "{gone} should be left out: {value}");
    }
    // verified is the one null that stays: it says nothing was verified.
    assert!(value["verified"].is_null() && value.as_object().unwrap().contains_key("verified"));
    let mut rest = value.clone();
    rest.as_object_mut().unwrap().remove("verified");
    assert!(no_nulls(&rest), "{value}");
    assert!(value.to_string().len() < 1200, "{} bytes", value.to_string().len());
}

#[test]
fn brief_shows_only_the_guarantees_that_say_something() {
    let mut run = terminal_run();
    run["guarantees"]["read_only"] = json!({"requested": true, "enforcement": "cli_flag", "proof": "tree_unchanged"});
    run["guarantees"]["checks"] = json!({"state": "passed", "ran": ["command_exits npm test"], "by": "app"});
    run["verified"] = json!(true);
    run["verified_reason"] = Value::Null;
    apply(&mut run, Shape { brief: true, max_result_chars: None });
    assert_eq!(run["guarantees"]["read_only"]["proof"], "tree_unchanged");
    assert_eq!(run["guarantees"]["checks"]["state"], "passed");
    assert!(run["guarantees"].get("isolation").is_none() && run["guarantees"].get("model").is_none());
    assert_eq!(run["verified"], true);
    assert!(run.get("verified_reason").is_none());
}

#[test]
fn full_changes_nothing_unless_a_cap_is_named() {
    let mut value = terminal_run();
    let before = value.clone();
    apply(&mut value, Shape { brief: false, max_result_chars: None });
    assert_eq!(value, before);
}

#[test]
fn a_long_result_is_cut_with_a_handle_to_the_rest() {
    let mut value = terminal_run();
    value["result"] = json!("x".repeat(500));
    apply(&mut value, Shape { brief: false, max_result_chars: Some(200) });
    assert_eq!(value["result"].as_str().unwrap().len(), 200);
    assert_eq!(value["result_truncated"], true);
    assert_eq!(value["result_chars"], 500);
    assert_eq!(value["more"], json!({"tool": "agent_transcript", "args": {"handle": "h1"}}));
    // Brief caps at 12000 by default, so a short result is untouched.
    let mut short = terminal_run();
    apply(&mut short, Shape { brief: true, max_result_chars: None });
    assert!(short.get("result_truncated").is_none() && short.get("more").is_none());
}

#[test]
fn wait_agents_lists_are_shaped_run_by_run() {
    let mut value = json!({"agents": [terminal_run(), terminal_run()], "reason": "completed", "waited_ms": 3});
    apply(&mut value, Shape { brief: true, max_result_chars: None });
    assert_eq!(value["agents"][1]["summary"], "all good");
    assert!(value["agents"][0].get("receipt").is_none());
    assert_eq!(value["reason"], "completed");
}

#[test]
fn the_arguments_are_parsed_and_removed() {
    let mut args = json!({"task": "t", "detail": "brief", "max_result_chars": 500});
    let shape = take_shape("run_agent", &mut args).unwrap().unwrap();
    assert_eq!(shape, Shape { brief: true, max_result_chars: Some(500) });
    assert_eq!(args, json!({"task": "t"}));
    assert!(take_shape("run_agent", &mut json!({"detail": "tiny"})).is_err());
    assert!(take_shape("run_agent", &mut json!({"max_result_chars": 5})).is_err());
    assert_eq!(take_shape("list_agents", &mut json!({"detail": "brief"})).unwrap(), None);
}
