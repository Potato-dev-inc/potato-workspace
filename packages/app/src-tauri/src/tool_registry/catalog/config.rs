//! Catalog entry: `workspace_config`, the one tool that changes the app's setup (settings, standby helpers). It maps onto the
//! same plan/apply routes the command line uses (`bridge/routes/config.rs`; logic `crate::config_plan`). Advanced tier:
//! callable by name, not listed by default.

use super::super::schema::*;
use super::super::types::{ToolDefinition, ToolSafety};
use serde_json::json;

pub(super) fn tools() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: "workspace_config",
        description: "Change how the person's Potato Workspace is set up, in two steps. op=plan with ops:[...] returns {plan_id, lines} (plain lines of what would change) and changes NOTHING: show those lines to the person. op=apply with plan_id runs exactly that plan, but only after the person taps Allow on a card in their Inbox: the call fails with CONSENT_PENDING until they answer (wait about 10 seconds, then make the same call again; do not loop) and CONSENT_DENIED if they say no. op=read with what=standby or settings lists the standby helpers or the settings you may change. Ops: {kind:\"standby_add\", name, agent, model?, project?, after_task?:\"wait\"|\"close\"}; {kind:\"standby_remove\", target} only takes a standby off its agent (it keeps running as a free warm agent); {kind:\"standby_close\", target} stops it and drops it; {kind:\"settings\", patch:{key:value}} (null puts a setting back to its default). target is a standby's name or id. Logins, lending, devices and secrets cannot be changed here. A plan is used once and expires after 10 minutes; if the app changed meanwhile, apply fails with PLAN_STALE: plan again. Errors: INVALID_ARGUMENT, UNKNOWN_SETTING, REFUSED, NOT_FOUND, AMBIGUOUS, PLAN_UNKNOWN, PLAN_STALE, CONSENT_PENDING, CONSENT_DENIED.",
        input_schema: object_schema(
            json!({
                "op": { "type": "string", "enum": ["plan", "apply", "read"] },
                "ops": {
                    "type": "array",
                    "maxItems": 12,
                    "description": "For op=plan: the changes, each an object with a kind (standby_add, standby_remove, standby_close, settings).",
                    "items": { "type": "object" }
                },
                "plan_id": { "type": "string", "maxLength": 80, "description": "For op=apply: the plan_id op=plan returned." },
                "what": { "type": "string", "enum": ["standby", "settings"], "description": "For op=read." }
            }),
            vec!["op"],
        ),
        output_schema: None,
        safety: ToolSafety::Mutating,
        visibility: visible_everywhere(),
        method: "POST",
        path: "/config/op",
    }]
}
