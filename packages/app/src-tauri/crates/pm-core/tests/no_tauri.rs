//! Guard: `pm-core` and `potato-host` never depend on Tauri. A manifest line or a `tauri::` path in source would pull the window
//! toolkit into the screen-less host. Comments may say the word.

use std::fs;
use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read dir").flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The text of `path` without `//` comment lines, so a doc line may name the toolkit.
fn code_only(path: &Path) -> String {
    let text = fs::read_to_string(path).expect("read file");
    text.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

#[test]
fn core_and_host_name_no_tauri() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    // Built from parts so this file does not match itself.
    let path_needle = format!("{}::", "tauri");
    for krate in [root.to_path_buf(), root.join("../potato-host")] {
        let manifest = fs::read_to_string(krate.join("Cargo.toml")).expect("manifest");
        assert!(
            !manifest.lines().any(|l| l.trim_start().starts_with("tauri")),
            "{} has a tauri dependency",
            krate.display()
        );
        let mut files = Vec::new();
        rust_files(&krate.join("src"), &mut files);
        assert!(!files.is_empty(), "no sources found under {}", krate.display());
        for file in files {
            assert!(!code_only(&file).contains(&path_needle), "{} names a Tauri path", file.display());
        }
    }
}
