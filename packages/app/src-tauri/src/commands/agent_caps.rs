//! What an agent can do, as the one capability table says (`crate::agent_caps`).

/// Shared by the command and its test: the same JSON the MCP side gets.
pub(crate) fn caps_get(agent_id: &str) -> Result<serde_json::Value, String> {
    let id = agent_id.trim();
    if id.is_empty() {
        return Err("AGENT_CAPS_BAD_ID: Type an agent name.".into());
    }
    Ok(crate::agent_caps::caps_json(id))
}

pub(crate) fn caps_list() -> Vec<serde_json::Value> {
    crate::agent_caps::all().iter().map(crate::agent_caps::caps_to_json).collect()
}

#[tauri::command]
pub async fn agent_caps_get(agent_id: String) -> Result<serde_json::Value, String> {
    caps_get(&agent_id)
}

#[tauri::command]
pub async fn agent_caps_list() -> Result<Vec<serde_json::Value>, String> {
    Ok(caps_list())
}

/// Test seam: what the command returns for an id.
#[cfg(test)]
pub(crate) fn agent_caps_for_test(agent_id: &str) -> Result<serde_json::Value, String> {
    caps_get(agent_id)
}
