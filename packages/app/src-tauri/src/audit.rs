//! The app's audit log lives in `pm-core` (`pm_core::audit`); this module keeps the old path and the one function that needs
//! the app's pairing store.

pub use pm_core::audit::*;
use serde_json::json;

/// Device events the pairing store emits (`mobile_pairing::events`) that no call site records
/// itself: a phone's abilities changed (Settings > Phone > Devices). Pairing and removing a phone
/// are recorded where they happen (`bridge/routes/pairing.rs`, `commands/app.rs`), which also know
/// who did it, so they are not recorded twice here. Registered once, when the bridge starts.
pub fn watch_device_events() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        crate::mobile_pairing::events::subscribe(|event| {
            if let crate::mobile_pairing::events::SecurityEvent::DeviceCapsChanged { device_id, caps } = event {
                record(
                    Kind::Pairing,
                    Who::Desktop,
                    "You changed what a paired phone may do",
                    json!({ "device_id": device_id, "caps": caps }),
                );
            }
        });
    });
}
