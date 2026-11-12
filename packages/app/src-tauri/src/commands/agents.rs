//! Tauri command for the agent registry listing (SPEC UI-2): the same body as `GET /agents/types`.

use super::*;

/// `{agents, dispatchable_ids}` for every registered agent, in registry order (SPEC 7.5).
#[tauri::command]
pub fn agents_list() -> Value {
    crate::agent_run_mode::decorate_listing(crate::tui::agent_types_listing())
}

fn command_error(error: crate::tui::declarative::service::ServiceError) -> String {
    format!("{}: {}", error.code, error.message)
}

/// `GET /agents/definitions`: every definition with state and errors.
#[tauri::command]
pub fn agents_definitions_list() -> Value {
    crate::tui::declarative::service::listing_global()
}

/// `POST /agents/definitions/reload`: rescan and re-register; the listing plus a diff.
#[tauri::command]
pub fn agents_definitions_reload() -> Value {
    crate::tui::declarative::service::reload_global_with_diff()
}

/// `POST /agents/definitions/validate`: registers and approves nothing.
#[tauri::command]
pub fn agents_definitions_validate(toml: String, source: Option<String>) -> Result<Value, String> {
    crate::tui::declarative::service::validate_global(&toml, source.as_deref().unwrap_or("user"))
        .map_err(command_error)
}

/// `POST /agents/definitions/approve`. Tauri commands are the webview's own channel, so this is
/// the app-session path of APR-7.
#[tauri::command]
pub fn agents_definition_approve(file: String, fingerprint: String) -> Result<Value, String> {
    crate::tui::declarative::service::approve_global(&file, &fingerprint).map_err(command_error)
}

/// The validation result (`ok`, `errors`, `rendered` argv) for one listed definition file, so the
/// approve dialog can show what would run (APR-3). Only files the last scan listed can be read.
#[tauri::command]
pub fn agents_definition_preview(file: String) -> Result<Value, String> {
    let wanted = std::fs::canonicalize(&file).unwrap_or_else(|_| PathBuf::from(&file));
    let entry = crate::tui::declarative::loader::last_entries()
        .into_iter()
        .find(|e| std::fs::canonicalize(&e.path).unwrap_or_else(|_| e.path.clone()) == wanted)
        .ok_or_else(|| format!("AGENT_DEF_NOT_FOUND: no listed definition file {file}"))?;
    let text = crate::tui::declarative::bundled::read_definition(&entry.path).map_err(|e| format!("AGENT_DEF_NOT_FOUND: {e}"))?;
    let here = entry.path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let mut preview =
        crate::tui::declarative::service::validate_global_at(&text, entry.source, here).map_err(command_error)?;
    preview["approved"] = crate::tui::declarative::service::approved_snapshot_global(&entry.path.to_string_lossy());
    preview["binary_changed"] = serde_json::json!(entry.binary_changed);
    Ok(preview)
}

/// Runs a definition file against a folder of captures with `*.expect.toml` files (P3-2). Reads the
/// definition and the regular files directly inside the folder; nothing is registered or approved.
#[tauri::command]
pub fn agents_check_file(path: String, fixtures_dir: Option<String>) -> Result<Value, String> {
    let file = PathBuf::from(&path);
    if file.extension().and_then(|e| e.to_str()) != Some("toml") {
        return Err("AGENT_DEF_NOT_FOUND: a definition file ends in .toml".into());
    }
    let dir = fixtures_dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from);
    let ids = crate::tui::registry::registry().code_ids();
    let report = crate::tui::declarative::check::check_report(&file, dir.as_deref(), &ids)?;
    serde_json::to_value(report).map_err(|e| e.to_string())
}

/// "Create folder" on the no-fixtures message: creates only the folder `agents_check_file` would
/// read for this definition file (the typed one, else the folder named after the file).
#[tauri::command]
pub fn agents_create_fixtures_dir(path: String, fixtures_dir: Option<String>) -> Result<String, String> {
    let file = PathBuf::from(&path);
    if file.extension().and_then(|e| e.to_str()) != Some("toml") {
        return Err("AGENT_DEF_NOT_FOUND: a definition file ends in .toml".into());
    }
    if path.replace('\\', "/").starts_with(crate::tui::declarative::bundled::PREFIX) && fixtures_dir.as_deref().is_none_or(|d| d.trim().is_empty()) {
        return Err("AGENT_DEF_NOT_FOUND: a bundled definition has no fixtures folder; type a folder to use".into());
    }
    let dir = fixtures_dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from);
    let dir = crate::tui::declarative::check::resolve_fixtures_dir(&file, dir.as_deref());
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.display().to_string())
}

