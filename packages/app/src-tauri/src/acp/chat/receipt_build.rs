//! The chat's receipt, built from `receipt::ReceiptInputs` (the facts live in `pm_core::acp::chat::receipt`). The receipt type itself is the
//! app's (`agent_runs::RunReceipt`), so this half stays here.

use serde_json::{json, Value};

use crate::acp::chat::receipt::{outcome_of, ReceiptInputs};
use crate::agent_runs::guarantees::{checks_guarantee, read_only_guarantee, Guarantees, IsolationGuarantee, ModelGuarantee};
use crate::agent_runs::{RunReceipt, RunTiming};

pub fn build(inputs: &ReceiptInputs) -> RunReceipt {
    // The result is built here from facts; the agent is never asked to print it.
    let structured = if inputs.final_turn || inputs.status == "waiting_input" {
        let facts = inputs.facts;
        Some(crate::agent_runs::structured::build(inputs.reply, &facts.files_changed, &facts.commands, &facts.open_questions))
    } else {
        None
    };
    let result_capture = if inputs.final_turn {
        "authoritative"
    } else {
        "pending"
    };
    let total = inputs.checks_total;
    let checks = if total == 0 {
        "none configured".to_string()
    } else if let Some(results) = inputs.results {
        format!("{}/{} passed", results.iter().filter(|r| r.passed).count(), total)
    } else {
        format!("0/{total} passed (pending)")
    };
    let mut not_verified = Vec::new();
    if total == 0 {
        not_verified.push("no checks configured".to_string());
    }
    let model_confirmed = match (inputs.requested_model, inputs.model_in_use) {
        (Some(asked), Some(ran)) => crate::agent_runs::persist::model_matches(asked, ran),
        _ => false,
    };
    if inputs.final_turn && inputs.requested_model.is_some() && !model_confirmed {
        not_verified.push("model not confirmed".to_string());
    }
    let note = |key: &str| inputs.lane_note.and_then(|n| n.get(key)).and_then(Value::as_str).map(str::to_string);
    let account_source = inputs.account_source.map(str::to_string).unwrap_or_else(|| {
        if inputs.account.is_some() { crate::accounts::helper::SOURCE_EXPLICIT } else { crate::accounts::helper::SOURCE_CLI_LOGIN }.to_string()
    });
    let guarantees = Guarantees {
        read_only: read_only_guarantee(inputs.read_only, inputs.read_only_enforcement, inputs.read_only_proof, inputs.final_turn),
        isolation: IsolationGuarantee { mode: "project_folder".into(), branch: None },
        checks: checks_guarantee(inputs.checks, inputs.results, inputs.final_turn),
        model: ModelGuarantee { asked: inputs.requested_model.map(str::to_string), confirmed: model_confirmed },
    };
    if let Some(agent) = inputs.read_only_cannot.filter(|_| !inputs.read_only) {
        not_verified.push(crate::agent_runs::read_only_cannot_note(agent));
    }
    if guarantees.read_only.proof.as_deref() == Some(crate::agent_runs::tree_proof::TREE_CHANGED) {
        not_verified.push("a read-only run changed files in the folder".to_string());
    }
    RunReceipt {
        backend: "acp".into(),
        model: inputs.model_in_use.map(str::to_string).or_else(|| inputs.requested_model.map(str::to_string)),
        read_only: if inputs.read_only { "enforced" } else { "off" }.into(),
        checks,
        result_capture: result_capture.into(),
        structured_result: structured,
        not_verified,
        outcome: outcome_of(inputs.status, total, inputs.results).into(),
        build_id: env!("PM_BUILD_ID").to_string(),
        standby_used: inputs.warm,
        account_used: inputs.account.map(str::to_string),
        account_source,
        fallback: None,
        run_mode: None,
        headless_ignored: None,
        headless_forced: None,
        model_note: None,
        lane_used: note("lane_used"),
        lane_reason: note("lane_reason"),
        lane_fallback: inputs.lane_note.and_then(|n| n.get("lane_fallback")).cloned(),
        agent_definition: None,
        worktree: None,
        usage_limit: None,
        guarantees: Some(guarantees),
        timing: Some(RunTiming { queue_ms: None, start_ms: None, first_output_ms: None, total_ms: None, warm: inputs.warm }),
    }
}

/// The receipt of a chat as a JSON value for its answers.
pub fn receipt_value(receipt: &RunReceipt) -> Value {
    serde_json::to_value(receipt).unwrap_or_else(|_| json!(null))
}

