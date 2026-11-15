//! Pass a task to a teammate ("Pass a task", plan `TEAM-PAGE-1115.md` 3.6 and 4.4): from a chat or the Team page, a
//! teammate gets a heads-up card with a title, the words and an optional chat summary. They see it on their Team page
//! (Tasks) and say Accept or Decline. It travels the team relay sealed twice, like a lend request: with the team key, and
//! again to ONE of their PCs (`wire`).
//!
//! The rules this module keeps:
//! - **A teammate's text is data.** It is cleaned (control characters dropped, cut to its limit), shown quoted, and never run.
//!   Accepting records the answer; `Start...` opens the New agent page with the words in the box, and the person presses
//!   the button. Nothing here starts an agent, a pane or a script (`guard_tests`).
//! - **Their own agent by default.** The sender may also offer "run it through my lent usage": a promise for one lend of one
//!   profile (the sender's click, bound to the task id, the person and the time). The receiver's `Accept` then sends the
//!   normal lend request naming the task, and the sender's PC answers yes for that request only (`OfferGate` in
//!   `capacity_proxy`). The model calls still go through the lender's proxy; no sign-in, token or key is in any item here.
//! - **Repo hand-over, at your own risk** (off until the person turns it on, on both PCs): a git bundle of one branch, cut
//!   into pieces over the team relay with a 2 MB cap (`bundle`). Both sides see a big plain warning; the receiver picks the
//!   place and gets a NEW folder, never an overwrite, and nothing in it is run.
//!
//! Desktop only: Tauri commands (`commands`) and nothing else. No bridge route, MCP tool or phone route reaches this module
//! (`guard_tests`).

pub mod app;
pub mod bundle;
pub mod commands;
pub mod model;
pub mod service;
pub mod wire;

#[cfg(test)]
mod bundle_tests;
#[cfg(test)]
mod guard_tests;
#[cfg(test)]
mod tests;

pub use app::{init, offer_gate, on_team_item};
