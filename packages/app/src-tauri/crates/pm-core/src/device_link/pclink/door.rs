//! The door of the far side of a PC link. It is a `HostBridge` (what `serve.rs` hands every request to), and it decides which
//! router a request goes to, by its first path part:
//!
//! - `/pclink/...`: the PC link's own routes (`pclink::handle`), under the PC's own level.
//! - `POST /agents/run` and `POST /lend/item`: the two older PC-to-PC doors that are not phone routes (an agent on one PC
//!   sending work to the other, and lending between my own PCs). They still run through the bridge's link entry, behind
//!   their own checks, and nothing else does.
//! - anything else, the phone's routes included (`/phone/...`, `/panes/...`, `/acp/...`): not found, and the answer says where
//!   to go. A PC is never given the phone's route table.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{events, handle, Asks, Caller, Level, Services};
use crate::device_link::serve::HostBridge;

type LevelOf = Arc<dyn Fn(&str) -> Option<Level> + Send + Sync>;
type NameOf = Arc<dyn Fn(&str) -> String + Send + Sync>;

pub struct Door {
    /// The old door, reachable only for the two routes above.
    pub legacy: Arc<dyn HostBridge>,
    pub services: Arc<dyn Services>,
    pub asks: Arc<Asks>,
    /// What this PC lets that node do now (read from the trust list at every request).
    pub level_of: LevelOf,
    pub name_of: NameOf,
    /// Whether that node carries the account marker (it is the person's own PC): no press and hold is asked of it.
    pub marked_of: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// Whether this PC lets that node borrow its agent sign-ins (the lend right, its own switch).
    pub lend_ok: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// The two routes that still use the old door.
pub fn legacy_ok(method: &str, segs: &[&str]) -> bool {
    matches!((method, segs), ("POST", ["agents", "run"]) | ("POST", ["lend", "item"]))
}

/// Pins a closure to "any lifetime in, same lifetime out" (the form `Services::events` takes).
fn higher<F: for<'a> Fn(&'a str) -> Option<std::borrow::Cow<'a, str>>>(f: F) -> F {
    f
}

fn answer(status: u16, value: Value) -> (u16, Vec<u8>) {
    (status, serde_json::to_vec(&value).unwrap_or_default())
}

#[async_trait]
impl HostBridge for Door {
    async fn call(&self, node: &str, method: &str, target: &str, body: Vec<u8>) -> (u16, Vec<u8>) {
        let path = target.split('?').next().unwrap_or("");
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if segs.first() == Some(&"pclink") {
            let (node, method, target) = (node.to_string(), method.to_string(), target.to_string());
            let (services, asks, level_of, name_of, marked_of, now_ms) = (self.services.clone(), self.asks.clone(), self.level_of.clone(), self.name_of.clone(), self.marked_of.clone(), self.now_ms.clone());
            let done = tokio::task::spawn_blocking(move || {
                let name = name_of(&node);
                let who = Caller { node: &node, name: &name, level: level_of(&node), marked: marked_of(&node), now_ms: now_ms() };
                handle(&who, services.as_ref(), &asks, &method, &target, &body)
            })
            .await;
            return match done {
                Ok((status, value)) => answer(status, value),
                Err(_) => answer(500, json!({ "error": "the request failed" })),
            };
        }
        if legacy_ok(method, &segs) {
            // The two older doors are checked HERE, whatever the bridge behind them says: running work needs Full, lending needs the lend right.
            let (name, allowed) = match segs.as_slice() {
                ["agents", "run"] => ("full", (self.level_of)(node) == Some(Level::Full)),
                _ => ("lend", (self.lend_ok)(node)),
            };
            if !allowed {
                return answer(403, json!({ "error": "not_allowed", "code": "DEVICE_NOT_ALLOWED", "needs": name, "hint": "This PC does not let that PC do this. Change it in Settings > Devices." }));
            }
            if segs.as_slice() == ["agents", "run"] {
                // Only a folder this PC already knows: never an arbitrary path (the sender's own path means nothing here).
                let named = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.get("project_path").and_then(Value::as_str).map(str::to_string)).filter(|p| !p.trim().is_empty());
                if let Some(folder) = named {
                    let services = self.services.clone();
                    let known = tokio::task::spawn_blocking(move || services.known_folder(&folder)).await.unwrap_or(false);
                    if !known {
                        return answer(404, json!({ "error": "This PC does not know that project. Open it here first.", "code": "UNKNOWN_PROJECT" }));
                    }
                }
            }
            return self.legacy.call(node, method, target, body).await;
        }
        answer(404, json!({ "error": "not found", "code": "USE_PCLINK", "hint": "One PC reaches another through /pclink/ routes only." }))
    }

    async fn poll(&self, node: &str, cursor: Option<u64>, wait: Duration) -> Option<(u64, String)> {
        (self.level_of)(node)?;
        let (node, services, level_of) = (node.to_string(), self.services.clone(), self.level_of.clone());
        let services_of = services.clone();
        let done = tokio::task::spawn_blocking(move || {
            let view = higher(|payload: &str| {
                let level = level_of(&node)?;
                let seen = events::view(level, payload)?;
                // A session switched off for other PCs on its own PC shows no frame either.
                if events::app_pane(&seen).is_some_and(|pane| services_of.ceiling(&pane).is_none()) {
                    return None;
                }
                // Terminal output is metered per PC (a flood becomes "redraw from the screen").
                services_of.frame_for(&node, seen.into_owned()).map(std::borrow::Cow::Owned)
            });
            let out = services.events(cursor, wait, &view);
            level_of(&node).map(|_| out)
        })
        .await;
        done.ok().flatten()
    }
}
