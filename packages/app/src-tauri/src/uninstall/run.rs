//! The executor: the ordered steps of "Uninstall everything".
//!
//! Order matters. Chats are zipped and the agents' config files are copied BEFORE anything is deleted,
//! and our entries leave the other tools' files BEFORE the program they point at goes away. A failure
//! in the zip or the backup stops everything (nothing deleted). A failure later is reported and the run
//! goes on, so one stuck file never leaves the PC half-way with no report.
//!
//! Every delete goes through [`remove_all`], which refuses a path that is not inside a folder the scan
//! found to be ours.

use std::path::{Path, PathBuf};

use super::entries::{self, Backup};
use super::helper::HelperArgs;
use super::host::Host;
use super::plan::{Scan, PROJECT_CHAT_CHILDREN, PROJECT_SHARED_CHILDREN};
use super::roots::Roots;
use super::{gid, Plan, Progress, Selection};
use crate::agent_pack::plan::Options;

/// Starts the cleanup helper (a copy of the app's own exe). A fake in tests.
pub trait Launcher {
    fn start_helper(&self, args: &HelperArgs) -> Result<(), String>;
}

#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub failures: Vec<String>,
    pub report_path: Option<PathBuf>,
    pub zip_path: Option<PathBuf>,
    pub backup_dir: Option<PathBuf>,
    pub aborted: Option<String>,
    /// The helper is running: the caller must exit the app now.
    pub handed_off: bool,
    pub removed_connections: usize,
}

struct Ctx<'a> {
    roots: &'a Roots,
    scan: &'a Scan,
    host: &'a dyn Host,
    launcher: &'a dyn Launcher,
    sel: &'a Selection,
    allowed: Vec<PathBuf>,
    out: Outcome,
}

/// Delete a file or folder. Refuses anything outside the folders this run may touch. Clears read-only
/// flags (git objects) and retries a locked file a few times.
pub fn remove_all(path: &Path, allowed: &[PathBuf]) -> Result<(), String> {
    let key = crate::project_path::comparable_project_path(path);
    let inside = allowed.iter().any(|root| {
        let r = crate::project_path::comparable_project_path(root);
        key == r || key.starts_with(&format!("{r}/"))
    });
    if !inside {
        return Err(format!("{} is not a place Potato Workspace owns, so it was left alone", path.display()));
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Ok(()) };
    let mut last = String::new();
    for attempt in 0..4u64 {
        let result = if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        match result {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                last = e.to_string();
                clear_readonly(path);
                std::thread::sleep(std::time::Duration::from_millis(60 * (attempt + 1)));
            }
        }
    }
    Err(format!("could not remove {}: {last}", path.display()))
}

fn clear_readonly(path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    if meta.permissions().readonly() {
        let mut perms = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(path, perms);
    }
    if meta.is_dir() {
        if let Ok(read) = std::fs::read_dir(path) {
            for e in read.filter_map(Result::ok) {
                clear_readonly(&e.path());
            }
        }
    }
}

fn step_list(sel: &Selection) -> Vec<(&'static str, &'static str)> {
    let mut steps = Vec::new();
    if sel.keep_chats {
        steps.push(("chats_zip", "Saving your chats"));
    }
    steps.push(("stop", "Stopping agents and the app's helpers"));
    steps.push(("backup", "Backing up your agents' settings"));
    steps.push(("connections", "Removing our entry from your agents"));
    steps.push(("projects", "Cleaning your projects"));
    steps.push(("autostart", "Turning off Open when I sign in"));
    steps.push(("keys", "Removing saved keys"));
    steps.push(("store", "Removing agent programs from the Store"));
    steps.push(("sign_ins", "Removing helper sign-ins"));
    steps.push(("report", "Writing the list of what is left"));
    steps.push(("handoff", "Deleting app data and the program"));
    steps
}

