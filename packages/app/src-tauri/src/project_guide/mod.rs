//! Project guide (Labs `project_guide_enabled`): a few plain pages that explain a project, one architecture
//! diagram, and the list of files each page cites so the app knows exactly when a page is out of date.
//!
//! * **The agent only writes.** The steps (look, outline, pages, diagram, manifest) are ours (`run.rs`). The model
//!   returns text; our code checks it (`check.rs`), draws the diagram itself (`mermaid.rs`) and writes every file.
//! * **Never automatic.** `run::start` needs the token a consent sheet got from `estimate` (`consent.rs`).
//! * **Where.** `<project>/.potato/guide/` (git-excluded). See `store.rs` for the layout.
//! * **No model here.** `scan`, `store`, `check`, `mermaid` and `stale` never call an agent, so they are cheap and
//!   fully testable. `run.rs` talks to an agent only through the [`run::GuideAgent`] trait; tests use a fake one.
//! * **Nothing is committed.** This module never runs `git commit` or `git push` (a test greps for it).

pub mod agent_tools;
pub mod check;
pub mod consent;
pub mod dry;
pub mod helper;
pub mod mermaid;
pub mod model;
pub mod prompts;
pub mod read;
pub mod run;
pub mod scan;
pub mod stale;
pub mod store;

/// The Labs switch (also in `DEV_LABS_KEYS`).
pub const LABS_KEY: &str = "project_guide_enabled";

#[cfg(test)]
mod tests;
