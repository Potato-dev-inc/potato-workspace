//! The events a paired PC sees, in the PC link's own shapes. The app's event log carries the phone's frames
//! (`event: panes`, `event: pane-status`, ...); this module keeps only the few a PC needs, and rewrites each to a frame that
//! holds no more than the PC needs to know to read again:
//!
//! | Frame            | Level  | Says                                       |
//! |------------------|--------|--------------------------------------------|
//! | `sessions`       | Watch  | the session list changed: read it          |
//! | `session-status` | Watch  | `{ id, status }`                           |
//! | `questions`      | Watch  | the questions changed: read them           |
//! | `outbox`         | Answer | `{ id }`: that session's messages changed  |
//!
//! Everything else is dropped (terminal bytes, logs, settings, the attention snapshot, previews, companions ...).

use std::borrow::Cow;

use serde_json::{json, Value};

use super::Level;

fn split(frame: &str) -> Option<(&str, &str)> {
    let rest = frame.strip_prefix("event: ")?;
    let (name, rest) = rest.split_once('\n')?;
    let data = rest.strip_prefix("data: ")?;
    Some((name.trim(), data.trim_end_matches('\n').trim()))
}

fn frame(name: &str, data: Value) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

/// The form of one log payload for a PC at `level`. `None`: that PC does not see it.
pub fn view(level: Level, payload: &str) -> Option<Cow<'_, str>> {
    let (name, data) = split(payload)?;
    let out = match name {
        "panes" => frame("sessions", json!({})),
        "pane-status" => {
            let v: Value = serde_json::from_str(data).ok()?;
            let id = v.get("pane_id")?.as_str()?;
            let status = v.get("status")?.as_str()?;
            frame("session-status", json!({ "id": id, "status": status }))
        }
        "pane-outbox" if level >= Level::Answer => {
            let v: Value = serde_json::from_str(data).ok()?;
            let id = v.get("paneId").or_else(|| v.get("pane_id"))?.as_str()?;
            frame("outbox", json!({ "id": id }))
        }
        // Watch may read the questions list, so a change reaches it too (its list refreshes).
        "questions" => frame("questions", json!({})),
        _ => return None,
    };
    Some(Cow::Owned(out))
}
