//! The events a paired PC sees, in the PC link's own shapes. The app's event log carries the phone's frames
//! (`event: panes`, `event: pane-status`, ...); this module keeps only the few a PC needs, and rewrites each to a frame that
//! holds no more than the PC needs to know to read again:
//!
//! | Frame            | Level  | Says                                       |
//! |------------------|--------|--------------------------------------------|
//! | `sessions`       | Watch  | the session list changed: read it          |
//! | `session-status` | Watch  | `{ id, status }`                           |
//! | `questions`      | Watch  | the questions changed: read them           |
//! | `app`            | per event | `{ event, payload }` of one allowlisted app event (`APP_EVENTS`, each with its own level), as the window got it |
//!
//! A terminal's output and size are `app` frames too (`terminal-data`, `pty://resized`; P2.3, Full only (S11), metered in `terminal.rs`).
//!
//! Everything else is dropped (logs, settings, the attention snapshot, previews, companions ...).

use std::borrow::Cow;

use serde_json::{json, Value};

use super::Level;

fn split(frame: &str) -> Option<(&str, &str)> {
    let rest = frame.strip_prefix("event: ")?;
    let (name, rest) = rest.split_once('\n')?;
    let data = rest.strip_prefix("data: ")?;
    Some((name.trim(), data.trim_end_matches('\n').trim()))
}

/// The app events a PC may see as an `app` frame: the event, the field that names its session, and the least level that may see it.
/// One entry per event; the one place that lists them.
const APP_EVENTS: &[(&str, &str, Level)] = &[
    ("acp-chat-state", "paneId", Level::Watch),
    // ---- P2.3 terminal ---- (output and size may hold secrets: Full only)
    ("terminal-data", "pane_id", Level::Full),
    ("terminal-lag", "pane_id", Level::Full),
    ("pty://resized", "pane_id", Level::Full),
    // ---- P3.1 workflows ----
    ("workflow-state", "paneId", Level::Watch),
    // ---- P1.7 chat feed ----
    ("session-chat-items", "paneId", Level::Watch),
    ("session-chat-status", "paneId", Level::Watch),
    ("session-chat-source", "paneId", Level::Watch),
    // The message box's queue holds what was typed to the agent: Answer reads it (as the messages route does).
    ("pane-outbox", "paneId", Level::Answer),
];

/// The `app` frame for one app event (what the far PC's window got, for the PC that is watching).
pub fn app_frame(event: &str, payload: &Value) -> String {
    frame("app", json!({ "event": event, "payload": payload }))
}

/// The session an `app` frame is about, so the door can apply that session's own "not for remote use" rule to the frame.
pub fn app_pane(payload: &str) -> Option<String> {
    let (name, data) = split(payload)?;
    let v: Value = serde_json::from_str(data).ok().filter(|_| name == "app")?;
    let field = APP_EVENTS.iter().find(|(e, _, _)| Some(*e) == v["event"].as_str())?.1;
    v["payload"][field].as_str().map(str::to_string)
}

/// `payload` with the stream offset of `source` when it has one (a missing offset is left out, never null).
fn with_offset(mut payload: Value, source: &Value) -> Value {
    if let Some(offset) = source.get("offset").filter(|o| o.is_u64()) {
        payload["offset"] = offset.clone();
    }
    payload
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
        // The queue itself (text already redacted by the pusher), not just "it changed": the box draws it as the window's own does.
        "pane-outbox" if level >= Level::Answer => {
            let v: Value = serde_json::from_str(data).ok()?;
            v.get("paneId")?.as_str()?;
            frame("app", json!({ "event": "pane-outbox", "payload": v }))
        }
        // A terminal's output and size, as the window gets them (`terminal-data` carries `b64`, not a number list). Metered by `terminal::throttle`.
        "terminal" if level >= Level::Full => {
            let v: Value = serde_json::from_str(data).ok()?;
            let (id, b64) = (v.get("pane_id")?.as_str()?, v.get("b64")?.as_str()?);
            app_frame("terminal-data", &with_offset(json!({ "pane_id": id, "b64": b64 }), &v))
        }
        "pane-resize" if level >= Level::Full => {
            let v: Value = serde_json::from_str(data).ok()?;
            app_frame("pty://resized", &with_offset(json!({ "pane_id": v.get("pane_id")?.as_str()?, "cols": v.get("cols")?, "rows": v.get("rows")? }), &v))
        }
        // Watch may read the questions list, so a change reaches it too (its list refreshes).
        "questions" => frame("questions", json!({})),
        "app" => {
            let v: Value = serde_json::from_str(data).ok()?;
            let event = v.get("event")?.as_str()?;
            let (_, field, least) = APP_EVENTS.iter().find(|(e, _, _)| *e == event)?;
            if level < *least {
                return None;
            }
            // Without the session it is about, a frame cannot be held to that session's rule: dropped.
            v["payload"][field].as_str()?;
            frame("app", json!({ "event": event, "payload": v["payload"] }))
        }
        _ => return None,
    };
    Some(Cow::Owned(out))
}
