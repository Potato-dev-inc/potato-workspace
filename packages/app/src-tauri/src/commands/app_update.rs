//! One-click update (Tauri updater v2). The page asks `app_update_check`; a press on Update calls `app_update_install`.
//!
//! - Nothing is installed without a press. A check only reads `latest.json` (the GitHub release) and keeps the answer.
//! - The download is checked against the public key in `tauri.conf.json` before anything else happens; a file that does not
//!   verify is refused and the app goes on as it was. Progress is sent to the page as `app-update-progress`.
//! - The download is kept. If an agent is working or waiting for you once it is done, the install is refused until the
//!   page says the person was warned (`confirm_running`); the kept download is used on the second press.
//! - Only then the running agents are asked to stop (each one is checkpointed first, the way the panic button does it), the
//!   panes are closed, and the installer runs. The installer is the MSI of the next version: same upgrade code, so it
//!   replaces the old one in place. The app's data folder is not touched by it.
//! - If the installer cannot start after the agents were stopped, the error starts with `UPDATE_STOPPED:` and the page
//!   offers to reopen the chats (`reopen_chats`). Terminal agents are not reopened.
//! - Any failure is a plain sentence; the version that is running keeps working.
//! - With "Smaller updates" on, an update may take the app-only package (about a third of the size, the built-in tools stay
//!   where they are). `update_plan` decides; any doubt means the full package. The small package is downloaded and checked
//!   the same way, the tools are copied to a safe place and checked BEFORE the installer runs, and if anything fails the
//!   full package is used instead (once per version). `tools_repair` puts the tools back with the full package of the
//!   running version.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::AppState;
use super::update_channel::{self, Channel, Failed};
use super::update_plan::{self, Plan, PlanInput, ToolsHere};

/// What a check found: the full update, and the app-only one when the plan chose it.
struct Found {
    full: Update,
    app: Option<Update>,
}

static FOUND: Mutex<Option<Found>> = Mutex::new(None);

/// A downloaded and verified update, kept while the person decides about the agents that are still working.
struct Ready {
    update: Update,
    bytes: Vec<u8>,
    /// The small package (its tools are already staged).
    app_only: bool,
}
static READY: Mutex<Option<Ready>> = Mutex::new(None);

/// A step the page may show above the progress: `preparing` (copying the tools) or `fallback` (the full update instead).
pub const STEP_EVENT: &str = "app-update-step";

/// The event the page listens to while the file downloads.
pub const PROGRESS_EVENT: &str = "app-update-progress";

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    pub current_version: String,
    pub version: String,
    pub notes: Option<String>,
    /// Size of the download in bytes, when `latest.json` says (releases before app-only updates do not).
    pub size: Option<u64>,
    /// The full package brings new built-in tools (so it is big on purpose).
    pub new_tools: bool,
    /// The small package was chosen.
    pub smaller: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
struct Step {
    step: &'static str,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBusy {
    /// Agent types with a pane that is working or waiting for you now (for example "claude" or "codex").
    pub agents: Vec<String>,
    /// The part of `agents` that are chats: they are brought back after the restart.
    pub chats: Vec<String>,
    /// The part of `agents` that run in a terminal: they stop for good and are not reopened.
    pub terminals: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// No new data for this long: the download counts as stopped.
pub const STALL_AFTER_MS: u64 = 45_000;
/// The sentence for a download that stopped moving.
pub const STALLED_SENTENCE: &str = "The download stopped moving. Check your internet and try again. Your current version keeps working.";

/// True when nothing has arrived for `limit_ms` (times are milliseconds since the download began).
pub fn is_stalled(now_ms: u64, last_chunk_ms: u64, limit_ms: u64) -> bool {
    now_ms.saturating_sub(last_chunk_ms) >= limit_ms
}

/// A plain sentence for what went wrong (the page shows it as it is). Pure, so tests can pin the words.
pub fn plain_update_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("signature") || lower.contains("minisign") || lower.contains("verif") {
        "The update did not pass its safety check, so it was not installed. Your current version keeps working.".to_string()
    } else if lower.contains("dns") || lower.contains("connect") || lower.contains("network") || lower.contains("timed out") || lower.contains("error sending request") || lower.contains("unreachable") {
        "Could not reach the update server. Check your internet and try again. Your current version keeps working.".to_string()
    } else if lower.contains("404") || lower.contains("not found") || lower.contains("status") {
        "No update information was found right now. Try again later.".to_string()
    } else {
        "The update could not be installed. Your current version keeps working.".to_string()
    }
}

