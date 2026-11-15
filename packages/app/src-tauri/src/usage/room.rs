//! "Room left": one number per sign-in that can cross to another PC.
//!
//! Only NUMBERS and LABELS cross: the agent id, the agent's name, the sign-in's label, percent left, when it resets and
//! when the numbers were read. Never a token, an email, a path or a login. A plan that reports nothing is "unknown"
//! (percent `None`), never a guess.

use super::{UsageRow, UsageSnapshot};
use serde::Serialize;
use serde_json::{json, Value};

/// The most sign-ins one PC tells another about.
const MAX_ROWS: usize = 24;
const LABEL_MAX: usize = 40;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Room {
    pub agent_id: String,
    pub agent_label: String,
    pub account_label: Option<String>,
    /// 0-100. `None`: the plan did not say.
    pub percent_left: Option<u8>,
    pub resets_at_ms: Option<u64>,
    pub observed_at_ms: Option<u64>,
}

fn plain(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(LABEL_MAX).collect::<String>().trim().to_string()
}

fn left_of(used: f64) -> u8 {
    (100.0 - used).clamp(0.0, 100.0).round() as u8
}

/// One sign-in's room: its tightest window (the one with the least left). A limited row has none left.
pub fn room_of(row: &UsageRow) -> Room {
    let tight = row.windows.iter().filter(|w| !w.reset_since).max_by(|a, b| a.used_percent.total_cmp(&b.used_percent));
    let (percent_left, resets_at_ms) = match row.state {
        "limited" => (Some(0), row.limited_until_ms.or(tight.and_then(|w| w.resets_at_ms))),
        "ok" => match tight {
            Some(w) => (Some(left_of(w.used_percent)), w.resets_at_ms),
            None if row.windows.iter().any(|w| w.reset_since) => (Some(100), None),
            None => (None, None),
        },
        _ => (None, None),
    };
    Room {
        agent_id: row.agent_id.clone(),
        agent_label: row.label.clone(),
        account_label: row.account_label.clone(),
        percent_left,
        resets_at_ms,
        observed_at_ms: row.observed_at_ms,
    }
}

/// This PC's own sign-ins (not the ones lent to it: those are the lender's to tell).
pub fn rooms_of(snap: &UsageSnapshot) -> Vec<Room> {
    snap.rows.iter().filter(|r| r.link != Some("borrowed") && r.totals.is_none()).map(room_of).take(MAX_ROWS).collect()
}

/// What goes over the device link: a list of objects with exactly these keys.
pub fn payload(rooms: &[Room]) -> Value {
    Value::Array(
        rooms
            .iter()
            .map(|r| {
                json!({
                    "agent_id": r.agent_id, "agent_label": r.agent_label, "account_label": r.account_label,
                    "percent_left": r.percent_left, "resets_at_ms": r.resets_at_ms, "observed_at_ms": r.observed_at_ms,
                })
            })
            .collect(),
    )
}

/// What came from the other PC, read defensively (untrusted: bounded, plain text, percent clamped, unknown keys dropped).
pub fn parse(value: &Value) -> Vec<Room> {
    let Some(list) = value.as_array() else { return Vec::new() };
    list.iter()
        .take(MAX_ROWS)
        .filter_map(|v| {
            let agent_id = plain(v["agent_id"].as_str()?);
            let agent_label = plain(v["agent_label"].as_str().unwrap_or(&agent_id));
            if agent_id.is_empty() {
                return None;
            }
            Some(Room {
                agent_label: if agent_label.is_empty() { agent_id.clone() } else { agent_label },
                agent_id,
                account_label: v["account_label"].as_str().map(plain).filter(|s| !s.is_empty()),
                percent_left: v["percent_left"].as_f64().map(|p| p.clamp(0.0, 100.0).round() as u8),
                resets_at_ms: v["resets_at_ms"].as_u64(),
                observed_at_ms: v["observed_at_ms"].as_u64(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::readers::Window;

    fn row(state: &'static str, used: Option<f64>) -> UsageRow {
        UsageRow {
            agent_id: "claude".into(),
            label: "Claude".into(),
            account_id: Some("secret-account-id".into()),
            account_label: Some("Work".into()),
            state,
            reason: Some("Sign in at someone@example.com".into()),
            windows: used.map(|u| vec![Window { name: "5-hour".into(), used_percent: u, minutes: Some(300), resets_at_ms: Some(1000), reset_since: false }]).unwrap_or_default(),
            totals: None,
            plan: Some("Max".into()),
            observed_at_ms: Some(5),
            limited_until_ms: None,
            page: Some("https://example.com/usage".into()),
            link: None,
            same_as_main: false,
        }
    }

    #[test]
    fn room_is_the_tightest_window_and_a_limit_is_nothing_left() {
        assert_eq!(room_of(&row("ok", Some(38.0))).percent_left, Some(62));
        assert_eq!(room_of(&row("ok", Some(140.0))).percent_left, Some(0));
        assert_eq!(room_of(&row("limited", None)).percent_left, Some(0));
        assert_eq!(room_of(&row("unknown", None)).percent_left, None);
        assert_eq!(room_of(&row("expired", None)).percent_left, None);
        assert_eq!(room_of(&row("ok", None)).percent_left, None);
    }

    #[test]
    fn what_crosses_to_another_pc_is_only_numbers_and_labels() {
        let sent = payload(&[room_of(&row("ok", Some(38.0)))]);
        let obj = sent[0].as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["account_label", "agent_id", "agent_label", "observed_at_ms", "percent_left", "resets_at_ms"]);
        let text = sent.to_string();
        for leak in ["secret-account-id", "example.com", "Max", "reason", "token"] {
            assert!(!text.contains(leak), "{leak} must not cross: {text}");
        }
        assert_eq!(parse(&sent), vec![room_of(&row("ok", Some(38.0)))]);
    }

    #[test]
    fn what_arrives_is_bounded_and_cleaned() {
        let long = "x".repeat(500);
        let got = parse(&json!([{ "agent_id": "claude", "agent_label": "Cl\u{7}aude", "account_label": long, "percent_left": 400, "token": "sk-1" }, { "agent_label": "no id" }, 7]));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].agent_label, "Claude");
        assert_eq!(got[0].account_label.as_ref().unwrap().len(), LABEL_MAX);
        assert_eq!(got[0].percent_left, Some(100));
        assert!(parse(&json!("nope")).is_empty());
    }
}
