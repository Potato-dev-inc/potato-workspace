//! The live PC for the executor: the running app, the Credential Manager, git, the Store.
//! Built only by the command layer. No test builds it.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::helper::HelperArgs;
use super::host::{Host, WorktreeInfo};
use super::run::Launcher;
use crate::agent_pack::plan::AgentSpec;

pub struct RealHost {
    pub app: AppHandle,
}

/// Credential Manager targets of ours: Generic entries whose target ends with the service name. The
/// other product's `.com.puppetmaster.app` entries never end that way.
pub const CREDENTIAL_SUFFIX: &str = ".com.potatodev.workspace";

#[cfg(windows)]
mod creds {
    use super::CREDENTIAL_SUFFIX;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CredEnumerateW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC};

    const ERROR_NOT_FOUND: u32 = 1168;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Every Generic target ending with the suffix. The API's own filter only takes a trailing `*`, so
    /// everything is listed and filtered here.
    pub fn targets() -> Result<Vec<String>, String> {
        let mut count = 0u32;
        let mut list: *mut *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: standard enumerate call; the list is freed with CredFree below.
        let ok = unsafe { CredEnumerateW(std::ptr::null(), 0, &mut count, &mut list) };
        if ok == 0 {
            // SAFETY: reads the thread's last error.
            let err = unsafe { GetLastError() };
            return if err == ERROR_NOT_FOUND { Ok(Vec::new()) } else { Err(format!("Windows error {err}")) };
        }
        let mut out = Vec::new();
        for i in 0..count as usize {
            // SAFETY: `list` holds `count` valid pointers until CredFree.
            let cred = unsafe { &**list.add(i) };
            if cred.Type != CRED_TYPE_GENERIC || cred.TargetName.is_null() {
                continue;
            }
            let mut len = 0;
            // SAFETY: TargetName is a NUL-terminated wide string owned by the list.
            while unsafe { *cred.TargetName.add(len) } != 0 {
                len += 1;
            }
            // SAFETY: `len` characters were just counted.
            let name = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(cred.TargetName, len) });
            if name.ends_with(CREDENTIAL_SUFFIX) {
                out.push(name);
            }
        }
        // SAFETY: frees the buffer CredEnumerateW allocated.
        unsafe { CredFree(list as *const _) };
        Ok(out)
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let w = wide(target);
        // SAFETY: NUL-terminated wide string that outlives the call.
        let ok = unsafe { CredDeleteW(w.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok != 0 {
            return Ok(());
        }
        // SAFETY: reads the thread's last error.
        let err = unsafe { GetLastError() };
        if err == ERROR_NOT_FOUND { Ok(()) } else { Err(format!("Windows error {err}")) }
    }
}

impl Host for RealHost {
    fn agent_specs(&self, _state_dir: &Path) -> Vec<AgentSpec> {
        crate::agent_pack::service::live_specs()
    }

    fn autostart_on(&self) -> bool {
        crate::autostart::get(&self.app).unwrap_or(false)
    }

    fn autostart_off(&self) -> Result<(), String> {
        crate::autostart::set(&self.app, false).map(|_| ())
    }