/// Panes whose agent is busy: working, or waiting for an answer (the same set the pane windows use).
fn counts_as_busy(status: &str) -> bool {
    matches!(status, "running" | "waiting_input")
}

/// The agent types of the panes that are working or waiting for you now, each named once. Pure: the caller passes
/// `(agent_type, status)`.
#[cfg(test)]
pub fn working_agents<'a>(panes: impl IntoIterator<Item = (&'a str, &'a str)>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (agent_type, status) in panes {
        if counts_as_busy(status) && !names.iter().any(|n| n == agent_type) {
            names.push(agent_type.to_string());
        }
    }
    names
}

/// Busy agents split into chats (brought back after the restart) and terminals (stopped for good). Pure: the caller
/// passes `(agent_type, status, is_chat)`.
pub fn working_split<'a>(panes: impl IntoIterator<Item = (&'a str, &'a str, bool)>) -> UpdateBusy {
    let mut busy = UpdateBusy { agents: Vec::new(), chats: Vec::new(), terminals: Vec::new() };
    for (agent_type, status, is_chat) in panes {
        if !counts_as_busy(status) {
            continue;
        }
        let list = if is_chat { &mut busy.chats } else { &mut busy.terminals };
        if !list.iter().any(|n| n == agent_type) {
            list.push(agent_type.to_string());
        }
        if !busy.agents.iter().any(|n| n == agent_type) {
            busy.agents.push(agent_type.to_string());
        }
    }
    busy
}

fn busy_now(app: &AppHandle) -> UpdateBusy {
    match app.try_state::<AppState>() {
        Some(state) => {
            let panes = state.registry.lock().list_including_remote();
            working_split(panes.iter().map(|p| (p.agent_type.as_str(), p.status.as_str(), p.lane.as_deref() == Some("acp"))))
        }
        None => UpdateBusy { agents: Vec::new(), chats: Vec::new(), terminals: Vec::new() },
    }
}

/// One read of one address, for a named target (`None` is this PC's usual one: the full MSI). Only an update newer than the
/// running app comes back, with the channel it came from.
async fn check_channel(app: &AppHandle, channel: Channel, target: Option<&str>) -> Result<Option<(String, (Update, Channel))>, String> {
    let url = tauri::Url::parse(update_channel::endpoint(channel)).map_err(|e| plain_update_error(&e.to_string()))?;
    let mut builder = app.updater_builder();
    if let Some(target) = target {
        builder = builder.target(target);
    }
    let updater = builder
        .endpoints(vec![url])
        .and_then(|b| b.build())
        .map_err(|e| plain_update_error(&e.to_string()))?;
    let found = updater.check().await.map_err(|e| plain_update_error(&e.to_string()))?;
    Ok(found.map(|u| (u.version.clone(), (u, channel))))
}

/// The words for a check that could not read a channel. The page reads the code at the start (`CHECK_FAILED_BETA:`) and
/// shows its own line, so a failed beta address is never shown as "up to date".
pub fn check_failed_error(failed: Failed) -> String {
    match failed {
        Failed::Stable => "CHECK_FAILED_STABLE: Couldn't check for updates. Try again later.".to_string(),
        Failed::Beta => "CHECK_FAILED_BETA: Couldn't check for early versions. Try again later.".to_string(),
    }
}

/// Looks for an update: the stable address, and with "Get early versions (beta)" on, the beta address too, then the
/// newer of the two. Off reads only the stable address, as before. A channel that cannot be read (offline, 404, a bad
/// file) and leaves nothing newer is an error with its code, never "no update". The channel comes back with the update.
async fn find_update(app: &AppHandle) -> Result<Option<(Update, Channel)>, String> {
    let early = update_channel::early_versions_on(&crate::settings_store::read_public_settings(app));
    let stable = check_channel(app, Channel::Stable, None).await;
    let beta = if update_channel::channels_to_check(early).contains(&Channel::Beta) { Some(check_channel(app, Channel::Beta, None).await) } else { None };
    update_channel::combine(stable, beta).map_err(check_failed_error)
}

