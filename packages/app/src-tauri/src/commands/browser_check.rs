//! "Check it in the browser" (R4-11): the button next to a pane's Preview chip. It opens the app's page in the agent
//! browser, looks at the console and the network, takes a picture and answers pass or fail. The answer goes to the
//! pane's Chat tab as a card (frontend `CheckCard`).

use serde_json::Value;
use tauri::AppHandle;

/// Whether the Labs switch "Agent browser" is on (the Check it button shows only then).
#[tauri::command]
pub fn browser_check_enabled(app: AppHandle) -> bool {
    crate::browser::live::enabled(&app)
}

/// Runs the check on the page at `url` (a dev server on this computer). The answer is the card's data:
/// `{verdict, pass, url, title, loaded, problem_count, problems, screenshot}`; `verdict` is `pass`, `fail` or
/// `sign_in`. An error is one plain sentence.
#[tauri::command]
pub async fn browser_check_it(app: AppHandle, pane_id: String, url: String) -> Result<Value, String> {
    let session = format!("check-it:{pane_id}");
    tauri::async_runtime::spawn_blocking(move || crate::browser::live::check_it(&app, &url, &session))
        .await
        .map_err(|e| format!("The check stopped early ({e})."))?
        .map_err(|e| e.message)
}

/// The globe button: opens the browser window for the person to browse (or brings it forward). Always available:
/// only an agent's use of it needs the Labs switch. `url` is optional; it goes through the same guard as an agent's.
/// The window is the one every agent joins ("use this page").
#[tauri::command]
pub async fn browser_open_window(app: AppHandle, url: Option<String>) -> Result<(), String> {
    let dev_port = app.config().build.dev_url.as_ref().and_then(|u| u.port());
    let checked = match url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(typed) => {
            let address = crate::browser::chrome::address_from_typed(typed).ok_or("That is not a web address.")?;
            // The name lookup can take a moment: do it off the main thread.
            let result = tauri::async_runtime::spawn_blocking(move || crate::browser::guard::check_url(&address, dev_port)).await.map_err(|e| e.to_string())?;
            Some(result.map_err(|(_, message)| message.to_string())?.0)
        }
        None => None,
    };
    let info = crate::point::window::open_person_browser(&app, checked.as_deref())?;
    crate::browser::live::adopt_person_window(&info.preview_id);
    Ok(())
}