    #[cfg(windows)]
    fn credential_targets(&self) -> Result<Vec<String>, String> {
        creds::targets()
    }
    #[cfg(not(windows))]
    fn credential_targets(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    #[cfg(windows)]
    fn delete_credential(&self, target: &str) -> Result<(), String> {
        if !target.ends_with(CREDENTIAL_SUFFIX) {
            return Err("not one of ours".into());
        }
        creds::delete(target)
    }
    #[cfg(not(windows))]
    fn delete_credential(&self, _target: &str) -> Result<(), String> {
        Ok(())
    }

    fn worktrees(&self, project: &Path) -> Vec<WorktreeInfo> {
        crate::worktrees::list(&project.to_string_lossy())
            .into_iter()
            .map(|entry| {
                let wt = &entry.worktree;
                let ahead = commits_ahead(project, &wt.base_commit, &wt.branch);
                let dirty = entry.exists && crate::worktrees::changes(wt).map(|c| c.files_changed > 0).unwrap_or(true);
                // If git cannot say, the copy counts as holding work: it is kept.
                let unsaved = dirty || ahead.map(|n| n > 0).unwrap_or(true);
                WorktreeInfo { handle: wt.handle.clone(), path: wt.path.clone(), branch: wt.branch.clone(), unsaved }
            })
            .collect()
    }

    fn discard_worktree(&self, project: &Path, info: &WorktreeInfo) -> Result<(), String> {
        let entry = crate::worktrees::list(&project.to_string_lossy())
            .into_iter()
            .find(|e| e.worktree.handle == info.handle && e.worktree.path == info.path)
            .ok_or_else(|| "the copy is already gone".to_string())?;
        crate::worktrees::discard(&entry.worktree).map_err(|e| e.message)
    }

    fn sweep_worktrees(&self, project: &Path) {
        let _ = crate::worktrees::sweep(&project.to_string_lossy());
    }

    fn remove_memory_blocks(&self, project: &Path) -> Vec<String> {
        crate::one_brain::sync(project, &crate::one_brain::targets(), false).removed
    }

    fn uninstall_hooks(&self, hooks_dir: &Path) -> usize {
        crate::agent_hooks::install::project::uninstall_all(hooks_dir, |agent| {
            crate::agent_hooks::scheme_for(agent).and_then(|s| s.project_file.as_ref().map(|f| f.root_key.clone()))
        })
    }

    fn uninstall_store_program(&self, id: &str) -> Result<(), String> {
        use crate::agent_install::plan::{Action, Tools};
        let entry = crate::agent_store::catalog::get(id).ok_or_else(|| format!("{id} is not in the Store"))?;
        let spec = crate::agent_store::catalog::install_spec(id);
        let record = crate::agent_store::record::load(&crate::agent_store::record::default_path()).agents.remove(id).and_then(|a| a.install);
        let plan = crate::agent_store::uninstall::uninstall_plan(entry, spec.as_ref(), record.as_ref(), &Tools::detect());
        if let Some(why) = plan.blocked {
            return Err(why);
        }
        for step in plan.steps {
            match step.action {
                Action::Argv { exe, args } => {
                    let status = crate::proc_util::hidden_command(&exe).args(&args).status().map_err(|e| format!("{exe}: {e}"))?;
                    if !status.success() {
                        return Err(format!("{} did not finish (exit {})", step.label, status.code().unwrap_or(-1)));
                    }
                }
                Action::Script { .. } => return Err("this one needs the vendor's own uninstaller; remove it in Settings > Apps".into()),
            }
        }
        Ok(())
    }

    fn stop_own_processes(&self) -> String {
        crate::acp::chat::begin_app_shutdown();
        crate::standby::shutdown();
        crate::mobile_tunnel::stop_for_uninstall();
        if let Some(state) = self.app.try_state::<crate::commands::AppState>() {
            crate::pty::registry_kill_all_and_wait(&state.registry);
        }
        "Only the app's own programs".into()
    }
}

fn commits_ahead(project: &Path, base: &str, branch: &str) -> Option<u32> {
    let out = crate::proc_util::hidden_command("git")
        .args(["rev-list", "--count", &format!("{base}..{branch}")])
        .current_dir(project)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Copies the running exe to `%TEMP%` and starts the copy detached with the helper flag.
pub struct RealLauncher;

impl Launcher for RealLauncher {
    fn start_helper(&self, args: &HelperArgs) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("could not find the app: {e}"))?;
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        let copy: PathBuf = args.temp.join(format!("potato-cleanup-{:x}{:x}.exe", std::process::id(), nanos));
        std::fs::copy(&exe, &copy).map_err(|e| format!("could not copy the app to {}: {e}", copy.display()))?;
        let mut command = crate::proc_util::hidden_command(&copy);
        command.args(args.to_cli());
        crate::proc_util::detach(&mut command);
        command.spawn().map(|_| ()).map_err(|e| format!("could not start the cleanup program: {e}"))
    }
}