/// Where the tools this version needs are on this PC now (the one tools resolver answers).
fn tools_here() -> ToolsHere {
    match crate::tools_home::current() {
        Some(home) if home.source == crate::tools_home::Source::Local => ToolsHere::Staged,
        Some(_) => ToolsHere::InstallOnly,
        None => ToolsHere::Nowhere,
    }
}

/// The plan for a found update, from the settings and what is on this PC.
fn plan_for(app: &AppHandle, update: &Update) -> Plan {
    let settings = crate::settings_store::read_public_settings(app);
    let switch_on = cfg!(windows) && settings.get(update_plan::SETTING_KEY).and_then(serde_json::Value::as_bool).unwrap_or(false);
    let failed_for = settings.get(update_plan::FAILED_KEY).and_then(serde_json::Value::as_str).filter(|s| !s.is_empty());
    update_plan::plan(&PlanInput {
        current_version: &update.current_version,
        new_version: &update.version,
        raw: &update.raw_json,
        tools_version: crate::tools_home::needed().tools_version,
        tools_here: tools_here(),
        switch_on,
        failed_for,
    })
}

/// Reads the same address again for the small package (the second target). It must be the same version; anything else
/// means the full package.
async fn find_app_only(app: &AppHandle, channel: Channel, version: &str) -> Option<Update> {
    let found = check_channel(app, channel, Some(update_plan::APP_TARGET)).await.ok()??;
    (found.1 .0.version == version).then_some(found.1 .0)
}

