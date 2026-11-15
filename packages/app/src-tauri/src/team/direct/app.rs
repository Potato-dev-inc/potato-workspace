//! The app's own wiring of the pass-a-task service: the live team session, the lend feature, and the window event.

use std::sync::{Arc, OnceLock};

use super::service::{Deps, Direct, LendPort, Port};
use super::wire::LendOffer;
use crate::capacity_proxy::service::OfferGate;
use crate::team::secure::{CapacityIn, Payload, Session};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static SERVICE: OnceLock<Arc<Direct>> = OnceLock::new();

/// One line in `lib.rs` setup: keeps the handle for `team://tasks-changed`. Builds nothing.
pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

struct AppPort;

impl Port for AppPort {
    fn session(&self) -> Result<Session, String> {
        crate::team::service::capacity_session()
    }
    fn send(&self, payload: &Payload) -> Result<(), String> {
        crate::team::service::capacity_send(payload)
    }
}

struct AppLend;

impl LendPort for AppLend {
    fn enabled(&self) -> bool {
        crate::capacity_proxy::enabled()
    }
    fn profile_for_task(&self, member_id: &str, profile_id: &str, secs: u64) -> Result<(String, Vec<String>), String> {
        crate::capacity_proxy::app_service()?.profile_for_task(member_id, profile_id, secs)
    }
    fn request(&self, member_id: &str, device_id: &str, offer: &LendOffer, reason: &str, task_id: &str) -> Result<(), String> {
        crate::capacity_proxy::app_service()?
            .request_for_task(member_id, device_id, &offer.agent_id, offer.secs, reason, &offer.profile_id, &offer.profile_name, task_id)
            .map(|_| ())
    }
}

/// The app's service, built the first time it is needed.
pub fn app_service() -> Arc<Direct> {
    SERVICE
        .get_or_init(|| {
            Direct::new(Deps {
                dir: crate::app_paths::app_data_dir().join("team-tasks"),
                port: Arc::new(AppPort),
                lend: Arc::new(AppLend),
                now: Arc::new(crate::capacity_proxy::now_ms),
                changed: Arc::new(|| {
                    if let Some(app) = APP.get() {
                        use tauri::Emitter;
                        let _ = app.emit("team://tasks-changed", ());
                    }
                }),
                spawn: Arc::new(|f| {
                    std::thread::spawn(f);
                }),
                pace_ms: 150,
            })
        })
        .clone()
}

/// The team relay delivered a pass-a-task item (`team::service`).
pub fn on_team_item(item: CapacityIn) {
    if let Err(why) = app_service().on_item(&item) {
        if why != super::wire::WireReject::NotForMe {
            tracing::info!(why = why.as_str(), "team tasks: item refused");
        }
    }
}

struct AppGate;

impl OfferGate for AppGate {
    fn claim(&self, offer_ref: &str, member_id: &str, device_id: &str, profile_id: Option<&str>, secs: u64) -> bool {
        app_service().claim(offer_ref, member_id, device_id, profile_id, secs)
    }
}

/// What `capacity_proxy` asks before it answers a request that names a task.
pub fn offer_gate() -> Arc<dyn OfferGate> {
    Arc::new(AppGate)
}
