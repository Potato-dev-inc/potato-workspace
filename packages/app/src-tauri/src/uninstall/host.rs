//! Everything the planner and the executor need from the live PC, behind one trait.
//!
//! The real implementation (`os_real::RealHost`) talks to the Credential Manager, the registry, git
//! and the running app. Tests use [`FakeHost`], which only records what it was asked to do, so no test
//! ever touches a real credential, process or start-up entry.

use std::path::Path;

use crate::agent_pack::plan::AgentSpec;

/// One safe copy an agent worked in (`<project>/.potato-workspace/worktrees/<name>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub handle: String,
    pub path: String,
    pub branch: String,
    /// The copy holds work that is not merged: uncommitted changes or commits ahead of where it began.
    pub unsaved: bool,
}

pub trait Host {
    /// Every agent and where it keeps its settings (the live registry, or a test's own list).
    fn agent_specs(&self, state_dir: &Path) -> Vec<AgentSpec>;
    fn autostart_on(&self) -> bool;
    fn autostart_off(&self) -> Result<(), String>;
    /// Credential Manager targets that match `*.com.potatodev.workspace`, nothing else.
    fn credential_targets(&self) -> Result<Vec<String>, String>;
    fn delete_credential(&self, target: &str) -> Result<(), String>;
    fn worktrees(&self, project: &Path) -> Vec<WorktreeInfo>;
    /// Throw one copy and its branch away (git, never a plain folder delete).
    fn discard_worktree(&self, project: &Path, info: &WorktreeInfo) -> Result<(), String>;
    fn sweep_worktrees(&self, project: &Path);
    /// Take our block out of `CLAUDE.md` / `AGENTS.md` / rule files. Returns the files changed.
    fn remove_memory_blocks(&self, project: &Path) -> Vec<String>;
    /// Remove the project-file hook entries recorded in `<hooks_dir>/installs.json`. Returns how many.
    fn uninstall_hooks(&self, hooks_dir: &Path) -> usize;
    /// Remove one program the Agent Store installed.
    fn uninstall_store_program(&self, id: &str) -> Result<(), String>;
    /// Stop the app's own agents, warm pool, bridge, tunnel program and `opencode serve`.
    /// Own processes only. Returns a short note.
    fn stop_own_processes(&self) -> String;
}

#[cfg(test)]
pub use fake::FakeHost;

#[cfg(test)]
mod fake {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// Records every call. Nothing it does leaves the process.
    #[derive(Default)]
    pub struct FakeHost {
        pub specs: Vec<AgentSpec>,
        pub autostart: RefCell<bool>,
        pub credentials: RefCell<Vec<String>>,
        pub worktrees: BTreeMap<String, Vec<WorktreeInfo>>,
        pub log: RefCell<Vec<String>>,
        pub fail_credentials: bool,
    }

    impl FakeHost {
        pub fn note(&self, line: impl Into<String>) {
            self.log.borrow_mut().push(line.into());
        }
        pub fn calls(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
    }

    impl Host for FakeHost {
        fn agent_specs(&self, _state_dir: &Path) -> Vec<AgentSpec> {
            self.specs.clone()
        }
        fn autostart_on(&self) -> bool {
            *self.autostart.borrow()
        }
        fn autostart_off(&self) -> Result<(), String> {
            self.note("autostart_off");
            *self.autostart.borrow_mut() = false;
            Ok(())
        }
        fn credential_targets(&self) -> Result<Vec<String>, String> {
            if self.fail_credentials {
                return Err("credential store locked".into());
            }
            Ok(self.credentials.borrow().iter().filter(|t| t.ends_with(".com.potatodev.workspace")).cloned().collect())
        }
        fn delete_credential(&self, target: &str) -> Result<(), String> {
            self.note(format!("delete_credential {target}"));
            self.credentials.borrow_mut().retain(|t| t != target);
            Ok(())
        }
        fn worktrees(&self, project: &Path) -> Vec<WorktreeInfo> {
            self.worktrees.get(&project.to_string_lossy().into_owned()).cloned().unwrap_or_default()
        }
        fn discard_worktree(&self, _project: &Path, info: &WorktreeInfo) -> Result<(), String> {
            self.note(format!("discard {}", info.branch));
            Ok(())
        }
        fn sweep_worktrees(&self, project: &Path) {
            self.note(format!("sweep {}", project.display()));
        }
        fn remove_memory_blocks(&self, project: &Path) -> Vec<String> {
            self.note(format!("memory {}", project.display()));
            Vec::new()
        }
        fn uninstall_hooks(&self, hooks_dir: &Path) -> usize {
            self.note(format!("hooks {}", hooks_dir.display()));
            0
        }
        fn uninstall_store_program(&self, id: &str) -> Result<(), String> {
            self.note(format!("store_uninstall {id}"));
            Ok(())
        }
        fn stop_own_processes(&self) -> String {
            self.note("stop_own_processes");
            "fake".into()
        }
    }
}
