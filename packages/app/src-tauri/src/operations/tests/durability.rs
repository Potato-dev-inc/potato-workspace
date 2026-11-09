//! Operations tests: corrupt-record handling, the idempotency index, resumable recovery.

use super::*;

fn operations_dir(project: &Path) -> PathBuf {
    root(&project.to_string_lossy()).unwrap()
}

fn index_file(project: &Path) -> PathBuf {
    operations_dir(project).join("_idempotency.index")
}

#[test]
fn corrupt_record_is_skipped_and_moved_and_lookup_still_works() {
    let _index = IsolatedIndex::new();
    let dir = temp();
    let project = dir.to_string_lossy().into_owned();
    let (good, _) = create_operation(request(&dir, "good-key")).unwrap();
    let bad_path = operations_dir(&dir).join("op-broken.json");
    fs::write(&bad_path, b"{ not json").unwrap();
    // Drop the index so the next lookup has to scan past the corrupt file.
    fs::remove_file(index_file(&dir)).unwrap();

    let found = find_by_idempotency_key(&project, "good-key").unwrap().unwrap();
    assert_eq!(found.operation_id, good.operation_id);
    assert!(!bad_path.exists(), "corrupt record leaves the live folder");
    let moved = operations_dir(&dir).join("_corrupt").join("op-broken.json");
    assert_eq!(fs::read(&moved).unwrap(), b"{ not json", "moved intact, never deleted");
    // Listing and creation keep working too.
    assert_eq!(list_operations(&project).unwrap().len(), 1);
    create_operation(request(&dir, "another-key")).unwrap();
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn idempotency_index_is_rebuilt_when_deleted_or_inconsistent() {
    let _index = IsolatedIndex::new();
    let dir = temp();
    let project = dir.to_string_lossy().into_owned();
    let (first, _) = create_operation(request(&dir, "key-one")).unwrap();
    let (second, _) = create_operation(request(&dir, "key-two")).unwrap();
    let written: std::collections::HashMap<String, String> =
        serde_json::from_slice(&fs::read(index_file(&dir)).unwrap()).unwrap();
    assert_eq!(written["key-one"], first.operation_id);
    assert_eq!(written["key-two"], second.operation_id);

    fs::remove_file(index_file(&dir)).unwrap();
    assert_eq!(
        find_by_idempotency_key(&project, "key-two").unwrap().unwrap().operation_id,
        second.operation_id
    );
    assert!(index_file(&dir).exists(), "rebuilt on disk");

    // Inconsistent: points at a record that does not exist.
    fs::write(index_file(&dir), br#"{"key-one":"ghost-id"}"#).unwrap();
    assert_eq!(
        find_by_idempotency_key(&project, "key-one").unwrap().unwrap().operation_id,
        first.operation_id
    );
    // Garbage index.
    fs::write(index_file(&dir), b"nope").unwrap();
    assert_eq!(
        find_by_idempotency_key(&project, "key-two").unwrap().unwrap().operation_id,
        second.operation_id
    );
    assert!(find_by_idempotency_key(&project, "never-used").unwrap().is_none());
    let _ = fs::remove_dir_all(dir);
}

fn previous_runtime(dir: &Path, id: &str, session: Option<&str>) {
    let path = path_for(&dir.to_string_lossy(), id).unwrap();
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["runtime_id"] = Value::String("previous-runtime".into());
    if let Some(session) = session {
        record["worker"]["provider_session_id"] = Value::String(session.into());
    }
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
}

#[test]
fn recovery_marks_session_bearing_operations_resumable_and_others_failed() {
    let _index = IsolatedIndex::new();
    let dir = temp();
    let project = dir.to_string_lossy().into_owned();
    let (with_session, _) = create_operation(request(&dir, "has-session")).unwrap();
    let (without, _) = create_operation(request(&dir, "no-session")).unwrap();
    previous_runtime(&dir, &with_session.operation_id, Some("codex-session-1"));
    previous_runtime(&dir, &without.operation_id, None);

    let recovered = recover_interrupted_operations(&project).unwrap();
    assert_eq!(recovered.len(), 2);
    let a = get_operation(&project, &with_session.operation_id).unwrap();
    let b = get_operation(&project, &without.operation_id).unwrap();
    for op in [&a, &b] {
        assert_eq!(op.status, OperationStatus::Failed);
        assert_eq!(op.error.as_ref().unwrap().code, "OPERATION_INTERRUPTED");
        assert_eq!(op.stage.as_deref(), Some("interrupted"));
    }
    assert!(a.worker.resumable);
    assert!(!b.worker.resumable);
    let _ = fs::remove_dir_all(dir);
}
