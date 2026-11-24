//! Adapter health (`acp::adapter_health`) with fakes only: the two checks are closures, the adapter is a fake entry
//! written to a temp folder, and no agent or network is used.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::adapter_catalog::{self, AdapterEntry};
use super::adapter_health::{blocked, check_at_start, check_on_change, note, run_checks, Checks, HealthStore, Record};
use super::adapter_overlay::AdapterOverlay;
use super::pin;
use crate::tui::declarative::wizard::acp_check::InitCheck;

struct Fixture {
    root: PathBuf,
    entry: AdapterEntry,
    item: AdapterOverlay,
    adapters: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pm-adapter-health-{}", uuid::Uuid::new_v4()));
        let dir = root.join("catalog").join("fakeagent");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fake_adapter.py"), "print('adapter')\n").unwrap();
        let sha = pin::sha256_hex(&dir.join("fake_adapter.py")).unwrap();
        let toml = format!(
            "id = \"fakeagent\"\nlabel = \"Fake agent\"\nprogram = \"fakeagent\"\nruntime = \"python\"\nscript = \"fake_adapter.py\"\nsha256 = \"{sha}\"\ntested_version = \"1.0.0\"\nimport_name = \"fakeagent\"\n"
        );
        std::fs::write(dir.join("adapter.toml"), toml).unwrap();
        let entry = adapter_catalog::load_entry(&dir).unwrap();
        // The agent's program with its Python beside it (the first place `agent_python::find` looks).
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("python.exe"), b"fake python").unwrap();
        std::fs::write(bin.join("fakeagent.exe"), b"fake program").unwrap();
        let item = AdapterOverlay {
            adapter_id: "fakeagent".into(),
            program: bin.join("fakeagent.exe").to_string_lossy().into_owned(),
            script: entry.installed_script(),
            script_sha256: sha,
            tested_version: "1.0.0".into(),
            ..AdapterOverlay::default()
        };
        Self { adapters: root.join("adapters"), root, entry, item }
    }

    fn store(&self) -> HealthStore {
        HealthStore::at(self.root.join("adapter_health.json"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn pass(_: &Path, _: &[String], _: Duration) -> InitCheck {
    InitCheck { ok: true, protocol_version: Some(1), ..InitCheck::default() }
}

fn no_answer(_: &Path, _: &[String], _: Duration) -> InitCheck {
    InitCheck { ok: false, reason: Some("no reply".into()), ..InitCheck::default() }
}

#[test]
fn a_version_change_with_a_pass_on_an_untested_version_keeps_chat_on_with_a_note() {
    let f = Fixture::new();
    let import = |_: &Path, _: &str| -> Result<(), String> { Ok(()) };
    let checks = Checks { import: &import, handshake: &pass };
    let record = check_on_change(&f.store(), "fakeagent", &f.entry, &f.item, "fakeagent 0.91.0", &f.adapters, &checks, 5);
    assert!(record.ok, "{record:?}");
    assert_eq!(record.agent_version, "0.91.0");
    let saved = f.store().get("fakeagent");
    assert_eq!(saved.as_ref(), Some(&record), "the record is saved per adapter id");
    assert_eq!(blocked(saved.as_ref(), Some("0.91.0")), None, "a pass never blocks");
    assert_eq!(note(saved.as_ref(), Some("0.91.0"), "1.0.0").as_deref(), Some("Not tested on version 0.91.0"));
}

#[test]
fn a_failed_import_blocks_with_a_plain_reason_and_skips_the_handshake() {
    let f = Fixture::new();
    let handshakes = Cell::new(0u32);
    let counting = |p: &Path, a: &[String], t: Duration| {
        handshakes.set(handshakes.get() + 1);
        pass(p, a, t)
    };
    let import = |_: &Path, _: &str| -> Result<(), String> { Err("the agent's Python cannot import fakeagent".to_string()) };
    let checks = Checks { import: &import, handshake: &counting };
    let record = check_on_change(&f.store(), "fakeagent", &f.entry, &f.item, "0.90.0", &f.adapters, &checks, 5);
    assert!(!record.ok);
    assert_eq!(handshakes.get(), 0, "a failed import stops before the handshake");
    let reason = record.reason.clone().unwrap();
    assert_eq!(
        reason,
        "Fake agent updated to 0.90.0 and its chat adapter no longer starts (its Python can no longer load the agent's code). The terminal still works."
    );
    assert_eq!(blocked(Some(&record), Some("0.90.0")).as_deref(), Some(reason.as_str()));
}

#[test]
fn a_failed_handshake_blocks_with_a_plain_reason() {
    let f = Fixture::new();
    let import = |_: &Path, _: &str| -> Result<(), String> { Ok(()) };
    let checks = Checks { import: &import, handshake: &no_answer };
    let record = check_on_change(&f.store(), "fakeagent", &f.entry, &f.item, "0.90.0", &f.adapters, &checks, 5);
    assert!(!record.ok);
    let reason = record.reason.clone().unwrap();
    assert!(reason.contains("did not answer the start-up check"), "{reason}");
    assert!(reason.ends_with("The terminal still works."), "{reason}");
    assert!(blocked(Some(&record), Some("0.90.0")).is_some());
}

#[test]
fn the_same_version_does_not_run_the_check_again() {
    let f = Fixture::new();
    let runs = Cell::new(0u32);
    let import = |_: &Path, _: &str| -> Result<(), String> {
        runs.set(runs.get() + 1);
        Ok(())
    };
    let checks = Checks { import: &import, handshake: &pass };
    let store = f.store();
    check_on_change(&store, "fakeagent", &f.entry, &f.item, "0.91.0", &f.adapters, &checks, 5);
    check_on_change(&store, "fakeagent", &f.entry, &f.item, "0.91.0", &f.adapters, &checks, 6);
    let at_start = check_at_start(&store, "fakeagent", &f.entry, &f.item, Some("0.91.0"), &f.adapters, &checks, 7);
    assert_eq!(at_start.map(|r| r.checked_ms), Some(5), "the stored record is used as it is");
    assert_eq!(runs.get(), 1, "one check for one version");
}

#[test]
fn a_fixed_agent_recovers_on_the_next_check() {
    let f = Fixture::new();
    let store = f.store();
    let broken = Checks { import: &|_: &Path, _: &str| -> Result<(), String> { Err("broken".to_string()) }, handshake: &pass };
    let failed = check_on_change(&store, "fakeagent", &f.entry, &f.item, "0.90.0", &f.adapters, &broken, 5);
    assert!(blocked(Some(&failed), Some("0.90.0")).is_some());
    let fixed = Checks { import: &|_: &Path, _: &str| -> Result<(), String> { Ok(()) }, handshake: &pass };
    let recovered = check_on_change(&store, "fakeagent", &f.entry, &f.item, "0.91.0", &f.adapters, &fixed, 9);
    assert!(recovered.ok);
    assert_eq!(blocked(store.get("fakeagent").as_ref(), Some("0.91.0")), None);
}

#[test]
fn at_the_start_the_tested_version_is_not_checked_and_an_untested_one_is() {
    let f = Fixture::new();
    let runs = Cell::new(0u32);
    let import = |_: &Path, _: &str| -> Result<(), String> {
        runs.set(runs.get() + 1);
        Ok(())
    };
    let checks = Checks { import: &import, handshake: &pass };
    let store = f.store();
    assert!(check_at_start(&store, "fakeagent", &f.entry, &f.item, Some("1.0.0"), &f.adapters, &checks, 1).is_none());
    assert!(check_at_start(&store, "fakeagent", &f.entry, &f.item, None, &f.adapters, &checks, 1).is_none(), "unknown version: nothing");
    assert_eq!(runs.get(), 0);
    let record = check_at_start(&store, "fakeagent", &f.entry, &f.item, Some("0.95.0"), &f.adapters, &checks, 2).unwrap();
    assert!(record.ok);
    assert_eq!(runs.get(), 1);
}

#[test]
fn a_failed_record_blocks_only_the_version_it_was_checked_on() {
    let failed = Record { agent_version: "0.90.0".into(), ok: false, reason: Some("why".into()), checked_ms: 1 };
    assert_eq!(blocked(Some(&failed), Some("0.90.0")).as_deref(), Some("why"));
    assert_eq!(blocked(Some(&failed), Some("0.92.0")), None, "a newer version is judged by its own check");
    assert_eq!(blocked(Some(&failed), None).as_deref(), Some("why"), "an unknown version keeps the saved verdict");
    assert_eq!(blocked(None, Some("0.90.0")), None);
}

#[test]
fn the_real_checks_run_on_a_script_that_is_not_there_and_fail_without_a_model_or_keys() {
    let f = Fixture::new();
    // The fake Python file is not a real interpreter: the import check fails, so no handshake and no network.
    let checks = super::adapter_health::real_checks();
    let record = run_checks(&f.entry, &f.item, "0.90.0", &f.adapters, &checks, 3, true);
    assert!(!record.ok);
    assert!(record.reason.unwrap().contains("updated to 0.90.0"));
}

#[test]
fn a_failure_once_then_a_pass_allows_the_chat_on_the_same_version() {
    let f = Fixture::new();
    let store = f.store();
    let broken = Checks { import: &|_: &Path, _: &str| -> Result<(), String> { Err("slow start".to_string()) }, handshake: &pass };
    let first = check_at_start(&store, "fakeagent", &f.entry, &f.item, Some("0.95.0"), &f.adapters, &broken, 1).unwrap();
    assert!(!first.ok);
    assert_eq!(first.reason.as_deref(), Some("Fake agent chat adapter did not start on version 0.95.0. The terminal still works."));
    assert!(blocked(store.get("fakeagent").as_ref(), Some("0.95.0")).is_some(), "the option shows the reason");

    // The next start on the same version tries again, and the pass is allowed.
    let fixed = Checks { import: &|_: &Path, _: &str| -> Result<(), String> { Ok(()) }, handshake: &pass };
    let second = check_at_start(&store, "fakeagent", &f.entry, &f.item, Some("0.95.0"), &f.adapters, &fixed, 2).unwrap();
    assert!(second.ok, "{second:?}");
    assert_eq!(blocked(store.get("fakeagent").as_ref(), Some("0.95.0")), None);

    // A later start on that passed version does not run the check again.
    let runs = Cell::new(0u32);
    let counting = Checks { import: &|_: &Path, _: &str| -> Result<(), String> { runs.set(runs.get() + 1); Err("x".into()) }, handshake: &pass };
    let third = check_at_start(&store, "fakeagent", &f.entry, &f.item, Some("0.95.0"), &f.adapters, &counting, 3).unwrap();
    assert!(third.ok);
    assert_eq!(runs.get(), 0, "a remembered pass is not re-checked");
}
