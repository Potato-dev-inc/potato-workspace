//! Finding a program on PATH that can really be started.
//!
//! A shell lists a name on PATH by looking at directory entries, so it also "finds" things that
//! cannot run: a symbolic link whose target was removed (a package manager upgrade or an agent
//! self-update leaves one), an empty placeholder file, a Windows app-execution alias whose app is
//! gone. Starting such an entry fails with "No application is associated with the specified file".
//! Every lookup here follows links and skips entries that do not lead to a real, non-empty file, so
//! the next folder on PATH gets its turn. Generic: it knows file names, never agents.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// What a PATH search for one program name found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Lookup {
    /// A file that exists, is not empty and can be started (links followed).
    Found(PathBuf),
    /// Entries carry the name but none can run (dangling link, empty file). The paths, in PATH order.
    Broken(Vec<PathBuf>),
    /// Nothing on PATH carries the name.
    Missing,
}

/// How a candidate file looks to the file system.
enum Candidate {
    Runnable,
    /// A Windows app-execution alias: a reparse point that is not a symbolic link and cannot be
    /// opened for metadata. May run (the app is installed) or not; only used when nothing better.
    Alias,
    Broken,
    Absent,
}

fn classify(path: &Path) -> Candidate {
    if let Ok(meta) = std::fs::metadata(path) {
        return if meta.is_file() && meta.len() > 0 { Candidate::Runnable } else { Candidate::Broken };
    }
    match std::fs::symlink_metadata(path) {
        Err(_) => Candidate::Absent,
        Ok(meta) if meta.file_type().is_symlink() => Candidate::Broken,
        Ok(meta) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                // FILE_ATTRIBUTE_REPARSE_POINT without being a symlink or junction: an AppExecLink.
                if meta.file_attributes() & 0x400 != 0 {
                    return Candidate::Alias;
                }
            }
            let _ = meta;
            Candidate::Broken
        }
    }
}

/// `name` plus each of `extensions` (tried in order, per directory) in the directories of `paths`.
/// Pure: no environment is read, so the lookup is testable on any platform.
pub(crate) fn lookup_in(paths: &OsStr, extensions: &[String], name: &str) -> Lookup {
    let mut alias: Option<PathBuf> = None;
    let mut broken: Vec<PathBuf> = Vec::new();
    for dir in std::env::split_paths(paths) {
        for ext in extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            match classify(&candidate) {
                Candidate::Runnable => return Lookup::Found(candidate),
                Candidate::Alias => {
                    alias.get_or_insert(candidate);
                }
                Candidate::Broken => broken.push(candidate),
                Candidate::Absent => {}
            }
        }
    }
    match alias {
        Some(path) => Lookup::Found(path),
        None if broken.is_empty() => Lookup::Missing,
        None => Lookup::Broken(broken),
    }
}

/// Folders a package manager links its command shortcuts into, which a person's PATH may lack
/// (winget adds `Links` to PATH only for sessions that start after its first use). Windows only.
pub(crate) fn well_known_dirs() -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut dirs = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(Path::new(&local).join("Microsoft").join("WinGet").join("Links"));
    }
    if let Some(files) = std::env::var_os("ProgramFiles") {
        dirs.push(Path::new(&files).join("WinGet").join("Links"));
    }
    dirs
}

/// `base` followed by the folders of `extra` it does not list yet (ignoring case and a trailing
/// slash). Added last, so a tool a person put on PATH always wins.
pub(crate) fn path_with_extra(base: &OsStr, extra: &[PathBuf]) -> OsString {
    let key = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_ascii_lowercase();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(base).collect();
    for dir in extra {
        if !dirs.iter().any(|d| key(d) == key(dir)) {
            dirs.push(dir.clone());
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| base.to_os_string())
}

/// What an agent pane's host shell should be told to start for the program called `name`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LaunchTarget {
    /// The full path of the file to start, or the bare name when nothing better is known (a
    /// PowerShell script shim, or a program that is not installed: the shell then explains itself).
    pub program: String,
    /// Plain words for the pane when entries carry the name but none can run.
    pub warning: Option<String>,
}

/// [`LaunchTarget`] for `name` over the directories of `paths`. A shell given the bare name takes
/// the first entry that carries it, even a dangling link, and fails with "No application is
/// associated"; here the first one that can run wins and its full path is used. `.ps1` shims keep
/// the bare name (the shell must run them as scripts).
pub(crate) fn launch_target_in(paths: &OsStr, extensions: &[String], name: &str) -> LaunchTarget {
    match lookup_in(paths, extensions, name) {
        Lookup::Found(path) => {
            let is_script = path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"));
            LaunchTarget {
                program: if is_script { name.to_string() } else { path.to_string_lossy().into_owned() },
                warning: None,
            }
        }
        Lookup::Broken(tried) => {
            let list = tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
            LaunchTarget {
                program: name.to_string(),
                warning: Some(format!(
                    "Potato Workspace found {list} for '{name}', but it cannot run (a broken link or an empty file, often left by an update). Remove it or reinstall {name}, then open a new pane."
                )),
            }
        }
        Lookup::Missing => LaunchTarget { program: name.to_string(), warning: None },
    }
}

