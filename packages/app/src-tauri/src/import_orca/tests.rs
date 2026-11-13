//! Tests with a made-up Orca folder (all names and paths are invented).

use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn temp(label: &str) -> Dir {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!("pm-orca-test-{label}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&dir).unwrap();
    Dir(dir)
}
fn json_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "\\\\")
}

/// A fake Orca folder: one default profile with a real project, a missing one, an SSH one and a repeat; one named
/// profile with another real project.
fn fake_orca() -> (Dir, Dir, PathBuf, PathBuf) {
    let orca = temp("orca");
    let work = temp("work");
    let alpha = work.0.join("alpha-app");
    let beta = work.0.join("beta-site");
    std::fs::create_dir_all(&alpha).unwrap();
    std::fs::create_dir_all(&beta).unwrap();
    let gone = work.0.join("deleted-long-ago");
    let main = format!(
        r##"{{"schemaVersion":3,"repos":[
            {{"id":"1","path":"{a}","displayName":"Alpha","badgeColor":"#fff","addedAt":1}},
            {{"id":"2","path":"{g}","displayName":"","addedAt":2}},
            {{"id":"3","path":"/srv/remote","displayName":"Remote box","connectionId":"ssh-1"}},
            {{"id":"4","path":"{a}","displayName":"Alpha again"}},
            {{"id":"5","path":"relative/dir","displayName":"Nope"}}
        ],"settings":{{"anyKey":"not read"}}}}"##,
        a = json_path(&alpha),
        g = json_path(&gone)
    );
    std::fs::write(orca.0.join("orca-data.json"), main).unwrap();
    let named = orca.0.join("profiles").join("work");
    std::fs::create_dir_all(&named).unwrap();
    std::fs::write(named.join("orca-data.json"), format!(r#"{{"repos":[{{"path":"{}","displayName":"Beta"}}]}}"#, json_path(&beta))).unwrap();
    (orca, work, alpha, beta)
}

#[test]
fn a_fake_orca_folder_lists_its_projects_once() {
    let (orca, _work, alpha, beta) = fake_orca();
    let scan = scan_dirs(&[orca.0.clone()]);
    assert!(scan.found);
    assert!(scan.chats.is_empty());
    let names: Vec<_> = scan.projects.iter().map(|p| (p.name.as_str(), p.exists)).collect();
    assert_eq!(names, vec![("Alpha", true), ("deleted-long-ago", false), ("Beta", true)]);
    assert_eq!(scan.projects[0].path, alpha.to_string_lossy());
    assert_eq!(scan.projects[2].path, beta.to_string_lossy());
}

#[test]
fn no_orca_folder_means_not_found() {
    let empty = temp("empty");
    let scan = scan_dirs(&[empty.0.join("nothing-here"), empty.0.clone()]);
    assert!(!scan.found);
    assert!(scan.projects.is_empty());
}

#[test]
fn a_broken_or_odd_data_file_is_skipped_without_an_error() {
    let orca = temp("broken");
    std::fs::write(orca.0.join("orca-data.json"), "{ not json").unwrap();
    let scan = scan_dirs(&[orca.0.clone()]);
    assert!(!scan.found && scan.projects.is_empty());
    std::fs::write(orca.0.join("orca-data.json"), r#"{"repos":"wrong type"}"#).unwrap();
    let scan = scan_dirs(&[orca.0.clone()]);
    assert!(scan.found && scan.projects.is_empty());
}

#[test]
fn scanning_changes_nothing_in_the_orca_folder() {
    let (orca, _work, _a, _b) = fake_orca();
    let before = std::fs::read(orca.0.join("orca-data.json")).unwrap();
    let _ = scan_dirs(&[orca.0.clone()]);
    assert_eq!(std::fs::read(orca.0.join("orca-data.json")).unwrap(), before);
    let mut files: Vec<_> = walk(&orca.0);
    files.sort();
    assert_eq!(files.len(), 2);
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        if e.path().is_dir() {
            out.extend(walk(&e.path()));
        } else {
            out.push(e.path());
        }
    }
    out
}

#[test]
fn accept_keeps_only_listed_folders_that_exist() {
    let (orca, _work, alpha, beta) = fake_orca();
    let listed = scan_dirs(&[orca.0.clone()]);
    let outsider = temp("outsider");
    let wanted = vec![
        beta.to_string_lossy().to_string(),
        alpha.to_string_lossy().to_string(),
        alpha.to_string_lossy().to_uppercase(),
        outsider.0.to_string_lossy().to_string(),
        listed.projects[1].path.clone(),
    ];
    let got = accept(&wanted, &listed);
    let names: Vec<_> = got.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["Beta", "Alpha"]);
}
