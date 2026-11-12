//! "Reset settings" on a temp settings file.

use std::path::PathBuf;

use super::reset::*;
use serde_json::json;

fn file(name: &str, body: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pm-reset-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");
    std::fs::write(&path, body).unwrap();
    path
}

fn done(path: &std::path::Path) {
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn every_setting_goes_back_and_the_keys_stay() {
    let path = file(
        "all",
        r#"{"settings":{"missions_enabled":true,"away_minutes":30,"default_model":"x","agent_hooks_agents":{"a":"on"},"anthropic_api_key":"sk-keep","ui_mode":"cockpit","onboarding_done":true,"onboarding_step":"agent"},"other":{"keep":1}}"#,
    );
    let n = reset_file(&path).unwrap();
    assert_eq!(n, 4, "four preferences reset");
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let s = &doc["settings"];
    assert_eq!(s["anthropic_api_key"], "sk-keep");
    assert_eq!(s["ui_mode"], "cockpit");
    assert_eq!(s["onboarding_done"], true);
    for gone in ["missions_enabled", "away_minutes", "default_model", "agent_hooks_agents"] {
        assert!(s.get(gone).is_none(), "{gone} should read as its default again");
    }
    assert_eq!(doc["other"]["keep"], 1, "other top-level data is untouched");
    // Doing it twice changes nothing.
    assert_eq!(reset_file(&path).unwrap(), 0);
    done(&path);
}

#[test]
fn a_missing_or_empty_file_is_fine_and_a_broken_one_is_left_alone() {
    let path = file("empty", "");
    assert_eq!(reset_file(&path).unwrap(), 0);
    done(&path);
    let path = file("broken", "{ nope");
    assert!(reset_file(&path).unwrap_err().contains("nothing was changed"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ nope");
    done(&path);
}

#[test]
fn the_patch_nulls_each_saved_key_except_the_kept_ones() {
    let patch = reset_patch(&json!({"a": 1, "ui_mode": "x", "openai_api_key": "k", "onboarding_agent": "claude"}));
    assert_eq!(patch.len(), 1);
    assert!(patch["a"].is_null());
    assert!(reset_patch(&json!(null)).is_empty());
}
