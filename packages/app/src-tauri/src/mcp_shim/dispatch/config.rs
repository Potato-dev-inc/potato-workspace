//! `workspace_config`: one bridge request with the arguments untouched. The app decides who may call and asks the person
//! before a plan is applied (`bridge/routes/config.rs`); the shim only forwards, with the session header it always sends.

use super::super::*;
use std::sync::mpsc::Receiver;

pub(super) fn dispatch(name: &str, args: &Value, _cancel_rx: Option<&Receiver<()>>) -> Option<Result<String, String>> {
    (name == "workspace_config").then(|| bridge_request("POST", "/config/op", Some(args.clone())))
}
