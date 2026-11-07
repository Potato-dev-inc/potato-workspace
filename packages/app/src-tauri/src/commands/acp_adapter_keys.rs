//! Tauri commands for the keys a reviewed adapter asks for (`acp::adapter_keys`). Set, status and clear only: a
//! status answers names and yes/no, never a value. Behind the same Labs switch as the other ACP overlay commands.

use crate::acp::adapter_keys::{self, KeyStatus};

/// Saves the value of one key the adapter asks for. The value is never echoed back.
#[tauri::command]
pub fn acp_adapter_key_set(adapter_id: String, env: String, value: String) -> Result<(), String> {
    super::acp_overlay::labs_gate()?;
    adapter_keys::set(adapter_id.trim(), env.trim(), value.trim())?;
    crate::redact::known::refresh();
    Ok(())
}

/// Each key the adapter asks for, with whether a value is saved. No values.
#[tauri::command]
pub fn acp_adapter_key_status(adapter_id: String) -> Result<Vec<KeyStatus>, String> {
    super::acp_overlay::labs_gate()?;
    adapter_keys::status(adapter_id.trim())
}

/// Removes a key kept for this adapter only (a key shared with Keys settings is cleared there).
#[tauri::command]
pub fn acp_adapter_key_clear(adapter_id: String, env: String) -> Result<(), String> {
    super::acp_overlay::labs_gate()?;
    adapter_keys::clear(adapter_id.trim(), env.trim())?;
    crate::redact::known::refresh();
    Ok(())
}
