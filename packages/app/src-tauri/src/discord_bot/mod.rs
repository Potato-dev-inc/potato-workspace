//! A companion on Discord, with the person's own bot (P3 of the fishd port, Labs `discord_bot_enabled`, off).
//!
//! The person makes a bot in the Discord developer page, pastes its token here once, and lists the servers and
//! channels where it may answer. Nothing else is open: an empty list means it answers nowhere.
//!
//! What it is NOT: it is not a way to reach the companion's agent pane. Every message from Discord is typed by
//! a stranger, so it is data. The reply comes from the small brain (`companion::brain`) over the person's own AI
//! key, with no tools: no shell, no files, no `delegate`, no pane message, no sandbox, no MCP.
//!
//! - `token`: the bot token, only in the OS credential store, write-only in the UI, never printed or logged.
//! - `config`: `discord-bot.json` (the allow list, owners, names, the gate, the budget). No secret in it.
//! - `scope`: the hard boundary: default-deny, bots and itself ignored, a direct message only from an owner.
//! - `gateway`: the WebSocket client (HELLO, heartbeat, IDENTIFY, READY, MESSAGE_CREATE, RESUME, back-off).
//! - `rest`: the one POST, with `allowed_mentions.parse = []`, and the wait on a 429.
//! - `service`: one bot: scope, hard triggers, the gate for joining in, the queue, the brain, the reply.
//! - `live`: the only place that starts threads. Nothing starts while the Labs switch is off.
//!
//! Nothing connects to discord.com in tests or by default. Tests run against a fake gateway on this computer
//! (`fake_gateway`), and the real addresses are fixed in `Real`: a local address can only be built in tests.

pub mod config;
pub mod gateway;
pub mod live;
pub mod rest;
pub mod scope;
pub mod service;
pub mod token;

#[cfg(test)]
pub mod fake_gateway;
#[cfg(test)]
mod guard_tests;
#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::Value;

/// The Labs switch. Set from the effective settings, so a development build reads it as on.
pub const LABS_KEY: &str = "discord_bot_enabled";
static ENABLED: AtomicBool = AtomicBool::new(false);
static VAULT: AtomicBool = AtomicBool::new(false);

pub const OFF: &str = "The Discord bot is off. Turn it on in Settings > General > Labs.";

/// Called with the effective settings each time they change (and once at start-up).
pub fn apply_settings(settings: &Value) {
    let on = settings.get(LABS_KEY).and_then(Value::as_bool) == Some(true);
    let was = ENABLED.swap(on, Ordering::SeqCst);
    VAULT.store(settings.get("companion_vault_enabled").and_then(Value::as_bool) == Some(true), Ordering::SeqCst);
    if on || was {
        live::settings_changed();
    }
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// The companion vault is on too, so what is heard and said goes into the journal.
pub fn vault_on() -> bool {
    VAULT.load(Ordering::SeqCst)
}

/// What the card shows about the connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// The bot is switched off.
    Off,
    /// There is no token yet.
    NoToken,
    Connecting,
    Online,
    /// Discord did not accept the token.
    TokenRejected,
    /// "Message Content" is not turned on in the Discord developer page.
    IntentMissing,
    /// It stopped for another reason and will not retry.
    Stopped,
}

/// Where the bot connects. The real one is fixed; a local one exists only in tests.
pub trait Transport: Send + Sync {
    fn gateway_url(&self) -> String;
    fn rest_base(&self) -> String;
    /// May the gateway's own "resume here" address be used?
    fn resume_ok(&self, url: &str) -> bool;
}

pub const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=10&encoding=json";
pub const REST_BASE: &str = "https://discord.com/api/v10";

pub struct Real;

impl Transport for Real {
    fn gateway_url(&self) -> String {
        GATEWAY_URL.into()
    }
    fn rest_base(&self) -> String {
        REST_BASE.into()
    }
    fn resume_ok(&self, url: &str) -> bool {
        url.strip_prefix("wss://").is_some_and(|rest| {
            let host = rest.split(['/', ':', '?']).next().unwrap_or("");
            host == "discord.gg" || host.ends_with(".discord.gg")
        })
    }
}

/// An address on this computer, for tests only.
#[cfg(test)]
pub struct Local {
    gateway: String,
    rest: String,
}

#[cfg(test)]
impl Local {
    pub fn new(gateway_port: u16, rest_port: u16) -> Self {
        Self { gateway: format!("ws://127.0.0.1:{gateway_port}/?v=10&encoding=json"), rest: format!("http://127.0.0.1:{rest_port}/api/v10") }
    }
}

#[cfg(test)]
impl Transport for Local {
    fn gateway_url(&self) -> String {
        self.gateway.clone()
    }
    fn rest_base(&self) -> String {
        self.rest.clone()
    }
    fn resume_ok(&self, url: &str) -> bool {
        url.starts_with("ws://127.0.0.1:")
    }
}

/// Every connection goes through here first. In tests it stops the run if an address is not this computer.
#[cfg_attr(not(test), allow(unused_variables))]
pub fn net_guard(url: &str) {
    #[cfg(test)]
    {
        let rest = url.split_once("://").map_or(url, |(_, r)| r);
        let host = rest.split(['/', ':', '?']).next().unwrap_or("");
        assert!(host == "127.0.0.1" || host == "localhost", "a Discord test tried to open a real address: {host}");
    }
}
