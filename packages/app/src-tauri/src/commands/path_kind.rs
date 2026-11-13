//! What dropped paths are: a folder, a file, or gone. The sidebar asks this when something is dropped on it
//! (a folder offers "Add as a project?"). Nothing is read or changed.

use std::path::Path;

/// `dir`, `file` or `missing` for one path. A link counts as what it points at.
pub fn kind_of(path: &Path) -> &'static str {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => "dir",
        Ok(_) => "file",
        Err(_) => "missing",
    }
}

/// One answer per path, in the same order.
#[tauri::command]
pub async fn path_kinds(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().take(200).map(|p| kind_of(Path::new(p)).to_string()).collect())
        .await
        .map_err(|e| format!("INTERNAL: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_a_file_and_a_missing_path_are_told_apart() {
        let dir = std::env::temp_dir().join(format!("pm-path-kind-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(kind_of(&dir), "dir");
        assert_eq!(kind_of(&file), "file");
        assert_eq!(kind_of(&dir.join("nope")), "missing");
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }
}
