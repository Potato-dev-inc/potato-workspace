//! Tauri commands for "Leaving my desk" (`mobile_pairing::desk_away`): the status bar chip and the palette read the
//! state, switch it on for a chosen length, and press "I'm back". The phone has the same switch on the bridge
//! (`bridge/routes/phone_control.rs`).

use crate::mobile_pairing::desk_away::{self, By, Length};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

fn now() -> u64 {
    crate::mobile_pairing::control_ask::now_ms()
}

/// Is the person away, until when, and who flipped it.
#[tauri::command]
pub fn get_desk_away() -> Value {
    desk_away::status_json(now())
}

/// Switch it on from the PC. `length` is `until_back`, `one_hour`, `four_hours` or `tonight`.
#[tauri::command]
pub fn start_desk_away(app: AppHandle, length: String, lock_screen: bool) -> Result<Value, String> {
    let length = Length::parse(&length)?;
    let away = desk_away::start(length, lock_screen, By::Pc, None);
    crate::audit::record(
        crate::audit::Kind::Pairing,
        crate::audit::Who::Desktop,
        "You handed the day to your phone",
        serde_json::json!({ "length": away.length, "lock_screen": away.lock_screen }),
    );
    let status = desk_away::status_json(now());
    let _ = app.emit(desk_away::AWAY_EVENT, &status);
    Ok(status)
}

/// "I'm back": phones lose the raised control, push goes back to the person's own levels, screen control opens.
#[tauri::command]
pub fn end_desk_away(app: AppHandle) -> Value {
    if desk_away::back() {
        crate::audit::record(crate::audit::Kind::Pairing, crate::audit::Who::Desktop, "You said you are back", serde_json::json!({}));
    }
    let status = desk_away::status_json(now());
    let _ = app.emit(desk_away::AWAY_EVENT, &status);
    status
}
