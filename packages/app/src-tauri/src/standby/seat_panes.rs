//! Which chats are a standby seat's own chat. A seat is one row in the sidebar, under its owner; the chat its task runs in
//! (or the one the person opened on it) is that row, never an agent of its own. The pane list carries the seat's id
//! (`PaneInfo::standby_seat`) from the first moment the chat is listed, so no screen ever draws it as a new agent.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;

static SEATS: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Chat `pane_id` is seat `helper_id`'s own chat. Call it before the chat is listed.
pub fn note(pane_id: &str, helper_id: &str) {
    SEATS.lock().insert(pane_id.to_string(), helper_id.to_string());
}

/// The seat chat `pane_id` belongs to.
pub fn get(pane_id: &str) -> Option<String> {
    SEATS.lock().get(pane_id).cloned()
}

/// The chat is gone.
pub fn forget(pane_id: &str) {
    SEATS.lock().remove(pane_id);
}
