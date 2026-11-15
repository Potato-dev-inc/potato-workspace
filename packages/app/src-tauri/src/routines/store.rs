//! The private file under `<app data>/routines/state.json`. Every write is atomic (`secure_file::write_private`).
//! A missing, unreadable or newer-format file reads as an empty state and is left in place (nothing is lost on a
//! read; a newer format is never overwritten by an older app).

use super::model::{State, FILE_VERSION};
use crate::secure_file::write_private;
use std::fs;
use std::path::PathBuf;
#[cfg(test)]
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn at(root: impl Into<PathBuf>) -> Store {
        Store { root: root.into() }
    }

    /// The app's own store: `<app data>/routines`.
    #[cfg(not(test))]
    pub fn live() -> Store {
        Store::at(crate::app_paths::app_data_dir().join("routines"))
    }

    #[cfg(test)]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    /// The saved state, or the empty one. `Err(())` is not a thing here: a bad file is just "nothing yet".
    pub fn load(&self) -> State {
        let Ok(text) = fs::read_to_string(self.path()) else { return State::default() };
        match serde_json::from_str::<State>(&text) {
            Ok(state) if state.version <= FILE_VERSION => state,
            _ => State::default(),
        }
    }

    /// Whether a file made by a newer app is there (this app must not write over it).
    pub fn is_newer(&self) -> bool {
        fs::read_to_string(self.path())
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|v| v.get("version").and_then(serde_json::Value::as_u64))
            .is_some_and(|v| v > u64::from(FILE_VERSION))
    }

    pub fn save(&self, state: &State) -> Result<(), String> {
        if self.is_newer() {
            return Err("The saved routines were made by a newer version of the app.".into());
        }
        fs::create_dir_all(&self.root).map_err(|e| format!("could not make the routines folder: {e}"))?;
        let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
        write_private(&self.path(), &json)
    }
}
