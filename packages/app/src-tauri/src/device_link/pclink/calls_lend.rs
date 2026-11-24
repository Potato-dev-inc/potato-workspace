//! P6.1 "Use my own agents" (`calls.rs`, block `---- P6.1 lend ----`): the one far call, and the check on the far start.
//!
//! `own_borrow_ask` is what the PC the person drives from (the lender) asks THIS PC to do after its own click: ask the lender
//! back for the lend that click promised. It can only ask the PC that is calling (never another node), and it asks; the
//! lender decides. The lender says yes by itself only for a request that names the promise its own click wrote
//! (`capacity_proxy::service::own_far`). Nothing here reads or returns a key, token or login.

use serde_json::{json, Value};

use super::app_services::{bad, command_error, Reply};
use super::calls::{arg, text_arg};

/// The far rows of this block.
pub const ROW: &str = "own_borrow_ask";
/// What a start from the caller would run on (own login, or the caller's lend): a read, so the New agent panel can say it first.
pub const PLAN_ROW: &str = "own_borrow_plan";

pub(super) fn dispatch(node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    if cmd == PLAN_ROW {
        let Some(agent) = text_arg(args, "agentId") else { return Some(bad("INVALID_ARGUMENT", "agentId is required")) };
        // Only the lend the CALLER made is ever named, and only its display name: no grant secret, key or token.
        let (signed_out, lend) = crate::capacity_proxy::far_plan(&agent, Some(node));
        return Some((200, json!({ "signedOut": signed_out, "lend": lend.map(|(grant, name)| json!({ "grantId": grant, "name": name })) })));
    }
    if cmd != ROW {
        return None;
    }
    let Some(agent) = text_arg(args, "agentId") else { return Some(bad("INVALID_ARGUMENT", "agentId is required")) };
    let Some(offer) = text_arg(args, "offerRef") else { return Some(bad("INVALID_ARGUMENT", "offerRef is required")) };
    let secs = arg(args, "secs").and_then(Value::as_u64).unwrap_or(0);
    let profile = text_arg(args, "profileId");
    // The lender is the caller, always: the node comes from the link that carried the call, never from the arguments.
    crate::audit::record(
        crate::audit::Kind::Consent,
        crate::audit::Who::Device(Some(crate::mobile_pairing::link_device_id(node))),
        &format!("A paired PC asked this PC to use its lend of a {agent} sign-in"),
        json!({ "event": "lend.own.ask" }),
    );
    Some(match crate::capacity_proxy::ask_lender(node, &agent, &offer, profile.as_deref(), secs) {
        Ok(grant) => (200, json!({ "grantId": grant })),
        Err(error) => command_error(&error),
    })
}

/// The far start was given `account`. Only a lend (`lend:<grant>`) is ever taken, and only one the CALLING PC made to this PC for this
/// agent: another paired PC cannot start a chat on it, and no login of this PC can be named from outside. `Err` is the refusal.
pub(super) fn start_account(node: &str, agent: &str, account: &str) -> Result<String, Reply> {
    let refuse = |why: &str| Err((403, json!({ "code": "ACCOUNT_REFUSED", "error": why })));
    let Some(grant) = account.strip_prefix(crate::capacity_proxy::ACCOUNT_PREFIX) else {
        return refuse("Only your own sign-in lent by that PC can be used here.");
    };
    if crate::capacity_proxy::grant_lent_by(grant, agent, node) {
        Ok(account.to_string())
    } else {
        refuse("That lent sign-in is not available. Pick it again.")
    }
}
