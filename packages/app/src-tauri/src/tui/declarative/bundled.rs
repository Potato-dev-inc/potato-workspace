//! Bundled agent definitions: the `resources/definitions/*.toml` files the app ships, so an installed program can be
//! listed without a user file. They load like user files and need no approval (the bundled source, SRC-1). The text is
//! read once per process. Nothing here names an agent: the files do.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The folder the shipped definitions live in: beside the app executable (an installed build), else the source tree.
pub fn root() -> Option<PathBuf> {
    let beside_exe = std::env::current_exe().ok().and_then(|exe| {
        let dir = exe.parent()?;
        Some(crate::shell_env::bundled_resources_root(dir).join("definitions"))
    });
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("definitions");
    [beside_exe, Some(source)].into_iter().flatten().find(|p| p.is_dir())
}

/// Every `*.toml` file in `dir` as (file name, text), sorted by name. A file that cannot be read is skipped.
pub fn read_dir(dir: &Path) -> Vec<(String, String)> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = read
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("toml")))
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_str()?.to_string();
            let text = std::fs::read_to_string(&p).ok()?;
            Some((name, text))
        })
        .collect()
}

/// The path prefix a bundled entry carries (`bundled/<name>`). It is never a real folder: reads go to `read_definition`.
pub const PREFIX: &str = "bundled/";

/// The text a definition path stands for. A bundled path (`bundled/<name>`) gives the shipped text and never touches
/// the disk; any other path is read from the file. Every read of a definition goes through here.
pub fn read_definition(path: &Path) -> std::io::Result<String> {
    let text = path.to_string_lossy().replace('\\', "/");
    match text.strip_prefix(PREFIX) {
        Some(name) => shipped()
            .iter()
            .find(|(file, _)| *file == name)
            .map(|(_, body)| (*body).to_string())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, format!("no shipped definition {name}"))),
        None => std::fs::read_to_string(path),
    }
}

static SHIPPED: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();

/// The shipped definitions as (file name, text). Read once; the text lives for the rest of the process.
pub fn shipped() -> &'static [(&'static str, &'static str)] {
    SHIPPED.get_or_init(|| {
        root()
            .map(|dir| read_dir(&dir))
            .unwrap_or_default()
            .into_iter()
            .map(|(name, text)| (&*Box::leak(name.into_boxed_str()), &*Box::leak(text.into_boxed_str())))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_toml_files_count_and_the_shipped_list_is_read() {
        assert!(!shipped().is_empty(), "the shipped definitions folder is read");
        assert!(shipped().iter().all(|(n, _)| n.to_ascii_lowercase().ends_with(".toml")));
        let dir = std::env::temp_dir().join(format!("pm-bundled-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.toml"), "x = 1\n").unwrap();
        std::fs::write(dir.join("a.TOML"), "y = 2\n").unwrap();
        std::fs::write(dir.join("notes.md"), "not a definition\n").unwrap();
        let found: Vec<String> = read_dir(&dir).into_iter().map(|(n, _)| n).collect();
        assert_eq!(found, vec!["a.TOML".to_string(), "b.toml".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod load_tests {
    use super::*;
    use crate::tui::declarative::approvals::Approvals;
    use crate::tui::declarative::loader::{build, DefState, LoadInputs};

    #[test]
    fn every_shipped_definition_loads_as_an_active_profile_with_no_acp_table() {
        let inputs = LoadInputs { bundled: shipped(), user_dir: None, code_ids: &[], projects: &[], extra: &[] };
        let built = build(&inputs, &Approvals::default());
        assert_eq!(built.entries.len(), shipped().len(), "one entry per shipped file");
        for entry in &built.entries {
            assert_eq!(entry.state, DefState::Active, "{:?} {:?}", entry.path, entry.errors);
        }
        assert_eq!(built.profiles.len(), shipped().len());
        for profile in &built.profiles {
            assert!(profile.acp_table().is_none(), "{} has its chat from a reviewed adapter, not its file", profile.id());
        }
    }
}
