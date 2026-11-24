//! "Browse folders" for a PC at Full: look through the folders of this PC without ever seeing, or naming, a path.
//!
//! The far PC offers a few **roots** by opaque id: this PC's home folder and the parent folders of the projects it knows. The
//! asker names a root and a relative `sub` (`code/billing`), never an absolute path. Everything is checked here:
//! - a `sub` is at most [`MAX_DEPTH`] plain segments (no `..`, `.`, drive letters, separators, stream names, control characters,
//!   names ending in a dot or a space), each at most [`MAX_SEGMENT`] characters;
//! - the folder is resolved on disk, and the resolved folder must still sit inside the resolved root (so a link, a junction or a
//!   mount point cannot lead out); a link on the way is refused outright, and links are never listed;
//! - a listing has folders only (no files, no hidden or system folders), sorted, at most [`MAX_ENTRIES`], and at most
//!   [`MAX_SCAN`] directory entries are even looked at;
//! - a drive root, or a parent of the home folder, is never a root.
//! Nothing here is tied to the app: tests run it on a temp folder.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

pub const MAX_ENTRIES: usize = 200;
pub const MAX_SCAN: usize = 5000;
pub const MAX_DEPTH: usize = 8;
pub const MAX_SEGMENT: usize = 128;
pub const MAX_ROOTS: usize = 8;

