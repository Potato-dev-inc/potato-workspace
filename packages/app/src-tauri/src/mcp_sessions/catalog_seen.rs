//! The tool catalog each MCP connection says it was started with.
//!
//! The MCP program sends its catalog hash on every bridge request (`X-Potato-Workspace-Catalog`). A connection whose
//! hash differs from this app's, and whose process is still alive, is an agent running an older (or newer) tool
//! list than the app: its calls can come back "unknown tool". The app shows that on the agent's chat so the person
//! can reconnect. In memory only; the value is a claim and grants no right (it is shown, never trusted).

use super::access::SESSION_PIDS;
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

static SESSION_CATALOGS: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// The most a catalog label may be: the real one is 16 hex characters.
const MAX_LABEL: usize = 48;

/// Plain characters only, so a claim can never carry markup or a line break into the app.
pub fn clean_catalog_label(raw: &str) -> Option<String> {
    let clean: String = raw.trim().chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).take(MAX_LABEL).collect();
    (!clean.is_empty()).then_some(clean)
}

pub fn note_session_catalog(session_id: &str, raw: &str) {
    let Some(label) = clean_catalog_label(raw) else { return };
    if let Ok(mut map) = SESSION_CATALOGS.lock() {
        if map.get(session_id) != Some(&label) {
            map.insert(session_id.to_string(), label);
        }
    }
}

/// One live connection whose tool list differs from the app's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleConnection {
    pub session_id: String,
    /// The pane the connection says it runs in (a hint), if it said.
    pub pane_id: Option<String>,
    pub catalog: String,
}

/// Live connections (their process still runs) whose catalog is not `app_catalog`, oldest session id first.
pub fn stale_connections(app_catalog: &str) -> Vec<StaleConnection> {
    stale_connections_where(app_catalog, |pid| crate::proc_util::pid_alive(pid))
}

pub(super) fn stale_connections_where(app_catalog: &str, alive: impl Fn(u32) -> bool) -> Vec<StaleConnection> {
    let Ok(catalogs) = SESSION_CATALOGS.lock() else { return Vec::new() };
    let pids = SESSION_PIDS.lock().map(|p| p.clone()).unwrap_or_default();
    let mut out: Vec<StaleConnection> = catalogs
        .iter()
        .filter(|(_, catalog)| catalog.as_str() != app_catalog)
        .filter(|(session, _)| pids.get(*session).is_some_and(|pid| alive(*pid)))
        .map(|(session, catalog)| StaleConnection {
            session_id: session.clone(),
            pane_id: super::pane_hint::claimed_session_pane(session),
            catalog: catalog.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_sessions::{note_session_pane, note_session_pid};

    #[test]
    fn labels_are_cleaned() {
        assert_eq!(clean_catalog_label(" 81-cee25c6f0af83be1 ").as_deref(), Some("81-cee25c6f0af83be1"));
        assert_eq!(clean_catalog_label("<b>x</b>\r\nX: y").as_deref(), Some("bxbXy"));
        assert_eq!(clean_catalog_label("   "), None);
    }

    #[test]
    fn only_a_live_connection_with_a_different_catalog_is_stale() {
        note_session_catalog("cs-old", "80-aaaa");
        note_session_pid("cs-old", 4_000_001);
        note_session_pane("cs-old", "pane-cs-1");
        note_session_catalog("cs-same", "81-bbbb");
        note_session_pid("cs-same", 4_000_002);
        note_session_catalog("cs-dead", "70-cccc");
        note_session_pid("cs-dead", 4_000_003);
        let stale = stale_connections_where("81-bbbb", |pid| pid != 4_000_003);
        let mine: Vec<_> = stale.iter().filter(|s| s.session_id.starts_with("cs-")).collect();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].session_id, "cs-old");
        assert_eq!(mine[0].pane_id.as_deref(), Some("pane-cs-1"));
        assert_eq!(mine[0].catalog, "80-aaaa");
    }

    #[test]
    fn a_reconnect_under_a_new_session_clears_the_old_one_when_its_process_ends() {
        note_session_catalog("cr-old", "80-aaaa");
        note_session_pid("cr-old", 4_000_011);
        assert!(stale_connections_where("81-bbbb", |_| true).iter().any(|s| s.session_id == "cr-old"));
        assert!(!stale_connections_where("81-bbbb", |_| false).iter().any(|s| s.session_id == "cr-old"));
    }
}
