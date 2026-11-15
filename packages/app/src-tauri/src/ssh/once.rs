//! One-shot SSH launches, keyed by pane id (like `wsl::place::request_once`). `commands::ssh::ssh_open` records the
//! launch just before it asks the registry for a pane; the spawn takes it, once. It is never part of any JSON, so
//! nothing from outside can make a pane run `ssh`.

use crate::wsl::model::PanePlace;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(30);

/// The `ssh` start of one pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshLaunch {
    pub exe: PathBuf,
    pub argv: Vec<String>,
    /// What the person calls the machine (the chip).
    pub name: String,
    pub folder: Option<String>,
}

static ONCE: Mutex<BTreeMap<String, (Instant, SshLaunch)>> = Mutex::new(BTreeMap::new());

fn map() -> MutexGuard<'static, BTreeMap<String, (Instant, SshLaunch)>> {
    ONCE.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn request(pane_id: &str, launch: SshLaunch) {
    let now = Instant::now();
    let mut m = map();
    m.retain(|_, (at, _)| now.saturating_duration_since(*at) < TTL);
    m.insert(pane_id.to_string(), (now, launch));
}

/// Taking it removes it: it applies to one spawn only.
pub fn take(pane_id: &str) -> Option<SshLaunch> {
    let (at, launch) = map().remove(pane_id)?;
    (Instant::now().saturating_duration_since(at) < TTL).then_some(launch)
}

/// The `place` of an SSH pane: display and chat facts only, it grants nothing. `kind` is `ssh`; `distro` carries the
/// machine's name for the chip (the field is shared with Linux places).
pub fn pane_place(launch: &SshLaunch) -> PanePlace {
    PanePlace {
        kind: "ssh".to_string(),
        distro: launch.name.clone(),
        cwd: launch.folder.clone().unwrap_or_default(),
        mount_root: String::new(),
        unc_root: String::new(),
        home_windows: String::new(),
        warnings: Vec::new(),
    }
}
