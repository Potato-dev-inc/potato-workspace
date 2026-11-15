//! One identity record for every device that can talk to this PC: this PC, a paired phone, a paired PC (the device
//! link) and a lending peer. The name the person sees comes from here, so a rename shows everywhere ("from Ren's Mac"
//! under a message, the Devices list, the "is typing" chip).
//!
//! - `id` is the id the other layers already use: `local` for this PC, the pairing uuid for a phone, `link:<node>` for a
//!   paired PC, `peer:<id>` for a lending peer. This module never names those layers.
//! - `auto_name` is what the device calls itself (a phone's model, a PC's computer name); it is refreshed when the
//!   device tells us again. `custom_name` is the person's own name and always wins.
//! - `account_id` is empty today. When a sign-in (Google, Discord) exists, it will sync names between a person's
//!   devices through this field. There is no sign-in here.
//! - No secret is kept here: names only.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(test)]
mod tests;

pub const LOCAL_ID: &str = "local";
const MAX_NAME_CHARS: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    ThisPc,
    Phone,
    Pc,
    Peer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceRecord {
    pub id: String,
    pub kind: DeviceKind,
    pub auto_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_name: Option<String>,
    /// A future sign-in's account. Empty until that exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

impl DeviceRecord {
    pub fn name(&self) -> &str {
        self.custom_name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&self.auto_name)
    }
}

/// One line, no control characters, at most 60 characters.
pub fn clean_name(raw: &str) -> String {
    let one_line: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    one_line.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_NAME_CHARS).collect()
}

pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| clean_name(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This computer".into())
}

pub struct Registry {
    path: Option<PathBuf>,
    records: Mutex<BTreeMap<String, DeviceRecord>>,
}

impl Registry {
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self { path: None, records: Mutex::new(BTreeMap::new()) }
    }

    /// Loads the file when it is there; a missing or broken file starts empty (names only, nothing to lose).
    pub fn at(path: PathBuf) -> Self {
        let records = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<DeviceRecord>>(&text).ok())
            .map(|list| list.into_iter().map(|r| (r.id.clone(), r)).collect())
            .unwrap_or_default();
        Self { path: Some(path), records: Mutex::new(records) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, DeviceRecord>> {
        self.records.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn save(&self, records: &BTreeMap<String, DeviceRecord>) {
        let Some(path) = &self.path else { return };
        let list: Vec<&DeviceRecord> = records.values().collect();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = path.with_extension("tmp");
        if serde_json::to_vec_pretty(&list).ok().and_then(|bytes| std::fs::write(&tmp, bytes).ok()).is_some() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    /// The device told us its own name (at pairing, or again later). Creates the record, or refreshes `auto_name`;
    /// a custom name is never touched. An empty name keeps what is there.
    pub fn observe(&self, id: &str, kind: DeviceKind, auto_name: &str) {
        let name = clean_name(auto_name);
        let mut records = self.lock();
        let changed = match records.get_mut(id) {
            Some(r) => {
                let changed = (!name.is_empty() && r.auto_name != name) || r.kind != kind;
                if !name.is_empty() {
                    r.auto_name = name;
                }
                r.kind = kind;
                changed
            }
            None => {
                let auto_name = if name.is_empty() { fallback(kind) } else { name };
                records.insert(id.to_string(), DeviceRecord { id: id.to_string(), kind, auto_name, custom_name: None, account_id: None });
                true
            }
        };
        if changed {
            self.save(&records);
        }
    }

    /// The person's own name for a device. Empty text goes back to the device's own name. `false`: no such device.
    pub fn rename(&self, id: &str, name: &str) -> bool {
        let mut records = self.lock();
        let Some(r) = records.get_mut(id) else { return false };
        let name = clean_name(name);
        r.custom_name = if name.is_empty() { None } else { Some(name) };
        self.save(&records);
        true
    }

    /// Reserved for a sign-in that does not exist yet (tests only until then).
    #[cfg(test)]
    pub fn set_account(&self, id: &str, account: Option<&str>) -> bool {
        let mut records = self.lock();
        let Some(r) = records.get_mut(id) else { return false };
        r.account_id = account.map(str::to_string).filter(|a| !a.is_empty());
        self.save(&records);
        true
    }

    pub fn forget(&self, id: &str) {
        let mut records = self.lock();
        if records.remove(id).is_some() {
            self.save(&records);
        }
    }

    pub fn get(&self, id: &str) -> Option<DeviceRecord> {
        self.lock().get(id).cloned()
    }

    pub fn display_name(&self, id: &str) -> Option<String> {
        self.get(id).map(|r| r.name().to_string())
    }

    /// `{ id: { name, kind } }` for every device, with this PC always present.
    pub fn names(&self) -> Value {
        self.observe(LOCAL_ID, DeviceKind::ThisPc, &computer_name());
        let records = self.lock();
        let map: serde_json::Map<String, Value> =
            records.values().map(|r| (r.id.clone(), json!({ "name": r.name(), "kind": r.kind }))).collect();
        Value::Object(map)
    }
}

fn fallback(kind: DeviceKind) -> String {
    match kind {
        DeviceKind::ThisPc => "This PC".into(),
        DeviceKind::Phone => "A phone".into(),
        DeviceKind::Pc => "Another PC".into(),
        DeviceKind::Peer => "A friend".into(),
    }
}

pub fn global() -> &'static Registry {
    static GLOBAL: OnceLock<Registry> = OnceLock::new();
    GLOBAL.get_or_init(|| {
        #[cfg(test)]
        {
            Registry::in_memory()
        }
        #[cfg(not(test))]
        {
            Registry::at(crate::app_paths::app_data_dir().join("device-identity.json"))
        }
    })
}

/// The name to show for a device id: the record's, else `fallback`.
pub fn name_or(id: &str, fallback: &str) -> String {
    global().display_name(id).unwrap_or_else(|| fallback.to_string())
}

/// The name of this PC (the person's own if they renamed it).
pub fn local_name() -> String {
    global().observe(LOCAL_ID, DeviceKind::ThisPc, &computer_name());
    global().display_name(LOCAL_ID).unwrap_or_else(computer_name)
}
