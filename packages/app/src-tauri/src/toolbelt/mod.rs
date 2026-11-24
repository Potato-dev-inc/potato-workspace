//! Toolbelt: list MCP servers once, write them into every agent's own config.
//!
//! - `store`   the user's list (`toolbelt.json` in the app data folder)
//! - `sync`    the engine: per agent, add/update/remove ONLY the entries this feature owns
//!             (keys named `pm-toolbelt-<id>`), with a preview and a `.bak`
//! - `import`  read servers an agent already has and offer them for the toolbelt
//! - `edit`    format-preserving edits of one table in a JSON / TOML / YAML config
//!
//! Where an agent keeps its MCP servers is declared by the agent itself (`TuiProfile::mcp_host`,
//! or `[mcp_host]` in a declarative definition). Nothing here matches an agent name.

pub mod edit;
pub mod import;
pub mod service;
pub mod store;
pub mod sync;

#[cfg(test)]
mod tests;


pub use pm_core::toolbelt::KEY_PREFIX;
#[cfg(test)]
pub use pm_core::toolbelt::host_from_toml;
