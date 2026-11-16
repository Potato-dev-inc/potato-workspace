//! The machine side of `config_plan`: the settings store, the standby list on disk and the warm pool.

use super::World;
use crate::pty::PaneRegistry;
use crate::standby::helpers::{self, HelperStore};
use parking_lot::Mutex;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;

pub struct LiveWorld<'a> {
    pub app: &'a AppHandle,
    pub registry: &'a Arc<Mutex<PaneRegistry>>,
}

impl World for LiveWorld<'_> {
    fn catalog(&self) -> Value {
        crate::settings_store::read_catalog(self.app)
    }

    fn patch_settings(&self, patch: &Value) {
        crate::settings_store::patch_public_settings(self.app, patch.clone());
    }

    fn helper_store(&self) -> HelperStore {
        helpers::file().snapshot()
    }

    fn standby_view(&self) -> Value {
        serde_json::to_value(helpers::view()).unwrap_or_default()
    }

    fn edit_helpers(&self, change: &mut dyn FnMut(&mut HelperStore) -> Result<(), String>) -> Result<(), String> {
        helpers::file().edit(|store| change(store))
    }

    fn agent_can_wait(&self, agent: &str) -> bool {
        crate::acp::config::find_builtin(agent).is_some()
    }

    fn folder_exists(&self, path: &str) -> bool {
        Path::new(path).is_dir()
    }

    fn default_project(&self) -> Option<String> {
        let path = self.registry.lock().project_path.clone();
        (!path.trim().is_empty()).then_some(path)
    }

    fn new_id(&self) -> String {
        uuid::Uuid::new_v4().simple().to_string()
    }

    fn helpers_changed(&self, closed: &[String]) {
        if let Some(pool) = crate::acp::warm::pool() {
            for id in closed {
                pool.drop_helper(id, crate::event_log::now_ms());
            }
        }
        // A new standby starts now, not at the next pass of the pool's loop.
        crate::acp::warm::refresh_now();
    }
}
