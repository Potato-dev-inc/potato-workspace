//! The `adapter` overlay source: a reviewed script from the catalog (`acp::adapter_catalog`) run with the agent's own
//! Python (`acp::agent_python`).
//!
//! * Stored as `{source: "adapter", adapter_id, program, python, script, script_sha256, tested_version}`. Only the
//!   install path (`install_for_agent`, behind `acp_overlay_install`) writes it. `acp_overlay_set` refuses the
//!   `source` field, so no typed path can create this source.
//! * Rebuilt on every read (like the bridge): the Python is found again from the stored program path, and the script
//!   must still match the catalog. A moved or removed agent drops out by itself.
//! * The spawn spec is built by the app: `<python> {adapters}/pm-adapter-<id>/<script>`, so `allow_interpreter` applies
//!   (no user command can name the interpreter). The file's SHA-256 is pinned (`pins` with an empty package) and
//!   checked before every start by `acp::pin::enforce`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::adapter_catalog::{self, AdapterEntry};
use super::adapter_keys;
use super::agent_python;
use super::config::{plain_text, AdapterKey, AdapterPin, AgentConfig, HostEnv, PinPolicy, RealHost};
use super::overlay::{OverlayItem, OverlayStore};
use super::pin;

/// The stored `source: "adapter"` entry. Names and plain settings only: never a key value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AdapterOverlay {
    pub adapter_id: String,
    /// The agent's program file when installed (absolute). Its Python is found again on every read.
    pub program: String,
    /// The Python found when installed (informational; reads use a fresh search).
    pub python: String,
    /// The script inside the adapters folder, with `/`: `pm-adapter-<id>/<script>`.
    pub script: String,
    pub script_sha256: String,
    pub tested_version: String,
    /// Keys the person approved (variable names from the catalog's `env_keys`). Their values come from the store.
    pub approved_keys: Vec<String>,
    /// Plain setting values the person chose (variable -> value). Missing ones use the catalog default.
    pub settings: BTreeMap<String, String>,
}

/// What the person approved on install: the key names to pass on, and the plain settings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Approvals {
    pub keys: Vec<String>,
    pub settings: BTreeMap<String, String>,
}

/// A plain setting value: short, no control characters, no template braces, and not secret-looking text.
fn plain_setting(value: &str) -> bool {
    value.chars().count() <= 128
        && plain_text(value)
        && !value.contains(['{', '}'])
        && crate::redact::text_with(value, &crate::redact::RedactContext::default()).into_inner() == value
}

/// Every approved key must be one the catalog entry asks for; every setting must be one it declares, with a plain
/// value. Both kinds of name pass the denied-name rule. The error names the offending variable, never a value.
fn check_approvals(entry: &AdapterEntry, item: &AdapterOverlay) -> Result<(), String> {
    for name in &item.approved_keys {
        let asked = entry.meta.env_keys.iter().any(|k| k.env == *name);
        if !asked || crate::tui::declarative::validate::denied_env_name(name) {
            return Err(format!("NOT_AVAILABLE: approved key {name} is not one this adapter asks for"));
        }
    }
    for (name, value) in &item.settings {
        let declared = entry.meta.env_settings.iter().any(|s| s.env == *name);
        if !declared || crate::tui::declarative::validate::denied_env_name(name) {
            return Err(format!("NOT_AVAILABLE: setting {name} is not one this adapter reads"));
        }
        if !plain_setting(value) {
            return Err(format!("INVALID_ARGUMENT: the value of {name} is not a plain setting"));
        }
    }
    Ok(())
}

