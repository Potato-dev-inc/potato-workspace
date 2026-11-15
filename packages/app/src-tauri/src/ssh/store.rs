//! The saved SSH places, in `<app data>/ssh_hosts.json`. A host holds a name, user, address, port and the PATH of a
//! key file. It never holds a password or key contents. Reads are tolerant: an entry that fails the rules is
//! dropped. Only Tauri commands write.

use crate::secure_file;
use crate::ssh::check::Facts;
use crate::ssh::model::SshHost;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const FILE_NAME: &str = "ssh_hosts.json";
const MAX_HOSTS: usize = 50;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// A saved place and what its last check found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    #[serde(flatten)]
    pub host: SshHost,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(default)]
    pub found: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Default)]
struct File {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    hosts: Vec<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn at(dir: &Path) -> Self {
        Self { path: dir.join(FILE_NAME) }
    }

    #[cfg(not(test))]
    pub fn live() -> Self {
        Self::at(&crate::app_paths::app_data_dir())
    }

    pub fn list(&self) -> Vec<Saved> {
        let Ok(text) = std::fs::read_to_string(&self.path) else { return Vec::new() };
        let file: File = serde_json::from_str(&text).unwrap_or_default();
        file.hosts
            .into_iter()
            .filter_map(|v| serde_json::from_value::<Saved>(v).ok())
            .filter(|s| s.host.is_valid())
            .take(MAX_HOSTS)
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Saved> {
        self.list().into_iter().find(|s| s.host.id == id)
    }

    fn write(&self, hosts: &[Saved]) -> Result<(), String> {
        let file = serde_json::json!({ "version": 1, "hosts": hosts });
        secure_file::write_private(&self.path, &serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?)
    }

    pub fn add(&self, saved: Saved) -> Result<(), String> {
        let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut all = self.list();
        if all.len() >= MAX_HOSTS {
            return Err("There are too many saved machines. Remove one first.".into());
        }
        all.retain(|s| s.host.id != saved.host.id);
        all.push(saved);
        self.write(&all)
    }

    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut all = self.list();
        let before = all.len();
        all.retain(|s| s.host.id != id);
        let removed = all.len() != before;
        if removed {
            self.write(&all)?;
        }
        Ok(removed)
    }

    /// Keeps what a check found (only names the caller already validated).
    pub fn set_check(&self, id: &str, facts: &Facts, at: u64) -> Result<(), String> {
        let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut all = self.list();
        let Some(s) = all.iter_mut().find(|s| s.host.id == id) else { return Ok(()) };
        s.os = facts.os.clone();
        s.found = facts.found.clone();
        s.checked_at = Some(at);
        self.write(&all)
    }
}
