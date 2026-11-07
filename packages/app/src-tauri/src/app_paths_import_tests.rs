//! The one-time copy of release 1.0.3's data (old folder and file names) into this app's own.
//! Everything runs in a temp folder: the real home, project and app data folders are never touched.

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("pw-import-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Temp(dir)
    }
    fn p(&self) -> &Path {
        &self.0
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn put(path: impl AsRef<Path>, text: &str) {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).unwrap()
}

#[test]
fn the_old_names_are_the_real_old_names_and_differ_from_the_new_ones() {
    assert_eq!(LEGACY_PROJECT_DIR_NAME, ".puppet-master");
    assert_eq!(LEGACY_HOME_DIR_NAME, ".puppet-master");
    assert_eq!(LEGACY_COMPANION_HOME_DIR_NAME, "PuppetMaster");
    assert_ne!(LEGACY_PROJECT_DIR_NAME, PROJECT_DIR_NAME);
    assert_ne!(LEGACY_HOME_DIR_NAME, HOME_DIR_NAME);
    assert_ne!(LEGACY_COMPANION_HOME_DIR_NAME, COMPANION_HOME_DIR_NAME);
    for (old, new) in renamed_app_data_files() {
        assert_ne!(old, new);
    }
}

#[test]
fn a_project_folder_from_1_0_3_is_copied_once_and_left_alone() {
    let t = Temp::new();
    let project = t.p().join("shop");
    let old = project.join(LEGACY_PROJECT_DIR_NAME);
    put(old.join("memory.md"), "remember me");
    put(old.join("operations/op-1/record.json"), "{\"id\":\"op-1\"}");
    put(old.join("budgets.json"), "{\"cap\":5}");
    put(old.join("worktrees/h-1/file.txt"), "a copied worktree is a broken one");

    migrate_legacy_project_data(&project);

    let new = project.join(PROJECT_DIR_NAME);
    assert_eq!(read(new.join("memory.md")), "remember me");
    assert_eq!(read(new.join("operations/op-1/record.json")), "{\"id\":\"op-1\"}");
    assert_eq!(read(new.join("budgets.json")), "{\"cap\":5}");
    assert!(!new.join("worktrees").exists(), "worktrees are never copied");
    assert!(new.join(IMPORT_MARKER_NAME).is_file());
    // The old data is exactly as it was.
    assert_eq!(read(old.join("memory.md")), "remember me");
    assert_eq!(read(old.join("worktrees/h-1/file.txt")), "a copied worktree is a broken one");
    assert!(!old.join(IMPORT_MARKER_NAME).exists(), "nothing is written into the old folder");

    // Second run: nothing happens, even when the person changed or removed things since.
    put(old.join("later.md"), "written by the old app afterwards");
    fs::remove_file(new.join("budgets.json")).unwrap();
    migrate_legacy_project_data(&project);
    assert!(!new.join("later.md").exists());
    assert!(!new.join("budgets.json").exists(), "a deleted file does not come back");
}

#[test]
fn data_already_saved_under_the_new_names_is_never_overwritten() {
    // A 1.0.4 user: the new folder already exists with newer files; the old one has 1.0.3 data.
    let t = Temp::new();
    let project = t.p().join("shop");
    let (old, new) = (project.join(LEGACY_PROJECT_DIR_NAME), project.join(PROJECT_DIR_NAME));
    put(old.join("memory.md"), "old memory");
    put(old.join("budgets.json"), "old budgets");
    put(old.join("operations/op-1/record.json"), "old op 1");
    put(new.join("memory.md"), "NEW memory written during 1.0.4");
    put(new.join("operations/op-2/record.json"), "new op 2");

    migrate_legacy_project_data(&project);

    assert_eq!(read(new.join("memory.md")), "NEW memory written during 1.0.4", "existing files win");
    assert_eq!(read(new.join("budgets.json")), "old budgets", "missing files are filled in");
    assert_eq!(read(new.join("operations/op-1/record.json")), "old op 1");
    assert_eq!(read(new.join("operations/op-2/record.json")), "new op 2");
    assert_eq!(read(old.join("memory.md")), "old memory");
    assert!(new.join(IMPORT_MARKER_NAME).is_file());
}

#[test]
fn a_project_without_old_data_gets_no_copy_and_later_old_data_is_ignored() {
    let t = Temp::new();
    let project = t.p().join("fresh");
    fs::create_dir_all(&project).unwrap();
    migrate_legacy_project_data(&project);
    assert!(!project.join(PROJECT_DIR_NAME).exists(), "nothing is created when there is nothing to copy");

    // The app starts using the project; the next open closes the door.
    fs::create_dir_all(project.join(PROJECT_DIR_NAME)).unwrap();
    migrate_legacy_project_data(&project);
    assert!(project.join(PROJECT_DIR_NAME).join(IMPORT_MARKER_NAME).is_file());

    // The other product writes there later: it is not pulled in.
    put(project.join(LEGACY_PROJECT_DIR_NAME).join("memory.md"), "other product's notes");
    migrate_legacy_project_data(&project);
    assert!(!project.join(PROJECT_DIR_NAME).join("memory.md").exists());
}

