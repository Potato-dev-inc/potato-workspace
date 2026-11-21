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

/// "Permanent link" or "Temporary link" for the phone's address. No restart; the Worker setting stays saved.
#[tauri::command]
pub fn set_link_temporary(on: bool) -> Result<TunnelStatus, String> {
    mobile_tunnel::set_link_temporary(on)
}

/// "Permanent link", "Temporary link" or "My domain" (`mode`: permanent | temporary | domain). `domain` is what the person typed
/// (validated and kept saved even when another link is on). `route` (book | direct) is optional: none keeps the link's own
/// route. A route this app does not build for the link is refused. No restart; the saved Worker stays.
#[tauri::command]
pub fn set_link_mode(mode: String, domain: Option<String>, route: Option<String>) -> Result<TunnelStatus, String> {
    mobile_tunnel::set_link_mode(&mode, domain, route.as_deref())
}

/// "Port on this PC": the port the phone server asks for first (`None` = automatic). Validated here (1024 to 65535, free now),
/// saved, and used from the next start. Only the app window can call this; the phone side has no route to it.
#[tauri::command]
pub fn set_phone_port(port: Option<i64>) -> Result<TunnelStatus, String> {
    crate::phone_port::save(port, crate::pwa_server::bound_pwa_port())?;
    Ok(mobile_tunnel::tunnel_status())
}

/// "Check": does this address really reach THIS PC? A fresh nonce goes out and the answer must carry the proof only this
/// running app can make. No token, no redirects, public addresses only. A pass is recorded here (never on the UI's say-so),
/// and only then may the address be given to phones.
#[tauri::command]
pub async fn check_own_domain(raw: String) -> Result<ConnectionTest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use crate::own_domain::Verdict;
        // The route and the name this Check STARTS with: a pass is written only if both still hold when it ends.
        let mode = crate::worker_origins::link_mode();
        let route = mode.route;
        let origin = crate::own_domain::normalize(&raw)?;
        let (result, verdict) = if mode.choice == crate::worker_origins::LinkChoice::Domain && route == crate::worker_origins::LinkRoute::Book {
            // Address book: the name is a small Worker. The Check takes the phone's path (ask the Worker where this PC is and
            // make it prove itself, then prove that address is THIS app), so a pass means a phone that opens the name arrives here.
            let (quick, supported) = mobile_tunnel::book_facts();
            // The name is the Worker deployed with this name's key: from now on this PC may tell it where it is, and one press waits
            // (up to 12 s) until it has, so it ends on a pass.
            let arm_it = || {
                if crate::domain_book::arm(&origin).is_ok() {
                    mobile_tunnel::kick_book();
                }
            };
            let checked = crate::domain_book::check_armed(&raw, quick, supported, &crate::bridge::identity::own_domain_proof, &arm_it)?;
            if crate::domain_book::should_disarm(&checked) {
                let _ = crate::domain_book::disarm(&origin);
            }
            (checked.test, checked.verdict)
        } else {
            crate::own_domain::check(&raw, &crate::bridge::identity::own_domain_proof)?
        };
        match verdict {
            Verdict::Pass => crate::worker_origins::mark_verified(&raw, route)?,
            // Another server answers there now: stop handing the address to phones. A timeout or error keeps an earlier pass.
            Verdict::NotThisPc => crate::worker_origins::unmark_verified_for_route(&raw, route)?,
            Verdict::Unreached => {}
        }
        Ok(result)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// "My domain" + Address book: the Worker files for the person's own Cloudflare (the source, and a settings file with the name
/// and the HASH of this PC's key filled in). The key itself never leaves this PC. Only the app window can call this.
#[tauri::command]
pub fn domain_book_files(domain: String) -> Result<crate::domain_book::WorkerFiles, String> {
    crate::domain_book::files(&domain)
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
