//! Approved adapter keys: what reaches the child, what never does, and what the disk, the status and the errors hold.
//! Fake agent only (`fakeagent`), in-memory credential store, no network, no OS key store.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::adapter_catalog::{self, AdapterEntry};
use super::adapter_keys;
use super::adapter_overlay::{self, Approvals, AdapterOverlay};
use super::config::{self, AgentConfig, HostEnv};
use super::fake_agent;
use super::overlay::{build_config, OverlayEntry, OverlayItem, OverlayStore};
use super::pin;
use crate::secrets::MemoryBackend;

const KEY: &str = "sk-test-fakeagent-0000000000";
const OPENAI: &str = "sk-test-openai-fakeagent-1111";
/// Looks like a real provider key to the redactor: used only where a refusal is expected.
const SECRET_LOOKING: &str = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// A host that answers the credential-store slots from a table and nothing else.
struct SlotHost {
    root: PathBuf,
    slots: HashMap<String, String>,
}

impl HostEnv for SlotHost {
    fn var(&self, _: &str) -> Option<OsString> {
        None
    }
    fn which(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn adapters_dir(&self) -> PathBuf {
        self.root.join("adapters")
    }
    fn homes_dir(&self) -> PathBuf {
        self.root.join("homes")
    }
    fn secret_value(&self, slot: &str) -> Option<String> {
        self.slots.get(slot).cloned()
    }
}

fn temp() -> PathBuf {
    std::env::temp_dir().join(format!("pm-adapter-keys-{}", uuid::Uuid::new_v4()))
}

/// A fake agent's catalog entry: one generic key, one key in a Keys-settings slot, one plain setting.
fn catalog(root: &Path) -> AdapterEntry {
    let dir = root.join("fakeagent");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("fake_adapter.py"), "print('adapter')\n").unwrap();
    let sha = pin::sha256_hex(&dir.join("fake_adapter.py")).unwrap();
    let toml = format!(
        "id = \"fakeagent\"\nlabel = \"Fake agent\"\nprogram = \"fakeagent\"\nruntime = \"python\"\nscript = \"fake_adapter.py\"\nsha256 = \"{sha}\"\ntested_version = \"1.0.0\"\nimport_name = \"fakeagent\"\n\
         env_keys = [ {{ env = \"FAKEAGENT_TOKEN\", label = \"Token\" }}, {{ env = \"OPENAI_API_KEY\", label = \"OpenAI\", slot = \"openai_api_key\" }} ]\n\
         env_settings = [ {{ env = \"FAKEAGENT_MODEL\", label = \"Model\", default = \"fake/model-small\" }} ]\n"
    );
    std::fs::write(dir.join("adapter.toml"), toml).unwrap();
    adapter_catalog::load_entry(&dir).unwrap()
}

/// An agent whose launcher names a Python in another folder by shebang (the same shape the overlay tests use).
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

/// Installs the fake adapter with `approvals` and returns the store, the stored item and the built config.
fn installed(root: &Path, entry: &AdapterEntry, approvals: &Approvals) -> (OverlayStore, AdapterOverlay, AgentConfig) {
    std::fs::create_dir_all(root).unwrap();
    let (program, _) = program_with_shebang(root);
    let store = OverlayStore::at(root.join("acp_overlay.json"));
    let item = adapter_overlay::install_adapter_in(&store, "fakeagent", "Fake agent", &program, entry, &root.join("adapters"), approvals, |_, _| Ok(())).unwrap();
    let cfg = adapter_overlay::config_with(entry, "fakeagent", "Fake agent", &item).unwrap();
    (store, item, cfg)
}

fn approve(keys: &[&str]) -> Approvals {
    Approvals { keys: keys.iter().map(|k| k.to_string()).collect(), ..Approvals::default() }
}

