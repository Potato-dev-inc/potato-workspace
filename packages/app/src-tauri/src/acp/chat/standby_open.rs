//! A standby the person opens like any chat. The chat is built around the seat's waiting session; the session stays in the
//! pool's slot (`warm::Pool::open_helper`), so the seat is still "ready". A task from an agent that takes the seat runs in
//! this same chat (see `warm/helpers.rs`): the seat has one chat, and nothing else is started.
//!
//! The pane id comes back as soon as the chat is registered (the announcement to the screens runs beside it). The standby's model (a call to the agent) and
//! the project's pins run afterwards in the background: the seat was put on its model while it warmed, and both only matter
//! at the first message. Timing marks `standby_open_begin`, `standby_open_built`, `standby_open_shown` say where time goes.

use std::sync::Arc;

use super::start::{build_registered_chat, ensure_sweeper, show_pane, StartDeps};
use super::AcpChat;

/// Opens helper `helper_id` as a chat and returns its pane id (the same one again while it stays open). A helper an agent has
/// returns the agent's task chat. A helper that is not ready says why in one plain sentence.
pub fn open_standby_chat(deps: &StartDeps, helper_id: &str) -> Result<String, String> {
    let key = format!("standby-open-{helper_id}");
    crate::startup_timing::begin(&key);
    crate::startup_timing::mark(&key, "standby_open_begin");
    let Some(pool) = crate::acp::warm::pool() else { return Err("Standbys are not running yet. Try again in a moment.".into()) };
    let Some(conversations) = deps.conversations.clone() else { return Err("Chats are not available here.".into()) };
    let mut built: Option<(Arc<AcpChat>, Option<String>)> = None;
    // A seat that sleeps wakes now and is waited for (its row says "Waking up"), so the click opens the chat instead of asking to try again.
    if pool.wake_and_wait(helper_id) {
        crate::startup_timing::mark(&key, "standby_open_woke");
    }
    let pane = pool.open_helper(helper_id, |warm, meta, agent| {
        let cfg = conversations.config_for(agent).map_err(|e| format!("The agent could not start: {e}"))?;
        let view = conversations.adopt_warm(&warm.id, agent, &warm.folder, warm.account.as_deref(), warm.session.clone()).map_err(|e| format!("The agent could not start: {e}"))?;
        // The chat is the seat's own from before it is listed: it is drawn as the seat's row, never as a new agent.
        crate::standby::seat_panes::note(&view.id, &meta.id);
        let chat = build_registered_chat(deps, &view.id, &cfg.label, &warm.session, &warm.folder, None, true);
        chat.set_seat(Some(&meta.id));
        ensure_sweeper();
        let grant = warm.account.as_deref().and_then(|id| id.strip_prefix(crate::capacity_proxy::ACCOUNT_PREFIX));
        show_pane(deps, &chat, &warm.session, agent.to_string(), &warm.folder, grant);
        built = Some((chat, meta.model.clone()));
        Ok(view.id)
    })?;
    crate::startup_timing::mark(&key, "standby_open_built");
    // Announced now: the screens select the pane at once. What follows runs outside the call.
    if let Some((chat, model)) = built {
        // The announcement runs the app's own listeners one after the other (the bridge's pane list, the tray, the badge): it
        // took about 320 ms in a real run. The person's click does not wait for it; the screens learn of the pane the moment it ends.
        let announce = deps.host.clone();
        if std::thread::Builder::new().name("acp-standby-announce".into()).spawn(move || announce.panes_changed()).is_err() {
            deps.host.panes_changed();
        }
        deps.host.state_changed(&pane, &chat.state());
        let host = deps.host.clone();
        let later = pane.clone();
        let run = move || {
            if let Some(wanted) = &model {
                super::default_model::apply_standby_model(&chat, wanted);
            }
            super::rules::apply_at_start(&chat, model.is_some());
            host.state_changed(&later, &chat.state());
        };
        if std::thread::Builder::new().name("acp-standby-open".into()).spawn(run).is_err() {
            tracing::warn!("acp: could not start the thread that finishes opening a standby");
        }
    }
    crate::startup_timing::mark_end(&key, "standby_open_shown");
    Ok(pane)
}
