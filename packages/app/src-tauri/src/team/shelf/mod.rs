//! The Team shelf (R4-14, "same setup for the whole team"): the skills and tools (MCP servers and
//! connectors) this PC has, listed in one place; "Suggest to a teammate" sends the definition with
//! every secret taken out; the teammate sees it and adds it with one click, after seeing exactly what
//! will be written.
//!
//! - `model`    the item that travels (definition only), its id and its cleaning rules
//! - `export`   my tool or skill -> an item, with secrets and my folders removed (`PLACEHOLDER`)
//! - `gate`     the untrusted-command check (shell, path, unknown program -> "I trust this")
//! - `local`    what this PC has (toolbelt, agent configs, skills folders)
//! - `add`      preview, apply and undo through the toolbelt writer and the skills folders
//! - `inbound`  shelf events on the wire (build mine, read a teammate's)
//! - `store`    suggestions I got, what I added, who has what
//! - `state`    what the tab shows
//! - `commands` the cockpit's commands (desktop only: no bridge route, no MCP tool, no phone)

pub mod add;
pub mod commands;
pub mod export;
pub mod gate;
pub mod inbound;
pub mod local;
pub mod model;
pub mod state;
pub mod store;

#[cfg(test)]
mod tests;

/// The shelf's file in the team folder.
pub const FILE: &str = "shelf.json";

/// A teammate's shelf event, kept. True when something changed (the cockpit should look again).
pub fn apply_inbound(file: &std::path::Path, read: inbound::Read, now_ms: u64) -> bool {
    store::with(file, |s| match read {
        inbound::Read::Suggest(card) => s.add_card(card, now_ms),
        inbound::Read::Have { member, ids, at_ms } => {
            s.set_have(&member, ids, at_ms, now_ms);
            true
        }
    })
}