/// [`launch_target_in`] over the PATH panes get.
pub(crate) fn launch_target(name: &str) -> LaunchTarget {
    // Command-line tests compare golden strings; they must not depend on what this machine has installed.
    #[cfg(test)]
    {
        return LaunchTarget { program: name.to_string(), warning: None };
    }
    #[cfg(not(test))]
    launch_target_in(&pane_search_path(), &super::runnable_extensions(), name)
}

/// The process PATH plus [`well_known_dirs`].
pub(crate) fn search_path() -> OsString {
    path_with_extra(&std::env::var_os("PATH").unwrap_or_default(), &well_known_dirs())
}

/// The PATH panes get plus [`well_known_dirs`].
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn pane_search_path() -> OsString {
    path_with_extra(OsStr::new(&crate::shell_env::path_for_spawn()), &well_known_dirs())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("pm-prog-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn exts() -> Vec<String> {
        vec![".exe".to_string()]
    }

    fn joined(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs).unwrap()
    }

    fn make_file_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn an_empty_placeholder_before_the_real_file_is_skipped() {
        let tmp = Tmp::new();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("tool.exe"), b"").unwrap();
        std::fs::write(b.join("tool.exe"), b"MZ real").unwrap();
        assert_eq!(lookup_in(&joined(&[&a, &b]), &exts(), "tool"), Lookup::Found(b.join("tool.exe")));
    }

    #[test]
    fn only_empty_files_are_reported_as_broken_with_their_paths() {
        let tmp = Tmp::new();
        std::fs::write(tmp.path().join("tool.exe"), b"").unwrap();
        assert_eq!(
            lookup_in(&joined(&[tmp.path()]), &exts(), "tool"),
            Lookup::Broken(vec![tmp.path().join("tool.exe")])
        );
        assert_eq!(lookup_in(&joined(&[tmp.path()]), &exts(), "other"), Lookup::Missing);
    }

    #[test]
    fn a_link_to_a_real_file_is_accepted() {
        let tmp = Tmp::new();
        let (links, pkg) = (tmp.path().join("links"), tmp.path().join("pkg"));
        std::fs::create_dir_all(&links).unwrap();
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("real.exe"), b"MZ real").unwrap();
        if !make_file_link(&pkg.join("real.exe"), &links.join("tool.exe")) {
            return; // this machine may not allow links
        }
        assert_eq!(lookup_in(&joined(&[&links]), &exts(), "tool"), Lookup::Found(links.join("tool.exe")));
    }

    #[test]
    fn a_dangling_link_is_skipped_for_the_next_folder() {
        let tmp = Tmp::new();
        let (links, real) = (tmp.path().join("links"), tmp.path().join("real"));
        std::fs::create_dir_all(&links).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("tool.exe"), b"MZ real").unwrap();
        if !make_file_link(&tmp.path().join("gone.exe"), &links.join("tool.exe")) {
            return;
        }
        assert_eq!(lookup_in(&joined(&[&links, &real]), &exts(), "tool"), Lookup::Found(real.join("tool.exe")));
        assert_eq!(
            lookup_in(&joined(&[&links]), &exts(), "tool"),
            Lookup::Broken(vec![links.join("tool.exe")])
        );
    }

    #[test]
    fn the_launch_target_is_the_first_file_that_can_run_by_its_full_path() {
        let tmp = Tmp::new();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("tool.exe"), b"").unwrap();
        std::fs::write(b.join("tool.exe"), b"MZ real").unwrap();
        let target = launch_target_in(&joined(&[&a, &b]), &exts(), "tool");
        assert_eq!(target.program, b.join("tool.exe").to_string_lossy());
        assert_eq!(target.warning, None);
    }

    #[test]
    fn an_unrunnable_entry_gives_a_message_naming_the_file_and_keeps_the_bare_name() {
        let tmp = Tmp::new();
        std::fs::write(tmp.path().join("tool.exe"), b"").unwrap();
        let target = launch_target_in(&joined(&[tmp.path()]), &exts(), "tool");
        assert_eq!(target.program, "tool");
        let warning = target.warning.unwrap();
        assert!(warning.contains("tool.exe") && warning.contains("cannot run"), "{warning}");
        let none = launch_target_in(&joined(&[tmp.path()]), &exts(), "absent");
        assert_eq!((none.program.as_str(), none.warning), ("absent", None));
    }

    #[test]
    fn a_script_shim_keeps_the_bare_name() {
        let tmp = Tmp::new();
        std::fs::write(tmp.path().join("tool.ps1"), b"echo hi").unwrap();
        let exts = vec![".exe".to_string(), ".ps1".to_string()];
        assert_eq!(launch_target_in(&joined(&[tmp.path()]), &exts, "tool").program, "tool");
    }

    #[test]
    fn extra_folders_go_last_and_are_not_repeated() {
        let base = std::env::join_paths([Path::new("/one"), Path::new("/two")]).unwrap();
        let out = path_with_extra(&base, &[PathBuf::from("/two/"), PathBuf::from("/three")]);
        let dirs: Vec<PathBuf> = std::env::split_paths(&out).collect();
        assert_eq!(dirs, [PathBuf::from("/one"), PathBuf::from("/two"), PathBuf::from("/three")]);
    }
}
