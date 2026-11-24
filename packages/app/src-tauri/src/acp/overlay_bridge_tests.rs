//! The bridge source of the chat overlay (`overlay.rs`): it asks the app's own tool bridge, so it is tested here.

use pm_core::acp::overlay::*;
use serde_json::{json, Value};
use std::path::PathBuf;

fn temp() -> (OverlayStore, PathBuf) {
    let dir = std::env::temp_dir().join(format!("pm-acp-overlay-bridge-{}", uuid::Uuid::new_v4()));
    (OverlayStore::at(dir.join(FILE)), dir)
}

fn entry(command: &str, args: &[&str]) -> OverlayEntry {
    OverlayEntry { command: command.into(), args: args.iter().map(|a| a.to_string()).collect(), ..OverlayEntry::default() }
}

#[test]
fn the_bridge_source_builds_the_app_exe_as_the_adapter_and_is_ignored_without_headless() {
    crate::engine_hooks::install();
    let (store, dir) = temp();
    std::fs::create_dir_all(&dir).unwrap();
    let headless = crate::tui::registered_agent_ids().into_iter().find(|id| crate::acp::bridge::available_for(id).is_ok()).expect("an agent with a headless mode");
    let none = crate::tui::registered_agent_ids().into_iter().find(|id| crate::acp::bridge::available_for(id).is_err());
    let mut agents = serde_json::Map::new();
    agents.insert(headless.clone(), json!({"source": "bridge", "future": 1}));
    if let Some(none) = &none {
        agents.insert(none.clone(), json!({"source": "bridge"}));
    }
    agents.insert("ok".into(), json!({"command": "adapter"}));
    std::fs::write(dir.join(FILE), serde_json::to_string(&json!({"version": 1, "agents": agents})).unwrap()).unwrap();
    let item = store.get_item(&headless).expect("bridge entry usable");
    assert_eq!(item.source(), "bridge");
    let cfg = build_item_config(&headless, "H", &item).unwrap();
    assert_eq!(std::path::PathBuf::from(&cfg.command), std::env::current_exe().unwrap());
    assert_eq!(cfg.args, vec!["acp-bridge".to_string(), "--agent".to_string(), headless.clone()]);
    assert!(cfg.env_allow.is_empty() && cfg.resume_command.is_empty() && cfg.pins.is_empty());
    assert_eq!(cfg.pin_policy, crate::acp::config::PinPolicy::Off);
    assert!(store.get(&headless).is_none(), "get() is the command entry only");
    assert!(is_overlay_backed(&store, &headless, false));
    assert!(resolve_with(&store, &headless, None, Some("H".into())).is_some());
    if let Some(none) = &none {
        assert!(store.get_item(none).is_none() && resolve_with(&store, none, None, Some("N".into())).is_none(), "no headless mode: ignored");
    }
    // writing another agent keeps the bridge entry readable; the entry is written as {source: bridge}
    store.put("other", &entry("adapter", &[])).unwrap();
    assert!(store.get_item(&headless).is_some());
    store.put_item(&headless, &OverlayItem::Bridge(BridgeEntry { raw: json!({"source": "bridge"}) })).unwrap();
    let after: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap();
    assert_eq!(after["agents"][&headless], json!({"source": "bridge"}));
    let _ = std::fs::remove_dir_all(dir);
}
