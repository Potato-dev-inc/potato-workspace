//! Reads the registry and the shipped tables into `DefFacts`. The only impure part besides the store.

use super::DefFacts;

pub fn def_facts(agent_id: &str) -> DefFacts {
    let registered = crate::tui::is_registered(agent_id);
    let descriptor = crate::tui::descriptor_for(agent_id);
    let label = descriptor.as_ref().map(|d| d.label.clone()).unwrap_or_else(|| agent_id.to_string());
    let id = descriptor.as_ref().map(|d| d.id.to_string()).unwrap_or_else(|| agent_id.to_string());
    if !registered {
        return DefFacts { agent_id: id, label, ..Default::default() };
    }
    let profile = crate::tui::profile_for(&id);
    let features = profile.features();
    let acp = profile.acp_table();
    let shipped = match crate::tui::declarative::loader::last_entry_for(&id) {
        // A code profile has no file at all.
        None => true,
        Some(entry) => entry.source == "bundled" || store_added(&id),
    };
    let reviewed_adapter = acp
        .as_ref()
        .map(|cfg| !crate::acp::adapter_catalog::for_program(&cfg.command).is_empty())
        .unwrap_or(false);
    DefFacts {
        agent_id: id.clone(),
        label,
        shipped,
        has_acp: acp.is_some(),
        has_headless: crate::tui::run_modes(&id).headless,
        resumable_headless: features.resumable_headless,
        read_only_mapped: crate::agent_runs::read_only_run_table(&id),
        // No shipped definition carries a model list today.
        definition_models: Vec::new(),
        reviewed_adapter,
    }
}

/// The Store added this agent from the byte-identical catalog copy (the ladder never sets a catalog version).
fn store_added(id: &str) -> bool {
    let rec = crate::agent_store::record::load(&crate::agent_store::record::default_path());
    rec.agents.get(id).is_some_and(|r| !r.catalog.is_empty())
}
