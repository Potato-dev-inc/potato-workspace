//! Notices attached to tool results: the SCHEMA_DRIFT warning and the alias marker.
//!
//! A shim whose tool catalog differs from the running app's is the usual cause of confusing
//! argument rejections and missing tools. `bridge_health` always said so, but nothing else did.
//! The warning rides on the first result of each affected tool in this MCP process (or on the
//! first result overall when only the catalog is known), so the agent sees the fix without a
//! repeat on every call. It is also in `instructions` and in `bridge_health`.

use super::*;
use std::collections::BTreeSet;
#[cfg(not(test))]
use std::sync::Mutex;
use std::time::Instant;

/// The fix, in the words every warning uses.
pub(crate) const SCHEMA_DRIFT_FIX: &str =
    "Rebuild or reinstall the Potato Workspace MCP, then reconnect (Claude: /mcp).";

/// How long a health answer is trusted before the next tool call asks the bridge again.
const DRIFT_TTL: Duration = Duration::from_secs(60);

/// Remembers the last drift verdict so a burst of tool calls costs one `/health` request, not one
/// each. An unanswered check (bridge down) is never remembered.
pub(crate) struct DriftCache {
    checked: Option<(Instant, Option<Value>)>,
}

impl DriftCache {
    pub(crate) const fn new() -> Self {
        Self { checked: None }
    }

    /// `fetch` returns `None` when the bridge could not be asked, `Some(verdict)` otherwise.
    pub(crate) fn lookup(
        &mut self,
        now: Instant,
        fetch: impl FnOnce() -> Option<Option<Value>>,
    ) -> Option<Value> {
        if let Some((at, verdict)) = &self.checked {
            if now.saturating_duration_since(*at) < DRIFT_TTL {
                return verdict.clone();
            }
        }
        let verdict = fetch()?;
        self.checked = Some((now, verdict.clone()));
        verdict
    }
}

#[cfg(not(test))]
static DRIFT_CACHE: Mutex<DriftCache> = Mutex::new(DriftCache::new());

/// Keys whose drift warning already went out in this MCP process: a tool name, or `OVERALL_KEY`
/// when the mismatch is known only as a whole (no per-tool hashes).
#[cfg(not(test))]
static DRIFT_WARNED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// The key for the warn-once-overall case.
const OVERALL_KEY: &str = "*";

#[cfg(test)]
thread_local! {
    /// Tests never reach a real bridge: a test sets the `/health` body it wants here.
    pub(crate) static TEST_HEALTH: RefCell<Option<Value>> = const { RefCell::new(None) };
    /// Each test runs on its own thread, so this is that test's own "already warned" memory.
    pub(crate) static TEST_DRIFT_WARNED: RefCell<BTreeSet<String>> = const { RefCell::new(BTreeSet::new()) };
}

#[cfg(not(test))]
fn fetch_drift() -> Option<Option<Value>> {
    let body = bridge_request("GET", "/health", None).ok()?;
    let health: Value = serde_json::from_str(&body).ok()?;
    health.get("catalog_version")?;
    Some(schema_drift_from_health(&health))
}

/// The SCHEMA_DRIFT notice while this exe's catalog differs from the running app's, else `None`.
pub(crate) fn current_schema_drift() -> Option<Value> {
    #[cfg(test)]
    {
        TEST_HEALTH.with(|health| health.borrow().as_ref().and_then(schema_drift_from_health))
    }
    #[cfg(not(test))]
    {
        let mut cache = DRIFT_CACHE.lock().ok()?;
        cache.lookup(Instant::now(), fetch_drift)
    }
}

/// Records that `key` is about to be warned about. Returns `true` the first time in this process.
fn mark_drift_warned(key: &str) -> bool {
    #[cfg(test)]
    {
        TEST_DRIFT_WARNED.with(|set| set.borrow_mut().insert(key.to_string()))
    }
    #[cfg(not(test))]
    {
        match DRIFT_WARNED.lock() {
            Ok(mut set) => set.insert(key.to_string()),
            Err(_) => true,
        }
    }
}

/// Whether a drift notice rides on this call's result to `tool`, and records that it did.
///
/// A notice that names tools (from per-tool hashes) warns once per differing tool, and never for a
/// tool whose schema matches. A notice that names none (only the catalog hash or version is known)
/// warns once for the whole process. A tool never gets the same warning twice.
pub(crate) fn drift_warning_due(tool: &str, drift: &Value) -> bool {
    let named: Vec<&str> = ["changed_tools", "only_in_app", "only_in_shim"]
        .iter()
        .filter_map(|key| drift.get(*key).and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if named.is_empty() {
        return mark_drift_warned(OVERALL_KEY);
    }
    named.contains(&tool) && mark_drift_warned(tool)
}

/// One human-readable line for a notice.
pub(crate) fn notice_line(notice: &Value) -> String {
    format!(
        "WARNING [{}]: {}",
        notice
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("NOTICE"),
        notice
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
    )
}

/// Adds `notices` to a tool result: a final text block (so every host shows it) and a
/// `potato_workspace_warnings` array in `structuredContent`. The first content block, which holds
/// the tool's own JSON, is left untouched.
pub(crate) fn apply_notices(result: &mut Value, notices: &[Value]) {
    if notices.is_empty() {
        return;
    }
    if let Some(content) = result.get_mut("content").and_then(Value::as_array_mut) {
        for notice in notices {
            content.push(json!({"type":"text","text":notice_line(notice)}));
        }
    }
    if let Some(structured) = result
        .get_mut("structuredContent")
        .and_then(Value::as_object_mut)
    {
        let slot = structured
            .entry("potato_workspace_warnings")
            .or_insert_with(|| json!([]));
        if let Some(list) = slot.as_array_mut() {
            list.extend(notices.iter().cloned());
        }
    }
}

/// Post-processes a finished `tools/call` result: marks alias calls and carries any drift warning.
pub(crate) fn annotate_tool_result(name: &str, result: &mut Value) {
    if let Some(canonical) = tool_registry::alias_of(name) {
        if let Some(structured) = result
            .get_mut("structuredContent")
            .and_then(Value::as_object_mut)
        {
            structured.insert("alias_of".into(), json!(canonical));
        }
    }
    if let Some(drift) = current_schema_drift() {
        if drift_warning_due(name, &drift) {
            apply_notices(result, &[drift]);
        }
    }
}

/// The MCP `instructions` text, with the drift warning on top while a mismatch lasts.
pub(crate) fn instructions_with_notices() -> String {
    let base = tool_registry::mcp_instructions();
    match current_schema_drift() {
        Some(drift) => format!("{}\n\n{base}", notice_line(&drift)),
        None => base.to_string(),
    }
}