/// Run the whole uninstall. `progress` is called as each step starts and ends.
pub fn run(
    roots: &Roots,
    host: &dyn Host,
    launcher: &dyn Launcher,
    plan: &Plan,
    sel: &Selection,
    app_pid: u32,
    progress: &mut dyn FnMut(Progress),
) -> Outcome {
    let scan = Scan::new(roots, host);
    let mut allowed: Vec<PathBuf> = Vec::new();
    for p in &scan.profiles {
        allowed.push(p.data_dir.clone());
        allowed.push(p.local_dir.clone());
    }
    for project in &scan.projects {
        allowed.push(crate::app_paths::project_data_dir(&project.path));
    }
    allowed.push(roots.home.join(crate::app_paths::COMPANION_HOME_DIR_NAME));
    for t in super::plan::temp_leftovers(&roots.temp) {
        allowed.push(t);
    }
    let mut cx = Ctx { roots, scan: &scan, host, launcher, sel, allowed, out: Outcome::default() };
    let steps = step_list(sel);
    let total = steps.len();
    let emit = |progress: &mut dyn FnMut(Progress), i: usize, id: &str, label: &str, detail: &str, state: &str| {
        progress(Progress { step: id.into(), label: label.into(), detail: detail.into(), state: state.into(), index: i, total });
    };
    let date = super::chats::today();
    let backup_dir = if sel.keep_chats { roots.documents.join(format!("Potato Workspace uninstall backup {}", super::chats::zip_name(date).trim_start_matches("Potato Workspace chats ").trim_end_matches(".zip"))) } else { roots.temp.join("potato-uninstall-backup") };
    let backup = Backup::new(backup_dir.clone());

    for (i, (id, label)) in steps.iter().enumerate() {
        emit(progress, i, id, label, "", "running");
        let result: Result<String, String> = match *id {
            "chats_zip" => cx.chats_zip(date),
            "stop" => Ok(cx.host.stop_own_processes()),
            "backup" => cx.backup(&backup),
            "connections" => cx.connections(&backup),
            "projects" => cx.projects(),
            "autostart" => cx.autostart(),
            "keys" => cx.keys(),
            "store" => cx.store(),
            "sign_ins" => cx.sign_ins(),
            "report" => cx.report(plan, &backup_dir),
            "handoff" => cx.handoff(app_pid),
            _ => Ok(String::new()),
        };
        match result {
            Ok(detail) => {
                let state = if detail.starts_with("skipped") { "skipped" } else { "done" };
                emit(progress, i, id, label, detail.trim_start_matches("skipped: "), state);
            }
            Err(e) => {
                emit(progress, i, id, label, &e, "failed");
                if matches!(*id, "chats_zip" | "backup") {
                    cx.out.aborted = Some(format!("Nothing was removed. {e}"));
                    return cx.out;
                }
                if *id == "handoff" {
                    cx.out.aborted = Some(e.clone());
                }
                cx.out.failures.push(format!("{label}: {e}"));
            }
        }
    }
    cx.out.backup_dir = backup_dir.exists().then_some(backup_dir);
    cx.out
}

