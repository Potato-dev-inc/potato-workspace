//! Putting the tools where an app-only update can find them, and tidying that place. Only ever touches the tools folder
//! (`%LOCALAPPDATA%/<app id>/tools`) and only entries this module made: `<number>`, `<number>.tmp` and `.discard`.

use std::path::{Path, PathBuf};

use super::{declared_version, local_dir, verify, Depth, ToolsManifest, MANIFEST_FILE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Staged {
    /// The folder for this tools version was already there and whole: nothing was copied.
    AlreadyThere,
    /// A fresh copy was made, checked file by file, and given its final name.
    Copied,
}

const DISCARD: &str = ".discard";

fn is_number(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit())
}

/// A name this module made and may remove: `3`, `3.tmp`.
fn is_ours(name: &str) -> bool {
    is_number(name) || name.strip_suffix(".tmp").is_some_and(is_number)
}

/// Moves one of our folders out of the way (into `.discard`), then removes it. A folder with another name, or one that is
/// not directly inside `base`, is never touched. Returns whether it is gone from its old place.
pub(super) fn discard(base: &Path, dir: &Path) -> bool {
    let Some(name) = dir.file_name().and_then(|n| n.to_str()) else { return false };
    if dir.parent() != Some(base) || !is_ours(name) {
        return false;
    }
    let trash = base.join(DISCARD);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let moved = trash.join(format!("{name}-{stamp}"));
    if std::fs::create_dir_all(&trash).is_err() || std::fs::rename(dir, &moved).is_err() {
        return false;
    }
    let _ = std::fs::remove_dir_all(&moved);
    true
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Copies what the manifest lists from the install folder into `<base>/<number>/` and checks it. The copy gets its
/// final name only after every file matched, so a half copy never looks like tools. Any failure leaves no final folder.
pub fn stage_local(install_resources: &Path, base: &Path, manifest: &ToolsManifest) -> Result<Staged, String> {
    let final_dir = local_dir(base, manifest.tools_version);
    if final_dir.exists() {
        if declared_version(&final_dir) == Some(manifest.tools_version) && verify(&final_dir, manifest, Depth::Quick).is_ok() {
            return Ok(Staged::AlreadyThere);
        }
        if !discard(base, &final_dir) {
            return Err("an old tools folder is in the way".into());
        }
    }
    let tmp = base.join(format!("{}.tmp", manifest.tools_version));
    if tmp.exists() && !discard(base, &tmp) {
        return Err("a half copy is in the way".into());
    }
    let result = copy_and_check(install_resources, &tmp, manifest).and_then(|()| std::fs::rename(&tmp, &final_dir).map_err(|e| format!("could not finish the copy: {e}")));
    if result.is_err() {
        discard(base, &tmp);
    }
    result.map(|()| Staged::Copied)
}

fn copy_and_check(from: &Path, tmp: &Path, manifest: &ToolsManifest) -> Result<(), String> {
    std::fs::create_dir_all(tmp).map_err(|e| format!("could not make the folder: {e}"))?;
    // Whole folders for the counted tools; the other listed files (cloudflared) one by one.
    for folder in manifest.counts.keys() {
        let src = from.join(folder);
        copy_tree(&src, &tmp.join(folder)).map_err(|e| format!("could not copy {folder}: {e}"))?;
    }
    for file in &manifest.files {
        let top = file.path.split('/').next().unwrap_or_default();
        if manifest.counts.contains_key(top) {
            continue;
        }
        let dst: PathBuf = tmp.join(&file.path);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not make the folder: {e}"))?;
        }
        std::fs::copy(from.join(&file.path), &dst).map_err(|e| format!("could not copy {}: {e}", file.path))?;
    }
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(tmp.join(MANIFEST_FILE), text).map_err(|e| format!("could not write the manifest: {e}"))?;
    verify(tmp, manifest, Depth::Full)
}

/// Removes staged folders of other numbers, half copies and the discard folder. Only names this module makes. Returns the
/// names it handled.
pub fn cleanup_local(base: &Path, keep: u32) -> Vec<String> {
    let mut handled = Vec::new();
    let Ok(entries) = std::fs::read_dir(base) else { return handled };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() {
            continue;
        }
        if name == DISCARD {
            continue;
        }
        if is_ours(&name) && name != keep.to_string() && discard(base, &entry.path()) {
            handled.push(name);
        }
    }
    // Last, so what was just moved there goes too.
    if base.join(DISCARD).is_dir() {
        let _ = std::fs::remove_dir_all(base.join(DISCARD));
        handled.push(DISCARD.to_string());
    }
    handled
}
