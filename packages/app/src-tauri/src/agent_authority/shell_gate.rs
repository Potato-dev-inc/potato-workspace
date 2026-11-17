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
            // A helper started from a pane (`launch-worker`): free for a proven agent window, a card for anyone else (`is_pane_spawn`).
            | ["panes"]
            | ["panes", _, "detach"]
            // Public routes with their own one-shot credential.
            | ["push", "act"]
            | ["pair", ..]
            // Showing the person a page is what this route is for.
            | ["artifacts", "show"]
            // The agent background terminals ask the person themselves (`terminal_gate`), and only for an agent in a pane.
            | ["terminals", _]
            | ["health"]
            // A plan changes nothing (the apply is the call that asks).
            | ["config", "plan"]
            // Refused for a caller with no MCP session; no card for a call that cannot work.
            | ["config", "op"]
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
        ["config", ..] => "your app setup".to_string(),
        ["opencode", ..] => "your OpenCode settings".to_string(),
        _ => "something in the app".to_string(),
    }
}

/// For `/settings`, the names of the keys it would change (never the values).
fn detail(segments: &[&str], body: &Value) -> Option<String> {
    if let ["config", "apply"] = segments {
        // The plan's own words (no setting values): what exactly the person is allowing.
        let id = body.get("plan_id")?.as_str()?;
        let lines = crate::config_plan::store().card_lines(id, crate::questions::now_ms())?;
        return (!lines.is_empty()).then(|| format!("It wants to: {}", lines.join("; ")));
    }
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

/// The card for a call from an MCP session (not a shell): same words, same Allow, keyed on the session.
pub fn check_session_call(session: &str, method: &str, segments: &[&str], body: &Value, now: u64) -> Result<(), OperationError> {
    let route = format!("{method} /{}", segments.join("/"));
    let requester = crate::mcp_sessions::session_client_name(session).unwrap_or_else(|| gate::UNKNOWN_REQUESTER.to_string());
    let ask = Ask {
        session: session.to_string(),
        subject: route.clone(),
        pane_id: None,
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
        Who::Agent(session.to_string()),
        &format!("{requester} changed {target} through its tools, after you allowed it"),
        json!({ "route": route, "via": "mcp" }),
    );
    Ok(())
}

/// `POST /panes`: an agent window starting a pane of its own (a helper, nested under it). It stays free
/// for a caller the app can PROVE is an agent window (its key, or its process tree); anyone else asks.
pub fn is_pane_spawn(method: &str, segments: &[&str]) -> bool {
    method == "POST" && matches!(crate::mobile_pairing::normalize_bridge_segments(segments), ["panes"])
}

/// Who an unproven local caller is told to be on the card, and the session its card is kept under.
const UNKNOWN_SESSION: &str = "local:unknown";

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
    let requester = registry
        .and_then(|r| r.lock().panes.get(pane).map(|p| p.info.agent_type.clone()))
        .map(|t| gate::agent_label(&t))
        .unwrap_or_else(|| gate::UNKNOWN_REQUESTER.to_string());
    ask_and_record(Some(pane), method, segments, body, requester, now)
}

/// The verdict for a local call nobody could place: no valid key, no pane in its process tree, and not the app
/// itself (an orphan that left its window, a stolen or stale key, a tool the person never started). It is never
/// treated as the app: a call that changes something, or starts a pane, asks the person first.
pub fn check_unknown_call(method: &str, segments: &[&str], body: &Value, now: u64) -> Result<(), OperationError> {
    let segments = crate::mobile_pairing::normalize_bridge_segments(segments);
    if !is_changing(method, segments) && !is_pane_spawn(method, segments) {
        return Ok(());
    }
    ask_and_record(None, method, segments, body, gate::UNKNOWN_REQUESTER.to_string(), now)
}

