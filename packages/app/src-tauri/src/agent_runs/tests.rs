//! Cross-module behaviour tests for agent runs, grouped by topic. Shared helpers live in
//! `fixtures`; the module-local tests sit beside the code they cover.

mod checks;
mod choices;
mod hidden_gate;
mod claims;
mod continuity;
mod definitions;
mod fixtures;
mod guarantees;
mod followups;
mod interrupt;
mod native_completion;
mod native_stop;
mod receipts;
mod request_fields;
mod steering;
mod tui_turn;
mod tui_turn_tools;
mod reopen;
mod views;
