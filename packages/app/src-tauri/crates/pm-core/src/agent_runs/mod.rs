//! Moved out of the app: the gates a typed prompt goes through and how a delivered turn is read (the app re-exports each module).
pub mod approval_policy;
pub mod completion;
pub mod checks;
pub mod delivery;
pub mod guarantees;
pub mod readiness;
pub mod structured;
pub mod transcript;
pub mod tree_proof;
#[cfg(test)]
mod tree_proof_tests;

use std::hash::{Hash, Hasher};

pub fn stable_prompt_id(prompt: &serde_json::Value) -> Option<String> {
    let id_text = serde_json::to_string(prompt).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    id_text.hash(&mut hasher);
    Some(format!("prompt-{:016x}", hasher.finish()))
}
