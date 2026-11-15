//! Discord bot commands (Labs `discord_bot_enabled`): the status, saving or removing the token, saving the
//! settings and an offline check. Desktop only: these are Tauri commands, not bridge routes, not MCP tools and
//! not phone routes, so an agent, a companion or a paired phone cannot read the token or change the allow list.
//!
//! Only an app window may call them. The token goes in and never comes back: no command here returns it, and
//! the status holds only whether one is saved and its last four characters.
//!
//! They are async and run the credential store off the window's thread.

use serde::Serialize;

use crate::companion::{model::valid_id, store};
use crate::discord_bot::{self as bot, config::BotSettings, live, live::BotStatus, token};

/// The windows that may use the Discord bot: the cockpit shows the card, Settings the switch.
const WINDOWS: [&str; 3] = ["cockpit", "main", "settings"];

fn guard(webview: &tauri::Webview) -> Result<(), String> {
    if WINDOWS.contains(&webview.label()) {
        Ok(())
    } else {
        Err("The Discord bot works only in the app window.".to_string())
    }
}

/// Window check and switch check in one place.
fn on(webview: &tauri::Webview) -> Result<(), String> {
    guard(webview)?;
    if bot::enabled() {
        Ok(())
    } else {
        Err(bot::OFF.to_string())
    }
}

/// The id of a companion that exists.
fn known(id: &str) -> Result<(), String> {
    let root = crate::app_paths::app_data_dir();
    let found = valid_id(id) && store::load_all(&root).map(|(list, _)| list.iter().any(|p| p.id == id)).unwrap_or(false);
    if found {
        Ok(())
    } else {
        Err("No companion has that id.".to_string())
    }
}

fn status_of(id: &str) -> BotStatus {
    live::status(&crate::app_paths::app_data_dir(), crate::secrets::backend(), id, bot::enabled(), crate::push::now_ms() as i64)
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "That did not finish. Try again.".to_string())?
}

#[tauri::command]
pub async fn discord_bot_status(webview: tauri::Webview, id: String) -> Result<BotStatus, String> {
    guard(&webview)?;
    blocking(move || {
        known(&id)?;
        Ok(status_of(&id))
    })
    .await
}

/// Keeps the pasted token in the credential store. It is not shown again and not returned.
#[tauri::command]
pub async fn discord_bot_set_token(webview: tauri::Webview, id: String, token: String) -> Result<BotStatus, String> {
    on(&webview)?;
    blocking(move || {
        known(&id)?;
        token::save_with(crate::secrets::backend(), &id, &token)?;
        live::restart(&id);
        Ok(status_of(&id))
    })
    .await
}

/// Removes the token and turns the bot off.
#[tauri::command]
pub async fn discord_bot_clear(webview: tauri::Webview, id: String) -> Result<BotStatus, String> {
    guard(&webview)?;
    blocking(move || {
        known(&id)?;
        token::forget_with(crate::secrets::backend(), &id)?;
        let root = crate::app_paths::app_data_dir();
        let mut settings = bot::config::load(&root, &id);
        if settings.on {
            settings.on = false;
            bot::config::save(&root, &id, settings)?;
        }
        live::reconcile_one(&id, false);
        Ok(status_of(&id))
    })
    .await
}

#[tauri::command]
pub async fn discord_bot_save_settings(webview: tauri::Webview, id: String, settings: BotSettings) -> Result<BotStatus, String> {
    on(&webview)?;
    blocking(move || {
        known(&id)?;
        bot::config::save(&crate::app_paths::app_data_dir(), &id, settings)?;
        live::reconcile_one(&id, true);
        Ok(status_of(&id))
    })
    .await
}

#[derive(Serialize)]
pub struct DiscordBotTest {
    pub ok: bool,
    pub message: String,
}

/// An offline check: is a token saved, and is anything allowed. Nothing is sent to Discord.
#[tauri::command]
pub async fn discord_bot_test(webview: tauri::Webview, id: String) -> Result<DiscordBotTest, String> {
    on(&webview)?;
    blocking(move || {
        known(&id)?;
        let status = status_of(&id);
        let outcome = if !status.store_available {
            DiscordBotTest { ok: false, message: token::NO_STORE.to_string() }
        } else if !status.set {
            DiscordBotTest { ok: false, message: "No token is saved yet.".to_string() }
        } else if status.settings.allow.is_empty() {
            DiscordBotTest { ok: true, message: "The token is saved. It answers nowhere until you add a server.".to_string() }
        } else {
            DiscordBotTest { ok: true, message: "The token is saved and a server is on the list. Nothing was sent to Discord.".to_string() }
        };
        Ok(outcome)
    })
    .await
}
