//! A shipped (bundled) definition goes through the same code the Settings screen and a launch use: listed, read by
//! its preview, gated at spawn and given a run-mode verdict. It has no file on disk, so none of those may read one.

use serde_json::json;

use crate::tui::declarative::approvals::Approvals;
use crate::tui::declarative::bundled::shipped;
use crate::tui::declarative::loader::{build, store_last, LoadInputs};

#[test]
fn a_shipped_entry_is_listed_read_gated_and_moded_without_a_file_on_disk() {
    let inputs = LoadInputs { bundled: shipped(), user_dir: None, code_ids: &[], projects: &[], extra: &[] };
    let built = build(&inputs, &Approvals::default());
    let profile = built.profiles.first().cloned().expect("a shipped entry builds a profile");
    let id = profile.id().to_string();
    let file = built.entries[0].path.to_string_lossy().into_owned();
    assert!(file.starts_with("bundled/"), "{file}");
    // list: the entries the Settings screen and the run-mode lookup read
    store_last(built.entries);
    // the listing the screen loads on open: no row carries a read error
    let listing = crate::tui::declarative::service::listing(&inputs, std::path::Path::new("no-such-approvals.json"));
    let rows = listing["definitions"].as_array().expect("definitions");
    assert!(!rows.is_empty() && !listing.to_string().contains("os error"), "{listing}");
    // the row's Check button (was "bundled/<name>: ... (os error 3)": it read the file from disk) and its folder button
    let checked = super::agents_check_file(file.clone(), None).expect("Check reads a shipped entry");
    assert_eq!(checked["status"], "no_fixtures", "a shipped entry has no fixtures folder of its own: {checked}");
    assert!(super::agents_create_fixtures_dir(file.clone(), None).unwrap_err().contains("bundled"), "no folder is made from a bundled path");
    assert!(!std::path::Path::new("bundled").exists(), "nothing was created in the working folder");
    // read: the Settings preview of the row (was "os error 3": it read bundled/<name> from disk)
    let preview = super::agents_definition_preview(file.clone()).expect("the preview reads a shipped entry");
    assert_eq!(preview["errors"], json!([]), "{preview}");
    // gate at launch: a shipped definition needs no approval, so the spawn gate passes
    if let Err(gate) = profile.spawn_gate("C:/some/project") {
        panic!("the spawn gate refused a shipped entry: {} {}", gate.code, gate.message);
    }
    // mode: a plain answer about One-task mode, never "not approved" (its file was unreadable before)
    let verdict = crate::agent_run_mode::verification_for(&id);
    assert_ne!(verdict.reason, Some("not_approved"), "{verdict:?}");
}
