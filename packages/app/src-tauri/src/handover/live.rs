//! `World` over the live app: the pane registry (who started whom), the chat sessions (what a task was asked and said, the
//! notices) and the sidebar's task list. Plus the one entry the Tauri commands call, and the turn-end hook.

use super::{book, hand_over, turn_ended, Mode, Outcome, Refused, World};
use crate::pty::PaneRegistry;
use crate::session_chat::ChatItem;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

pub struct LiveWorld {
    registry: Arc<Mutex<PaneRegistry>>,
    /// The names the person sees ("Claude 2"), when the window sent them. Else the pane's title.
    names: HashMap<String, String>,
}

impl LiveWorld {
    pub fn new(registry: Arc<Mutex<PaneRegistry>>, names: HashMap<String, String>) -> Self {
        Self { registry, names }
    }
}

fn last_assistant(items: &[ChatItem]) -> Option<String> {
    items.iter().rev().find_map(|item| match item {
        ChatItem::Assistant { text, .. } if !text.trim().is_empty() => Some(text.clone()),
        _ => None,
    })
}

impl World for LiveWorld {
    fn owner_of(&self, pane: &str) -> Option<Option<String>> {
        self.registry.lock().panes.get(pane).map(|p| p.info.parent_pane_id.clone().filter(|id| !id.is_empty()))
    }

    fn is_minion(&self, pane: &str) -> bool {
        self.registry.lock().panes.get(pane).is_some_and(|p| p.info.started_as.as_deref() == Some("minion"))
    }

    fn is_chat(&self, pane: &str) -> bool {
        crate::acp::chat::get(pane).is_some_and(|chat| !chat.is_closed())
    }

    fn exists(&self, pane: &str) -> bool {
        self.registry.lock().panes.contains_key(pane)
    }

    fn name_of(&self, pane: &str) -> String {
        if let Some(name) = self.names.get(pane).filter(|n| !n.trim().is_empty()) {
            return name.clone();
        }
        let title = self.registry.lock().panes.get(pane).and_then(|p| p.info().title).filter(|t| !t.trim().is_empty());
        title.or_else(|| crate::acp::chat::get(pane).map(|chat| chat.label().to_string())).unwrap_or_else(|| "an agent".to_string())
    }

    fn asked(&self, task: &str) -> String {
        let Some(chat) = crate::acp::chat::get(task) else { return String::new() };
        chat.items()
            .iter()
            .find_map(|item| match item {
                ChatItem::User { text, .. } => Some(text.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    fn so_far(&self, task: &str) -> String {
        crate::acp::chat::get(task).and_then(|chat| last_assistant(&chat.items())).unwrap_or_default()
    }

    fn finished(&self, task: &str) -> Option<String> {
        let chat = crate::acp::chat::get(task)?;
        let view = crate::acp::chat::surface::view(&chat);
        match view.get("status").and_then(|s| s.as_str()) {
            Some("completed") => Some(view.get("result").and_then(|r| r.as_str()).map(str::to_string).or_else(|| last_assistant(&chat.items())).unwrap_or_else(|| "It finished with no written result.".to_string())),
            Some("failed") => Some(format!("It failed: {}", view.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("it stopped with an error."))),
            Some("cancelled") => Some("It was stopped before it finished.".to_string()),
            _ => None,
        }
    }

    fn move_to(&self, task: &str, to: &str) {
        if let Some(pane) = self.registry.lock().panes.get_mut(task) {
            pane.info.parent_pane_id = Some(to.to_string());
        }
        if let Some(chat) = crate::acp::chat::get(task) {
            // The agent in the new pane now holds the tool rights. A pane no MCP connection has named yet is still the owner by
            // its place (`surface::owned` lets the agent in the pane a chat is nested under steer it); this value only has to
            // be one the first agent's connection can never match.
            let session = crate::mcp_sessions::session_of_pane(to).unwrap_or_else(|| format!("pane:{to}"));
            chat.set_started_by(Some(&session));
            chat.persist_link(Some(&session), Some(to));
        }
        let _ = crate::task_sidebar::file().edit(|store| {
            store.hand_to(&format!("minion:{task}"), to);
            Ok(())
        });
        crate::bridge::notify_panes_changed();
    }

    fn tell(&self, pane: &str, text: &str) -> bool {
        let Some(chat) = crate::acp::chat::get(pane).filter(|chat| !chat.is_closed()) else { return false };
        chat.deliver_app_notice("handover", &super::prefix(), text).is_ok()
    }
}

/// The person's choice, from the sidebar. `names` are the names the window shows (task, old owner, new owner), when it sent them.
pub fn hand_over_live(registry: &Arc<Mutex<PaneRegistry>>, task: &str, to: &str, mode: Mode, names: HashMap<String, String>) -> Result<Outcome, Refused> {
    hand_over(&LiveWorld::new(registry.clone(), names), book(), task, to, mode)
}

/// The person changed their mind about "when it finishes" before it did.
pub fn cancel_pending(task: &str) -> bool {
    book().lock().cancel(task)
}

/// A turn of chat `pane` ended. When a hand-over waits on it (or still owes its first result), look at its status a few times
/// (it turns final a moment after the turn-end event) and tell whoever is owed. Runs on its own thread: the session is still
/// finishing the event that called this.
pub fn turn_ended_soon(pane: &str) {
    if !book().lock().is_handed(pane) {
        return;
    }
    let pane = pane.to_string();
    std::thread::spawn(move || {
        let Some(registry) = crate::bridge::shared_registry() else { return };
        let world = LiveWorld::new(registry, HashMap::new());
        for _ in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            if !book().lock().is_handed(&pane) {
                return;
            }
            if world.finished(&pane).is_some() {
                turn_ended(&world, book(), &pane);
                return;
            }
        }
    });
}
