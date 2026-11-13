//! The `sqlite_totals` reader: what a pay-per-use agent spent, summed from the messages in its own SQLite file.
//!
//! Read-only (the file may be open in the agent at the same time), no process run, no network. Only the time,
//! the model name, the cost and the token counts are selected; no message text is ever read or kept.
//! Names in the table (`usage.toml`) are checked to be plain words before they go into the query.

use super::readers::{ModelSpend, Reading, Spend, Totals};
use chrono::TimeZone;
use rusqlite::{params_from_iter, types::Value, Connection, OpenFlags};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const WEEK: Duration = Duration::from_secs(7 * 24 * 3600);
/// A busy database (the agent writing) is waited for this long, then the reading is skipped.
const BUSY: Duration = Duration::from_millis(1500);

/// The reader's fields, borrowed from `Reader::SqliteTotals`.
pub struct Spec<'a> {
    pub table: &'a str,
    pub time_column: &'a str,
    pub data_column: &'a str,
    pub only: Option<&'a (String, String)>,
    pub model: &'a str,
    pub cost: &'a str,
    pub tokens: &'a [String],
}

fn word(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `/tokens/input` -> `$.tokens.input`; `None` when a part is not a plain word.
fn json_path(pointer: &str) -> Option<String> {
    let parts: Vec<&str> = pointer.strip_prefix('/')?.split('/').collect();
    parts.iter().all(|p| word(p)).then(|| format!("$.{}", parts.join(".")))
}

/// Start of the local day containing `now`, in Unix ms.
fn day_start_ms(now: SystemTime) -> u64 {
    let ms = now.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let local = chrono::Local.timestamp_millis_opt(ms).single();
    let start = local.and_then(|t| t.date_naive().and_hms_opt(0, 0, 0)).and_then(|d| chrono::Local.from_local_datetime(&d).earliest());
    start.map(|t| t.timestamp_millis().max(0) as u64).unwrap_or_else(|| (ms.max(0) as u64) / 86_400_000 * 86_400_000)
}

/// Today (since local midnight) and the last 7 days, per model. `None` when the file is missing, cannot be
/// opened, or holds nothing from the last 7 days.
pub fn read_totals(path: &Path, spec: &Spec<'_>, now: SystemTime) -> Option<Reading> {
    if !path.is_file() || ![spec.table, spec.time_column, spec.data_column].iter().all(|n| word(n)) {
        return None;
    }
    let data = spec.data_column;
    let mut selects = vec![spec.time_column.to_string(), format!("json_extract({data}, ?)"), format!("json_extract({data}, ?)")];
    let mut params: Vec<Value> = vec![json_path(spec.model)?.into(), json_path(spec.cost)?.into()];
    for pointer in spec.tokens {
        selects.push(format!("json_extract({data}, ?)"));
        params.push(json_path(pointer)?.into());
    }
    let week_start = now.checked_sub(WEEK).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut sql = format!("SELECT {} FROM {} WHERE {} >= ?", selects.join(", "), spec.table, spec.time_column);
    params.push(week_start.into());
    if let Some((pointer, value)) = spec.only {
        sql.push_str(&format!(" AND json_extract({data}, ?) = ?"));
        params.push(json_path(pointer)?.into());
        params.push(value.clone().into());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    conn.busy_timeout(BUSY).ok()?;
    let mut stmt = conn.prepare(&sql).ok()?;
    let today_start = day_start_ms(now) as i64;
    let token_count = spec.tokens.len();
    let mut rows = stmt.query(params_from_iter(params.iter())).ok()?;
    let (mut today, mut week) = (Spend::default(), Spend::default());
    let mut models: BTreeMap<String, Spend> = BTreeMap::new();
    let mut newest: i64 = 0;
    let mut any = false;
    while let Ok(Some(row)) = rows.next() {
        let at: i64 = row.get(0).unwrap_or(0);
        let model: Option<String> = row.get(1).ok().flatten();
        let cost = row.get::<_, Option<f64>>(2).ok().flatten().filter(|c| c.is_finite() && *c > 0.0).unwrap_or(0.0);
        let tokens: u64 = (0..token_count).map(|i| row.get::<_, Option<i64>>(3 + i).ok().flatten().unwrap_or(0).max(0) as u64).sum();
        any = true;
        newest = newest.max(at);
        week.cost += cost;
        week.tokens += tokens;
        if at >= today_start {
            today.cost += cost;
            today.tokens += tokens;
        }
        let entry = models.entry(model.filter(|m| !m.is_empty()).unwrap_or_else(|| "unknown".into())).or_default();
        entry.cost += cost;
        entry.tokens += tokens;
    }
    if !any {
        return None;
    }
    let mut models: Vec<ModelSpend> = models.into_iter().map(|(model, s)| ModelSpend { model, cost: s.cost, tokens: s.tokens }).collect();
    models.sort_by(|a, b| b.cost.total_cmp(&a.cost).then(b.tokens.cmp(&a.tokens)).then_with(|| a.model.cmp(&b.model)));
    Some(Reading { totals: Some(Totals { today, week, models }), observed_at_ms: u64::try_from(newest).ok(), ..Reading::default() })
}