/// The config of a stored adapter entry, built from the catalog entry it names. `Err` when the entry no longer fits
/// the catalog, the agent's Python is gone, an approval names something the catalog does not, or the built command
/// fails the table checks. A refused entry is ignored on read.
pub fn config_with(entry: &AdapterEntry, id: &str, label: &str, item: &AdapterOverlay) -> Result<AgentConfig, String> {
    if item.adapter_id != entry.meta.id {
        return Err("INVALID_ARGUMENT: the adapter entry names another adapter".into());
    }
    if item.script != entry.installed_script() || !item.script_sha256.eq_ignore_ascii_case(&entry.meta.sha256) {
        return Err("NOT_AVAILABLE: the adapter no longer matches the reviewed one; install it again".into());
    }
    if adapter_catalog::program_stem(&item.program) != entry.meta.program {
        return Err("NOT_AVAILABLE: the stored program is not the one this adapter attaches to".into());
    }
    check_approvals(entry, item)?;
    let python = agent_python::find(Path::new(&item.program)).ok_or("NOT_AVAILABLE: the agent's Python was not found")?;
    let template = format!("{{adapters}}/{}", item.script);
    // Settings: the person's value, else the catalog default. Keys: only the approved ones, each with its slot.
    let env: BTreeMap<String, String> = entry
        .meta
        .env_settings
        .iter()
        .map(|s| (s.env.clone(), item.settings.get(&s.env).cloned().unwrap_or_else(|| s.default.clone())))
        .collect();
    let adapter_keys: Vec<AdapterKey> = entry
        .meta
        .env_keys
        .iter()
        .filter(|k| item.approved_keys.iter().any(|a| *a == k.env))
        .map(|k| AdapterKey { env: k.env.clone(), slot: adapter_keys::slot_of(entry, k) })
        .collect();
    let cfg = AgentConfig {
        command: python.to_string_lossy().into_owned(),
        args: vec![template.clone()],
        pins: vec![AdapterPin { package: format!("file:{}", entry.install_folder()), version: entry.meta.tested_version.clone(), entry: template, sha256: Some(entry.meta.sha256.to_ascii_lowercase()) }],
        pin_policy: PinPolicy::Enforce,
        env,
        adapter_keys,
        adapter_key_groups: entry.meta.key_groups.iter().map(|g| g.iter().filter(|n| item.approved_keys.iter().any(|a| a == *n)).cloned().collect()).collect(),
        ..AgentConfig::default()
    };
    // The paths come from the app; a secret-looking path is still refused, like every stored command.
    for text in std::iter::once(&cfg.command).chain(&cfg.args) {
        if crate::redact::text(text).into_inner() != *text {
            return Err("INVALID_ARGUMENT: adapter path looks like a secret; it is never stored".into());
        }
    }
    if let Some((code, path, message)) = crate::tui::declarative::validate::acp_table_errors(&cfg, true).into_iter().next() {
        return Err(format!("{code}: {path}: {message}"));
    }
    Ok(AgentConfig { id: id.to_string(), label: label.to_string(), ..cfg })
}

/// The config of a stored adapter entry for agent `id`, using the shipped catalog.
pub fn config(id: &str, label: &str, item: &AdapterOverlay) -> Result<AgentConfig, String> {
    let entry = adapter_catalog::load().into_iter().find(|e| e.meta.id == item.adapter_id).ok_or("NOT_AVAILABLE: no reviewed adapter has this id")?;
    let mut cfg = config_with(&entry, id, label, item)?;
    // A failed health check (`adapter_health`) lists the agent with its chat switched off and the plain reason. The
    // terminal lane is not affected; no check runs here (this is read on every view).
    if let Some(reason) = super::adapter_health::blocked_now(id, &item.adapter_id) {
        cfg.disabled = true;
        cfg.disabled_note = reason;
    }
    Ok(cfg)
}

/// Copies the reviewed script into `adapters/pm-adapter-<id>/`, checks the copy, and stores the entry with what the
/// person approved. `confirm` runs the agent's Python once (`agent_python::confirm_import`); tests pass their own.
pub fn install_adapter_in(
    store: &OverlayStore,
    id: &str,
    label: &str,
    program: &Path,
    entry: &AdapterEntry,
    adapters: &Path,
    approvals: &Approvals,
    confirm: impl FnOnce(&Path, &str) -> Result<(), String>,
) -> Result<AdapterOverlay, String> {
    let python = agent_python::find(program).ok_or("NOT_AVAILABLE: the agent's Python was not found")?;
    confirm(&python, &entry.meta.import_name).map_err(|e| format!("NOT_AVAILABLE: {e}"))?;
    let dir = adapters.join(entry.install_folder());
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create the adapter folder: {e}"))?;
    let target = dir.join(&entry.meta.script);
    std::fs::copy(entry.script_path(), &target).map_err(|e| format!("could not copy the adapter: {e}"))?;
    let copied = pin::sha256_hex(&target).map_err(|e| format!("could not read the adapter copy: {e}"))?;
    if !copied.eq_ignore_ascii_case(&entry.meta.sha256) {
        return Err("NOT_AVAILABLE: the adapter copy does not match the reviewed script".into());
    }
    let item = AdapterOverlay {
        adapter_id: entry.meta.id.clone(),
        program: program.to_string_lossy().into_owned(),
        python: python.to_string_lossy().into_owned(),
        script: entry.installed_script(),
        script_sha256: entry.meta.sha256.to_ascii_lowercase(),
        tested_version: entry.meta.tested_version.clone(),
        approved_keys: approvals.keys.iter().cloned().collect::<BTreeSet<String>>().into_iter().collect(),
        settings: approvals.settings.clone(),
    };
    // Check the config it would build before anything is written (this also refuses an approval the catalog lacks).
    config_with(entry, id, label, &item)?;
    store.put_item(id, &OverlayItem::Adapter(item.clone()))?;
    Ok(item)
}

