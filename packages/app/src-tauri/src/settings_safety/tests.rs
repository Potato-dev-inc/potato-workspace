use super::*;
use serde_json::json;
use std::time::{Duration, SystemTime};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-settings-safety-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_settings(path: &Path, marker: u64) {
    std::fs::write(path, json!({"schema_version": 1, "settings": {"away_minutes": marker}}).to_string()).unwrap();
}

fn age_backup(path: &Path, n: usize, age: Duration) {
    let file = std::fs::OpenOptions::new().write(true).open(backup_path(path, n)).unwrap();
    file.set_modified(SystemTime::now() - age).unwrap();
}

const TWO_HOURS: Duration = Duration::from_secs(2 * 3600);

#[test]
fn a_file_without_a_version_reads_as_version_zero_and_is_stamped_one_on_save() {
    let old = json!({"settings": {"theme": "dark"}});
    assert_eq!(schema_version_of(&old), 0);
    assert_eq!(version_to_write(&old), 1);
    let mut stamped = old.clone();
    stamp(&mut stamped);
    assert_eq!(stamped["schema_version"], 1);
    assert_eq!(stamped["settings"], old["settings"], "nothing else changes");
}

#[test]
fn a_file_from_a_newer_app_keeps_its_higher_number() {
    let mut newer = json!({"schema_version": 7, "settings": {}});
    stamp(&mut newer);
    assert_eq!(newer["schema_version"], 7);
}

#[test]
fn saving_through_the_patch_code_writes_the_version() {
    let dir = temp_dir("stamp");
    let path = dir.join("settings.json");
    let mut patch = serde_json::Map::new();
    patch.insert("away_minutes".into(), json!(9));
    crate::settings_patch::patch_file(&path, &patch).unwrap();
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(file["schema_version"], 1);
    assert_eq!(file["settings"]["away_minutes"], 9);
}

#[test]
fn health_tells_missing_good_and_damaged_apart() {
    let dir = temp_dir("health");
    let path = dir.join("settings.json");
    assert_eq!(health(&path), FileHealth::Missing);
    write_settings(&path, 1);
    assert_eq!(health(&path), FileHealth::Good);
    std::fs::write(&path, "{ not json").unwrap();
    assert_eq!(health(&path), FileHealth::Damaged);
    std::fs::write(&path, "").unwrap();
    assert_eq!(health(&path), FileHealth::Damaged);
    std::fs::write(&path, "[1,2]").unwrap();
    assert_eq!(health(&path), FileHealth::Damaged);
    std::fs::write(&path, r#"{"settings": 5}"#).unwrap();
    assert_eq!(health(&path), FileHealth::Damaged);
    std::fs::write(&path, "{}").unwrap();
    assert_eq!(health(&path), FileHealth::Good, "a file with no settings yet is fine");
}

#[test]
fn the_first_good_file_gets_backup_one() {
    let dir = temp_dir("first");
    let path = dir.join("settings.json");
    write_settings(&path, 1);
    assert!(rotate_backups(&path, SystemTime::now()).unwrap());
    assert!(backup_path(&path, 1).exists());
    assert!(!backup_path(&path, 2).exists());
}

#[test]
fn unchanged_content_makes_no_new_backup_even_after_an_hour() {
    let dir = temp_dir("same");
    let path = dir.join("settings.json");
    write_settings(&path, 1);
    rotate_backups(&path, SystemTime::now()).unwrap();
    age_backup(&path, 1, TWO_HOURS);
    assert!(!rotate_backups(&path, SystemTime::now()).unwrap());
    assert!(!backup_path(&path, 2).exists());
}

#[test]
fn changed_content_within_an_hour_makes_no_new_backup() {
    let dir = temp_dir("hour");
    let path = dir.join("settings.json");
    write_settings(&path, 1);
    rotate_backups(&path, SystemTime::now()).unwrap();
    write_settings(&path, 2);
    assert!(!rotate_backups(&path, SystemTime::now()).unwrap());
    assert!(!backup_path(&path, 2).exists());
}

#[test]
fn changed_content_after_an_hour_moves_the_older_copies_down_and_keeps_five() {
    let dir = temp_dir("rotate");
    let path = dir.join("settings.json");
    for marker in 1..=7u64 {
        write_settings(&path, marker);
        assert!(rotate_backups(&path, SystemTime::now()).unwrap(), "copy {marker}");
        age_backup(&path, 1, TWO_HOURS);
    }
    let marker_of = |n: usize| -> u64 {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(backup_path(&path, n)).unwrap()).unwrap();
        v["settings"]["away_minutes"].as_u64().unwrap()
    };
    assert_eq!((1..=5).map(marker_of).collect::<Vec<_>>(), vec![7, 6, 5, 4, 3], "newest first, the two oldest fell away");
    assert!(!backup_path(&path, 6).exists());
}

#[test]
fn a_damaged_file_is_never_copied_over_a_good_backup() {
    let dir = temp_dir("nodamage");
    let path = dir.join("settings.json");
    write_settings(&path, 1);
    rotate_backups(&path, SystemTime::now()).unwrap();
    age_backup(&path, 1, TWO_HOURS);
    std::fs::write(&path, "{ broken").unwrap();
    assert!(!rotate_backups(&path, SystemTime::now()).unwrap());
    assert_eq!(best_backup(&path).unwrap().0, 1);
}

#[test]
fn a_damaged_file_is_recovered_from_backup_one_and_kept_aside() {
    let dir = temp_dir("restore");
    let path = dir.join("settings.json");
    write_settings(&path, 42);
    rotate_backups(&path, SystemTime::now()).unwrap();
    std::fs::write(&path, "{ half a file").unwrap();
    assert_eq!(check_on_start(&path, SystemTime::now()), FileHealth::Damaged);
    assert_eq!(std::fs::read_to_string(sibling(&path, "damaged")).unwrap(), "{ half a file");
    assert!(status(&path).damaged && status(&path).has_backup);
    assert_eq!(restore_last_good(&path).unwrap(), 1);
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(file["settings"]["away_minutes"], 42);
    assert_eq!(health(&path), FileHealth::Good);
    // The flag is cleared by the command; here, clear it so other tests in this process see a clean state.
    DAMAGED_AT_START.store(false, Ordering::SeqCst);
}

#[test]
fn the_restore_skips_a_backup_that_is_itself_damaged() {
    let dir = temp_dir("skip");
    let path = dir.join("settings.json");
    write_settings(&path, 5);
    std::fs::write(backup_path(&path, 1), "garbage").unwrap();
    std::fs::copy(&path, backup_path(&path, 2)).unwrap();
    std::fs::write(&path, "").unwrap();
    assert_eq!(restore_last_good(&path).unwrap(), 2);
}

#[test]
fn with_no_backup_the_restore_says_so_and_changes_nothing() {
    let dir = temp_dir("none");
    let path = dir.join("settings.json");
    std::fs::write(&path, "{ broken").unwrap();
    let err = restore_last_good(&path).unwrap_err();
    assert!(err.contains("no saved copy"), "{err}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
}