fn ask_and_record(
    pane: Option<&str>,
    method: &str,
    segments: &[&str],
    body: &Value,
    requester: String,
    now: u64,
) -> Result<(), OperationError> {
    let route = format!("{method} /{}", segments.join("/"));
    let ask = Ask {
        session: pane.map(|p| format!("pane:{p}")).unwrap_or_else(|| UNKNOWN_SESSION.to_string()),
        subject: route.clone(),
        pane_id: pane.map(str::to_string),
        action: Action::ConfigChange,
        prompt_key: body_key(body),
        requester: requester.clone(),
        target: target_words(segments),
        risk: None,
        risk_headline: detail(segments, body),
    };
    let target = ask.target.clone();
    gate::run(ask, now)?;
    let (who, how) = match pane {
        Some(pane) => (Who::Agent(format!("pane:{pane}")), "from a command"),
        None => (Who::Agent(UNKNOWN_SESSION.to_string()), "from a command it could not place"),
    };
    audit::record(
        Kind::Consent,
        who,
        &format!("{requester} changed {target} {how}, after you allowed it"),
        json!({ "pane_id": pane, "route": route, "via": "shell" }),
    );
    Ok(())
}

/// Where a request that changes something comes from, as far as the app can prove.
#[derive(Debug, PartialEq, Eq)]
pub enum Caller {
    /// This agent window's own key, or its process tree, names the pane.
    Pane(String),
    /// The pane header only (a claim): makes the call stricter, never looser.
    Claimed(String),
    /// The app itself (its webview, or something the person started at their desktop).
    App,
    /// Nobody could place it.
    Unknown,
}

/// Name the caller. Order: the pane's key, then the process tree, then a header claim, then "is it the app".
/// A caller that cannot be placed is `Unknown` on Windows (where the connection's owner can be read); where the OS
/// cannot say who owns a connection at all (another OS), it stays the app, as before, because nothing could ever
/// tell the app's UI from anyone else. A connection whose peer could not be read at all (never a real socket) also stays the app.
#[allow(clippy::too_many_arguments)]
pub fn identify_caller(
    registry: &Registry,
    owner: &dyn TcpOwner,
    snapshot: &dyn Fn() -> Option<Vec<ProcEntry>>,
    peer: Option<Peer>,
    headers: &str,
    app_pid: u32,
    fail_closed: bool,
) -> Caller {
    if let Some(pane) = super::pane_keys::pane_from_headers(headers) {
        return Caller::Pane(pane);
    }
    if let Some(pane) = crate::companion::peer::caller_pane(registry, owner, snapshot, peer) {
        return Caller::Pane(pane);
    }
    if let Some(pane) = claimed_pane(headers) {
        return Caller::Claimed(pane);
    }
    match crate::companion::peer::caller_is_the_app(owner, snapshot, peer, app_pid) {
        Some(true) => Caller::App,
        Some(false) => Caller::Unknown,
        None if fail_closed && peer.is_some() => Caller::Unknown,
        None => Caller::App,
    }
}

/// The router's check for a request that carries an MCP session header. A session is a caller's own claim: the app
/// does not issue it, any local process can make one up (the first call with a new id creates it). So the header
/// proves nothing. A session call from a proven agent window or from the app itself goes on to the MCP rules
/// (`mcp_sessions::authorize`) as before; one nobody could place (an orphan with no key, a process that is nowhere in
/// the app's or the desktop's tree) is an unknown local caller and asks like a shell command does.
#[allow(clippy::too_many_arguments)]
pub fn check_session_request(
    registry: &Registry,
    owner: &dyn TcpOwner,
    snapshot: &dyn Fn() -> Option<Vec<ProcEntry>>,
    peer: Option<Peer>,
    headers: &str,
    method: &str,
    segments: &[&str],
    body: &Value,
) -> Result<(), OperationError> {
    check_session_request_as(registry, owner, snapshot, peer, headers, method, segments, body, std::process::id(), cfg!(windows))
}

/// `check_session_request` with the app's process id and the fail-closed choice passed in (the tests).
#[allow(clippy::too_many_arguments)]
pub fn check_session_request_as(
    registry: &Registry,
    owner: &dyn TcpOwner,
    snapshot: &dyn Fn() -> Option<Vec<ProcEntry>>,
    peer: Option<Peer>,
    headers: &str,
    method: &str,
    segments: &[&str],
    body: &Value,
    app_pid: u32,
    fail_closed: bool,
) -> Result<(), OperationError> {
    if !is_changing(method, segments) && !is_pane_spawn(method, segments) {
        return Ok(());
    }
    match identify_caller(registry, owner, snapshot, peer, headers, app_pid, fail_closed) {
        Caller::Unknown => check_unknown_call(method, segments, body, gate::questions_now()),
        Caller::Pane(_) | Caller::Claimed(_) | Caller::App => Ok(()),
    }
}

