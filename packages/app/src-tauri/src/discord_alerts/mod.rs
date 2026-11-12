//! Discord alerts (replaces Tag Your Agent): the person pastes a Discord webhook link, presses Test, and chooses which
//! alerts to post to that channel: needs you, finished, failed. No bot. Off until a link is saved.
//!
//! - `webhook`: the strict link check (https, discord hosts, `/api/webhooks/<id>/<token>`).
//! - `client`: the one POST, with timeouts; its errors are fixed words and never hold the link.
//! - `service`: the saved link (OS credential store only), the choices (a small json file), the rate limit.
//!
//! The words come from the same place as the phone and Telegram alerts (`push::triggers::copy_for_view`) and go
//! through the same outgoing cleaning (`channels::render::clean_multiline`), so secrets in agent text are masked.
//! The link is never written to a settings file, a log or an error text. Nothing here names an agent.

pub mod client;
pub mod service;
pub mod webhook;

#[cfg(test)]
mod tests;

use crate::push::hub::Candidate;
use crate::push::triggers::{copy_for_view, View};
use once_cell::sync::Lazy;
use service::{AlertKind, Service};

/// Discord allows 2000 characters in a message. Stay well under it.
pub const MAX_CHARS: usize = 1800;

static SERVICE: Lazy<Service> = Lazy::new(|| {
    Service::new(
        crate::secrets::backend(),
        crate::app_paths::app_data_dir().join("discord-alerts.json"),
        Box::new(client::UreqPost::new()),
    )
});

pub fn service() -> &'static Service {
    &SERVICE
}

/// Load the saved link and choices; call once at start-up.
pub fn init() {
    service().init();
}

/// A link is saved and at least one alert is on: worth building a notification for.
pub fn listening() -> bool {
    service().listening()
}

/// The words of an alert, cleaned like every outgoing message, cut to `MAX_CHARS`.
pub fn message_for(candidate: &Candidate) -> String {
    let words = copy_for_view(
        candidate.kind,
        &candidate.agent_label,
        candidate.heading.as_deref(),
        candidate.prompt.as_ref(),
        candidate.detail.as_deref(),
        View::Full,
    );
    let raw = format!("{}\n{}", words.title, words.body);
    crate::channels::render::clean_multiline(&raw, MAX_CHARS).as_str().to_string()
}

/// A notification candidate (the same ones the phone and Telegram get): posts it on its own thread if its kind is on.
pub fn offer(candidate: &Candidate) {
    let Some(kind) = AlertKind::of(candidate.kind) else { return };
    if !service().wants(kind) {
        return;
    }
    let text = message_for(candidate);
    let key = candidate.key.clone();
    let spawned = std::thread::Builder::new().name("discord-alert".into()).spawn(move || {
        let outcome = service().send_alert(kind, &key, &text, crate::push::now_ms());
        if let service::Outcome::Failed(e) = outcome {
            // `e` is fixed words: it never holds the link.
            tracing::debug!(error = %e, "a Discord alert was not posted");
        }
    });
    drop(spawned);
}