fn slots(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn env_value(spec: &super::conn::SpawnSpec, name: &str) -> Option<String> {
    spec.env.iter().find(|(n, _)| n.to_string_lossy() == name).map(|(_, v)| v.to_string_lossy().into_owned())
}

#[test]
fn an_approved_key_reaches_the_child_and_an_unapproved_one_does_not() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    let (_, _, cfg) = installed(&root, &entry, &approve(&["FAKEAGENT_TOKEN"]));
    let host = SlotHost { root: root.clone(), slots: slots(&[("adapter_fakeagent_fakeagent_token", KEY), ("openai_api_key", OPENAI)]) };
    let spec = config::resolve_spawn(&cfg, &host, &root).unwrap();
    assert_eq!(env_value(&spec, "FAKEAGENT_TOKEN").as_deref(), Some(KEY), "approved key is passed");
    assert!(env_value(&spec, "OPENAI_API_KEY").is_none(), "a key that was not approved is never passed, even when saved");
    assert_eq!(env_value(&spec, "FAKEAGENT_MODEL").as_deref(), Some("fake/model-small"), "the catalog default is passed");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_key_in_keys_settings_is_passed_only_when_approved() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    let host = SlotHost { root: root.clone(), slots: slots(&[("adapter_fakeagent_fakeagent_token", KEY), ("openai_api_key", OPENAI)]) };
    let (_, _, cfg) = installed(&root, &entry, &approve(&["OPENAI_API_KEY"]));
    let spec = config::resolve_spawn(&cfg, &host, &root).unwrap();
    assert_eq!(env_value(&spec, "OPENAI_API_KEY").as_deref(), Some(OPENAI));
    assert!(env_value(&spec, "FAKEAGENT_TOKEN").is_none());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn other_agents_keys_and_other_sources_get_nothing_new() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    // Every slot holds a value, including another adapter's slot and the provider keys.
    let host = SlotHost {
        root: root.clone(),
        slots: slots(&[("adapter_otheragent_otheragent_token", "sk-test-other-2222222222"), ("anthropic_api_key", "sk-test-anthropic-3333"), ("openai_api_key", OPENAI), ("adapter_fakeagent_fakeagent_token", KEY)]),
    };
    let (_, _, cfg) = installed(&root, &entry, &approve(&["FAKEAGENT_TOKEN"]));
    let spec = config::resolve_spawn(&cfg, &host, &root).unwrap();
    assert!(env_value(&spec, "ANTHROPIC_API_KEY").is_none());
    assert!(env_value(&spec, "OTHERAGENT_TOKEN").is_none());
    assert!(env_value(&spec, "OPENAI_API_KEY").is_none());
    // A typed command (the overlay's command source) has no adapter keys, whatever the store holds.
    let typed = OverlayEntry { command: "fakeagent-acp".into(), args: vec!["--stdio".into()], ..OverlayEntry::default() };
    let typed_cfg = build_config("fakeagent", "Fake agent", &typed).unwrap();
    assert!(typed_cfg.adapter_keys.is_empty());
    let spec = config::resolve_spawn(&typed_cfg, &host, &root).unwrap();
    for name in ["FAKEAGENT_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] {
        assert!(env_value(&spec, name).is_none(), "{name} must not reach a typed command");
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_missing_approved_key_is_a_start_error_that_names_it_and_holds_no_value() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    let (_, _, cfg) = installed(&root, &entry, &approve(&["FAKEAGENT_TOKEN"]));
    let host = SlotHost { root: root.clone(), slots: HashMap::new() };
    let err = config::resolve_spawn(&cfg, &host, &root).unwrap_err().to_string();
    assert!(err.contains("FAKEAGENT_TOKEN"), "{err}");
    assert!(err.contains("add the key for this adapter"), "{err}");
    assert!(!err.contains(KEY));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn the_overlay_file_holds_names_and_settings_never_a_key_value() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    let mem = MemoryBackend::new();
    adapter_keys::set_in(&mem, &entry, "FAKEAGENT_TOKEN", KEY).unwrap();
    let mut approvals = approve(&["FAKEAGENT_TOKEN"]);
    approvals.settings.insert("FAKEAGENT_MODEL".into(), "fake/model-large".into());
    let (store, _, _) = installed(&root, &entry, &approvals);
    let text = std::fs::read_to_string(root.join("acp_overlay.json")).unwrap();
    assert!(text.contains("FAKEAGENT_TOKEN") && text.contains("fake/model-large"), "{text}");
    assert!(!text.contains(KEY), "no key value on disk");
    let OverlayItem::Adapter(read) = store.stored_item("fakeagent").unwrap() else { panic!("adapter item") };
    assert_eq!(read.approved_keys, vec!["FAKEAGENT_TOKEN".to_string()]);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn status_answers_names_and_a_yes_or_no_only() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    let mem = MemoryBackend::new();
    let before = adapter_keys::status_in(&mem, &entry).unwrap();
    assert!(before.iter().all(|k| !k.set));
    adapter_keys::set_in(&mem, &entry, "FAKEAGENT_TOKEN", KEY).unwrap();
    let status = adapter_keys::status_in(&mem, &entry).unwrap();
    let token = status.iter().find(|k| k.env == "FAKEAGENT_TOKEN").unwrap();
    assert!(token.set && token.label == "Token");
    let text = serde_json::to_string(&status).unwrap();
    assert!(!text.contains(KEY), "{text}");
    assert!(text.contains("\"set\":true") && text.contains("\"set\":false"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn set_refuses_a_name_the_adapter_does_not_ask_for_and_clear_keeps_shared_keys() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    let mem = MemoryBackend::new();
    assert!(adapter_keys::set_in(&mem, &entry, "PATH", KEY).unwrap_err().contains("does not ask for"));
    assert!(adapter_keys::set_in(&mem, &entry, "FAKEAGENT_TOKEN", "bad\nvalue").is_err());
    adapter_keys::set_in(&mem, &entry, "FAKEAGENT_TOKEN", KEY).unwrap();
    adapter_keys::clear_in(&mem, &entry, "FAKEAGENT_TOKEN").unwrap();
    assert!(!adapter_keys::status_in(&mem, &entry).unwrap()[0].set);
    // The shared Keys-settings key is cleared from Keys settings, never from here.
    assert!(adapter_keys::clear_in(&mem, &entry, "OPENAI_API_KEY").unwrap_err().contains("Keys settings"));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn tampered_names_and_values_are_refused_and_the_entry_is_ignored() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    let (store, item, _) = installed(&root, &entry, &approve(&["FAKEAGENT_TOKEN"]));
    let mut bad_key = item.clone();
    bad_key.approved_keys = vec!["NOT_IN_CATALOG".into()];
    assert!(adapter_overlay::config_with(&entry, "fakeagent", "F", &bad_key).unwrap_err().contains("NOT_IN_CATALOG"));
    let mut denied = item.clone();
    denied.approved_keys = vec!["PATH".into()];
    assert!(adapter_overlay::config_with(&entry, "fakeagent", "F", &denied).is_err());
    let mut undeclared = item.clone();
    undeclared.settings.insert("OPENAI_API_KEY".into(), "x".into());
    assert!(adapter_overlay::config_with(&entry, "fakeagent", "F", &undeclared).is_err());
    let mut secret_setting = item.clone();
    secret_setting.settings.insert("FAKEAGENT_MODEL".into(), SECRET_LOOKING.into());
    let err = adapter_overlay::config_with(&entry, "fakeagent", "F", &secret_setting).unwrap_err();
    assert!(!err.contains(SECRET_LOOKING), "{err}");
    let mut braces = item.clone();
    braces.settings.insert("FAKEAGENT_MODEL".into(), "{adapters}/x".into());
    assert!(adapter_overlay::config_with(&entry, "fakeagent", "F", &braces).is_err());
    // A hand-edited file with an unknown approved key: the entry is ignored on read.
    let text = std::fs::read_to_string(root.join("acp_overlay.json")).unwrap();
    std::fs::write(root.join("acp_overlay.json"), text.replace("FAKEAGENT_TOKEN", "NOT_IN_CATALOG")).unwrap();
    assert!(store.get_item("fakeagent").is_none(), "a tampered adapter entry is refused");
    // Install refuses an approval the catalog lacks.
    let (program, _) = program_with_shebang(&root.join("second"));
    let store2 = OverlayStore::at(root.join("second").join("acp_overlay.json"));
    let refused = adapter_overlay::install_adapter_in(&store2, "fakeagent", "F", &program, &entry, &root.join("second").join("adapters"), &approve(&["PATH"]), |_, _| Ok(()));
    assert!(refused.is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_secret_echoed_into_a_start_error_is_redacted() {
    let echoed = format!("could not start the adapter: child said {KEY} and stopped");
    crate::redact::known::register(KEY);
    let masked = crate::redact::text(&echoed).into_inner();
    crate::redact::known::clear_registered();
    assert!(!masked.contains(KEY), "{masked}");
}

#[test]
fn the_shipped_aider_entry_declares_its_keys_and_settings() {
    let entry = adapter_catalog::load().into_iter().find(|e| e.meta.id == "aider").expect("aider ships");
    let keys: Vec<&str> = entry.meta.env_keys.iter().map(|k| k.env.as_str()).collect();
    assert_eq!(keys, ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]);
    let settings: Vec<&str> = entry.meta.env_settings.iter().map(|s| s.env.as_str()).collect();
    assert_eq!(settings, ["AIDER_MODEL", "AIDER_MODEL_2"]);
    assert!(entry.meta.env_settings.iter().all(|s| !s.default.contains("key")));
}

#[test]
fn a_key_group_needs_one_saved_key_before_the_adapter_is_ready() {
    let root = temp();
    let mut entry = catalog(&root.join("catalog"));
    entry.meta.key_groups = vec![vec!["FAKEAGENT_TOKEN".into(), "OPENAI_API_KEY".into()]];
    let mem = MemoryBackend::new();
    let refused = adapter_keys::ready_in(&mem, &entry).unwrap_err();
    assert!(refused.starts_with("NOT_AVAILABLE:") && refused.contains("Token or OpenAI"), "{refused}");
    assert!(!refused.contains(KEY));
    adapter_keys::set_in(&mem, &entry, "OPENAI_API_KEY", OPENAI).unwrap();
    assert!(adapter_keys::ready_in(&mem, &entry).is_ok(), "one key of the group is enough");
    let status = adapter_keys::status_in(&mem, &entry).unwrap();
    assert!(status.iter().find(|k| k.env == "OPENAI_API_KEY").unwrap().shared, "a Keys-settings key is marked shared");
    assert!(!status.iter().find(|k| k.env == "FAKEAGENT_TOKEN").unwrap().shared);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_catalog_entry_with_a_group_naming_an_unasked_key_is_refused() {
    let root = temp();
    let dir = root.join("bad");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("fake_adapter.py"), "print('adapter')\n").unwrap();
    let sha = pin::sha256_hex(&dir.join("fake_adapter.py")).unwrap();
    let toml = format!(
        "id = \"bad\"\nlabel = \"Bad\"\nprogram = \"fakeagent\"\nruntime = \"python\"\nscript = \"fake_adapter.py\"\nsha256 = \"{sha}\"\ntested_version = \"1.0.0\"\nimport_name = \"fakeagent\"\nkey_groups = [[\"NOT_ASKED\"]]\n"
    );
    std::fs::write(dir.join("adapter.toml"), toml).unwrap();
    let err = adapter_catalog::load_entry(&dir).unwrap_err();
    assert!(err.contains("key group"), "{err}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn the_shipped_aider_needs_one_provider_key() {
    let entry = adapter_catalog::load().into_iter().find(|e| e.meta.id == "aider").expect("aider ships");
    assert_eq!(entry.meta.key_groups, vec![vec!["OPENROUTER_API_KEY".to_string(), "OPENAI_API_KEY".to_string()]]);
}

#[test]
fn the_shipped_aider_model_offers_public_choices_that_name_its_keys() {
    let entry = adapter_catalog::load().into_iter().find(|e| e.meta.id == "aider").expect("aider ships");
    let model = entry.meta.env_settings.iter().find(|s| s.env == "AIDER_MODEL").expect("the model setting");
    assert_eq!(model.default, "openrouter/deepseek/deepseek-chat");
    let values: Vec<&str> = model.options.iter().map(|o| o.value.as_str()).collect();
    assert_eq!(values, ["openrouter/deepseek/deepseek-chat", "openrouter/deepseek/deepseek-v4.1-flash-1017", "openai/gpt-4o-mini"]);
    let needs: Vec<Option<&str>> = model.options.iter().map(|o| o.needs_key.as_deref()).collect();
    assert_eq!(needs, [Some("OPENROUTER_API_KEY"), Some("OPENROUTER_API_KEY"), Some("OPENAI_API_KEY")]);
}

/// The catalog entry of `catalog`, with the two keys in one group: either one is enough.
fn grouped_catalog(root: &Path) -> AdapterEntry {
    let entry = catalog(root);
    let path = entry.dir.join("adapter.toml");
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, format!("{text}key_groups = [[\"FAKEAGENT_TOKEN\", \"OPENAI_API_KEY\"]]
")).unwrap();
    adapter_catalog::load_entry(&entry.dir).unwrap()
}

/// A saved adapter entry approved for both keys of a one-of group, with only one key saved: the start must go on.
/// Goes from the stored entry through the real config build, the real pin check, the real spawn and the real
/// initialize and session/new handshake (the test binary stands in for the Python child).
#[test]
fn a_saved_entry_with_one_key_of_a_one_of_group_starts_and_handshakes() {
    use std::sync::Arc;
    let root = temp();
    let entry = grouped_catalog(&root.join("catalog"));
    let (store, _, cfg) = installed(&root, &entry, &approve(&["FAKEAGENT_TOKEN", "OPENAI_API_KEY"]));
    // read back from the saved overlay file, as the app does on a start
    let Some(OverlayItem::Adapter(saved)) = store.stored_item("fakeagent") else { panic!("saved adapter entry") };
    let cfg_saved = adapter_overlay::config_with(&entry, "fakeagent", "Fake agent", &saved).unwrap();
    assert_eq!(cfg_saved.adapter_keys.len(), 2);
    assert_eq!(cfg_saved.adapter_key_groups, vec![vec!["FAKEAGENT_TOKEN".to_string(), "OPENAI_API_KEY".to_string()]]);
    let one = SlotHost { root: root.clone(), slots: slots(&[("openai_api_key", OPENAI)]) };
    let spec = config::resolve_spawn(&cfg_saved, &one, &root).expect("one saved key of the group is enough");
    assert_eq!(env_value(&spec, "OPENAI_API_KEY").as_deref(), Some(OPENAI));
    assert!(env_value(&spec, "FAKEAGENT_TOKEN").is_none(), "a key that is not saved is left out");
    assert!(pin::enforce(&cfg_saved, &one).is_ok(), "the copied script passes the pin");
    // no key of the group saved: refused, naming the variables, never a value
    let none = SlotHost { root: root.clone(), slots: slots(&[]) };
    let err = config::resolve_spawn(&cfg_saved, &none, &root).unwrap_err().to_string();
    assert!(err.contains("FAKEAGENT_TOKEN or OPENAI_API_KEY") && err.contains("not saved"), "{err}");
    // the real spawn and handshake: same keys and groups, the child is the test binary's fake agent
    let tmp = fake_agent::agent_config("", &root.join("store"));
    let live = AgentConfig { command: tmp.command, args: tmp.args, env: tmp.env, pins: Vec::new(), pin_policy: tmp.pin_policy, timeouts: tmp.timeouts, ..cfg };
    struct Passthrough(SlotHost);
    impl HostEnv for Passthrough {
        fn var(&self, name: &str) -> Option<OsString> {
            std::env::var_os(name)
        }
        fn which(&self, _: &str) -> Option<PathBuf> {
            None
        }
        fn adapters_dir(&self) -> PathBuf {
            self.0.adapters_dir()
        }
        fn homes_dir(&self) -> PathBuf {
            self.0.homes_dir()
        }
        fn secret_value(&self, slot: &str) -> Option<String> {
            self.0.secret_value(slot)
        }
    }
    let host: Arc<dyn HostEnv> = Arc::new(Passthrough(one));
    let session = super::session::AcpSession::new(Arc::new(live), host, super::session::SessionParams { key: format!("t-{}", uuid::Uuid::new_v4()), cwd: root.clone(), resume_session_id: None });
    let started = session.ensure_running();
    assert!(started.is_ok(), "{started:?}");
    assert!(session.caps().is_some() && session.snapshot().session_id.is_some(), "initialize and session/new completed");
    session.close();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_key_in_no_group_is_required_on_its_own() {
    let root = temp();
    let entry = catalog(&root.join("catalog"));
    let (_, _, cfg) = installed(&root, &entry, &approve(&["FAKEAGENT_TOKEN"]));
    let host = SlotHost { root: root.clone(), slots: slots(&[("openai_api_key", OPENAI)]) };
    let err = config::resolve_spawn(&cfg, &host, &root).unwrap_err().to_string();
    assert!(err.contains("FAKEAGENT_TOKEN") && err.contains("not saved"), "{err}");
    let _ = std::fs::remove_dir_all(root);
}