/// Installs the reviewed adapter for the agent whose program is `program` (a file name, as the registry knows it),
/// with the keys and settings the person approved.
pub fn install_for_agent(store: &OverlayStore, id: &str, label: &str, program: &str, approvals: &Approvals) -> Result<AdapterOverlay, String> {
    let host = RealHost;
    install_for_agent_in(store, id, label, program, approvals, &adapter_catalog::for_program(program), &host, agent_python::confirm_import)
}

/// `install_for_agent` with the catalog entries, the host and the import check given (tests pass fakes).
#[allow(clippy::too_many_arguments)]
pub fn install_for_agent_in(
    store: &OverlayStore,
    id: &str,
    label: &str,
    program: &str,
    approvals: &Approvals,
    entries: &[AdapterEntry],
    host: &dyn HostEnv,
    confirm_import: impl FnOnce(&Path, &str) -> Result<(), String>,
) -> Result<AdapterOverlay, String> {
    let entry = entries.first().ok_or("NOT_AVAILABLE: no reviewed adapter is shipped for this agent")?;
    // `which` adds the extension itself: look for the bare name (a registry name may carry `.exe`).
    let located = host.which(&adapter_catalog::program_stem(program)).ok_or("NOT_AVAILABLE: the program is not on this PC")?;
    install_adapter_in(store, id, label, &located, entry, &host.adapters_dir(), approvals, confirm_import)
}

/// The adapter as an option for "Add chat": available when the agent's Python is found, else unavailable with a plain
/// reason. `None` when no reviewed adapter is shipped for this program.
pub fn adapter_option_from(program: &str, entry: Option<&AdapterEntry>, python: Option<PathBuf>) -> Option<Value> {
    let entry = entry?;
    let summary = format!("Puppet Master runs a reviewed adapter script with the Python that {program} was installed with. Tested with {program} {}.", entry.meta.tested_version);
    // The names the person approves on install. Names, labels and plain defaults only.
    let keys: Vec<Value> = entry.meta.env_keys.iter().map(|k| json!({ "env": k.env, "label": k.label })).collect();
    let settings: Vec<Value> = entry
        .meta
        .env_settings
        .iter()
        .map(|s| {
            let options: Vec<Value> = s.options.iter().map(|o| json!({ "value": o.value, "label": o.label, "needs_key": o.needs_key })).collect();
            json!({ "env": s.env, "label": s.label, "default": s.default, "options": options })
        })
        .collect();
    let mut option = json!({
        "kind": "adapter",
        "label": "Reviewed adapter",
        "summary": summary,
        "adapter": { "id": entry.meta.id, "tested_version": entry.meta.tested_version },
        "env_keys": keys,
        "env_settings": settings,
        "key_groups": entry.meta.key_groups,
    });
    match python {
        Some(_) => option["available"] = json!(true),
        None => {
            option["available"] = json!(false);
            option["reason"] = json!(format!("Could not find the Python that {program} was installed with, so the adapter cannot run."));
        }
    }
    Some(option)
}

/// The version number the installed program prints for `--version` (one short run, the wizard's fixed probe). `None`
/// when the program is not found or prints no version: the screen then says nothing about versions.
pub fn installed_version(program: &str) -> Option<String> {
    let path = RealHost.which(&adapter_catalog::program_stem(program))?;
    version_at(&path)
}

/// The version number the program file at `path` prints for `--version`.
pub fn version_at(path: &Path) -> Option<String> {
    static NUMBER: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| regex::Regex::new(r"\d+(\.\d+)+").expect("version pattern"));
    let command = crate::tui::VersionCommand { program: path.to_string_lossy().into_owned(), args: vec!["--version".into()] };
    match crate::agent_health::run_version(&command, crate::agent_health::VERSION_TIMEOUT) {
        crate::agent_health::VersionOutcome::Version(line) => NUMBER.find(&line).map(|m| m.as_str().to_string()),
        _ => None,
    }
}

