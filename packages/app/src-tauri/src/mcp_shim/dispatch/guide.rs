//! The project guide tools (`read_guide_structure`, `read_guide_page`, `ask_guide`): one bridge request each, with the
//! arguments untouched. The app decides who may ask and whether the Labs switch is on (`bridge/routes/guide_mcp.rs`);
//! the shim only forwards, with the session header it always sends.

use super::super::*;
use std::sync::mpsc::Receiver;

pub(super) fn dispatch(name: &str, args: &Value, _cancel_rx: Option<&Receiver<()>>) -> Option<Result<String, String>> {
    let path = match name {
        "read_guide_structure" => "/guide/structure",
        "read_guide_page" => "/guide/page",
        "ask_guide" => "/guide/ask",
        _ => return None,
    };
    Some(bridge_request("POST", path, Some(args.clone())))
}