/// "Add as generic agent" (P4-2): writes an unapproved generic definition for `command` into the
/// user agents folder and rescans. The listing shows it as `unapproved`; nothing is approved here.
#[tauri::command]
pub fn agents_add_generic(command: String) -> Result<Value, String> {
    let ids = crate::tui::registry::registry().code_ids();
    crate::tui::declarative::loader::write_generic(&crate::app_paths::agents_dir(), &command, &ids)?;
    Ok(crate::tui::declarative::service::reload_global_with_diff())
}

#[tauri::command]
pub fn agents_definition_revoke(id: String) -> Result<Value, String> {
    crate::tui::declarative::service::revoke_global(&id).map_err(command_error)
}

#[tauri::command]
pub fn agents_definitions_consent(kind: String, path: String, enabled: bool) -> Result<Value, String> {
    crate::tui::declarative::service::consent(&serde_json::json!({"kind": kind, "path": path, "enabled": enabled}))
        .map_err(command_error)
}

/// SRC-5: switch the user / project / extra source on or off.
#[tauri::command]
pub fn agents_source_set(name: String, enabled: bool) -> Result<Value, String> {
    crate::tui::declarative::service::set_source(&serde_json::json!({"name": name, "enabled": enabled}))
        .map_err(command_error)
}

/// SRC-4: add (`"add"`) or remove (`"remove"`) an extra definition directory. A new one has no
/// consent and loads nothing until `agents_definitions_consent` allows it.
#[tauri::command]
pub fn agents_extra_dir(action: String, path: String) -> Result<Value, String> {
    crate::tui::declarative::service::extra_dir(&serde_json::json!({"action": action, "path": path}))
        .map_err(command_error)
}

/// Consent banner (P5-3): the definition file names found in `<project>/.potato-workspace/agents`
/// and whether this canonical path is consented. Reads names only, never the files.
#[tauri::command]
pub fn agents_project_scan(project: String) -> Value {
    crate::tui::declarative::service::project_scan(&project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_file_refuses_non_toml_and_reports_fixtures() {
        assert!(agents_check_file("C:/x/notes.txt".into(), None).unwrap_err().starts_with("AGENT_DEF_NOT_FOUND"));
        let kilo = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/agent-definitions/kilo.toml");
        let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/src/tui/declarative/fixtures/kilo");
        let body = agents_check_file(kilo.into(), Some(fixtures.into())).unwrap();
        assert_eq!(body["status"], "ran", "{body}");
        assert!(body["results"].as_array().unwrap().iter().all(|r| r["passed"] == true), "{body}");
    }

    #[test]
    fn check_file_with_no_fixtures_folder_is_neutral_not_a_failure() {
        let kilo = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/agent-definitions/kilo.toml");
        let missing = std::env::temp_dir().join(format!("pm-no-such-fixtures-{}", std::process::id()));
        let body = agents_check_file(kilo.into(), Some(missing.display().to_string())).unwrap();
        assert_eq!(body["status"], "no_fixtures", "{body}");
        assert_eq!(body["reason"], "missing");
        assert_eq!(body["explicit"], true);
        assert_eq!(body["dir"], missing.display().to_string());
        assert!(body["results"].as_array().unwrap().is_empty());
        // An empty folder is the same state; creating the folder touches only that folder.
        let made = agents_create_fixtures_dir(kilo.into(), Some(missing.display().to_string())).unwrap();
        assert_eq!(made, missing.display().to_string());
        let body = agents_check_file(kilo.into(), Some(missing.display().to_string())).unwrap();
        assert_eq!((body["status"].as_str(), body["reason"].as_str()), (Some("no_fixtures"), Some("empty")));
        let _ = std::fs::remove_dir(&missing);
    }

    #[test]
    fn preview_refuses_a_file_the_scan_did_not_list() {
        let error = agents_definition_preview("C:\\definitely\\not\\listed.toml".into()).unwrap_err();
        assert!(error.starts_with("AGENT_DEF_NOT_FOUND"), "{error}");
    }

    #[test]
    fn agents_list_returns_the_nine_code_agents() {
        let body = agents_list();
        let ids: Vec<&str> = body["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            [
                "claude",
                "codex",
                "opencode",
                "opencode_native",
                "cursor_agent",
                "cursor",
                "cmd",
                "powershell",
                "bash"
            ]
        );
        assert_eq!(body["agents"][0]["label"], "Claude");
        assert_eq!(body["dispatchable_ids"].as_array().unwrap().len(), 5);
    }
}

