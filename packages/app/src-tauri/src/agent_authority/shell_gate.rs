//! A command run inside an agent's window is that agent, not the app.
//!
//! A bridge call with no MCP session id used to count as "the app itself": the webview, the CLI and
//! the MCP shim send none. So an agent that ran `curl -X PATCH .../settings` (or the CLI) in its shell
//! skipped every agent check. This module closes that for the calls that CHANGE something.
//!
//! * Who is calling: the OS says which process owns the client end of the loopback connection and the
//!   process table places it in a pane's tree (`companion::peer::caller_pane`, the same method the
//!   companion guard uses). The `X-Potato-Workspace-Pane` header (the CLI writes it from
//!   `POTATO_WORKSPACE_PANE_ID`) is only a HINT that makes the call stricter: a caller can claim to be
//!   an agent, it can never claim to be the app. The app's own webview is in no pane tree, so it is
//!   never asked.
//! * What counts: every method except GET, HEAD and OPTIONS, minus a short list (`is_changing`).
//! * What happens: the same consent card the Inbox already shows (`consent::Action::ConfigChange`).
//!   The call fails with `CONSENT_PENDING` until the person taps Allow once, then the same call
//!   (same route, same body) goes through once. Deny: `CONSENT_DENIED`.
//! * Not here: a request that came through a forwarder or a foreign Host/Origin is never "local"
//!   (`mobile_pairing::requires_pairing_token`), it needs a paired device's token and never gets here.
//!   MCP sessions have their own gate (`mcp_sessions::authorize`).

use super::consent::{Action, Ask};
use super::gate;
use crate::audit::{self, Kind, Who};
use crate::companion::peer::{Peer, TcpOwner};
use crate::operations::OperationError;
use crate::pty::agent_proc::ProcEntry;
use crate::pty::PaneRegistry;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;

/// The header the CLI sets from `POTATO_WORKSPACE_PANE_ID`. A hint only: it can make a call stricter.
pub const PANE_HEADER: &str = "X-Potato-Workspace-Pane";

type Registry = Arc<Mutex<PaneRegistry>>;

/// Routes an agent's shell may still call without a card although they are not GET.
fn exempt(segments: &[&str]) -> bool {
    matches!(
        segments,
        // Waiting on a run is a read.
        ["operations", "by-key" | "by-handle"]
            | ["operations", _, "wait"]
            // Asking the person a question is not a change (answering one has its own rules).
            | ["questions", ..]
            // The existing "a helper started from a pane is nested under it" flow (`launch-worker`).
            | ["panes"]
            | ["panes", _, "detach"]
            // Public routes with their own one-shot credential.
            | ["push", "act"]
            | ["pair", ..]
            // Showing the person a page is what this route is for.
            | ["artifacts", "show"]
            | ["health"]
    )
}

/// Whether the call changes something an agent's shell must ask about.
pub fn is_changing(method: &str, segments: &[&str]) -> bool {
    if matches!(method, "GET" | "HEAD" | "OPTIONS") {
        return false;
    }
    let segments = crate::mobile_pairing::normalize_bridge_segments(segments);
    !exempt(segments)
}

/// The pane a request CLAIMS to come from, by header. Never loosens anything.
pub fn claimed_pane(headers: &str) -> Option<String> {
    let value = crate::mobile_pairing::header_value(headers, PANE_HEADER)?;
    let value: String = value.chars().take(64).collect();
    (!value.trim().is_empty()).then(|| value.trim().to_string())
}

/// What the person reads on the card: "your settings".
fn target_words(segments: &[&str]) -> String {
    match segments {
        ["settings", ..] => "your settings".to_string(),
        ["panes", _, "input" | "key"] => "a window by typing into it".to_string(),
        ["agents", ..] => "your agent list".to_string(),
        ["opencode", ..] => "your OpenCode settings".to_string(),
        _ => "something in the app".to_string(),
    }
}

