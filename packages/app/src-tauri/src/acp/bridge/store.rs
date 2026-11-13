//! What the bridge remembers between runs so `session/load` can bring a chat back after a restart: for each
//! chat the agent's own conversation id (what the headless resume flag needs), the folder and the chosen model.
//! One small JSON file per agent in the app's data folder. Never holds a secret: ids, a folder and a model name.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Chats kept per agent; the oldest go first.
const MAX_CHATS: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remembered {
    pub provider_session: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub model: String,
    /// Counts up per write, to drop the oldest.
    #[serde(default)]
    pub seq: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    chats: BTreeMap<String, Remembered>,
}

/// The file of one agent, or nothing when the bridge was given no folder (tests that do not resume).
pub struct Store {
    path: Option<PathBuf>,
}

fn file_name(agent: &str) -> String {
    let safe: String = agent.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    format!("{safe}.json")
}

impl Store {
    pub fn new(dir: Option<&Path>, agent: &str) -> Store {
        Store { path: dir.map(|d| d.join(file_name(agent))) }
    }

    fn read(&self) -> File {
        let Some(path) = &self.path else { return File::default() };
        std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    }

    pub fn get(&self, chat: &str) -> Option<Remembered> {
        self.read().chats.get(chat).cloned()
    }

    /// Remembers `chat`. A failed write is ignored: the chat still works, it just cannot be brought back.
    pub fn put(&self, chat: &str, mut entry: Remembered) {
        let Some(path) = &self.path else { return };
        let mut file = self.read();
        entry.seq = file.chats.values().map(|r| r.seq).max().unwrap_or(0) + 1;
        file.chats.insert(chat.to_string(), entry);
        while file.chats.len() > MAX_CHATS {
            let Some(oldest) = file.chats.iter().min_by_key(|(_, r)| r.seq).map(|(k, _)| k.clone()) else { break };
            file.chats.remove(&oldest);
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let Ok(text) = serde_json::to_string(&file) else { return };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}