impl Ctx<'_> {
    fn fail(&mut self, text: String) {
        self.out.failures.push(text);
    }

    fn chats_zip(&mut self, date: (i64, u32, u32)) -> Result<String, String> {
        let (path, n) = super::chats::write_zip(self.scan, self.roots, date)?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.out.zip_path = Some(path);
        Ok(format!("{n} files saved to Documents\\{name}"))
    }

    fn backup(&mut self, backup: &Backup) -> Result<String, String> {
        let mut n = 0;
        let hosts = self.scan.global_hosts.iter().chain(self.scan.projects.iter().flat_map(|p| p.hosts.iter()));
        for (h, _) in hosts {
            if backup.save(&h.path)?.is_some() {
                n += 1;
            }
        }
        Ok(format!("{n} file{} copied", if n == 1 { "" } else { "s" }))
    }

    fn connections(&mut self, backup: &Backup) -> Result<String, String> {
        if !self.sel.has(gid::CONNECTIONS) {
            return Ok("skipped: left as they are".into());
        }
        // First what the pack and the hooks recorded (they put back exactly what they changed) ...
        for profile in &self.scan.profiles {
            let opts = Options { home: self.roots.home.clone(), state_dir: profile.data_dir.clone(), launch: Default::default() };
            if let Err(e) = crate::agent_pack::plan::undo(&opts) {
                self.fail(format!("agent pack undo ({}): {e}", profile.id));
            }
            self.host.uninstall_hooks(&profile.data_dir.join("hooks"));
        }
        // ... then whatever of ours is still there, key by key.
        let hosts: Vec<entries::HostFile> = entries::global_hosts(&self.scan.specs, self.roots)
            .into_iter()
            .chain(self.scan.projects.iter().flat_map(|p| entries::project_hosts(&self.scan.specs, &p.path)))
            .collect();
        let mut count = 0;
        for h in &hosts {
            match entries::remove_ours(h, backup) {
                Ok(Some(done)) => count += done.keys.len(),
                Ok(None) => {}
                Err(e) => self.fail(format!("{}: {e}", h.path.display())),
            }
        }
        for dir in self.scan.skill_dirs(self.roots) {
            for ours in entries::our_skill_dirs(&dir) {
                match entries::remove_skill_dir(&ours) {
                    Ok(()) => count += 1,
                    Err(e) => self.fail(e),
                }
            }
        }
        self.out.removed_connections = count;
        Ok(format!("{count} entr{} removed", if count == 1 { "y" } else { "ies" }))
    }

    fn projects(&mut self) -> Result<String, String> {
        let sel = self.sel;
        let mut notes = 0;
        for project in &self.scan.projects {
            if sel.has(gid::PROJECTS) {
                notes += self.host.remove_memory_blocks(&project.path).len();
            }
            let mut kept_copy = false;
            for wt in self.host.worktrees(&project.path) {
                let wanted = if wt.unsaved { sel.has(gid::UNSAVED_BRANCHES) } else { sel.has(gid::COPIES) };
                if wanted {
                    if let Err(e) = self.host.discard_worktree(&project.path, &wt) {
                        self.out.failures.push(format!("copy {}: {e}", wt.branch));
                        kept_copy = true;
                    }
                } else {
                    kept_copy = true;
                }
            }
            if sel.has(gid::COPIES) || sel.has(gid::UNSAVED_BRANCHES) {
                self.host.sweep_worktrees(&project.path);
            }
            let data = crate::app_paths::project_data_dir(&project.path);
            if sel.has(gid::CHATS) {
                for child in PROJECT_CHAT_CHILDREN {
                    if let Err(e) = remove_all(&data.join(child), &self.allowed) {
                        self.out.failures.push(e);
                    }
                }
            }
            if sel.has(gid::PROJECTS) {
                let Ok(read) = std::fs::read_dir(&data) else { continue };
                for entry in read.filter_map(Result::ok) {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let keep = (PROJECT_CHAT_CHILDREN.contains(&name.as_str()) && !sel.has(gid::CHATS))
                        || (PROJECT_SHARED_CHILDREN.contains(&name.as_str()) && !sel.has(gid::SHARED_NOTES))
                        || (name == "worktrees" && kept_copy);
                    if !keep {
                        if let Err(e) = remove_all(&entry.path(), &self.allowed) {
                            self.out.failures.push(e);
                        }
                    }
                }
                let _ = std::fs::remove_dir(&data);
                if !data.exists() {
                    crate::git_exclude::remove_block(&project.path);
                }
            }
        }
        if sel.has(gid::CHATS) {
            let companions = self.roots.home.join(crate::app_paths::COMPANION_HOME_DIR_NAME).join("companions");
            if let Err(e) = remove_all(&companions, &self.allowed) {
                self.fail(e);
            }
            let _ = std::fs::remove_dir(self.roots.home.join(crate::app_paths::COMPANION_HOME_DIR_NAME));
        }
        if sel.has(gid::APP_DATA) {
            for t in super::plan::temp_leftovers(&self.roots.temp) {
                if let Err(e) = remove_all(&t, &self.allowed) {
                    self.fail(e);
                }
            }
        }
        Ok(format!("{} project{}, {notes} notes block{} removed", self.scan.projects.len(), if self.scan.projects.len() == 1 { "" } else { "s" }, if notes == 1 { "" } else { "s" }))
    }

    fn autostart(&mut self) -> Result<String, String> {
        if !self.sel.has(gid::AUTOSTART) {
            return Ok("skipped: left as it is".into());
        }
        self.host.autostart_off()?;
        Ok(String::new())
    }

    fn keys(&mut self) -> Result<String, String> {
        if !self.sel.has(gid::KEYS) {
            return Ok("skipped: left as they are".into());
        }
        let mut n = 0;
        for target in self.host.credential_targets()? {
            // Belt and braces: the filter is also checked here, never the other product's entries.
            if !target.ends_with(".com.potatodev.workspace") {
                continue;
            }
            match self.host.delete_credential(&target) {
                Ok(()) => n += 1,
                Err(e) => self.fail(format!("key {target}: {e}")),
            }
        }
        Ok(format!("{n} key{}", if n == 1 { "" } else { "s" }))
    }

    fn store(&mut self) -> Result<String, String> {
        if !self.sel.has(gid::STORE_PROGRAMS) {
            return Ok("skipped: your agent programs stay".into());
        }
        let mut n = 0;
        for (id, _) in super::plan::store_programs(&self.scan.profiles) {
            match self.host.uninstall_store_program(&id) {
                Ok(()) => n += 1,
                Err(e) => self.fail(format!("program {id}: {e}")),
            }
        }
        Ok(format!("{n} program{}", if n == 1 { "" } else { "s" }))
    }

    fn sign_ins(&mut self) -> Result<String, String> {
        if !self.sel.has(gid::SIGN_INS) {
            return Ok("skipped: left as they are".into());
        }
        let mut n = 0;
        for profile in &self.scan.profiles {
            let root = profile.data_dir.join("accounts");
            let Ok(read) = std::fs::read_dir(&root) else { continue };
            for entry in read.filter_map(Result::ok) {
                match remove_all(&entry.path(), &self.allowed) {
                    Ok(()) => n += 1,
                    Err(e) => self.out.failures.push(e),
                }
            }
        }
        Ok(format!("{n} account folder{}", if n == 1 { "" } else { "s" }))
    }

    fn report(&mut self, plan: &Plan, backup_dir: &Path) -> Result<String, String> {
        let dir = match &self.out.zip_path {
            Some(zip) => zip.parent().map(Path::to_path_buf).unwrap_or_else(|| self.roots.documents.clone()),
            None => self.roots.temp.clone(),
        };
        let path = dir.join("Potato Workspace - what was left.txt");
        let mut text = String::from("Potato Workspace was removed from this PC. Here is what was left, and why.\n\n");
        if let Some(zip) = &self.out.zip_path {
            text.push_str(&format!("Your chats are saved in: {}\n\n", zip.display()));
        }
        if backup_dir.exists() {
            text.push_str(&format!("Copies of your agents' settings (made before we changed them): {}\n\n", backup_dir.display()));
        }
        if !self.out.failures.is_empty() {
            text.push_str("Things that did not work:\n");
            for f in &self.out.failures {
                text.push_str(&format!("  - {f}\n"));
            }
            text.push('\n');
        }
        text.push_str("Things we can't remove for you:\n");
        for c in &plan.cant {
            text.push_str(&format!("  - {}: {}\n", c.title, c.how));
        }
        let kept: Vec<&str> = plan.groups.iter().filter(|g| !self.sel.has(&g.id)).map(|g| g.title.as_str()).collect();
        if !kept.is_empty() {
            text.push_str("\nYou chose to keep:\n");
            for k in kept {
                text.push_str(&format!("  - {k}\n"));
            }
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
        self.out.report_path = Some(path.clone());
        Ok(path.display().to_string())
    }

    fn handoff(&mut self, app_pid: u32) -> Result<String, String> {
        let Some(report) = self.out.report_path.clone() else { return Err("no report to hand over".into()) };
        let remove_data = self.sel.has(gid::APP_DATA);
        let args = HelperArgs {
            app_pid,
            ids: self.scan.profiles.iter().map(|p| p.id.clone()).collect(),
            appdata: self.roots.appdata.clone(),
            localappdata: self.roots.localappdata.clone(),
            keep: if remove_data { self.scan.keep_inside_app_data(self.sel, self.roots) } else { Vec::new() },
            remove_data,
            remove_program: self.sel.has(gid::PROGRAM) && self.roots.install_dir.is_some(),
            report,
            temp: self.roots.temp.clone(),
        };
        self.launcher.start_helper(&args)?;
        self.out.handed_off = true;
        Ok(String::new())
    }
}
