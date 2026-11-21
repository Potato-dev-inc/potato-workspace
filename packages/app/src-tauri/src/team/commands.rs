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

/// The cockpit's facts about me for the Team page's presence (every 30 s). Rust applies what I chose to share.
#[tauri::command]
pub async fn team_presence_report(report: super::presence::Report) -> Result<Value, String> {
    blocking(move || service::presence_report(report)).await
}

/// "Share what I am doing": the level and the projects kept private.
#[tauri::command]
pub async fn team_share_set(level: super::presence::ShareLevel, exclude: Vec<String>) -> Result<Value, String> {
    blocking(move || service::share_set(level, exclude)).await
}

/// "Try again" on the Team link line: connect again (and, for the owner, set the team up again on a relay that forgot it).
#[tauri::command]
pub async fn team_reconnect() -> Result<Value, String> {
    blocking(service::reconnect).await
}

/// "Move this team to <relay>" on the Team link line (admin only; the new address is checked first).
#[tauri::command]
pub async fn team_move_relay(relay: String) -> Result<Value, String> {
    blocking(move || service::move_relay(&relay)).await
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

/// **Join popup, step 1.** What an invite link says (team, who invited), without using it up. The link is
/// untrusted text: only a code and a host are taken from it.
#[tauri::command]
pub async fn team_invite_lookup(link: String) -> Result<Value, String> {
    blocking(move || {
        let target = super::invite_web::parse_target(&link)?;
        super::invite_web::peek(&target.base_url(), &target)
    })
    .await
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInput {
    pub link: String,
    pub name: String,
    #[serde(default)]
    pub github: Option<String>,
}

/// **Join popup, step 2.** Use the invite up (the Worker burns it) and ask the team owner to let this
/// computer in. The owner still says yes.
#[tauri::command]
pub async fn team_invite_accept(input: AcceptInput) -> Result<Value, String> {
    blocking(move || service::join_by_link(&input.link, input.name, input.github)).await
}

/// What a Worker address can do (`features`), for "Use this address" and "Update your Worker". Sends nothing secret.
#[tauri::command]
pub async fn worker_check(address: String) -> Result<Value, String> {
    blocking(move || {
        let normal = super::transport::relay::normalize_relay_url(&address)?;
        // The Worker's own routes are at the root of its address, whatever path a relay address carries.
        let after = normal.split_once("://").map(|(s, r)| (s, r)).ok_or("That address has no https://.")?;
        let origin = format!("{}://{}", after.0, after.1.split('/').next().unwrap_or(""));
        Ok(super::invite_web::worker_health(&origin))
    })
    .await
}
