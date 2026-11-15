use super::model::*;
use super::store::Store;

fn fresh() -> Store {
    Store::at(std::env::temp_dir().join(format!("pm-routines-store-{}", uuid::Uuid::new_v4().simple())))
}

#[test]
fn nothing_saved_reads_as_empty() {
    assert_eq!(fresh().load(), State::default());
}

#[test]
fn what_is_saved_comes_back() {
    let store = fresh();
    let mut state = State::default();
    state.config.max_at_once = Some(3);
    state.next_seq = 7;
    store.save(&state).unwrap();
    assert_eq!(store.load(), state);
}

#[test]
fn a_broken_file_reads_as_empty_and_stays_on_disk() {
    let store = fresh();
    std::fs::create_dir_all(store.root()).unwrap();
    let path = store.root().join("state.json");
    std::fs::write(&path, "{ not json").unwrap();
    assert_eq!(store.load(), State::default());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
}

#[test]
fn a_file_from_a_newer_app_is_never_written_over() {
    let store = fresh();
    std::fs::create_dir_all(store.root()).unwrap();
    let path = store.root().join("state.json");
    let newer = format!(r#"{{"version":{},"workflows":[]}}"#, FILE_VERSION + 1);
    std::fs::write(&path, &newer).unwrap();
    assert_eq!(store.load(), State::default());
    assert!(store.save(&State::default()).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
}