/// Sharing (P5-6): copy the user definition `id` to `target` (+ `<stem>.fixtures.zip` when it has
/// fixtures). Writes only the chosen target files; no network.
#[tauri::command]
pub fn agents_export_definition(id: String, target: String) -> Result<Value, String> {
    let done = crate::tui::declarative::loader::export_definition(
        &crate::app_paths::agents_dir(),
        &id,
        std::path::Path::new(&target),
    )?;
    Ok(serde_json::json!({
        "path": done.toml_path.to_string_lossy(),
        "fixtures_zip": done.fixtures_zip.map(|p| p.to_string_lossy().to_string()),
    }))
}

/// Sharing (P5-6): validate `source` and place it in the user agents folder UNAPPROVED, then
/// rescan. An old approval record for the same path and fingerprint is dropped first so an import
/// can never come back already active.
#[tauri::command]
pub fn agents_import_definition(source: String) -> Result<Value, String> {
    let ids = crate::tui::registry::registry().code_ids();
    let placed = crate::tui::declarative::loader::import_definition(
        &crate::app_paths::agents_dir(),
        std::path::Path::new(&source),
        &ids,
    )?;
    let file = placed.to_string_lossy().to_string();
    if !crate::tui::declarative::service::approved_snapshot_global(&file).is_null() {
        let id = placed.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let shared = crate::tui::declarative::loader::last_entries()
            .iter()
            .any(|e| e.id.as_deref() == Some(id.as_str()) && e.path != placed);
        if !shared {
            let _ = crate::tui::declarative::service::revoke_global(&id);
        }
    }
    Ok(crate::tui::declarative::service::reload_global_with_diff())
}

/// Current plain-language activity phrase per pane id (`pane_activity`); changes arrive as the
/// `pty://activity` event `{pane_id, activity}`.
#[tauri::command]
pub fn pane_activities() -> Value {
    serde_json::to_value(crate::pane_activity::snapshot()).unwrap_or(Value::Null)
}

/// Dev-server URLs per pane id (`pane_preview`), newest first; changes arrive as the
/// `pty://preview` event `{pane_id, urls}` (empty list = cleared).
#[tauri::command]
pub fn pane_previews() -> Value {
    serde_json::to_value(crate::pane_preview::snapshot()).unwrap_or(Value::Null)
}

/// Agent doctor quick check: installed? version? for every CLI agent (no tokens spent).
#[tauri::command(async)]
pub fn agents_health() -> Value {
    serde_json::json!({ "agents": crate::agent_health::check_all() })
}

/// Agent doctor deep check for one agent: a bounded read-only "Reply with exactly OK".
/// Only runs when the user presses Test; costs a few tokens.
#[tauri::command(async)]
pub fn agents_health_test(
    agent_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Value {
    serde_json::to_value(crate::agent_health::test_agent(&agent_id, state.registry.clone(), app))
        .unwrap_or(Value::Null)
}

/// Settings > Agents "Remove": moves one of the user's own definitions to `.removed/` (never deletes).
#[tauri::command]
pub fn agents_definition_remove(file: String) -> Result<Value, String> {
    crate::tui::declarative::service::remove_global(&file).map_err(command_error)
}

/// "Undo" / "Restore": puts a removed definition back (refuses when the file name is taken again).
#[tauri::command]
pub fn agents_definition_restore(removed_id: String) -> Result<Value, String> {
    crate::tui::declarative::service::restore_global(&removed_id).map_err(command_error)
}

/// The "Recently removed" list: `{removed: [...], total}`, newest first.
#[tauri::command]
pub fn agents_definitions_removed() -> Value {
    crate::tui::declarative::service::removed_global()
}

/// "Delete for good" for one "Recently removed" entry. Permanent; the files are not kept.
#[tauri::command]
pub fn agents_definition_purge(removed_id: String) -> Result<Value, String> {
    crate::tui::declarative::service::purge_global(&removed_id).map_err(command_error)
}

/// "Clear all" in "Recently removed": permanently deletes every entry in `.removed/`.
#[tauri::command]
pub fn agents_definitions_purge_all() -> Result<Value, String> {
    crate::tui::declarative::service::purge_all_global().map_err(command_error)
}

#[cfg(test)]
#[path = "agents_shipped_tests.rs"]
mod shipped_path_tests;
