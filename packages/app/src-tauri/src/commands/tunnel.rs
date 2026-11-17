//! Tauri commands for the bring-your-own-tunnel setting (see `tunnel_config.rs`).

use super::*;
use crate::mobile_tunnel::{self, ConnectionTest, TunnelStatus};
use crate::tunnel_config::TunnelConfigInput;

/// Mode, public URL, running/error state and the redacted saved setting (never the token).
#[tauri::command]
pub fn get_tunnel_status() -> TunnelStatus {
    mobile_tunnel::tunnel_status()
}

/// Save the tunnel setting and restart the tunnel so it takes effect.
#[tauri::command]
pub async fn set_tunnel_config(app: AppHandle, input: TunnelConfigInput) -> Result<TunnelStatus, String> {
    tauri::async_runtime::spawn_blocking(move || mobile_tunnel::apply_tunnel_config(&app, input))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn restart_tunnel(app: AppHandle, try_anyway: Option<bool>) -> Result<TunnelStatus, String> {
    tauri::async_runtime::spawn_blocking(move || mobile_tunnel::restart_mobile_tunnel_with(&app, try_anyway == Some(true)))
        .await
        .map_err(|err| err.to_string())?
}

/// Fetch `<public>/bridge/health`. `url: None` tests the tunnel's current public URL.
#[tauri::command]
pub async fn test_tunnel_connection(url: Option<String>) -> Result<ConnectionTest, String> {
    tauri::async_runtime::spawn_blocking(move || mobile_tunnel::test_connection(url))
        .await
        .map_err(|err| err.to_string())?
}

/// Turn on the fixed phone address (OpenTunnel, Labs). Same as saving the `open_tunnel` setting.
#[tauri::command]
pub async fn enable_opentunnel(app: AppHandle) -> Result<TunnelStatus, String> {
    tauri::async_runtime::spawn_blocking(move || mobile_tunnel::apply_tunnel_config(&app, TunnelConfigInput::OpenTunnel))
        .await
        .map_err(|err| err.to_string())?
}

/// Turn the fixed phone address off and go back to the automatic address. The address is kept for next time.
#[tauri::command]
pub async fn disable_opentunnel(app: AppHandle) -> Result<TunnelStatus, String> {
    tauri::async_runtime::spawn_blocking(move || mobile_tunnel::apply_tunnel_config(&app, TunnelConfigInput::Quick))
        .await
        .map_err(|err| err.to_string())?
}

/// Delete the fixed phone address on the relay and on this computer, then go back to the automatic address.
#[tauri::command]
pub async fn forget_opentunnel_address(app: AppHandle) -> Result<TunnelStatus, String> {
    mobile_tunnel::forget_open_tunnel_address(app).await
}
