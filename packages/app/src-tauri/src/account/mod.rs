//! Potato account (phase 1): one sign-in for your devices. The account is an address book (who you are, which
//! devices are yours), never a vault: it holds no agent login, key, chat or file, and nothing in here carries one.
//! Plan: `D:\pm-night\PLAN-POTATO-ACCOUNT.md`; the server is `account/server`.
//!
//! - `signin`: the sign-in this app started, and the one deep link that may finish it.
//! - `statement`: what this device signs (its device statement, a revocation, every request).
//! - `store`: the session in the OS credential store.
//! - `client`: the HTTP calls. `service`: the app-level operations. `commands/account.rs`: the window commands.

pub use signin::link_shape;
pub mod client;
pub mod directory;
pub mod service;
pub mod signin;
pub mod statement;
pub mod store;

#[cfg(test)]
mod tests;

use tauri::{AppHandle, Emitter};

/// The window hears this when the sign-in state changed.
pub const CHANGED_EVENT: &str = "pm-account-changed";

/// A deep link that finishes the sign-in this app started. Returns whether the link was a sign-in link
/// (valid or not), so the invite code does not look at it again. The ticket is redeemed here; the window never
/// sees it.
pub fn handle_link<S: AsRef<str>>(app: &AppHandle, urls: &[S]) -> bool {
    let mut looked_like_one = false;
    let mut found = None;
    for u in urls {
        match signin::check_link(u.as_ref()) {
            Ok(link) => {
                found = Some(link);
                break;
            }
            Err(signin::Refused::NotSignIn) => {}
            Err(why) => {
                looked_like_one = true;
                tracing::debug!(reason = why.why(), "sign-in link refused");
            }
        }
    }
    let Some(link) = found else {
        // A link that was meant as a sign-in (but is malformed) is still not an invite: say so and stop here.
        return looked_like_one;
    };
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("account-signin".into()).spawn(move || {
        if service::service().finish_sign_in(&link) {
            crate::cockpit::open_cockpit(&app, None);
            // Signed in: a PC that lets its other PCs open it tells the account where it is.
            crate::device_link::app::account_changed();
        }
        let _ = app.emit(CHANGED_EVENT, ());
    });
    drop(spawned);
    true
}