/// A folder this PC lets another browse from.
#[derive(Debug, Clone, PartialEq)]
pub struct Root {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

/// Why a request was refused: `(status, code, words)`.
pub type Refused = (u16, &'static str, &'static str);

const NOT_ALLOWED: Refused = (400, "BAD_PATH", "That folder name is not allowed.");
const GONE: Refused = (404, "NOT_A_FOLDER", "That folder is not there.");

fn key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn last_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The roots: home first (named "Home"), then the parent of each known project that is a real folder. `id_of` makes the opaque id.
pub fn roots(home: Option<&Path>, known: &[String], id_of: &dyn Fn(&str) -> String) -> Vec<Root> {
    let mut out: Vec<Root> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut add = |name: String, path: PathBuf| {
        let k = key(&path);
        if out.len() >= MAX_ROOTS || seen.contains(&k) || is_network(&path) || !path.is_dir() {
            return;
        }
        seen.push(k);
        out.push(Root { id: id_of(&path.to_string_lossy()), name, path });
    };
    if let Some(home) = home.filter(|h| h.parent().is_some()) {
        add("Home".to_string(), home.to_path_buf());
    }
    for folder in known {
        let Some(parent) = Path::new(folder).parent() else { continue };
        // A drive root, or anything that holds the home folder (it would show other people's folders), is never offered.
        if parent.parent().is_none() || home.map_or(false, |h| h.starts_with(parent)) {
            continue;
        }
        let name = last_name(parent);
        if !name.is_empty() {
            add(name, parent.to_path_buf());
        }
    }
    out
}

/// A network path (`\\server\share`, also as `\\?\UNC\...` or `//server/share`): never a root, so a share is never browsed or opened.
pub fn is_network(path: &Path) -> bool {
    let text = path.to_string_lossy();
    if text.starts_with(r"\\?\UNC\") || text.starts_with(r"\\.\UNC\") {
        return true;
    }
    // `\\?\C:\...` is a local drive in verbatim form; any other `\\server` or `//server` is a share.
    (text.starts_with(r"\\") && !text.starts_with(r"\\?\") && !text.starts_with(r"\\.\")) || text.starts_with("//")
}

fn bad_segment(seg: &str) -> bool {
    if seg.is_empty() || seg == "." || seg == ".." || seg.chars().count() > MAX_SEGMENT {
        return true;
    }
    if seg.ends_with('.') || seg.ends_with(' ') {
        return true;
    }
    // '~' too: on Windows DOCKER~1 is the short name of .docker, which the dot-folder rule would not see in the request.
    seg.chars().any(|c| c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '~'))
}

/// `a/b/c` to its segments. Empty is the root itself. Any odd segment refuses the whole thing.
pub fn segments(sub: &str) -> Result<Vec<&str>, Refused> {
    if sub.is_empty() {
        return Ok(Vec::new());
    }
    let segs: Vec<&str> = sub.split('/').collect();
    if segs.len() > MAX_DEPTH || segs.iter().any(|s| bad_segment(s)) {
        return Err(NOT_ALLOWED);
    }
    Ok(segs)
}

/// The folder `segs` under `root`, resolved on disk and checked to stay inside the root. No link on the way.
pub fn resolve(root: &Root, segs: &[&str]) -> Result<PathBuf, Refused> {
    let mut walk = root.path.clone();
    for seg in segs {
        // A dot-folder (.ssh, .git, .config) or a hidden / system folder (AppData) is never entered, listed or opened, by name either.
        if seg.starts_with('.') {
            return Err(NOT_ALLOWED);
        }
        walk.push(seg);
        let meta = std::fs::symlink_metadata(&walk).map_err(|_| GONE)?;
        if meta.file_type().is_symlink() || hidden_meta(&meta) {
            return Err(NOT_ALLOWED);
        }
        if !meta.is_dir() {
            return Err(GONE);
        }
    }
    let canon_root = std::fs::canonicalize(&root.path).map_err(|_| GONE)?;
    check_root(&canon_root)?;
    let canon = std::fs::canonicalize(&walk).map_err(|_| GONE)?;
    check_resolved(&canon_root, &canon)?;
    if !canon.is_dir() {
        return Err(NOT_ALLOWED);
    }
    Ok(plain(canon))
}

/// A root that resolves to a network share (a mapped drive, a subst or a junction pointing at one canonicalizes to `\\?\UNC\...`) is refused.
pub fn check_root(canon_root: &Path) -> Result<(), Refused> {
    if is_network(canon_root) {
        return Err(NOT_ALLOWED);
    }
    Ok(())
}

/// The resolved folder must sit inside the resolved root, and no part of it below the root may be a dot-folder: whatever the request
/// named (an 8.3 short name, a case or Unicode variant), the real folder name decides.
pub fn check_resolved(canon_root: &Path, canon: &Path) -> Result<(), Refused> {
    let Ok(below) = canon.strip_prefix(canon_root) else { return Err(NOT_ALLOWED) };
    if below.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
        return Err(NOT_ALLOWED);
    }
    Ok(())
}

/// The resolved path without the `\\?\` prefix Windows puts on a canonical one, so the folder is stored (and its id made) the way every
/// other part of the app names it, and a folder swapped for a link afterwards is not followed.
fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix("\\\\?\\") {
        Some(rest) if rest.chars().nth(1) == Some(':') => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(windows)]
fn hidden_meta(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & (0x2 | 0x4) != 0
}
#[cfg(not(windows))]
fn hidden_meta(_: &std::fs::Metadata) -> bool {
    false
}
fn hidden(entry: &std::fs::DirEntry) -> bool {
    entry.metadata().map_or(true, |m| hidden_meta(&m))
}

/// The folders directly inside `dir`: names only, sorted, capped. The flag says the list was cut.
pub fn list(dir: &Path) -> Result<(Vec<String>, bool), Refused> {
    let read = std::fs::read_dir(dir).map_err(|_| GONE)?;
    let mut names: Vec<String> = Vec::new();
    let mut cut = false;
    for (i, entry) in read.enumerate() {
        if i >= MAX_SCAN {
            cut = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        let Ok(kind) = entry.file_type() else { continue };
        if !kind.is_dir() || kind.is_symlink() || hidden(&entry) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || bad_segment(&name) {
            continue;
        }
        names.push(name);
    }
    names.sort_by_key(|n| n.to_lowercase());
    if names.len() > MAX_ENTRIES {
        names.truncate(MAX_ENTRIES);
        cut = true;
    }
    Ok((names, cut))
}

fn refused(r: Refused) -> (u16, Value) {
    (r.0, json!({ "error": r.2, "code": r.1 }))
}

/// `GET /pclink/browse`: with no root, the roots; with a root and a `sub`, the folders inside it.
pub fn view(roots: &[Root], root: Option<&str>, sub: &str) -> (u16, Value) {
    let Some(root_id) = root else {
        let all: Vec<Value> = roots.iter().map(|r| json!({ "id": r.id, "name": r.name })).collect();
        return (200, json!({ "roots": all }));
    };
    let Some(found) = roots.iter().find(|r| r.id == root_id) else {
        return refused((404, "UNKNOWN_ROOT", "This PC does not offer that place."));
    };
    let segs = match segments(sub) {
        Ok(s) => s,
        Err(r) => return refused(r),
    };
    let dir = match resolve(found, &segs) {
        Ok(d) => d,
        Err(r) => return refused(r),
    };
    match list(&dir) {
        Ok((names, cut)) => {
            let name = segs.last().map(|s| s.to_string()).unwrap_or_else(|| found.name.clone());
            let entries: Vec<Value> = names.into_iter().map(|n| json!({ "name": n })).collect();
            (200, json!({ "root": found.id, "sub": segs.join("/"), "name": name, "entries": entries, "truncated": cut }))
        }
        Err(r) => refused(r),
    }
}

/// The folder a request names, to open as a project: it must be inside a root and not be the root itself. Returns its path
/// (which stays on this PC) and its name.
pub fn open_target(roots: &[Root], root: &str, sub: &str) -> Result<(String, String), (u16, Value)> {
    let Some(found) = roots.iter().find(|r| r.id == root) else {
        return Err(refused((404, "UNKNOWN_ROOT", "This PC does not offer that place.")));
    };
    let segs = segments(sub).map_err(refused)?;
    if segs.is_empty() {
        return Err(refused((400, "BAD_PATH", "Pick a folder inside it.")));
    }
    let dir = resolve(found, &segs).map_err(refused)?;
    Ok((dir.to_string_lossy().into_owned(), segs[segs.len() - 1].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("pm-browse-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::canonicalize(&base).unwrap()
    }
    fn id(p: &str) -> String {
        format!("r{}", p.len())
    }
    fn one(path: &Path) -> Root {
        Root { id: "r1".into(), name: "Home".into(), path: path.to_path_buf() }
    }
    fn names_of(body: &Value) -> Vec<String> {
        body["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn roots_are_home_and_the_parents_of_known_projects_and_never_a_drive_root_or_a_parent_of_home() {
        let base = temp("roots");
        let home = base.join("home").join("me");
        let code = base.join("work").join("code");
        let proj = code.join("billing");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let in_home = home.join("notes");
        std::fs::create_dir_all(&in_home).unwrap();
        let known = vec![proj.to_string_lossy().into_owned(), in_home.to_string_lossy().into_owned(), "/solo".to_string()];
        let rs = roots(Some(&home), &known, &id);
        let names: Vec<&str> = rs.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["Home", "code"], "home, then the parent of billing; notes' parent is home itself; solo's parent is a drive root");
        // The folder that holds home ("home") is never offered even when a project sits right under it.
        let sibling = base.join("home").join("other");
        std::fs::create_dir_all(&sibling).unwrap();
        let rs = roots(Some(&home), &[sibling.to_string_lossy().into_owned()], &id);
        assert_eq!(rs.len(), 1, "only Home");
    }

    #[test]
    fn a_sub_with_anything_odd_is_refused() {
        for bad in ["..", "a/..", "../a", "a//b", "/a", "a/", ".", "C:", "a/C:\\x", "a\\b", "a:stream", "a.", "a ", "a/b*", "a\u{0}b", "a?b"] {
            assert!(segments(bad).is_err(), "{bad:?} must be refused");
        }
        assert!(segments(&["a"; MAX_DEPTH + 1].join("/")).is_err(), "too deep");
        assert!(segments(&"x".repeat(MAX_SEGMENT + 1)).is_err(), "too long");
        assert_eq!(segments("").unwrap(), Vec::<&str>::new());
        assert_eq!(segments("code/billing service").unwrap(), vec!["code", "billing service"]);
    }

    #[test]
    fn a_listing_has_folders_only_sorted_without_hidden_ones_and_no_path() {
        let base = temp("list");
        for d in ["Beta", "alpha", ".git", "gamma"] {
            std::fs::create_dir_all(base.join(d)).unwrap();
        }
        std::fs::write(base.join("file.txt"), "x").unwrap();
        let (code, body) = view(&[one(&base)], Some("r1"), "");
        assert_eq!(code, 200);
        assert_eq!(names_of(&body), vec!["alpha", "Beta", "gamma"]);
        assert_eq!(body["truncated"], false);
        let leaf = base.file_name().unwrap().to_string_lossy().to_string();
        assert!(!body.to_string().contains(&leaf), "no path travels");
    }

    #[test]
    fn a_long_listing_is_cut() {
        let base = temp("many");
        for i in 0..(MAX_ENTRIES + 20) {
            std::fs::create_dir_all(base.join(format!("d{i:04}"))).unwrap();
        }
        let (_, body) = view(&[one(&base)], Some("r1"), "");
        assert_eq!(names_of(&body).len(), MAX_ENTRIES);
        assert_eq!(body["truncated"], true);
    }

    #[test]
    fn an_unknown_root_a_missing_folder_and_a_file_are_refused() {
        let base = temp("gone");
        std::fs::write(base.join("f"), "x").unwrap();
        let rs = [one(&base)];
        assert_eq!(view(&rs, Some("nope"), "").0, 404);
        assert_eq!(view(&rs, Some("r1"), "missing").0, 404);
        assert_eq!(view(&rs, Some("r1"), "f").0, 404, "a file is not a folder");
        assert_eq!(view(&rs, Some("r1"), "..").0, 400);
        assert_eq!(view(&rs, None, "").1["roots"][0]["id"], "r1");
    }

    #[test]
    fn opening_needs_a_folder_inside_a_root_not_the_root() {
        let base = temp("open");
        std::fs::create_dir_all(base.join("a").join("b")).unwrap();
        let rs = [one(&base)];
        let (path, name) = open_target(&rs, "r1", "a/b").unwrap();
        assert_eq!(name, "b");
        assert!(Path::new(&path).ends_with(Path::new("a").join("b")));
        assert_eq!(open_target(&rs, "r1", "").unwrap_err().0, 400, "the root itself is not a project");
        assert_eq!(open_target(&rs, "r1", "../x").unwrap_err().0, 400);
        assert_eq!(open_target(&rs, "zz", "a").unwrap_err().0, 404);
    }

    #[test]
    fn a_dot_folder_cannot_be_entered_or_opened_by_name() {
        let base = temp("dot");
        std::fs::create_dir_all(base.join(".ssh").join("keys")).unwrap();
        std::fs::create_dir_all(base.join("code").join(".git")).unwrap();
        let rs = [one(&base)];
        assert_eq!(view(&rs, Some("r1"), ".ssh").0, 400);
        assert_eq!(view(&rs, Some("r1"), ".ssh/keys").0, 400);
        assert_eq!(view(&rs, Some("r1"), "code/.git").0, 400);
        assert_eq!(open_target(&rs, "r1", ".ssh").unwrap_err().0, 400);
        assert_eq!(open_target(&rs, "r1", "code/.git").unwrap_err().0, 400);
    }

    #[cfg(windows)]
    #[test]
    fn a_hidden_or_system_folder_cannot_be_entered_or_opened_by_name() {
        let base = temp("hid");
        std::fs::create_dir_all(base.join("AppData").join("Local")).unwrap();
        std::fs::create_dir_all(base.join("code")).unwrap();
        let done = std::process::Command::new("attrib").arg("+h").arg(base.join("AppData").to_string_lossy().trim_start_matches(r"\\?\")).output();
        assert!(done.map_or(false, |o| o.status.success()), "attrib +h failed");
        let rs = [one(&base)];
        assert_eq!(names_of(&view(&rs, Some("r1"), "").1), vec!["code"], "not listed");
        assert_eq!(view(&rs, Some("r1"), "AppData").0, 400);
        assert_eq!(view(&rs, Some("r1"), "AppData/Local").0, 400);
        assert_eq!(open_target(&rs, "r1", "AppData/Local").unwrap_err().0, 400);
    }

    #[test]
    fn a_resolved_path_with_a_dot_part_or_outside_the_root_is_refused() {
        let root = Path::new("/r/home");
        assert!(check_resolved(root, Path::new("/r/home/code/app")).is_ok());
        assert!(check_resolved(root, Path::new("/r/home/.ssh")).is_err());
        assert!(check_resolved(root, Path::new("/r/home/code/.git/hooks")).is_err());
        assert!(check_resolved(root, Path::new("/r/other")).is_err());
        assert!(segments("DOCKER~1").is_err() && segments("code/VSCODE~1").is_err(), "8.3 short names are refused by name");
    }

    #[test]
    fn network_paths_are_never_roots() {
        assert!(is_network(Path::new(r"\\server\share\x")) && is_network(Path::new(r"\\?\UNC\server\share")) && is_network(Path::new("//server/share")));
        assert!(!is_network(Path::new(r"C:\Users\me")) && !is_network(Path::new("/home/me")));
        // Deep paths, as a root would canonicalize: the check on the canonical root itself fails without is_network.
        for net in [r"\\?\UNC\server\share\a\proj", r"\\server\share\a\proj", "//server/share/a/proj"] {
            assert!(is_network(Path::new(net)), "{net}");
            assert!(check_root(Path::new(net)).is_err(), "{net}");
        }
        assert!(check_root(Path::new(r"\\?\C:\Users\me\code")).is_ok());
        assert!(check_root(Path::new("/home/me/code")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn the_8_3_short_name_of_a_dot_folder_cannot_be_browsed_or_opened() {
        let base = temp("short");
        std::fs::create_dir_all(base.join(".ssh").join("keys")).unwrap();
        let plain = base.join(".ssh").to_string_lossy().trim_start_matches(r"\\?\").to_string();
        let script = format!("(New-Object -ComObject Scripting.FileSystemObject).GetFolder('{plain}').ShortName");
        let out = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).output().expect("powershell runs");
        let short = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let rs = [one(&base)];
        let canon_root = std::fs::canonicalize(&base).unwrap();
        // The function the request path ends in: the real folder is a dot-folder whatever name was typed.
        assert!(check_resolved(&canon_root, &std::fs::canonicalize(base.join(".ssh")).unwrap()).is_err());
        if short.contains('~') {
            assert_eq!(view(&rs, Some("r1"), &short).0, 400, "short name {short}");
            assert_eq!(view(&rs, Some("r1"), &format!("{short}/keys")).0, 400);
            assert_eq!(open_target(&rs, "r1", &short).unwrap_err().0, 400);
        } else {
            eprintln!("SKIPPED the by-name half: 8.3 short names are off on this drive (short name was {short:?}); the resolved-path check was still tested");
        }
    }

    #[test]
    fn the_opened_path_is_the_resolved_plain_one() {
        let base = temp("plain");
        std::fs::create_dir_all(base.join("Code").join("Proj")).unwrap();
        let rs = [one(&base)];
        let (path, _) = open_target(&rs, "r1", "Code/Proj").unwrap();
        assert!(!path.starts_with("\\\\?\\") || base.to_string_lossy().starts_with("\\\\?\\"), "no verbatim prefix added: {path}");
        assert_eq!(std::fs::canonicalize(&path).unwrap(), std::fs::canonicalize(base.join("Code").join("Proj")).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_leading_out_of_the_root_is_refused_and_not_listed() {
        let base = temp("link");
        let outside = temp("outside");
        std::fs::create_dir_all(outside.join("secret")).unwrap();
        std::fs::create_dir_all(base.join("real")).unwrap();
        std::os::unix::fs::symlink(&outside, base.join("escape")).unwrap();
        let rs = [one(&base)];
        let (_, body) = view(&rs, Some("r1"), "");
        assert_eq!(names_of(&body), vec!["real"], "the link is not listed");
        assert_eq!(view(&rs, Some("r1"), "escape").0, 400, "and cannot be entered by name");
        assert_eq!(view(&rs, Some("r1"), "escape/secret").0, 400);
        assert_eq!(open_target(&rs, "r1", "escape/secret").unwrap_err().0, 400);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_leading_out_of_the_root_is_refused_and_not_listed() {
        let base = temp("junc");
        let outside = temp("outside");
        std::fs::create_dir_all(outside.join("secret")).unwrap();
        std::fs::create_dir_all(base.join("real")).unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(base.join("escape")).arg(&outside).output();
        assert!(made.map_or(false, |o| o.status.success()), "mklink /J failed: this test must really make a junction, it does not skip");
        let rs = [one(&base)];
        let (_, body) = view(&rs, Some("r1"), "");
        assert_eq!(names_of(&body), vec!["real"], "the junction is not listed");
        assert_eq!(view(&rs, Some("r1"), "escape/secret").0, 400);
        assert_eq!(open_target(&rs, "r1", "escape/secret").unwrap_err().0, 400);
    }
}