/// For `/settings`, the names of the keys it would change (never the values).
fn detail(segments: &[&str], body: &Value) -> Option<String> {
    if !matches!(segments, ["settings", ..]) {
        return None;
    }
    let keys: Vec<&str> = body
        .as_object()?
        .keys()
        .map(String::as_str)
        .filter(|k| k.len() <= 40 && k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
        .take(8)
        .collect();
    (!keys.is_empty()).then(|| format!("It wants to change: {}", keys.join(", ")))
}

fn body_key(body: &Value) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    body.to_string().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// The verdict for a call known to come from agent pane `pane`.
pub fn check_agent_call(
    pane: &str,
    method: &str,
    segments: &[&str],
    body: &Value,
    registry: Option<&Registry>,
    now: u64,
) -> Result<(), OperationError> {
    let segments = crate::mobile_pairing::normalize_bridge_segments(segments);
    if !is_changing(method, segments) {
        return Ok(());
    }
    let route = format!("{method} /{}", segments.join("/"));
    let requester = registry
        .and_then(|r| r.lock().panes.get(pane).map(|p| p.info.agent_type.clone()))
        .map(|t| gate::agent_label(&t))
        .unwrap_or_else(|| gate::UNKNOWN_REQUESTER.to_string());
    let ask = Ask {
        session: format!("pane:{pane}"),
        subject: route.clone(),
        pane_id: Some(pane.to_string()),
        action: Action::ConfigChange,
        prompt_key: body_key(body),
        requester: requester.clone(),
        target: target_words(segments),
        risk: None,
        risk_headline: detail(segments, body),
    };
    let target = ask.target.clone();
    gate::run(ask, now)?;
    audit::record(
        Kind::Consent,
        Who::Agent(format!("pane:{pane}")),
        &format!("{requester} changed {target} from a command, after you allowed it"),
        json!({ "pane_id": pane, "route": route, "via": "shell" }),
    );
    Ok(())
}

/// The router's check for a request from a session-less local caller (not a phone, not a forwarder).
/// No pane from the OS and no header claim means the app's own UI: no prompt.
#[allow(clippy::too_many_arguments)]
pub fn check_request(
    registry: &Registry,
    owner: &dyn TcpOwner,
    snapshot: &dyn Fn() -> Option<Vec<ProcEntry>>,
    peer: Option<Peer>,
    headers: &str,
    method: &str,
    segments: &[&str],
    body: &Value,
) -> Result<(), OperationError> {
    if !is_changing(method, segments) {
        return Ok(());
    }
    let pane = crate::companion::peer::caller_pane(registry, owner, snapshot, peer).or_else(|| claimed_pane(headers));
    match pane {
        Some(pane) => check_agent_call(&pane, method, segments, body, Some(registry), gate::questions_now()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_authority::consent::{CHOICE_DENY, CHOICE_ONCE};
    use crate::questions::{self, now_ms};

    fn pane() -> String {
        format!("pane-{}", uuid::Uuid::new_v4())
    }

    fn pending_id(error: &OperationError) -> String {
        assert_eq!(error.code, "CONSENT_PENDING", "{}", error.message);
        error.context["consent_id"].as_str().unwrap().to_string()
    }

    fn answer(id: &str, choice: &str) {
        assert!(questions::store().answer(id, Some(choice), None, "desktop", now_ms()).unwrap().accepted);
    }

    #[test]
    fn an_agent_pane_changing_settings_gets_a_card_and_nothing_goes_through_until_allow() {
        let pane = pane();
        let body = json!({"language": "zh-TW"});
        let error = check_agent_call(&pane, "PATCH", &["settings"], &body, None, now_ms()).unwrap_err();
        let id = pending_id(&error);
        let card = questions::store().get(&id, now_ms()).unwrap();
        assert_eq!(card.question, "Allow another agent to change your settings?");
        assert!(card.context.as_deref().unwrap().contains("language"), "{:?}", card.context);
        assert!(!card.context.as_deref().unwrap().contains("zh-TW"), "values stay off the card");
        assert_eq!(card.consent.as_ref().unwrap().action, "config_change");
        // Asking again before the person answers does not let it through, nor raise a second card.
        assert_eq!(pending_id(&check_agent_call(&pane, "PATCH", &["settings"], &body, None, now_ms()).unwrap_err()), id);
        answer(&id, CHOICE_ONCE);
        check_agent_call(&pane, "PATCH", &["settings"], &body, None, now_ms()).expect("allowed once");
        // Once only: the same call asks again.
        assert_ne!(pending_id(&check_agent_call(&pane, "PATCH", &["settings"], &body, None, now_ms()).unwrap_err()), id);
    }

    #[test]
    fn deny_refuses_and_a_different_body_needs_its_own_card() {
        let pane = pane();
        let id = pending_id(&check_agent_call(&pane, "PATCH", &["settings"], &json!({"a": 1}), None, now_ms()).unwrap_err());
        answer(&id, CHOICE_DENY);
        let error = check_agent_call(&pane, "PATCH", &["settings"], &json!({"a": 1}), None, now_ms()).unwrap_err();
        assert_eq!(error.code, "CONSENT_DENIED");
        let other = pending_id(&check_agent_call(&pane, "PATCH", &["settings"], &json!({"a": 2}), None, now_ms()).unwrap_err());
        assert_ne!(other, id);
    }

    #[test]
    fn read_only_calls_pass_with_no_card() {
        let pane = pane();
        for (method, segments) in [("GET", vec!["settings"]), ("GET", vec!["panes"]), ("HEAD", vec!["health"]), ("POST", vec!["operations", "op1", "wait"])] {
            assert!(!is_changing(method, &segments));
            check_agent_call(&pane, method, &segments, &json!({}), None, now_ms()).expect("passes");
        }
        assert!(is_changing("PATCH", &["settings"]));
        assert!(is_changing("PATCH", &["bridge", "settings"]), "a /bridge prefix does not hide a change");
        assert!(is_changing("POST", &["panes", "p1", "input"]));
        assert!(is_changing("DELETE", &["panes", "p1"]));
        assert!(is_changing("POST", &["agents", "definitions"]));
    }

    struct Nobody;
    impl TcpOwner for Nobody {
        fn owner_pid(&self, _: &Peer) -> Option<u32> {
            None
        }
    }

    fn registry() -> Registry {
        Arc::new(Mutex::new(PaneRegistry::new()))
    }

    #[test]
    fn the_apps_own_ui_call_passes_with_no_prompt() {
        // The OS names no pane for the webview and it sends no pane header.
        let headers = "Host: 127.0.0.1:1\r\nOrigin: http://tauri.localhost\r\n";
        check_request(&registry(), &Nobody, &|| None, None, headers, "PATCH", &["settings"], &json!({"x": 1})).expect("UI passes");
    }

    #[test]
    fn a_pane_header_claim_makes_the_call_an_agent_call_and_can_never_loosen_it() {
        let name = pane();
        let headers = format!("Host: 127.0.0.1:1\r\n{PANE_HEADER}: {name}\r\n");
        let error = check_request(&registry(), &Nobody, &|| None, None, &headers, "PATCH", &["settings"], &json!({"x": 1})).unwrap_err();
        pending_id(&error);
        assert_eq!(claimed_pane(&headers).as_deref(), Some(name.as_str()));
        assert_eq!(claimed_pane("Host: x\r\n"), None);
        assert_eq!(claimed_pane(&format!("{PANE_HEADER}:   \r\n")), None);
    }

    #[test]
    fn a_forwarded_or_foreign_call_is_never_local_so_it_needs_a_paired_token() {
        let settings = ["settings"];
        for headers in [
            "Host: 127.0.0.1:1\r\nX-Forwarded-For: 1.2.3.4\r\n",
            "Host: 127.0.0.1:1\r\nCf-Connecting-Ip: 1.2.3.4\r\n",
            "Host: evil.example\r\n",
            "Host: 127.0.0.1:1\r\nOrigin: http://localhost:5173\r\n",
        ] {
            assert!(crate::mobile_pairing::requires_pairing_token(headers, true), "{headers}");
            assert!(
                crate::mobile_pairing::authorize_bridge_request(headers, true, &settings, "PATCH").is_err(),
                "no token, refused: {headers}"
            );
        }
        // A claimed pane header does not turn a forwarded call into a local one.
        let spoof = format!("Host: 127.0.0.1:1\r\nX-Forwarded-For: 1.2.3.4\r\n{PANE_HEADER}: p1\r\n");
        assert!(crate::mobile_pairing::requires_pairing_token(&spoof, true));
        assert!(crate::mobile_pairing::authorize_bridge_request(&spoof, true, &settings, "PATCH").is_err());
    }
}