#[test]
fn home_and_companion_folders_from_1_0_3_are_copied_once() {
    let t = Temp::new();
    let home = t.p();
    put(home.join(LEGACY_HOME_DIR_NAME).join("notes.json"), "{}");
    let companion = home.join(LEGACY_COMPANION_HOME_DIR_NAME).join("companions").join("pipi");
    put(companion.join("soul.md"), "I am Pipi");
    put(companion.join("memory/journal/2026-11-01.md"), "day one");
    put(companion.join(LEGACY_PROJECT_DIR_NAME).join("companion.json"), "{\"id\":\"pipi\"}");
    // A file elsewhere in the old product folder is not a companion and is not copied.
    put(home.join(LEGACY_COMPANION_HOME_DIR_NAME).join("other.txt"), "not a companion");

    migrate_legacy_home_data_in(home);

    assert_eq!(read(home.join(HOME_DIR_NAME).join("notes.json")), "{}");
    let moved = home.join(COMPANION_HOME_DIR_NAME).join("companions").join("pipi");
    assert_eq!(read(moved.join("soul.md")), "I am Pipi");
    assert_eq!(read(moved.join("memory/journal/2026-11-01.md")), "day one");
    assert!(!home.join(COMPANION_HOME_DIR_NAME).join("other.txt").exists());
    // The old data is untouched.
    assert_eq!(read(companion.join("soul.md")), "I am Pipi");
    assert!(home.join(LEGACY_HOME_DIR_NAME).join("notes.json").is_file());

    // Second run does nothing, and a changed new file is not overwritten.
    put(moved.join("soul.md"), "I am Pipi, edited");
    put(companion.join("soul.md"), "old app changed it");
    migrate_legacy_home_data_in(home);
    assert_eq!(read(moved.join("soul.md")), "I am Pipi, edited");
}

#[test]
fn a_companion_home_gets_its_marker_folder_copied_under_the_new_name() {
    let t = Temp::new();
    let home = t.p().join("pipi");
    put(home.join(LEGACY_PROJECT_DIR_NAME).join("companion.json"), "{\"id\":\"pipi\"}");
    copy_legacy_data_once(&home.join(LEGACY_PROJECT_DIR_NAME), &home.join(PROJECT_DIR_NAME));
    assert_eq!(read(home.join(PROJECT_DIR_NAME).join("companion.json")), "{\"id\":\"pipi\"}");
}

#[test]
fn renamed_files_in_the_app_data_folder_are_copied_once_and_the_port_is_not() {
    let t = Temp::new();
    let dir = t.p().join("com.potatodev.workspace");
    put(dir.join(LEGACY_PAIRING_FILE_NAME), "pairing 1.0.3");
    put(dir.join(LEGACY_TUNNEL_FILE_NAME), "tunnel 1.0.3");
    put(dir.join(LEGACY_PUSH_FILE_NAME), "push 1.0.3");
    put(dir.join(LEGACY_PUSH_VAPID_FILE_NAME), "vapid 1.0.3");
    // The old port file: its name is the old product's, and it must not be carried over.
    put(dir.join(LEGACY_PAIRING_FILE_NAME.replace("pairing.json", "bridge.port")), "127.0.0.1:17321\n");
    // Something a 1.0.4 start already wrote under the new name.
    put(dir.join(crate::tunnel_config::TUNNEL_FILE_NAME), "tunnel written by 1.0.4");

    import_files_once(&dir, &renamed_app_data_files());

    assert_eq!(read(dir.join(PAIRING_FILE_NAME)), "pairing 1.0.3");
    assert_eq!(read(dir.join(crate::push::SUBSCRIPTIONS_FILE_NAME)), "push 1.0.3");
    assert_eq!(read(dir.join(crate::push::VAPID_FILE_NAME)), "vapid 1.0.3");
    assert_eq!(read(dir.join(crate::tunnel_config::TUNNEL_FILE_NAME)), "tunnel written by 1.0.4", "not overwritten");
    assert!(!dir.join(BRIDGE_PORT_FILE_NAME).exists(), "a copied port would point at the old range");
    assert_eq!(read(dir.join(LEGACY_PAIRING_FILE_NAME)), "pairing 1.0.3", "the old file stays");
    assert!(dir.join(IMPORT_MARKER_NAME).is_file());

    fs::remove_file(dir.join(PAIRING_FILE_NAME)).unwrap();
    import_files_once(&dir, &renamed_app_data_files());
    assert!(!dir.join(PAIRING_FILE_NAME).exists(), "second run does nothing");
}

#[test]
fn a_failed_copy_leaves_no_marker_and_is_tried_again_without_overwriting() {
    let t = Temp::new();
    let project = t.p().join("shop");
    let (old, new) = (project.join(LEGACY_PROJECT_DIR_NAME), project.join(PROJECT_DIR_NAME));
    put(old.join("a.md"), "a");
    put(old.join("sub/b.md"), "b");
    // A file sits where the copy needs a folder: the copy cannot finish.
    put(new.join("sub"), "a file, not a folder");
    migrate_legacy_project_data(&project);
    assert!(!new.join(IMPORT_MARKER_NAME).exists());
    assert_eq!(read(new.join("sub")), "a file, not a folder", "existing data is never removed");
    assert_eq!(read(old.join("sub/b.md")), "b");

    fs::remove_file(new.join("sub")).unwrap();
    migrate_legacy_project_data(&project);
    assert_eq!(read(new.join("sub/b.md")), "b");
    assert_eq!(read(new.join("a.md")), "a");
    assert!(new.join(IMPORT_MARKER_NAME).is_file());
}
