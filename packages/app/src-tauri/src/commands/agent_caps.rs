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

/// "Check it again" on an agent's page: the free checks again (version, handshake, models), then the table as it stands.
#[tauri::command]
pub async fn agent_caps_recheck(agent_id: String) -> Result<serde_json::Value, String> {
    let id = agent_id.trim().to_string();
    if id.is_empty() {
        return Err("AGENT_CAPS_BAD_ID: Type an agent name.".into());
    }
    tokio::task::spawn_blocking(move || crate::agent_caps::drift::check_again(&id)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::caps_get;

    fn without_clock(mut v: serde_json::Value) -> serde_json::Value {
        if let Some(map) = v.as_object_mut() {
            for (_, inner) in map.iter_mut() {
                if let Some(o) = inner.as_object_mut() {
                    o.remove("at");
                }
            }
        }
        v
    }

    /// The command and `caps_json` are one function, for a registered agent too.
    #[test]
    fn the_command_and_caps_json_are_one_function() {
        let id = crate::tui::registered_agent_ids().into_iter().next().unwrap();
        assert_eq!(without_clock(caps_get(&id).unwrap()), without_clock(crate::agent_caps::caps_json(&id)));
        assert!(caps_get("  ").is_err());
    }
}
