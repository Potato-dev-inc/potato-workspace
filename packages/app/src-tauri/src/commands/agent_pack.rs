//! Tauri commands for "Add Potato Workspace to your agents" (skills + MCP entry per detected agent).
//! Thin wrappers over `crate::agent_pack::service`.

use serde_json::Value;

#[tauri::command]
pub fn agent_pack_preview() -> Result<Value, String> {
    crate::agent_pack::service::call_live("preview")
}

#[tauri::command]
pub fn agent_pack_apply() -> Result<Value, String> {
    crate::agent_pack::service::call_live("apply")
}

#[tauri::command]
pub fn agent_pack_undo() -> Result<Value, String> {
    crate::agent_pack::service::call_live("undo")
}

#[tauri::command]
pub fn agent_pack_inspect(path: String) -> Result<Value, String> {
    let env = crate::agent_pack::service::Env::live()?;
    crate::agent_pack::service::inspect(&env, &path)
}

#[tauri::command]
pub fn agent_pack_custom_save(agent_id: Option<String>, name: Option<String>, path: String, skills_dir: Option<String>) -> Result<Value, String> {
    let env = crate::agent_pack::service::Env::live()?;
    crate::agent_pack::service::save_custom(&env, agent_id.as_deref(), name.as_deref().unwrap_or(""), &path, skills_dir.as_deref())
}

#[tauri::command]
pub fn agent_pack_custom_forget(id: String) -> Result<Value, String> {
    let env = crate::agent_pack::service::Env::live()?;
    crate::agent_pack::service::forget_custom(&env, &id)
}
