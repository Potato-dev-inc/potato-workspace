//! "Open in my editor": find the code editors installed on this computer and open a project file (at a line) in one.
//!
//! The only program ever started is the editor program found here for the chosen id (never a path or command from
//! the screen), with the file as its argument and no shell in between. The file must be inside the pane's project
//! folder (`crate::files::resolve_in_root`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// How an editor is told which line to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Line {
    /// `--goto <file>:<line>` (VS Code and its relatives).
    Goto,
    /// `<file>:<line>` (Zed, Sublime Text).
    Colon,
    /// `-n<line> <file>` (Notepad++).
    NFlag,
}

/// Where an install folder is looked for.
#[derive(Debug, Clone, Copy)]
enum Base {
    LocalAppData,
    ProgramFiles,
}

struct Def {
    id: &'static str,
    name: &'static str,
    /// Program names looked for on `PATH`.
    on_path: &'static [&'static str],
    /// Usual install places: a folder under the base, and the program in it (Windows).
    installed: &'static [(Base, &'static str)],
    line: Line,
}

const DEFS: &[Def] = &[
    Def {
        id: "vscode",
        name: "VS Code",
        on_path: if cfg!(windows) { &[] } else { &["code"] },
        installed: &[(Base::LocalAppData, "Programs/Microsoft VS Code/Code.exe"), (Base::ProgramFiles, "Microsoft VS Code/Code.exe")],
        line: Line::Goto,
    },
    Def {
        id: "cursor",
        name: "Cursor",
        on_path: if cfg!(windows) { &[] } else { &["cursor"] },
        installed: &[(Base::LocalAppData, "Programs/cursor/Cursor.exe"), (Base::ProgramFiles, "Cursor/Cursor.exe")],
        line: Line::Goto,
    },
    Def {
        id: "windsurf",
        name: "Windsurf",
        on_path: if cfg!(windows) { &[] } else { &["windsurf"] },
        installed: &[(Base::LocalAppData, "Programs/Windsurf/Windsurf.exe")],
        line: Line::Goto,
    },
    Def {
        id: "zed",
        name: "Zed",
        on_path: if cfg!(windows) { &["zed.exe"] } else { &["zed"] },
        installed: &[(Base::LocalAppData, "Programs/Zed/Zed.exe"), (Base::LocalAppData, "Zed/Zed.exe")],
        line: Line::Colon,
    },
    Def {
        id: "sublime",
        name: "Sublime Text",
        on_path: if cfg!(windows) { &["subl.exe"] } else { &["subl"] },
        installed: &[(Base::ProgramFiles, "Sublime Text/sublime_text.exe")],
        line: Line::Colon,
    },
    Def {
        id: "notepadpp",
        name: "Notepad++",
        on_path: &[],
        installed: &[(Base::ProgramFiles, "Notepad++/notepad++.exe")],
        line: Line::NFlag,
    },
];

/// Where to look: `PATH` and the install bases (a test passes its own).
#[derive(Debug, Clone, Default)]
pub struct Places {
    pub path: OsString,
    pub local_app_data: Option<PathBuf>,
    pub program_files: Vec<PathBuf>,
}

impl Places {
    pub fn from_env() -> Self {
        let mut program_files = Vec::new();
        for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(dir) = std::env::var_os(key).map(PathBuf::from) {
                if !program_files.contains(&dir) {
                    program_files.push(dir);
                }
            }
        }
        Self { path: std::env::var_os("PATH").unwrap_or_default(), local_app_data: std::env::var_os("LOCALAPPDATA").map(PathBuf::from), program_files }
    }
}

/// An editor found on this computer. The id is what the person's choice is saved as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EditorFound {
    pub id: String,
    pub name: String,
}

fn program_of(def: &Def, places: &Places) -> Option<PathBuf> {
    for name in def.on_path {
        if let Some(found) = std::env::split_paths(&places.path).map(|dir| dir.join(name)).find(|p| p.is_file()) {
            return Some(found);
        }
    }
    for (base, rel) in def.installed {
        let roots: Vec<&Path> = match base {
            Base::LocalAppData => places.local_app_data.iter().map(PathBuf::as_path).collect(),
            Base::ProgramFiles => places.program_files.iter().map(PathBuf::as_path).collect(),
        };
        if let Some(found) = roots.iter().map(|root| root.join(rel)).find(|p| p.is_file()) {
            return Some(found);
        }
    }
    None
}

/// The editors installed here, in a fixed order.
pub fn find_editors(places: &Places) -> Vec<EditorFound> {
    DEFS.iter().filter(|d| program_of(d, places).is_some()).map(|d| EditorFound { id: d.id.into(), name: d.name.into() }).collect()
}

fn plain(path: &Path) -> String {
    path.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

fn args_for(line: Line, file: &Path, at: Option<u32>) -> Vec<OsString> {
    let file = plain(file);
    let at = at.filter(|n| *n > 0);
    match (line, at) {
        (Line::Goto, Some(n)) => vec!["--goto".into(), format!("{file}:{n}").into()],
        (Line::Colon, Some(n)) => vec![format!("{file}:{n}").into()],
        (Line::NFlag, Some(n)) => vec![format!("-n{n}").into(), file.into()],
        (_, None) => vec![file.into()],
    }
}

/// The program and arguments that open `file` in the editor `id`. Refuses an editor that is not installed.
pub fn plan(places: &Places, id: &str, file: &Path, at: Option<u32>) -> Result<(PathBuf, Vec<OsString>), String> {
    let def = DEFS.iter().find(|d| d.id == id).ok_or_else(|| "EDITOR_UNKNOWN: That editor is not on the list.".to_string())?;
    let program = program_of(def, places).ok_or_else(|| format!("EDITOR_MISSING: {} is not installed on this computer.", def.name))?;
    Ok((program, args_for(def.line, file, at)))
}

/// Opens `rel` (inside `root`) in the editor `id`, at line `at` when given.
pub fn open(root: &str, rel: &str, id: &str, at: Option<u32>) -> Result<(), String> {
    let (_, file) = crate::files::resolve_in_root(root, rel)?;
    if !file.is_file() {
        return Err("FILES_NOT_FOUND: That file is not there any more.".into());
    }
    let (program, args) = plan(&Places::from_env(), id, &file, at)?;
    crate::proc_util::hidden_command(program)
        .args(args)
        .current_dir(Path::new(root))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("EDITOR_START: Could not start the editor: {e}."))
}

#[cfg(test)]
mod tests;
