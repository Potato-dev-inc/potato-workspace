//! "Uninstall everything" and "Reset settings" (Settings > Danger zone).
//!
//! - `roots`    every folder passed in explicitly; nothing below reads a real environment variable
//! - `host`     the things that touch the live PC (processes, credentials, start at sign-in, git copies),
//!              behind one trait so tests use a fake
//! - `entries`  taking our entries out of other tools' config files (structural edit, backup first)
//! - `plan`     the dry run: what would be removed, grouped, with default ticks
//! - `run`      the ordered steps, with progress
//! - `chats`    "Keep my chats": a zip in Documents before anything is deleted
//! - `helper`   the cleanup process that outlives the app and removes the rest
//! - `reset`    "Reset settings"
//! - `commands` the Tauri commands (the only place real roots are built)
//!
//! What this never touches: the other product (its app data folders, its home folders and its
//! credentials), its WSL distro, the npm cache and the WebView2 runtime.

pub mod chats;
pub mod commands;
pub mod entries;
pub mod helper;
pub mod helper_os;
pub mod host;
pub mod os_real;
pub mod plan;
pub mod reset;
pub mod roots;
pub mod run;

use serde::{Deserialize, Serialize};

/// The command-line switch the app's own exe copy runs the cleanup helper with.
pub const HELPER_FLAG: &str = "--potato-cleanup";
/// The progress event the UI listens to.
pub const PROGRESS_EVENT: &str = "uninstall://progress";
/// The MSI upgrade code (`tauri.conf.json` > bundle > windows > wix > upgradeCode).
pub const UPGRADE_CODE: &str = "{2E0398E3-228F-4C24-A750-390F8BD522D8}";
/// Set to `1` to let a debug build run the real uninstall (tests on a throwaway PC only).
pub const DEV_ALLOW_ENV: &str = "POTATO_ALLOW_UNINSTALL_IN_DEV";

/// Group ids. The UI ticks groups, not single files.
pub mod gid {
    pub const PROGRAM: &str = "program";
    pub const AUTOSTART: &str = "autostart";
    pub const APP_DATA: &str = "app_data";
    pub const SIGN_INS: &str = "sign_ins";
    pub const KEYS: &str = "keys";
    pub const CONNECTIONS: &str = "connections";
    pub const PROJECTS: &str = "projects";
    pub const COPIES: &str = "copies";
    pub const CHATS: &str = "chats";
    pub const UNSAVED_BRANCHES: &str = "unsaved_branches";
    pub const SHARED_NOTES: &str = "shared_notes";
    pub const STORE_PROGRAMS: &str = "store_programs";
}

/// One thing the plan found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub label: String,
    pub path: Option<String>,
    pub bytes: u64,
    pub files: u64,
}

impl Item {
    pub fn new(label: impl Into<String>, path: Option<String>) -> Self {
        Self { label: label.into(), path, bytes: 0, files: 0 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub title: String,
    pub detail: String,
    /// "412 MB", "14 keys": the short size shown at the right.
    pub size: String,
    pub bytes: u64,
    pub files: u64,
    /// Agent connections only: how many entries.
    pub connections: u64,
    pub default_on: bool,
    /// Why a group starts unticked.
    pub keep_reason: Option<String>,
    pub items: Vec<Item>,
}

/// Something that stays, and how to deal with it by hand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cant {
    pub title: String,
    pub how: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub groups: Vec<Group>,
    pub cant: Vec<Cant>,
    pub profiles: Vec<String>,
    pub total_files: u64,
    pub connections: u64,
    pub keys: u64,
    /// Name of the zip "Keep my chats" would write, for example `Potato Workspace chats 2026-11-11.zip`.
    pub chats_zip_name: String,
    /// "Keep my chats" starts unticked (founder answer D5).
    pub keep_chats_default: bool,
}

/// What the person left ticked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub groups: Vec<String>,
    pub keep_chats: bool,
}

impl Selection {
    pub fn has(&self, id: &str) -> bool {
        self.groups.iter().any(|g| g == id)
    }

    /// The default ticks of a plan (the UI computes the same from `defaultOn`; Rust tests use this).
    #[cfg(test)]
    pub fn defaults(plan: &Plan) -> Self {
        Self { groups: plan.groups.iter().filter(|g| g.default_on).map(|g| g.id.clone()).collect(), keep_chats: plan.keep_chats_default }
    }
}

/// One line of the live checklist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub step: String,
    pub label: String,
    pub detail: String,
    /// `running`, `done`, `skipped` or `failed`.
    pub state: String,
    pub index: usize,
    pub total: usize,
}

/// Whether the real uninstall may run in this build. A debug build refuses unless the test flag is set.
pub fn run_allowed(debug_build: bool, dev_flag: Option<&str>, packaged: bool) -> bool {
    if dev_flag == Some("1") {
        return true;
    }
    !debug_build && packaged
}

/// Shown on the button and returned by the run command when it is not allowed.
pub const NOT_IN_DEV: &str = "Not in the dev build";

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_entries;
#[cfg(test)]
mod tests_helper;
#[cfg(test)]
mod tests_integration;
#[cfg(test)]
mod tests_reset;
