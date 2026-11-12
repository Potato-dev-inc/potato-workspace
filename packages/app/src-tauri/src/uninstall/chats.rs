//! "Keep my chats": one zip in Documents, written and checked BEFORE anything is deleted.

use std::path::{Path, PathBuf};

use super::plan::Scan;
use super::roots::Roots;
use crate::flight::zip::ZipWriter;

/// A file bigger than this does not go into the zip (the zip writer has no ZIP64). The step then fails,
/// so nothing is deleted while the chats are not safe.
const MAX_FILE: u64 = 1_500_000_000;

/// Today in UTC as `(year, month, day)`.
pub fn today() -> (i64, u32, u32) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    civil((secs / 86_400) as i64)
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's algorithm).
pub fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

pub fn zip_name((y, m, d): (i64, u32, u32)) -> String {
    format!("Potato Workspace chats {y:04}-{m:02}-{d:02}.zip")
}

fn files_under(path: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    if meta.is_dir() {
        if depth > 40 {
            return;
        }
        if let Ok(read) = std::fs::read_dir(path) {
            let mut kids: Vec<PathBuf> = read.filter_map(Result::ok).map(|e| e.path()).collect();
            kids.sort();
            for kid in kids {
                files_under(&kid, out, depth + 1);
            }
        }
    } else if meta.is_file() {
        out.push(path.to_path_buf());
    }
}

/// `(name inside the zip, file on disk)` for every chat file.
pub fn zip_entries(scan: &Scan, roots: &Roots) -> Vec<(String, PathBuf)> {
    let rel_name = |prefix: &str, base: &Path, file: &Path| -> String {
        let rel = file.strip_prefix(base).unwrap_or(file).to_string_lossy().replace('\\', "/");
        format!("{prefix}/{}", rel.trim_start_matches('/'))
    };
    let mut out = Vec::new();
    for profile in &scan.profiles {
        for path in [profile.data_dir.join("acp").join("journals"), profile.data_dir.join("chat-index.sqlite")] {
            let mut files = Vec::new();
            files_under(&path, &mut files, 0);
            for f in files {
                out.push((rel_name(&format!("app-data/{}", profile.id), &profile.data_dir, &f), f));
            }
        }
    }
    let companions = roots.home.join(crate::app_paths::COMPANION_HOME_DIR_NAME).join("companions");
    let mut files = Vec::new();
    files_under(&companions, &mut files, 0);
    for f in files {
        out.push((rel_name("companions", &companions, &f), f));
    }
    for (n, project) in scan.projects.iter().enumerate() {
        let name = project.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
        let data = crate::app_paths::project_data_dir(&project.path);
        for child in super::plan::PROJECT_CHAT_CHILDREN {
            let mut files = Vec::new();
            files_under(&data.join(child), &mut files, 0);
            for f in files {
                out.push((rel_name(&format!("projects/{n}-{name}"), &data, &f), f));
            }
        }
    }
    out
}

/// Write the zip into `<documents>`. Returns its path and how many files it holds. Any file that
/// cannot be read or is too big is an error: the caller stops before deleting.
pub fn write_zip(scan: &Scan, roots: &Roots, date: (i64, u32, u32)) -> Result<(PathBuf, usize), String> {
    std::fs::create_dir_all(&roots.documents).map_err(|e| format!("could not open {}: {e}", roots.documents.display()))?;
    let mut target = roots.documents.join(zip_name(date));
    let mut n = 2;
    while target.exists() {
        target = roots.documents.join(zip_name(date).replace(".zip", &format!(" ({n}).zip")));
        n += 1;
    }
    let entries = zip_entries(scan, roots);
    let file = std::fs::File::create(&target).map_err(|e| format!("could not create {}: {e}", target.display()))?;
    let mut zip = ZipWriter::new(std::io::BufWriter::new(file));
    for (name, path) in &entries {
        let len = std::fs::metadata(path).map(|m| m.len()).map_err(|e| format!("could not read {}: {e}", path.display()))?;
        if len > MAX_FILE {
            drop(zip);
            let _ = std::fs::remove_file(&target);
            return Err(format!("{} is too big to zip ({} MB). Copy it somewhere safe by hand, then untick Your chats.", path.display(), len / 1_000_000));
        }
        let data = std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
        zip.add(name, &data).map_err(|e| format!("could not write the zip: {e}"))?;
    }
    zip.finish().and_then(|mut w| std::io::Write::flush(&mut w)).map_err(|e| format!("could not finish the zip: {e}"))?;
    let written = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    if written < 22 {
        return Err("the chats zip came out empty".into());
    }
    Ok((target, entries.len()))
}
