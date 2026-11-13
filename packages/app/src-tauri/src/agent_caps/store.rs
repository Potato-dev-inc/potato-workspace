//! `<app data>/agent-caps/<agent_id>.json` = `{schema, handshake, seen}`. A missing or broken file reads as empty.

use super::types::CAPS_SCHEMA;
use super::{HandshakeFacts, SeenFact};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SEEN_MAX: usize = 50;

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct StoreFile {
    pub schema: u32,
    pub handshake: Option<HandshakeFacts>,
    pub seen: Vec<SeenFact>,
}

#[cfg(not(test))]
pub fn default_dir() -> PathBuf {
    crate::app_paths::app_data_dir().join("agent-caps")
}

/// Tests never write into the person's app data.
#[cfg(test)]
pub fn default_dir() -> PathBuf {
    std::env::temp_dir().join(format!("pm-agent-caps-default-{}", std::process::id()))
}

/// Only plain ids become file names.
fn path_for(dir: &Path, agent_id: &str) -> Result<PathBuf, String> {
    let ok = !agent_id.is_empty()
        && agent_id.len() <= 64
        && agent_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok {
        return Err("agent caps: not a plain agent id".into());
    }
    Ok(dir.join(format!("{}.json", agent_id.to_ascii_lowercase())))
}

pub fn load(dir: &Path, agent_id: &str) -> StoreFile {
    let Ok(path) = path_for(dir, agent_id) else { return StoreFile::default() };
    let Ok(text) = std::fs::read_to_string(path) else { return StoreFile::default() };
    let mut file = serde_json::from_str::<StoreFile>(&text).unwrap_or_default();
    let extra = file.seen.len().saturating_sub(SEEN_MAX);
    file.seen.drain(..extra);
    file
}

/// Every write takes this: two chats of one agent that record together must not lose a fact or fight for the temp file.
static WRITE: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Deletes the agent's file. A missing file is fine.
pub fn remove(dir: &Path, agent_id: &str) {
    let _guard = WRITE.lock();
    if let Ok(path) = path_for(dir, agent_id) {
        let _ = std::fs::remove_file(path);
    }
}

pub fn update(dir: &Path, agent_id: &str, change: impl FnOnce(&mut StoreFile)) -> Result<(), String> {
    let _guard = WRITE.lock();
    let path = path_for(dir, agent_id)?;
    let mut file = load(dir, agent_id);
    change(&mut file);
    file.schema = CAPS_SCHEMA;
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("agent caps: {e}"))?;
    crate::secure_file::write_private(&path, &text)
}
