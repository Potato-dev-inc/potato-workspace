//! Agents sending work to another device: the MCP `run_agent` call with `account: "device:<name>"`.
//!
//! The tool catalog is unchanged: the target rides in the existing optional `account` field. Only `POST /agents/run`
//! with an account that starts with `device:` is taken here; every other request and every plain account id goes on
//! as before.
//!
//! - **Off by default, per device.** The person's switch (`Settings > Devices > <name>`) decides; with it off the
//!   caller gets a plain sentence.
//! - **No hops.** A request that itself arrived from another device or a phone is refused: a device never forwards
//!   what another device sent.
//! - **The far device decides.** It needs to have given this PC Full control; its refusal comes back in its own words.
//!   A sign-in is never sent: the far device runs the agent with its own.
//! - This module knows nothing of the link; the app gives it a [`DeviceSender`] (`device_link/app.rs`).

use std::sync::{Arc, OnceLock};

use serde_json::Value;

use crate::operations::OperationError;

#[cfg(test)]
mod tests;

pub const PREFIX: &str = "device:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub node: String,
    pub name: String,
}

pub trait DeviceSender: Send + Sync {
    /// A paired device by name (any case) or the start of its id.
    fn resolve(&self, name_or_prefix: &str) -> Result<Target, String>;
    /// The person's switch for that device.
    fn may_send(&self, node: &str) -> bool;
    /// One bridge request on that device. A refusal by the far side comes back as its own status and words.
    fn request(&self, node: &str, method: &str, path: &str, body: Value) -> Result<(u16, Value), String>;
}

static SENDER: OnceLock<Arc<dyn DeviceSender>> = OnceLock::new();

pub fn set_sender(sender: Arc<dyn DeviceSender>) {
    let _ = SENDER.set(sender);
}

fn refuse(code: &str, message: impl Into<String>) -> Option<Result<Value, OperationError>> {
    Some(Err(OperationError::new(code, message, false)))
}

/// `Some(answer)` when this request is a run on another device, `None` for everything else.
pub fn intercept(method: &str, segments: &[&str], body: &[u8], remote_device: bool) -> Option<Result<Value, OperationError>> {
    intercept_with(SENDER.get().map(|s| s.as_ref()), method, segments, body, remote_device)
}

pub(crate) fn intercept_with(
    sender: Option<&dyn DeviceSender>,
    method: &str,
    segments: &[&str],
    body: &[u8],
    remote_device: bool,
) -> Option<Result<Value, OperationError>> {
    if method != "POST" || segments != ["agents", "run"] {
        return None;
    }
    let mut request: Value = serde_json::from_slice(body).ok()?;
    let wanted = request.get("account")?.as_str()?.strip_prefix(PREFIX)?.to_string();
    if remote_device {
        return refuse("DEVICE_NO_HOPS", "Work that came from another device cannot be sent on to a third one.");
    }
    let Some(sender) = sender else {
        return refuse("DEVICES_OFF", "Devices is switched off. Turn it on in Labs to send work to another device.");
    };
    let target = match sender.resolve(&wanted) {
        Ok(t) => t,
        Err(message) => return refuse("DEVICE_NOT_FOUND", message),
    };
    if !sender.may_send(&target.node) {
        return refuse(
            "DEVICE_SEND_OFF",
            format!("{0} does not let agents send work to it. Turn it on: Settings > Devices > {0}.", target.name),
        );
    }
    if let Some(map) = request.as_object_mut() {
        for key in ["account", "worker_id", "handle"] {
            map.remove(key);
        }
    }
    match sender.request(&target.node, "POST", "/agents/run", request) {
        Ok((status, mut answer)) if status < 300 => {
            if let Some(map) = answer.as_object_mut() {
                map.insert("device".into(), Value::String(target.name));
            }
            Some(Ok(answer))
        }
        Ok((status, answer)) => {
            let message = answer["message"].as_str().or_else(|| answer["hint"].as_str()).or_else(|| answer["error"].as_str()).unwrap_or("The device refused.");
            let code = answer["code"].as_str().unwrap_or(if status == 403 { "DEVICE_REFUSED" } else { "DEVICE_ERROR" });
            refuse(code, format!("{}: {message}", target.name))
        }
        Err(message) => refuse("DEVICE_UNREACHABLE", format!("{}: {message}", target.name)),
    }
}
