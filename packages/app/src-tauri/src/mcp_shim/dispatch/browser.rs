//! The agent browser tools (`browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_console`): one
//! bridge request each, with the arguments untouched. The app decides who may ask and whether the Labs switch is on
//! (`bridge/routes/browser_mcp.rs`); the shim only forwards, with the session header it always sends.

use super::super::*;
use std::sync::mpsc::Receiver;

pub(super) fn dispatch(name: &str, args: &Value, _cancel_rx: Option<&Receiver<()>>) -> Option<Result<String, String>> {
    let path = match name {
        "browser_open" => "/browser/open",
        "browser_read" => "/browser/read",
        "browser_click" => "/browser/click",
        "browser_type" => "/browser/type",
        "browser_console" => "/browser/console",
        _ => return None,
    };
    Some(bridge_request("POST", path, Some(args.clone())))
}
