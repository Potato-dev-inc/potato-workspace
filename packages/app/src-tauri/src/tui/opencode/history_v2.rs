//! OpenCode 2.x's old chats, read from the same SQLite database as the old layout (`history.rs`), read-only.
//! This is the layout the 2.x releases write: `session_v2` (one row per chat), `session_message` (one row per
//! message, `data` holds the whole message as JSON) and `session_part` (empty in the releases checked so far).
//!
//! Where the names come from: the `opencode` 2.2.7 binary (`opencode-ai` npm package, Windows x64) carries its own
//! migration SQL. The live database of an installed 2.2.7 has these tables with these columns, and a message's
//! `data` for each `type`:
//! - `user`: `{text, time: {created}}`.
//! - `assistant`: `{agent, model: {providerID, id, variant}, content, finish, cost, tokens, time: {created, completed}}`.
//!   `content` is a list of `text` (`text`), `reasoning` (`text`, `time`) and `tool` (`id`, `name`, `input`, `time`,
//!   `state`: `{status, input, content: [{type: "text", text}], metadata}`, or `{status: "error", error: {message, type}}`).
//! - `compaction`: `{status, reason, summary, time}`. `system`, `synthetic`, `idle` and `model-switched` are not chat text.
//! A child chat (a sub-agent) has `parent_id` set and is left out of the listing, as in the old layout.
//!
//! The rows are turned into the `{info, parts}` objects of the old layout's HTTP shape, so `chat::map::map_messages`
//! maps both layouts the same way. Nothing here writes. A layout that does not match is `ReadError::Format`.
//! Known gap: an assistant message with `finish: "error"` stores no error text, so it reads as a finished turn.

use std::time::Instant;

use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

use super::history::{object, read_error, with_fields};
use crate::session_chat::history::{valid_session_id, HistoryChat, ListLimits, Listing, ReadError};
use crate::session_chat::home_to_tilde;

/// Parent chats (sub-agent sessions have a parent and are left out), newest first. `bytes` is the size of the
/// chat's message data, which the importer counts against `max_file_bytes`.
const LIST_SQL: &str = "SELECT s.id, s.directory, s.time_updated,
       (SELECT COALESCE(SUM(length(CAST(m.data AS BLOB))), 0) FROM session_message m WHERE m.session_id = s.id) AS bytes
FROM session_v2 s
WHERE s.parent_id IS NULL AND s.time_updated >= ?1
ORDER BY s.time_updated DESC, s.id";

/// The messages of one chat in the order the session wrote them.
pub(super) const MESSAGES_SQL: &str = "SELECT id, type, data FROM session_message WHERE session_id = ?1 ORDER BY seq, id";

/// Lists the parent chats of a v2 database. The caller has checked the layout.
pub(super) fn list_chats(conn: &Connection, home: Option<&str>, limits: &ListLimits) -> rusqlite::Result<Listing> {
    let started = Instant::now();
    let since = limits.since_ms.unwrap_or(i64::MIN);
    let mut out = Listing::default();
    let mut stmt = conn.prepare(LIST_SQL)?;
    let rows = stmt.query_map(params![since], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
    })?;
    for row in rows {
        if started.elapsed() >= limits.budget {
            out.cut_short = true;
            break;
        }
        let (session, directory, updated_ms, bytes) = row?;
        let bytes = bytes.max(0) as u64;
        if bytes > limits.max_file_bytes {
            out.too_big += 1;
            continue;
        }
        if !valid_session_id(&session) {
            out.unreadable += 1;
            continue;
        }
        if out.chats.len() >= limits.max_chats {
            out.cut_short = true;
            break;
        }
        let cwd = directory.filter(|dir| !dir.is_empty()).map(|dir| home_to_tilde(&dir, home));
        out.chats.push(HistoryChat { session, cwd, updated_ms, bytes, stamp: updated_ms.to_string() });
    }
    Ok(out)
}

