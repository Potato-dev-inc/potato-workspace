//! Cockpit commands for Team (Tauri `invoke`, local to this app). Team traffic between teammates
//! never goes through these or through the bridge: they are the person's own clicks.

use super::service;
use serde_json::Value;

async fn blocking<T: serde::Serialize + Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<Value, String> {
    let out = tauri::async_runtime::spawn_blocking(job).await.map_err(|e| e.to_string())??;
    serde_json::to_value(out).map_err(|e| e.to_string())
}

/// "Your name" on the Team page when settings have none: this computer's sign-in or computer name.
#[tauri::command]
pub fn team_default_name() -> String {
    super::membership::suggest_name(|k| std::env::var(k).ok())
}

#[tauri::command]
pub async fn team_state() -> Result<Value, String> {
    blocking(service::view).await
}

/// Settings > Team > People: how far away each computer of the team is. Only a relay team has a mailbox to time.
#[tauri::command]
pub async fn team_ping() -> Result<Vec<crate::capacity_proxy::ping::DevicePing>, String> {
    if service::transport_kind() != Some("relay") {
        return Err("Pings need a team on a relay.".into());
    }
    crate::capacity_proxy::ping_team().await
}

#[tauri::command]
pub async fn team_config_get() -> Result<Value, String> {
    blocking(service::config_get).await
}

#[tauri::command]
pub async fn team_config_set(config: service::ConfigInput) -> Result<Value, String> {
    blocking(move || service::config_set(config)).await
}

#[tauri::command]
pub async fn team_send(draft_id: String, note: Option<String>) -> Result<Value, String> {
    blocking(move || service::send(&draft_id, note)).await
}

#[tauri::command]
pub async fn team_draft_dismiss(draft_id: String) -> Result<Value, String> {
    blocking(move || service::dismiss_draft(&draft_id)).await
}

#[tauri::command]
pub async fn team_card_dismiss(card_id: String) -> Result<Value, String> {
    blocking(move || service::dismiss_card(&card_id)).await
}

/// War Room: "Claim it" / "Release" on the red-default-branch banner.
#[tauri::command]
pub async fn team_ci_claim(card_id: String, claim: bool) -> Result<Value, String> {
    blocking(move || service::claim_ci(&card_id, claim)).await
}

#[tauri::command]
pub async fn team_pull(card_id: String) -> Result<Value, String> {
    blocking(move || service::pull(&card_id)).await
}

#[tauri::command]
pub async fn team_queue(card_id: String, pane_id: String, when: String) -> Result<Value, String> {
    blocking(move || service::queue(&card_id, &pane_id, &when)).await
}

#[tauri::command]
pub async fn team_job_apply(job_id: String) -> Result<Value, String> {
    blocking(move || service::apply(&job_id)).await
}

#[tauri::command]
pub async fn team_job_discard(job_id: String) -> Result<Value, String> {
    blocking(move || service::discard(&job_id)).await
}

#[tauri::command]
pub async fn team_job_diff(job_id: String) -> Result<Value, String> {
    blocking(move || service::diff(&job_id)).await
}

#[tauri::command]
pub async fn team_create(input: service::CreateInput) -> Result<Value, String> {
    blocking(move || service::create(input)).await
}

#[tauri::command]
pub async fn team_invite() -> Result<Value, String> {
    blocking(service::create_invite).await
}

#[tauri::command]
pub async fn team_join(input: service::JoinInput) -> Result<Value, String> {
    blocking(move || service::join(input)).await
}

#[tauri::command]
pub async fn team_leave() -> Result<Value, String> {
    blocking(service::leave).await
}

#[tauri::command]
pub async fn team_join_approve(join_id: String) -> Result<Value, String> {
    blocking(move || service::approve_join(&join_id)).await
}

#[tauri::command]
pub async fn team_join_decline(join_id: String) -> Result<Value, String> {
    blocking(move || service::decline_join(&join_id)).await
}

#[tauri::command]
pub async fn team_member_remove(member_id: String) -> Result<Value, String> {
    blocking(move || service::remove_member(&member_id)).await
}

#[tauri::command]
pub async fn team_gaps_clear() -> Result<Value, String> {
    blocking(service::clear_gaps).await
}

#[tauri::command]
pub async fn team_merge_plan(card_id: String) -> Result<Value, String> {
    blocking(move || service::merge_plan(&card_id)).await
}

#[tauri::command]
pub async fn team_merge_when_green(card_id: String, head_sha: String) -> Result<Value, String> {
    blocking(move || service::merge_when_green(&card_id, &head_sha)).await
}

#[tauri::command]
pub async fn team_job_start(job_id: String) -> Result<Value, String> {
    blocking(move || service::start_job(&job_id)).await
}

#[tauri::command]
pub async fn team_member_confirm_github(member_id: String) -> Result<Value, String> {
    blocking(move || service::confirm_github(&member_id)).await
}

/// "Create team relay": deploys the bundled relay Worker into the person's Cloudflare account with a pasted API
/// token. Progress goes out as `team://relay-deploy` `{ step }` events. Answers `{status:"pick_account", accounts}`
/// when the token sees several accounts (call again with `account_id`), or `{status:"done", url}`.
#[tauri::command]
pub async fn team_relay_deploy(app: tauri::AppHandle, token: String, account_id: Option<String>) -> Result<Value, String> {
    use super::relay_deploy::{deploy, load_bundle, CloudflareAuth};
    use tauri::{Emitter, Manager};
    let auth = CloudflareAuth::ApiToken(token);
    let resource_dir = app.path().resource_dir().ok();
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(std::path::PathBuf::from));
    let dir = crate::mcp_runtime::installed_resource_dir(resource_dir.as_deref(), exe_dir.as_deref(), "relay-worker")
        .or_else(|| cfg!(debug_assertions).then(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/relay-worker")));
    blocking(move || {
        let bundle = load_bundle(&dir.unwrap_or_default())?;
        deploy(auth, account_id, &bundle, |step| {
            let _ = app.emit("team://relay-deploy", serde_json::json!({ "step": step }));
        })
    })
    .await
}