/// The router's check for a request from a session-less local caller (not a phone, not a forwarder).
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
    check_request_as(registry, owner, snapshot, peer, headers, method, segments, body, std::process::id(), cfg!(windows))
}

/// `check_request` with the app's process id and the fail-closed choice passed in (the tests).
#[allow(clippy::too_many_arguments)]
pub fn check_request_as(
    registry: &Registry,
    owner: &dyn TcpOwner,
    snapshot: &dyn Fn() -> Option<Vec<ProcEntry>>,
    peer: Option<Peer>,
    headers: &str,
    method: &str,
    segments: &[&str],
    body: &Value,
    app_pid: u32,
    fail_closed: bool,
) -> Result<(), OperationError> {
    if !is_changing(method, segments) && !is_pane_spawn(method, segments) {
        return Ok(());
    }
    let now = gate::questions_now();
    match identify_caller(registry, owner, snapshot, peer, headers, app_pid, fail_closed) {
        // A proven agent window may start a pane of its own; anything else it changes asks.
        Caller::Pane(_) if is_pane_spawn(method, segments) => Ok(()),
        Caller::Pane(pane) => check_agent_call(&pane, method, segments, body, Some(registry), now),
        // A claim proves nothing: for a pane start it asks like a stranger.
        Caller::Claimed(_) if is_pane_spawn(method, segments) => check_unknown_call(method, segments, body, now),
        Caller::Claimed(pane) => check_agent_call(&pane, method, segments, body, Some(registry), now),
        Caller::App => Ok(()),
        Caller::Unknown => check_unknown_call(method, segments, body, now),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_authority::consent::{CHOICE_DENY, CHOICE_ONCE};
    use crate::questions::{self, now_ms};
    use crate::agent_authority::pane_keys;

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

    #[test]
    fn a_config_plan_is_free_but_applying_it_from_an_agent_window_is_a_card_with_the_plans_words() {
        assert!(!is_changing("POST", &["config", "plan"]), "a plan changes nothing");
        assert!(!is_changing("GET", &["config", "standby"]));
        assert!(is_changing("POST", &["config", "apply"]));
        let world = crate::config_plan::tests::Fake::new();
        let body = json!({ "ops": [{ "kind": "standby_add", "name": "Cheap helper", "agent": "opencode" }, { "kind": "settings", "patch": { "language": "zh-TW" } }] });
        let view = crate::config_plan::plan(&world, crate::config_plan::store(), &body, now_ms()).unwrap();
        let pane = pane();
        let apply = json!({ "plan_id": view.plan_id });
        let error = check_agent_call(&pane, "POST", &["config", "apply"], &apply, None, now_ms()).unwrap_err();
        let card = questions::store().get(&pending_id(&error), now_ms()).unwrap();
        assert_eq!(card.question, "Allow another agent to change your app setup?");
        let context = card.context.as_deref().unwrap();
        assert!(context.contains("Cheap helper") && context.contains("language") && !context.contains("zh-TW"), "{context}");
        // The plan call itself raises nothing.
        check_agent_call(&pane, "POST", &["config", "plan"], &body, None, now_ms()).expect("planning needs no card");
    }

    fn registry() -> Registry {
        Arc::new(Mutex::new(PaneRegistry::new()))
    }

    /// A fake owner: the process that owns the client end of the connection.
    struct Owner(Option<u32>);
    impl TcpOwner for Owner {
        fn owner_pid(&self, _: &Peer) -> Option<u32> {
            self.0
        }
    }

    const APP: u32 = 7;
    const DESKTOP: u32 = 50;

    fn proc(pid: u32, parent: u32) -> ProcEntry {
        ProcEntry { pid, parent, image: "x.exe".into() }
    }

    /// The app (7) has the webview 500 under it. An agent pane's process 100 hangs off the desktop shell with its
    /// shell 102. An orphan 600 left that tree: its parent 999 has exited.
    fn table() -> Vec<ProcEntry> {
        vec![ProcEntry { pid: DESKTOP, parent: 999_999, image: "explorer.exe".into() }, proc(500, APP), proc(100, DESKTOP), proc(102, 100), proc(600, 999)]
    }

    fn peer() -> Option<Peer> {
        Some(Peer { local: "127.0.0.1:17360".parse().unwrap(), remote: "127.0.0.1:50123".parse().unwrap() })
    }

    const PLAIN: &str = "Host: 127.0.0.1:1\r\n";

    fn call(owner: Option<u32>, headers: &str, method: &str, segments: &[&str]) -> Result<(), OperationError> {
        check_request_as(&registry(), &Owner(owner), &|| Some(table()), peer(), headers, method, segments, &json!({"x": 1}), APP, true)
    }

    #[test]
    fn the_apps_own_ui_call_passes_with_no_prompt() {
        // The webview's process hangs off this app: it is the app, not an unknown caller.
        let headers = "Host: 127.0.0.1:1\r\nOrigin: http://tauri.localhost\r\n";
        call(Some(500), headers, "PATCH", &["settings"]).expect("UI passes");
        // What the person runs in their own terminal (its chain reaches the desktop shell) is the person's.
        call(Some(DESKTOP), PLAIN, "PATCH", &["settings"]).expect("the person's own desktop passes");
    }

    #[test]
    fn an_unknown_local_caller_needs_consent_and_is_never_treated_as_the_app() {
        // An orphan that left every window's tree, with no key and no header.
        let error = call(Some(600), PLAIN, "PATCH", &["settings"]).unwrap_err();
        let id = pending_id(&error);
        assert!(error.context["pane_id"].is_null(), "no pane could be named");
        let card = questions::store().get(&id, now_ms()).unwrap();
        assert_eq!(card.question, "Allow another agent to change your settings?");
        // Where nobody can say who owns the connection at all (the OS table is silent), Windows still asks.
        pending_id(&call(None, PLAIN, "PATCH", &["settings"]).unwrap_err());
        // Only another OS, where nothing could ever tell the UI apart, keeps today's behaviour.
        check_request_as(&registry(), &Owner(None), &|| None, peer(), PLAIN, "PATCH", &["settings"], &json!({"y": 1}), APP, false).expect("no detection at all");
        // A read is never asked.
        call(Some(600), PLAIN, "GET", &["settings"]).expect("reads pass");
    }

    #[test]
    fn an_orphan_that_carries_its_panes_key_is_that_pane_not_the_app() {
        let name = pane();
        let key = pane_keys::mint(&name);
        let headers = format!("{PLAIN}{}: {key}\r\n", pane_keys::KEY_HEADER);
        // The process escaped its window's tree (600), yet the key names the pane.
        assert_eq!(
            identify_caller(&registry(), &Owner(Some(600)), &|| Some(table()), peer(), &headers, APP, true),
            Caller::Pane(name.clone())
        );
        let error = call(Some(600), &headers, "PATCH", &["settings"]).unwrap_err();
        assert_eq!(pending_id(&error), pending_id(&call(Some(600), &headers, "PATCH", &["settings"]).unwrap_err()));
        assert_eq!(error.context["pane_id"], name.as_str(), "the card is raised for the pane the key names");
        // A key beats a claim in the pane header.
        let both = format!("{headers}{PANE_HEADER}: some-other-pane\r\n");
        assert_eq!(identify_caller(&registry(), &Owner(Some(600)), &|| Some(table()), peer(), &both, APP, true), Caller::Pane(name));
    }

    #[test]
    fn a_closed_panes_key_is_rejected_and_the_caller_is_unknown_again() {
        let name = pane();
        let key = pane_keys::mint(&name);
        let headers = format!("{PLAIN}{}: {key}\r\n", pane_keys::KEY_HEADER);
        pane_keys::revoke(&name);
        assert_eq!(identify_caller(&registry(), &Owner(Some(600)), &|| Some(table()), peer(), &headers, APP, true), Caller::Unknown);
        let error = call(Some(600), &headers, "PATCH", &["settings"]).unwrap_err();
        pending_id(&error);
        assert!(error.context["pane_id"].is_null());
        // A made-up key is no better than none, even from inside the app's own tree.
        let forged = format!("{PLAIN}{}: not-a-real-key\r\n", pane_keys::KEY_HEADER);
        call(Some(500), &forged, "PATCH", &["settings"]).expect("a bad key does not make the app's own UI an agent");
        pending_id(&call(Some(600), &forged, "PATCH", &["settings"]).unwrap_err());
    }


    #[test]
    fn a_made_up_mcp_session_header_does_not_skip_the_consent_check() {
        let forged = format!("{PLAIN}X-Potato-Workspace-Session: made-up-{}\r\n", uuid::Uuid::new_v4());
        let session_call = |owner: u32, headers: &str, method: &str, segments: &[&str]| {
            check_session_request_as(&registry(), &Owner(Some(owner)), &|| Some(table()), peer(), headers, method, segments, &json!({"s": 1}), APP, true)
        };
        // An orphan with a made-up session and no key: asked, for a change and for starting a pane.
        pending_id(&session_call(600, &forged, "POST", &["agents", "run"]).unwrap_err());
        pending_id(&session_call(600, &forged, "POST", &["panes"]).unwrap_err());
        // Reads are never asked.
        session_call(600, &forged, "GET", &["panes"]).expect("reads pass");
        // The same session id from the app's own tree, or from a window by its key, goes on to the MCP rules as before.
        session_call(500, &forged, "POST", &["agents", "run"]).expect("the app's own tools");
        let name = pane();
        let key = pane_keys::mint(&name);
        let keyed = format!("{forged}{}: {key}\r\n", pane_keys::KEY_HEADER);
        session_call(600, &keyed, "POST", &["agents", "run"]).expect("a keyed window's MCP shim");
        pane_keys::revoke(&name);
        pending_id(&session_call(600, &keyed, "POST", &["agents", "run"]).unwrap_err());
    }
    #[test]
    fn starting_a_pane_needs_a_key_or_consent() {
        assert!(is_pane_spawn("POST", &["panes"]));
        assert!(is_pane_spawn("POST", &["bridge", "panes"]));
        assert!(!is_pane_spawn("GET", &["panes"]) && !is_pane_spawn("POST", &["panes", "p1", "input"]));
        // A stranger, and a bare pane claim, ask first.
        let error = call(Some(600), PLAIN, "POST", &["panes"]).unwrap_err();
        pending_id(&error);
        assert_eq!(error.context["action"], "config_change");
        pending_id(&call(Some(600), &format!("{PLAIN}{PANE_HEADER}: pane-1\r\n"), "POST", &["panes"]).unwrap_err());
        // The pane's own key (even from an orphan) starts a pane with no card.
        let name = pane();
        let key = pane_keys::mint(&name);
        call(Some(600), &format!("{PLAIN}{}: {key}\r\n", pane_keys::KEY_HEADER), "POST", &["panes"]).expect("a keyed window starts a helper");
        // The app itself, and a pane's other changes (the key does not unlock them), behave as before.
        call(Some(500), PLAIN, "POST", &["panes"]).expect("the app starts panes");
        pending_id(&call(Some(600), &format!("{PLAIN}{}: {key}\r\n", pane_keys::KEY_HEADER), "PATCH", &["settings"]).unwrap_err());
        pane_keys::revoke(&name);
    }

    #[test]
    fn a_pane_header_claim_makes_the_call_an_agent_call_and_can_never_loosen_it() {
        let name = pane();
        let headers = format!("Host: 127.0.0.1:1\r\n{PANE_HEADER}: {name}\r\n");
        // Even from inside the app's own tree the claim makes it stricter.
        let error = call(Some(500), &headers, "PATCH", &["settings"]).unwrap_err();
        pending_id(&error);
        assert_eq!(error.context["pane_id"], name.as_str());
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