/// The adapter option for `program` on this PC (the catalog and the program's Python are read here), with the
/// installed version when it can be read (`installed_version`).
pub fn adapter_option(program: &str) -> Option<Value> {
    adapter_option_in(program, adapter_catalog::for_program(program).into_iter().next(), &RealHost, &version_at, &super::adapter_health::option_health)
}

/// `adapter_option` with the catalog entry, the host, the version reader and the health lookup given (tests pass fakes).
/// `program` may carry a folder or `.exe`: only its bare name is looked up and shown.
pub fn adapter_option_in(
    program: &str,
    entry: Option<AdapterEntry>,
    host: &dyn HostEnv,
    read_version: &dyn Fn(&Path) -> Option<String>,
    health: &dyn Fn(&str, &str, Option<&str>) -> (Option<String>, Option<String>),
) -> Option<Value> {
    let name = adapter_catalog::program_stem(program);
    let located = entry.as_ref().and_then(|_| host.which(&name));
    let python = located.as_deref().and_then(agent_python::find);
    let mut option = adapter_option_from(&name, entry.as_ref(), python)?;
    let installed = located.as_deref().and_then(read_version);
    option["installed_version"] = json!(installed);
    // The last health check's verdict for this adapter: a failed one makes the option unavailable with its reason; a
    // pass on another version adds a note. Read from the saved record only.
    if let Some(entry) = entry.as_ref() {
        let (blocked, note) = health(&entry.meta.id, &entry.meta.tested_version, installed.as_deref());
        if let Some(reason) = blocked {
            option["available"] = json!(false);
            option["reason"] = json!(reason);
        }
        if let Some(note) = note {
            option["note"] = json!(note);
        }
    }
    Some(option)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::overlay::{build_config, OverlayEntry};
    use serde_json::json;
    use std::ffi::OsString;

    struct TestHost(PathBuf);
    impl HostEnv for TestHost {
        fn var(&self, _: &str) -> Option<OsString> {
            None
        }
        fn which(&self, _: &str) -> Option<PathBuf> {
            None
        }
        fn adapters_dir(&self) -> PathBuf {
            self.0.join("adapters")
        }
        fn homes_dir(&self) -> PathBuf {
            self.0.join("homes")
        }
    }

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("pm-adapter-ovl-{}", uuid::Uuid::new_v4()))
    }

    /// A catalog entry for a made-up agent, written into `root/fakeagent/`.
    fn catalog(root: &Path) -> AdapterEntry {
        let dir = root.join("fakeagent");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fake_adapter.py"), "print('adapter')\n").unwrap();
        let sha = pin::sha256_hex(&dir.join("fake_adapter.py")).unwrap();
        let toml = format!(
            "id = \"fakeagent\"\nlabel = \"Fake agent\"\nprogram = \"fakeagent\"\nruntime = \"python\"\nscript = \"fake_adapter.py\"\nsha256 = \"{sha}\"\ntested_version = \"1.0.0\"\nimport_name = \"fakeagent\"\n"
        );
        std::fs::write(dir.join("adapter.toml"), toml).unwrap();
        adapter_catalog::load_entry(&dir).unwrap()
    }

    /// An agent whose launcher `.exe` names a Python in another folder by shebang: `root/bin/fakeagent.exe`.
    fn program_with_shebang(root: &Path) -> (PathBuf, PathBuf) {
        let python = root.join("py home").join("python.exe");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, b"not really python").unwrap();
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let program = bin.join("fakeagent.exe");
        let mut bytes = b"MZ\x90\x00 binary part".to_vec();
        bytes.extend_from_slice(format!("\r\n#!\"{}\"\r\nPK zip part", python.display()).as_bytes());
        std::fs::write(&program, bytes).unwrap();
        (program, python)
    }

    fn installed(root: &Path, entry: &AdapterEntry, program: &Path) -> (OverlayStore, PathBuf, AdapterOverlay) {
        std::fs::create_dir_all(root).unwrap();
        let store = OverlayStore::at(root.join("acp_overlay.json"));
        let adapters = root.join("adapters");
        let item = install_adapter_in(&store, "fakeagent", "Fake agent", program, entry, &adapters, &Approvals::default(), |_, _| Ok(())).unwrap();
        (store, adapters, item)
    }

    #[test]
    fn install_round_trip_builds_a_pinned_python_command() {
        let root = temp();
        let entry = catalog(&root.join("catalog"));
        let (program, python) = program_with_shebang(&root);
        let (store, adapters, item) = installed(&root, &entry, &program);
        assert_eq!(PathBuf::from(&item.python), python);
        let stored = store.stored_item("fakeagent").unwrap();
        assert_eq!(stored, OverlayItem::Adapter(item.clone()));
        assert_eq!(stored.source(), "adapter");
        let text = std::fs::read_to_string(root.join("acp_overlay.json")).unwrap();
        assert!(text.contains("\"source\": \"adapter\""), "{text}");
        let OverlayItem::Adapter(read) = stored else { panic!("adapter item") };
        let cfg = config_with(&entry, "fakeagent", "Fake agent", &read).unwrap();
        assert_eq!(PathBuf::from(&cfg.command), python);
        assert_eq!(cfg.args, vec!["{adapters}/pm-adapter-fakeagent/fake_adapter.py".to_string()]);
        assert_eq!(cfg.pin_policy, PinPolicy::Enforce);
        assert_eq!(cfg.pins[0].sha256.as_deref(), Some(entry.meta.sha256.as_str()));
        assert!(adapters.join("pm-adapter-fakeagent").join("fake_adapter.py").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_changed_script_fails_the_pin_before_start() {
        let root = temp();
        let entry = catalog(&root.join("catalog"));
        let (program, _) = program_with_shebang(&root);
        let (store, adapters, _) = installed(&root, &entry, &program);
        let OverlayItem::Adapter(read) = store.stored_item("fakeagent").unwrap() else { panic!("adapter item") };
        let cfg = config_with(&entry, "fakeagent", "Fake agent", &read).unwrap();
        let host = TestHost(root.clone());
        assert!(pin::enforce(&cfg, &host).is_ok());
        std::fs::write(adapters.join("pm-adapter-fakeagent").join("fake_adapter.py"), "print('edited')\n").unwrap();
        let err = pin::enforce(&cfg, &host).unwrap_err();
        assert!(err.to_string().contains("changed after it was pinned"), "{err}");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_tampered_entry_or_a_missing_python_is_refused_not_built() {
        let root = temp();
        let entry = catalog(&root.join("catalog"));
        let (program, python) = program_with_shebang(&root);
        let (_, _, item) = installed(&root, &entry, &program);
        let mut bad_sha = item.clone();
        bad_sha.script_sha256 = "00".repeat(32);
        assert!(config_with(&entry, "fakeagent", "F", &bad_sha).is_err());
        let mut other = item.clone();
        other.script = "pm-adapter-fakeagent/../../evil.py".into();
        assert!(config_with(&entry, "fakeagent", "F", &other).is_err());
        std::fs::remove_file(&python).unwrap();
        assert!(config_with(&entry, "fakeagent", "F", &item).unwrap_err().contains("Python"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn typed_commands_cannot_name_an_interpreter_or_the_adapter_source() {
        let typed = OverlayEntry { command: "python".into(), args: vec!["x.py".into()], ..OverlayEntry::default() };
        assert!(build_config("fakeagent", "F", &typed).unwrap_err().contains("AGENT_DEF_SHELL_INTERPRETER"));
        assert!(OverlayEntry::from_json(&json!({"source": "adapter", "command": "x"})).is_err(), "the source field is never typed");
        assert!(OverlayEntry::from_json(&json!({"command": "x", "adapter_id": "fakeagent"})).is_err());
    }

    #[test]
    fn the_option_is_available_with_a_python_and_unavailable_without() {
        let root = temp();
        let entry = catalog(&root.join("catalog"));
        let found = adapter_option_from("fakeagent.exe", Some(&entry), Some(PathBuf::from("C:/x/python.exe"))).unwrap();
        assert_eq!((found["kind"].clone(), found["available"].clone()), (json!("adapter"), json!(true)));
        assert_eq!(found["adapter"]["tested_version"], "1.0.0");
        let missing = adapter_option_from("fakeagent", Some(&entry), None).unwrap();
        assert_eq!(missing["available"], false);
        assert!(missing["reason"].as_str().unwrap().contains("Could not find the Python"));
        assert!(adapter_option_from("fakeagent", None, None).is_none(), "no reviewed adapter: no option");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn every_shipped_catalog_entry_passes_its_checks() {
        let root = adapter_catalog::catalog_root().expect("the catalog folder ships with the app");
        let (good, bad) = adapter_catalog::load_dir(&root);
        assert!(bad.is_empty(), "{bad:?}");
        assert!(!good.is_empty());
        for entry in good {
            assert_eq!(entry.meta.runtime, "python");
            assert!(entry.script_path().is_file());
        }
    }
}
