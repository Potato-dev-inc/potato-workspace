//! The trusted hosts overlay: `[mcp_host]` / `[skills_host]` for agents whose own definition has none.
//!
//! `agent-hosts.toml` is compiled into the app, so it is trusted; nothing reads it from a user, project
//! or store folder. Store definitions stay barred from declaring hosts (`agent_store::check`). An agent
//! id is looked up here only when its definition declares no host of that kind. No agent is named in code.

use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::BTreeMap;

use super::schema::{DefError, McpHostTable};
use crate::agent_pack::SkillsHostTable;

const OVERLAY: &str = include_str!("agent-hosts.toml");

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostsEntry {
    pub mcp_host: Option<McpHostTable>,
    pub skills_host: Option<SkillsHostTable>,
}

/// Parse an overlay text into id -> hosts.
pub fn parse(text: &str) -> Result<BTreeMap<String, HostsEntry>, String> {
    toml::from_str(text).map_err(|e| e.to_string())
}

/// Every problem in an overlay, `id: path: message`; empty when all entries pass the definition validator.
pub fn problems(text: &str) -> Vec<String> {
    let map = match parse(text) {
        Ok(m) => m,
        Err(e) => return vec![format!("overlay does not parse: {e}")],
    };
    let mut out = Vec::new();
    for (id, entry) in &map {
        if entry.mcp_host.is_none() && entry.skills_host.is_none() {
            out.push(format!("{id}: declares no host"));
        }
        let errs: Vec<DefError> = super::validate::validate_hosts(entry.mcp_host.as_ref(), entry.skills_host.as_ref());
        out.extend(errs.into_iter().map(|e| format!("{id}: {}: {}", e.path, e.message)));
    }
    out
}

static HOSTS: Lazy<BTreeMap<String, HostsEntry>> = Lazy::new(|| parse(OVERLAY).unwrap_or_default());

pub fn mcp_host_for(id: &str) -> Option<McpHostTable> {
    HOSTS.get(id).and_then(|e| e.mcp_host.clone())
}

pub fn skills_host_for(id: &str) -> Option<SkillsHostTable> {
    HOSTS.get(id).and_then(|e| e.skills_host.clone())
}

pub fn ids() -> Vec<String> {
    HOSTS.keys().cloned().collect()
}
