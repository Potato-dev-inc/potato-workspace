//! Moved out of the app: the `[skills_host]` table of an agent profile (the app re-exports `host`).
pub mod host;
pub use host::{skills_host_from_toml, SkillsHostTable};