/// Remembers that the small package did not work for `version`: that version takes the full package from now on.
fn remember_app_only_failed(app: &AppHandle, version: &str) {
    crate::settings_store::patch_public_settings(app, serde_json::json!({ update_plan::FAILED_KEY: version }));
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> Result<Option<UpdateOffer>, String> {
    match find_update(&app).await {
        Ok(Some((update, channel))) => {
            let mut plan = plan_for(&app, &update);
            let mut app_update = None;
            if matches!(plan, Plan::AppOnly { .. }) {
                app_update = find_app_only(&app, channel, &update.version).await;
                if app_update.is_none() {
                    plan = Plan::Full;
                }
            }
            let (size, new_tools) = update_plan::offer_size(plan, &update.raw_json, crate::tools_home::needed().tools_version);
            let offer = UpdateOffer {
                current_version: update.current_version.clone(),
                version: update.version.clone(),
                notes: update.body.clone().filter(|n| !n.trim().is_empty()),
                size,
                new_tools,
                smaller: app_update.is_some(),
            };
            *FOUND.lock().unwrap_or_else(|p| p.into_inner()) = Some(Found { full: update, app: app_update });
            *READY.lock().unwrap_or_else(|p| p.into_inner()) = None;
            Ok(Some(offer))
        }
        Ok(None) => {
            *FOUND.lock().unwrap_or_else(|p| p.into_inner()) = None;
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// Which agents are working or waiting for you: the page warns before it restarts.
#[tauri::command]
pub fn app_update_busy(app: AppHandle) -> UpdateBusy {
    busy_now(&app)
}

/// Downloads one package and checks its signature (progress goes to the page). A download that stops moving ends with a
/// plain sentence; the unfinished download is dropped, nothing was installed.
async fn download_checked(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let mut downloaded: u64 = 0;
    let mut last_sent: Option<u8> = None;
    let progress_app = app.clone();
    let started = std::time::Instant::now();
    let last_chunk = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let touch = last_chunk.clone();
    let download = update.download(
        move |chunk, total| {
            touch.store(started.elapsed().as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
            downloaded += chunk as u64;
            let percent = total.filter(|t| *t > 0).map(|t| (downloaded.saturating_mul(100) / t).min(100) as u8);
            if percent.is_none() || percent != last_sent {
                last_sent = percent;
                let _ = progress_app.emit(PROGRESS_EVENT, Progress { downloaded, total });
            }
        },
        || {},
    );
    let watchdog = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let now = started.elapsed().as_millis() as u64;
            if is_stalled(now, last_chunk.load(std::sync::atomic::Ordering::Relaxed), STALL_AFTER_MS) {
                break;
            }
        }
    };
    tokio::select! {
        done = download => done.map_err(|e| plain_update_error(&e.to_string())),
        () = watchdog => Err(STALLED_SENTENCE.to_string()),
    }
}

/// Copies the built-in tools to the safe place (and checks every file) so the small installer may remove them from the
/// install folder. Runs off the main threads: it is a few hundred MB of local copying.
async fn stage_tools(app: &AppHandle) -> Result<(), String> {
    let _ = app.emit(STEP_EVENT, Step { step: "preparing" });
    tokio::task::spawn_blocking(|| {
        let base = crate::tools_home::local_base().ok_or_else(|| "no place for the tools".to_string())?;
        let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(std::path::Path::to_path_buf)).ok_or_else(|| "no install folder".to_string())?;
        let resources = crate::shell_env::bundled_resources_root(&exe_dir);
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        crate::tools_home::stage_local(&resources, &base, &crate::tools_home::needed()).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The small package: download, check the signature, stage the tools. Any failure is an `Err` and the caller falls back.
async fn prepare_app_only(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let bytes = download_checked(app, update).await?;
    stage_tools(app).await?;
    Ok(bytes)
}

/// Picks the package and has it ready: the small one when the plan chose it and everything works, else the full one.
/// Nothing has been stopped yet, so a failure here changes nothing.
async fn download_choice(app: &AppHandle, found: Found) -> Result<Ready, String> {
    if let Some(small) = found.app {
        match prepare_app_only(app, &small).await {
            Ok(bytes) => return Ok(Ready { update: small, bytes, app_only: true }),
            Err(why) => {
                tracing::warn!(%why, version = %found.full.version, "the small update did not work; taking the full one");
                remember_app_only_failed(app, &found.full.version);
                let _ = app.emit(STEP_EVENT, Step { step: "fallback" });
            }
        }
    }
    let bytes = download_checked(app, &found.full).await?;
    Ok(Ready { update: found.full, bytes, app_only: false })
}

/// The press on Update: download and verify (with progress), then stop the agents and close their panes, then install.
/// `reopen_chats` is the other use: after an install that could not start, bring the stopped chats back.
#[tauri::command]
pub async fn app_update_install(app: AppHandle, confirm_running: bool, reopen_chats: Option<bool>) -> Result<(), String> {
    if reopen_chats == Some(true) {
        return reopen_stopped_chats(&app);
    }
    let kept = READY.lock().unwrap_or_else(|p| p.into_inner()).take();
    let ready = match kept {
        Some(ready) => ready,
        None => {
            let found = FOUND.lock().unwrap_or_else(|p| p.into_inner()).take();
            let found = match found {
                Some(found) => found,
                None => {
                    let (update, channel) = find_update(&app).await?.ok_or_else(|| "There is no update to install.".to_string())?;
                    let app_update = match plan_for(&app, &update) {
                        Plan::AppOnly { .. } => find_app_only(&app, channel, &update.version).await,
                        Plan::Full => None,
                    };
                    Found { full: update, app: app_update }
                }
            };
            download_choice(&app, found).await?
        }
    };
    // The download took a while: ask again who is working now (an agent may have started or asked something).
    let busy = busy_now(&app).agents;
    if !busy.is_empty() && !confirm_running {
        let said = format!("UPDATE_RUNNING: {} is working or waiting for you. Confirm to restart anyway; its work is saved first.", busy.join(", "));
        *READY.lock().unwrap_or_else(|p| p.into_inner()) = Some(ready);
        return Err(said);
    }
    let Ready { update, bytes, app_only } = ready;
    stop_for_update(&app);
    update.install(bytes).map_err(|e| {
        if app_only {
            // The small installer would not start: the next try takes the full package.
            remember_app_only_failed(&app, &update.version);
        }
        update_stopped_error(&e.to_string())
    })?;
    // On Windows the installer ends this process; if it is still here, it is not going to run.
    Ok(())
}

/// What the page shows about the built-in tools: fine, or missing (then it offers Repair).
#[tauri::command]
pub fn tools_status() -> crate::tools_home::ToolsStatus {
    crate::tools_home::status()
}

/// The addresses Repair reads, best first: the release of the running version, then the two fixed channels. Only a
/// release for exactly the running version is accepted.
pub fn repair_addresses(running: &str) -> Vec<String> {
    vec![
        format!("https://github.com/Potato-dev-inc/potato-workspace/releases/download/v{running}/latest.json"),
        update_channel::endpoint(Channel::Beta).to_string(),
        update_channel::endpoint(Channel::Stable).to_string(),
    ]
}

/// Repair: downloads the FULL installer of the version that is running (its signature is checked like any update) and runs
/// it, which puts the built-in tools back. Agents that are working are asked about first, as for an update.
#[tauri::command]
pub async fn tools_repair(app: AppHandle, confirm_running: bool) -> Result<(), String> {
    let running = app.package_info().version.to_string();
    let kept = READY.lock().unwrap_or_else(|p| p.into_inner()).take();
    let ready = match kept {
        Some(ready) if ready.update.version == running => ready,
        _ => {
            let mut found: Option<Update> = None;
            for address in repair_addresses(&running) {
                let Ok(url) = tauri::Url::parse(&address) else { continue };
                let same = running.clone();
                let built = app
                    .updater_builder()
                    .version_comparator(move |_current, release| release.version.to_string() == same)
                    .endpoints(vec![url])
                    .and_then(|b| b.build());
                if let Ok(updater) = built {
                    if let Ok(Some(update)) = updater.check().await {
                        found = Some(update);
                        break;
                    }
                }
            }
            let update = found.ok_or_else(|| "Could not find the installer for this version. Check your internet and try again.".to_string())?;
            let bytes = download_checked(&app, &update).await?;
            Ready { update, bytes, app_only: false }
        }
    };
    let busy = busy_now(&app).agents;
    if !busy.is_empty() && !confirm_running {
        let said = format!("UPDATE_RUNNING: {} is working or waiting for you. Confirm to restart anyway; its work is saved first.", busy.join(", "));
        *READY.lock().unwrap_or_else(|p| p.into_inner()) = Some(ready);
        return Err(said);
    }
    stop_for_update(&app);
    ready.update.install(ready.bytes).map_err(|e| update_stopped_error(&e.to_string()))?;
    Ok(())
}

/// The installer could not start after the agents were stopped: the app keeps running, so it is not ending any more
/// (closing a chat must again count as the person closing it), and the page gets the `UPDATE_STOPPED:` message.
fn update_stopped_error(raw: &str) -> String {
    crate::acp::chat::cancel_app_shutdown();
    format!("UPDATE_STOPPED: Agents were stopped. {}", plain_update_error(raw))
}

/// What the app's own exit does for the agents and the panes, done right before the installer closes the app (it ends
/// the process without the usual exit event, and on Windows it ends it as soon as it starts, so this cannot wait).
fn stop_for_update(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        // The app ends with the install: chats stop but stay restorable.
        crate::acp::chat::begin_app_shutdown();
        let _ = crate::panic::stop_all(&state.registry, app);
        crate::pty::registry_kill_all_and_wait(&state.registry);
    }
}

/// After an install that could not start: the chats that were stopped are open records again; list their panes.
fn reopen_stopped_chats(app: &AppHandle) -> Result<(), String> {
    let state = app.try_state::<AppState>().ok_or_else(|| "The app is not ready yet.".to_string())?;
    if !crate::acp::chat_enabled() {
        return Ok(());
    }
    let deps = super::acp_chat::live_deps(app, &state.registry);
    crate::acp::chat::restore_panes(&deps);
    let _ = app.emit("acp-conversations-changed", ());
    Ok(())
}

/// With `PM_UPDATE_PROBE=<file>` set: at start-up, check, download and verify (never install) and write what happened
/// to the file. It is how a build is shown to find, fetch and verify an update; off unless the variable is set.
pub fn startup_probe(app: AppHandle) {
    let Some(file) = std::env::var_os("PM_UPDATE_PROBE").filter(|f| !f.is_empty()) else { return };
    tauri::async_runtime::spawn(async move {
        let report = match app_update_check(app.clone()).await {
            Ok(Some(offer)) => {
                let found = FOUND.lock().unwrap_or_else(|p| p.into_inner()).take();
                match found {
                    Some(found) => match found.app.as_ref().unwrap_or(&found.full).download(|_, _| {}, || {}).await {
                        Ok(bytes) => serde_json::json!({ "result": "verified", "current": offer.current_version, "version": offer.version, "notes": offer.notes, "bytes": bytes.len(), "smaller": offer.smaller }),
                        Err(e) => serde_json::json!({ "result": "refused", "version": offer.version, "plain": plain_update_error(&e.to_string()), "raw": e.to_string() }),
                    },
                    None => serde_json::json!({ "result": "no update kept" }),
                }
            }
            Ok(None) => serde_json::json!({ "result": "none" }),
            Err(plain) => serde_json::json!({ "result": "check failed", "plain": plain }),
        };
        let _ = std::fs::write(file, report.to_string());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_reads_the_release_of_the_running_version_first_then_the_two_channels() {
        let addresses = repair_addresses("1.2.0");
        assert_eq!(addresses[0], "https://github.com/Potato-dev-inc/potato-workspace/releases/download/v1.2.0/latest.json");
        assert_eq!(addresses[1], update_channel::endpoint(Channel::Beta));
        assert_eq!(addresses[2], update_channel::endpoint(Channel::Stable));
        assert!(addresses.iter().all(|a| tauri::Url::parse(a).is_ok()));
    }

    #[test]
    fn the_offer_says_nothing_extra_for_a_release_without_the_small_package() {
        let offer = UpdateOffer { current_version: "1.1.1".into(), version: "1.1.2".into(), notes: None, size: None, new_tools: false, smaller: false };
        let json = serde_json::to_value(&offer).unwrap();
        assert_eq!(json["size"], serde_json::Value::Null);
        assert_eq!(json["newTools"], false);
        assert_eq!(json["smaller"], false);
    }

    #[test]
    fn a_bad_signature_is_said_as_a_safety_check_and_nothing_is_installed() {
        let s = plain_update_error("the signature could not be verified: Invalid signature");
        assert!(s.contains("safety check") && s.contains("keeps working"), "{s}");
    }

    #[test]
    fn a_download_that_stops_moving_is_called_stalled_and_says_so_in_plain_words() {
        assert!(!is_stalled(10_000, 0, STALL_AFTER_MS));
        assert!(!is_stalled(44_999, 0, STALL_AFTER_MS));
        assert!(is_stalled(45_000, 0, STALL_AFTER_MS));
        // Data arriving keeps resetting the clock.
        assert!(!is_stalled(100_000, 70_000, STALL_AFTER_MS));
        assert!(STALLED_SENTENCE.contains("try again") && STALLED_SENTENCE.contains("keeps working"));
    }

    #[test]
    fn a_network_failure_is_said_in_plain_words() {
        for raw in ["error sending request for url (https://github.com/x): dns error", "operation timed out", "Could not connect"] {
            assert!(plain_update_error(raw).contains("Could not reach the update server"), "{raw}");
        }
    }

    #[test]
    fn any_other_failure_keeps_the_old_version_working() {
        assert!(plain_update_error("weird").contains("keeps working"));
        assert!(plain_update_error("HTTP status client error (404 Not Found)").contains("No update information"));
    }

    #[test]
    fn the_raw_error_text_is_never_shown() {
        let s = plain_update_error("C:\\Users\\someone\\secret path failed: signature mismatch");
        assert!(!s.contains("someone") && !s.contains("C:"), "{s}");
    }

    #[test]
    fn running_and_waiting_panes_count_and_each_agent_is_named_once() {
        let panes = [("claude", "running"), ("codex", "idle"), ("claude", "waiting_input"), ("gemini", "waiting_input"), ("shell", "exited")];
        assert_eq!(working_agents(panes), vec!["claude".to_string(), "gemini".to_string()]);
        assert!(working_agents([("codex", "idle")]).is_empty());
    }

    #[test]
    fn busy_agents_are_split_into_chats_and_terminals() {
        let busy = working_split([("claude", "running", true), ("codex", "waiting_input", false), ("claude", "running", true), ("shell", "idle", false)]);
        assert_eq!(busy.agents, vec!["claude".to_string(), "codex".to_string()]);
        assert_eq!(busy.chats, vec!["claude".to_string()]);
        assert_eq!(busy.terminals, vec!["codex".to_string()]);
    }

    #[test]
    fn a_failed_install_after_the_stop_is_marked_so_the_page_can_offer_to_reopen() {
        let said = update_stopped_error("installer failed");
        assert!(said.starts_with("UPDATE_STOPPED:") && said.contains("keeps working"), "{said}");
    }

    #[test]
    fn a_failed_install_means_the_app_is_not_ending_so_closing_a_chat_is_the_persons_again() {
        crate::acp::chat::begin_app_shutdown();
        assert!(crate::acp::chat::app_is_shutting_down());
        let said = update_stopped_error("installer failed");
        assert!(said.starts_with("UPDATE_STOPPED:"), "{said}");
        assert!(!crate::acp::chat::app_is_shutting_down(), "the flag stays set after the installer failed");
    }
}
