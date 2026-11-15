//! A standby the person opens like any chat. The chat is built around the helper's waiting session; the session stays in the
//! pool's slot (`warm::Pool::open_helper`), so the helper is still "ready" and a task from an agent can still take it, but then
//! with a fresh session (see `warm/helpers.rs`): the person's chat keeps this one.

use std::sync::Arc;

use super::start::{build_registered_chat, ensure_sweeper, show_pane, StartDeps};
use super::AcpChat;

/// Opens helper `helper_id` as a chat and returns its pane id (the same one again while it stays open). A helper an agent has
/// returns the agent's task chat. A helper that is not ready says why in one plain sentence.
pub fn open_standby_chat(deps: &StartDeps, helper_id: &str) -> Result<String, String> {
    let Some(pool) = crate::acp::warm::pool() else { return Err("Standbys are not running yet. Try again in a moment.".into()) };
    let Some(conversations) = deps.conversations.clone() else { return Err("Chats are not available here.".into()) };
    let mut built: Option<(Arc<AcpChat>, Option<String>)> = None;
    let pane = pool.open_helper(helper_id, |warm, meta, agent| {
        let cfg = conversations.config_for(agent).map_err(|e| format!("The agent could not start: {e}"))?;
        let view = conversations.adopt_warm(&warm.id, agent, &warm.folder, warm.account.as_deref(), warm.session.clone()).map_err(|e| format!("The agent could not start: {e}"))?;
        let chat = build_registered_chat(deps, &view.id, &cfg.label, &warm.session, &warm.folder, None, true);
        ensure_sweeper();
        let grant = warm.account.as_deref().and_then(|id| id.strip_prefix(crate::capacity_proxy::ACCOUNT_PREFIX));
        show_pane(deps, &chat, &warm.session, agent.to_string(), &warm.folder, grant);
        built = Some((chat, meta.model.clone()));
        Ok(view.id)
    })?;
    // Outside the pool's lock: the standby's model (a call to the agent), the pins of the project, and the screens.
    if let Some((chat, model)) = built {
        if let Some(wanted) = &model {
            super::default_model::apply_standby_model(&chat, wanted);
        }
        super::rules::apply_at_start(&chat, model.is_some());
        deps.host.panes_changed();
        deps.host.state_changed(&pane, &chat.state());
    }
    Ok(pane)
}
