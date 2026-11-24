//! Write a file so a reader sees the old file or the new one, never half of one.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `bytes` to `path` so a reader sees the old file or the new one, never half of one:
/// write a sibling temp file, then rename it over the target.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = tmp_path(path);
    if let Err(e) = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn tmp_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    path.with_file_name(format!("{name}.{}-{}.tmp", std::process::id(), TMP_COUNTER.fetch_add(1, Ordering::Relaxed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_whole_creates_folders_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("pm-write-atomic-{}", std::process::id()));
        let file = dir.join("a").join("x.json");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
