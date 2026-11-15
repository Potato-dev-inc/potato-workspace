//! The social judgment gate (P3 of the fishd port, from fishd `src/channels/{gate,ambient,burst,addressing}.ts`).
//!
//! In a room of several people the companion is not an assistant that answers every line. For a message that
//! did not call it (no mention, no reply to it, no name) the question is only: should it join in? This module
//! answers that and nothing else. Everything here is pure or takes the clock and the model as arguments, so it
//! runs in unit tests with no network.
//!
//! - `heuristic`: rules, deterministic per message id. Always available, always the last link.
//! - `llm`: asks the person's own small model for YES or NO. Any failure falls through.
//! - `jev`: the formula of a hosted judge. Held back: no client exists, nothing is ever sent (decision D2).
//! - `chain`: the links in order; the first that gives an answer wins; the heuristic is always last.
//! - `budget`: how often it may join in, how many turns one person may start, how many wait in the queue.
//!   The budget is checked BEFORE any gate call, so a full budget costs nothing.
//! - `burst`: not a file of its own: the rolling tape of each channel in `discord_bot::service` plays that role.
//! - `addressing`: a line aimed at somebody else is not for the companion.
//!
//! The gate only ever returns "speak" or "stay quiet". The text of the room goes into the question as data in
//! a marked block; whatever it says there cannot make the gate do anything but answer yes or no.

pub mod addressing;
pub mod budget;
pub mod chain;
pub mod gate;
pub mod heuristic;
#[allow(dead_code)] // Held back (decision D2): the formula is tested, but no judge can be built, so nothing calls it.
pub mod jev;
pub mod llm;

