//! Tauri commands for the budget of each project and the right-size line (`crate::project_budget`,
//! `acp::chat::right_size`).

use serde_json::{json, Value};

fn chat_of(pane_id: &str) -> Result<std::sync::Arc<crate::acp::chat::AcpChat>, String> {
    crate::acp::chat::get(pane_id).ok_or_else(|| format!("PANE_NOT_FOUND: {pane_id} is not a chat session"))
}

/// The limits of a project (the Settings row). All empty = no limits.
#[tauri::command]
pub fn project_budget_limits(project: String) -> crate::project_budget::Limits {
    crate::project_budget::limits(&project)
}

/// Saves the limits of a project; 0 or empty means no limit for that part. Returns what was kept.
#[tauri::command]
pub fn project_budget_set(project: String, limits: crate::project_budget::Limits) -> crate::project_budget::Limits {
    crate::project_budget::set_limits(&project, limits);
    // A card above a chat that says the budget is reached re-reads at once (a limit removed or raised clears it).
    pm_core::host::emit("project-budget://changed", Value::Null);
    crate::project_budget::limits(&project)
}

/// Where the project of a chat stands today, or `null` when it has no limits.
#[tauri::command]
pub fn project_budget_status(pane_id: String) -> Option<crate::project_budget::Status> {
    crate::acp::chat::get(&pane_id)?.project_budget_status()
}

/// "Raise" on the card: more room for the limits that ran out. Returns the new status.
#[tauri::command]
pub fn project_budget_raise(pane_id: String) -> Result<Option<crate::project_budget::Status>, String> {
    Ok(chat_of(&pane_id)?.project_budget_raise())
}

/// The quiet "try a different model" line a chat may show after its latest turn, or `null`.
#[tauri::command]
pub fn right_size_pending(pane_id: String) -> Option<crate::acp::chat::right_size::Suggestion> {
    crate::acp::chat::get(&pane_id)?.right_size_pending()
}

/// "Switch": uses the suggested model for the next turns of this chat.
#[tauri::command]
pub fn right_size_switch(pane_id: String) -> Result<Value, String> {
    let chat = chat_of(&pane_id)?;
    let suggestion = chat.right_size_pending().ok_or_else(|| "There is nothing to switch.".to_string())?;
    chat.set_config("model", &suggestion.to_value).map_err(|e| e.to_string())?;
    chat.right_size_dismiss();
    Ok(json!({ "model": suggestion.to_name }))
}

/// The line is closed without switching.
#[tauri::command]
pub fn right_size_dismiss(pane_id: String) {
    if let Some(chat) = crate::acp::chat::get(&pane_id) {
        chat.right_size_dismiss();
    }
}