/// The message rows of one chat, as `{info, parts}` objects, within `max_bytes` of data. Returns the messages and
/// whether the byte cap stopped the read.
pub(super) fn load_messages(conn: &Connection, session: &str, max_bytes: u64) -> Result<(Vec<Value>, bool), ReadError> {
    let mut stmt = conn.prepare(MESSAGES_SQL).map_err(|err| read_error(&err))?;
    let rows = stmt
        .query_map([session], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .map_err(|err| read_error(&err))?;
    let mut used: u64 = 0;
    let mut cut_short = false;
    let mut kept: Vec<(String, String, String)> = Vec::new();
    for row in rows {
        let (id, kind, data) = row.map_err(|err| read_error(&err))?;
        used += data.len() as u64;
        if used > max_bytes {
            cut_short = true;
            break;
        }
        kept.push((id, kind, data));
    }
    drop(stmt);
    Ok((to_messages(&kept, session), cut_short))
}

/// Turns the message rows (id, type, data) of one chat into the old layout's `{info, parts}` objects. A row whose
/// data is not a JSON object, or whose type is not chat, gives nothing. A user message's id is remembered so the
/// assistant messages after it can name it as their parent (the turn length is counted from it).
pub(super) fn to_messages(rows: &[(String, String, String)], session: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut last_user: Option<&str> = None;
    for (id, kind, data) in rows {
        let Some(data) = object(data) else {
            continue;
        };
        match kind.as_str() {
            "user" => {
                last_user = Some(id.as_str());
                let info = message_info(id, session, "user", &data);
                let text = data["text"].as_str().unwrap_or("");
                out.push(json!({ "info": info, "parts": [{ "type": "text", "text": text }] }));
            }
            "assistant" => {
                let info = assistant_info(id, session, last_user, &data);
                out.push(json!({ "info": info, "parts": assistant_parts(&data) }));
            }
            "compaction" => {
                let info = message_info(id, session, "assistant", &data);
                out.push(json!({ "info": info, "parts": [{ "type": "compaction" }] }));
            }
            _ => {}
        }
    }
    out
}

/// The `info` of a message: its id, its session, its role and its time.
fn message_info(id: &str, session: &str, role: &str, data: &Value) -> Value {
    let mut info = with_fields(json!({ "role": role, "time": data["time"] }), &[("id", id), ("sessionID", session)]);
    if let Value::Object(map) = &mut info {
        map.retain(|_, value| !value.is_null());
    }
    info
}

/// The `info` of an assistant message: the message fields plus the model, the finish and the parent user message.
fn assistant_info(id: &str, session: &str, parent: Option<&str>, data: &Value) -> Value {
    let mut info = message_info(id, session, "assistant", data);
    if let Value::Object(map) = &mut info {
        map.insert("finish".into(), data["finish"].clone());
        map.insert("providerID".into(), data["model"]["providerID"].clone());
        map.insert("modelID".into(), data["model"]["id"].clone());
        if let Some(parent) = parent {
            map.insert("parentID".into(), Value::String(parent.to_string()));
        }
        map.retain(|_, value| !value.is_null());
    }
    info
}

/// The parts of an assistant message in order: its text, its tool calls (with results), then the token count.
/// Reasoning is left out, as the old layout leaves it out.
fn assistant_parts(data: &Value) -> Vec<Value> {
    let mut parts: Vec<Value> = Vec::new();
    for item in data["content"].as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("text") => parts.push(json!({ "type": "text", "text": item["text"] })),
            Some("tool") => parts.push(tool_part(item)),
            _ => {}
        }
    }
    if data["tokens"].is_object() {
        parts.push(json!({ "type": "step-finish", "tokens": data["tokens"] }));
    }
    parts
}

/// One tool call as the old layout's `tool` part: the call, its input, and its result in `state` (`output` when it
/// completed, `error` text when it failed).
fn tool_part(item: &Value) -> Value {
    let state_in = &item["state"];
    let mut state = Map::new();
    state.insert("status".into(), state_in["status"].clone());
    state.insert("input".into(), state_in["input"].clone());
    if state_in["status"] == "error" {
        let message = state_in["error"]["message"].as_str().or_else(|| state_in["error"].as_str()).unwrap_or("The tool failed.");
        state.insert("error".into(), Value::String(message.to_string()));
    } else {
        let output: Vec<&str> = state_in["content"].as_array().into_iter().flatten().filter_map(|part| part["text"].as_str()).collect();
        state.insert("output".into(), Value::String(output.join("\n")));
    }
    state.insert("metadata".into(), state_in["metadata"].clone());
    state.insert("time".into(), json!({ "start": item["time"]["created"], "end": item["time"]["completed"] }));
    json!({ "type": "tool", "callID": item["id"], "tool": item["name"], "state": Value::Object(state) })
}

#[cfg(test)]
#[path = "history_v2_tests.rs"]
mod tests;
