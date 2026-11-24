//! The folders this machine knows as projects: what `GET /pclink/projects`, `browse` and `projects/open` answer, and what
//! `known_folder` checks. A small JSON list in the host's data folder. An id is SHA-256(install key, normalised path), 16 hex digits,
//! like the app's (`app_services.rs::project_id`): without the key a PC cannot work out an id from a guessed path. No path travels.

use std::path::{Path, PathBuf};

use pm_core::device_link::pclink::browse;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type Reply = (u16, Value);

/// Folders kept (the newest first).
const MAX_KNOWN: usize = 50;

#[derive(Clone)]
pub struct Projects {
    file: PathBuf,
    key: [u8; 16],
    home: Option<PathBuf>,
}

impl Projects {
    /// `dir` is the host's data folder. The key file is made on first use and never replaced if it is there but unreadable.
    pub fn open(dir: &Path, home: Option<PathBuf>) -> Self {
        Self { key: install_key(&dir.join("pclink-id-key")), file: dir.join("projects.json"), home }
    }

    /// Read from the file every time: `run` and `link --stdio` are separate processes and each sees the other's folders.
    fn load(&self) -> Vec<String> {
        std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok()).unwrap_or_default()
    }

    pub fn id(&self, path: &str) -> String {
        id_with(&self.key, &path.replace('\\', "/").trim_end_matches('/').to_lowercase())
    }

    fn known(&self) -> Vec<String> {
        self.load().into_iter().filter(|p| Path::new(p).is_dir()).collect()
    }

    pub fn list(&self) -> Reply {
        let rows: Vec<Value> = self.known().iter().map(|p| json!({ "id": self.id(p), "name": name_of(p), "state": state_of(Path::new(p)) })).collect();
        (200, json!({ "projects": rows }))
    }

    /// The folder of a known project by its id (the only way a far row names one).
    pub fn folder_of(&self, id: &str) -> Option<String> {
        self.known().into_iter().find(|p| self.id(p) == id)
    }

    pub fn known_folder(&self, path: &str) -> bool {
        let id = self.id(path);
        self.known().iter().any(|p| self.id(p) == id)
    }

    fn roots(&self) -> Vec<browse::Root> {
        browse::roots(self.home.as_deref(), &self.known(), &|p| self.id(p))
    }

    pub fn browse(&self, root: Option<&str>, sub: &str) -> Reply {
        browse::view(&self.roots(), root, sub)
    }

    pub fn open_folder(&self, root: &str, sub: &str) -> Reply {
        let (folder, name) = match browse::open_target(&self.roots(), root, sub) {
            Ok(found) => found,
            Err(refused) => return refused,
        };
        self.remember(&folder);
        (200, json!({ "project": { "id": self.id(&folder), "name": name, "state": state_of(Path::new(&folder)) } }))
    }

    fn remember(&self, folder: &str) {
        let mut list = self.load();
        let id = self.id(folder);
        list.retain(|p| self.id(p) != id);
        list.insert(0, folder.to_string());
        list.truncate(MAX_KNOWN);
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.file.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec(&list).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.file);
        }
    }
}

impl pm_core::device_link::pclink::engine_services::ProjectNames for Projects {
    fn id(&self, path: &str) -> String {
        Projects::id(self, path)
    }
    fn folder_of(&self, id: &str) -> Option<String> {
        Projects::folder_of(self, id)
    }
}

fn name_of(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

/// `repo` for a Git work tree, `folder` for any other folder (what the app says for the two states a project list needs).
fn state_of(path: &Path) -> &'static str {
    if path.join(".git").exists() {
        "repo"
    } else {
        "folder"
    }
}

fn id_with(key: &[u8; 16], normal: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(normal.as_bytes());
    format!("p{}", hasher.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect::<String>())
}

/// 16 random bytes kept in `file` (hex). Present but unreadable: this run uses a key of its own and the file is left alone.
fn install_key(file: &Path) -> [u8; 16] {
    if let Ok(text) = std::fs::read_to_string(file) {
        if let Some(key) = unhex16(text.trim()) {
            return key;
        }
        return *uuid::Uuid::new_v4().as_bytes();
    }
    let key = *uuid::Uuid::new_v4().as_bytes();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text: String = key.iter().map(|b| format!("{b:02x}")).collect();
    let _ = std::fs::write(file, text);
    key
}

fn unhex16(text: &str) -> Option<[u8; 16]> {
    if text.len() != 32 || !text.is_ascii() {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        // Beside the test exe, in the cargo target folder: never the system temp folder.
        let dir = std::env::current_exe().unwrap().parent().unwrap().join("host-projects-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_browsed_folder_becomes_a_project_by_id_and_survives_a_restart() {
        let base = scratch("open");
        let home = base.join("home");
        std::fs::create_dir_all(home.join("code/billing/.git")).unwrap();
        std::fs::create_dir_all(home.join("code/notes")).unwrap();
        let p = Projects::open(&base.join("data"), Some(home.clone()));
        assert_eq!(p.list().1, json!({ "projects": [] }));
        // Browse: the home root by id, then the folder inside it; never a path.
        let (status, view) = p.browse(None, "");
        assert_eq!(status, 200);
        let root = view["roots"][0]["id"].as_str().unwrap().to_string();
        let (status, opened) = p.open_folder(&root, "code/billing");
        assert_eq!((status, opened["project"]["name"].as_str(), opened["project"]["state"].as_str()), (200, Some("billing"), Some("repo")));
        let id = opened["project"]["id"].as_str().unwrap().to_string();
        assert!(!opened.to_string().contains(home.to_str().unwrap()), "no path in the answer");
        assert_eq!(p.list().1["projects"][0]["id"], json!(id));
        assert!(p.known_folder(home.join("code/billing").to_str().unwrap()));
        assert!(!p.known_folder(home.join("code/notes").to_str().unwrap()), "only opened folders are known");
        // Another process (`run` next to `link --stdio`) adds a folder: this one sees both.
        let second = Projects::open(&base.join("data"), Some(base.join("home")));
        second.remember(base.join("home/code/notes").to_str().unwrap());
        assert_eq!(p.list().1["projects"].as_array().unwrap().len(), 2);
        // A restart (new object, same folder) knows it by the same id.
        let again = Projects::open(&base.join("data"), Some(home));
        assert!(again.list().1["projects"].as_array().unwrap().iter().any(|r| r["id"] == json!(id)));
    }

    #[test]
    fn a_way_out_of_the_root_is_refused_and_ids_depend_on_the_install_key() {
        let base = scratch("escape");
        let home = base.join("home");
        std::fs::create_dir_all(home.join("code")).unwrap();
        let p = Projects::open(&base.join("data"), Some(home));
        let root = p.browse(None, "").1["roots"][0]["id"].as_str().unwrap().to_string();
        for bad in ["..", "code/../..", "/etc", "C:/x"] {
            assert_ne!(p.open_folder(&root, bad).0, 200, "{bad}");
        }
        assert_eq!(p.list().1, json!({ "projects": [] }));
        let other = Projects::open(&scratch("escape2"), None);
        assert_ne!(p.id("/a/b"), other.id("/a/b"), "another install gives another id");
        assert_eq!(p.id("/A/b/"), p.id("/a/b"));
    }
}
