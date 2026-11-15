//! Tauri commands for installing, uninstalling and inspecting the MCP registration of the CLI agents.

use super::*;

#[tauri::command]
pub async fn install_npm_mcp_configs(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<Vec<crate::mcp_install::EnsureMcpResult>, String> {
    crate::mcp_install::install_mcp_configs_with_preference(
        std::path::Path::new(&project_path),
        developer_use_rust_mcp(&state),
    )
}

#[tauri::command]
pub async fn install_global_npm_mcp_configs(
    state: State<'_, AppState>,
) -> Result<Vec<crate::mcp_install::EnsureMcpResult>, String> {
    crate::mcp_install::install_global_mcp_configs_with_preference(developer_use_rust_mcp(&state))
}

#[tauri::command]
pub async fn uninstall_npm_mcp_configs(
    project_path: String,
) -> Result<Vec<crate::mcp_install::EnsureMcpResult>, String> {
    crate::mcp_install::uninstall_npm_mcp_configs(std::path::Path::new(&project_path))
}

#[tauri::command]
pub async fn uninstall_global_npm_mcp_configs(
) -> Result<Vec<crate::mcp_install::EnsureMcpResult>, String> {
    crate::mcp_install::uninstall_global_npm_mcp_configs()
}

#[tauri::command]
pub async fn get_mcp_status(
    state: State<'_, AppState>,
    project_path: String,
    auto_repair: bool,
) -> Result<crate::mcp_status::McpStatusReport, String> {
    crate::mcp_status::get_mcp_status_with_preference(
        std::path::Path::new(&project_path),
        auto_repair,
        developer_use_rust_mcp(&state),
    )
}

/// Agents whose tool list is older (or newer) than this app's, for the "Tools are out of date" banner.
#[tauri::command]
pub async fn mcp_tools_drift() -> Result<Vec<crate::mcp_drift::ToolsDrift>, String> {
    Ok(crate::mcp_drift::report())
}

/// "Reconnect": restart the chat's agent so it starts this app's own MCP program.
#[tauri::command]
pub async fn mcp_reconnect(pane_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::mcp_drift::reconnect(&pane_id))
        .await
        .map_err(|e| format!("ACP_START_FAILED: {e}"))?
}
