//! Moved out of the app: the path rule a profile's instruction files are checked with.

/// A path that stays inside the project: relative, no `..`, no drive, no leading slash.
pub fn relative_path_ok(path: &str) -> bool {
    let p = path.trim();
    if p.is_empty() || p.starts_with('/') || p.starts_with('\\') || p.contains(':') {
        return false;
    }
    p.split(['/', '\\']).all(|part| !part.is_empty() && part != "." && part != "..")
}

