//! The account in the app: start a sign-in, finish it from the link, list the devices, sign a device out.
//! Everything the window gets is a plain view ("signed in as X", a device list); the session token and the
//! verifier never leave this module.

use super::client::{configured_base, ApiError, Client};
use super::signin::{PendingSignIn, SignInLink};
use super::statement::{device_statement, revoke_statement};
use super::store::{SessionStore, StoredSession};
use crate::keys::crypto::SigningKey;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AccountInfo {
    pub id: String,
    pub display_name: String,
    pub provider: String,
}

/// What the window may know. No token, no verifier, no key.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    /// The address of the account service is known; without it there is nothing to sign in to.
    pub configured: bool,
    pub signed_in: bool,
    /// A sign-in was started and its link has not come back yet.
    pub waiting: bool,
    /// The last thing that went wrong, as a plain sentence.
    pub message: Option<String>,
    pub account: Option<AccountInfo>,
    pub device_id: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DeviceRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub created_at: u64,
    pub last_seen_at: u64,
    pub online: bool,
    pub revoked: bool,
    pub not_me: bool,
    pub is_this: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct DevicesReply {
    pub signed_in: bool,
    pub devices: Vec<DeviceRow>,
}

/// Where the pieces come from. The app uses the real ones; tests give a memory store and a local server.
pub struct Parts {
    pub store: SessionStore,
    pub key: Box<dyn Fn() -> Result<SigningKey, String> + Send + Sync>,
    pub base: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub name: Box<dyn Fn() -> String + Send + Sync>,
    pub open: Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
}

pub struct AccountService {
    parts: Parts,
    pending: PendingSignIn,
    message: Mutex<Option<String>>,
}

/// This device's name in the list: the computer's name, with the profile when this is not the default one.
fn device_name() -> String {
    let base = crate::device_identity::computer_name();
    let name = match crate::app_paths::profile() {
        Some(p) if p != "dev" => format!("{base} ({p})"),
        _ => base,
    };
    name.chars().take(40).collect()
}

/// Open the sign-in page in the system browser. A development build can write the address to a file instead
/// (`PM_ACCOUNT_URL_FILE`), so a test run opens no window.
fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("PM_ACCOUNT_URL_FILE") {
        return std::fs::write(path, url).map_err(|e| e.to_string());
    }
    crate::app_lifecycle::open_external_url(url.to_string())
}

impl AccountService {
    pub fn app() -> Self {
        Self::new(Parts {
            store: SessionStore::app(),
            key: Box::new(|| crate::keys::KeyStore::app().device_sign()),
            base: Box::new(configured_base),
            name: Box::new(device_name),
            open: Box::new(open_in_browser),
        })
    }

    pub fn new(parts: Parts) -> Self {
        Self { parts, pending: PendingSignIn::default(), message: Mutex::new(None) }
    }

    fn say(&self, text: Option<String>) {
        *self.message.lock() = text;
    }

    /// A session counts only for the server it was made on.
    fn session(&self) -> Option<StoredSession> {
        let session = self.parts.store.load()?;
        let base = (self.parts.base)()?;
        (session.server == base).then_some(session)
    }

    pub fn view(&self) -> AccountView {
        let session = self.session();
        AccountView {
            configured: (self.parts.base)().is_some(),
            signed_in: session.is_some(),
            waiting: self.pending.is_waiting(now()),
            message: self.message.lock().clone(),
            account: session.as_ref().map(|s| AccountInfo { id: s.account_id.clone(), display_name: s.display_name.clone(), provider: s.provider.clone() }),
            device_id: session.map(|s| s.device_id),
        }
    }

    /// Start a sign-in and open the browser. The window only learns that it is waiting.
    pub fn start_sign_in(&self) -> Result<AccountView, String> {
        let base = (self.parts.base)().ok_or("The account service is not set up yet.")?;
        let pending = self.pending.start(now());
        self.say(None);
        if let Err(e) = (self.parts.open)(&pending.start_url(&base)) {
            self.pending.cancel();
            tracing::warn!(error = %e, "account: could not open the browser");
            return Err("Could not open your browser.".into());
        }
        Ok(self.view())
    }

    pub fn cancel_sign_in(&self) -> AccountView {
        self.pending.cancel();
        self.view()
    }

    /// A link came back from the browser. Checked against the sign-in this app started; anything else is dropped.
    pub fn finish_sign_in(&self, link: &SignInLink) -> bool {
        let Some(pending) = self.pending.accept(link, now()) else {
            tracing::info!(reason = "state", "account: a sign-in link did not match a pending sign-in (wrong state, expired or nothing pending)");
            return false;
        };
        match self.redeem(link, pending.verifier()) {
            Ok(()) => self.say(None),
            Err(e) => {
                tracing::warn!("account: sign-in failed");
                self.say(Some(e));
            }
        }
        true
    }

    fn redeem(&self, link: &SignInLink, verifier: &str) -> Result<(), String> {
        let base = (self.parts.base)().ok_or("The account service is not set up yet.")?;
        let key = (self.parts.key)().map_err(|_| "This computer's key store is not available.".to_string())?;
        let device_id = self.parts.store.device_id().map_err(|_| "This computer's key store is not available.".to_string())?;
        let signed = device_statement(&key, &link.account, &device_id, "pc", &(self.parts.name)());
        let reply = Client::new(&base).redeem(&link.ticket, verifier, &signed.statement, &signed.signature).map_err(|e| e.sentence())?;
        let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let token = text(&reply, "token");
        let account = reply.get("account").cloned().unwrap_or(Value::Null);
        let account_id = text(&account, "id");
        if token.is_empty() || account_id != link.account {
            return Err("The account service gave an answer this app does not trust.".into());
        }
        let session = StoredSession { token, device_id, account_id, display_name: text(&account, "display_name"), provider: text(&account, "provider"), server: base };
        self.parts.store.save(&session)
    }

    fn signed(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        let session = self.session().ok_or(ApiError::Unauthorized)?;
        let base = (self.parts.base)().ok_or(ApiError::Unauthorized)?;
        let key = (self.parts.key)().map_err(|e| ApiError::Network(e))?;
        let result = Client::new(&base).signed(&session, &key, method, path, body);
        if result == Err(ApiError::Unauthorized) {
            // Signed out somewhere else, or the session ran out: forget it here too.
            self.parts.store.clear();
            self.say(Some(ApiError::Unauthorized.sentence()));
        }
        result
    }

    /// The address book: every device on this account (names, kinds, times), nothing else.
    pub fn devices(&self) -> Result<DevicesReply, String> {
        match self.signed("GET", "/v1/devices", None) {
            Ok(v) => Ok(DevicesReply { signed_in: true, devices: rows(&v) }),
            Err(ApiError::Unauthorized) => Ok(DevicesReply { signed_in: false, devices: vec![] }),
            Err(e) => Err(e.sentence()),
        }
    }

    /// "Sign out this device" / "Not me?": the calling device signs the statement, the server ends that session.
    pub fn revoke(&self, target: &str, action: &str) -> Result<DevicesReply, String> {
        if uuid::Uuid::parse_str(target).is_err() || !matches!(action, "sign_out" | "not_me") {
            return Err("That device is not in the list.".into());
        }
        let session = self.session().ok_or("You are not signed in.")?;
        let key = (self.parts.key)().map_err(|_| "This computer's key store is not available.".to_string())?;
        let signed = revoke_statement(&key, action, target, &session.device_id, now());
        let route = if action == "sign_out" { "sign-out" } else { "not-me" };
        let body = serde_json::json!({ "statement": signed.statement, "signature": signed.signature });
        match self.signed("POST", &format!("/v1/devices/{target}/{route}"), Some(&body)) {
            Ok(_) => {}
            Err(ApiError::Unauthorized) => return Ok(DevicesReply { signed_in: false, devices: vec![] }),
            Err(e) => return Err(e.sentence()),
        }
        if target == session.device_id {
            self.parts.store.clear();
            return Ok(DevicesReply { signed_in: false, devices: vec![] });
        }
        self.devices()
    }

    /// Sign this device out: tell the server (best effort) and forget the session here.
    pub fn sign_out_here(&self) -> AccountView {
        if self.session().is_some() {
            let _ = self.signed("DELETE", "/v1/session", None);
        }
        self.parts.store.clear();
        self.say(None);
        self.view()
    }
}

fn rows(v: &Value) -> Vec<DeviceRow> {
    let text = |d: &Value, k: &str| d.get(k).and_then(Value::as_str).unwrap_or_default().chars().take(60).collect::<String>();
    let num = |d: &Value, k: &str| d.get(k).and_then(Value::as_u64).unwrap_or(0);
    let flag = |d: &Value, k: &str| d.get(k).and_then(Value::as_bool).unwrap_or(false);
    v.get("devices")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|d| uuid::Uuid::parse_str(&text(d, "id")).is_ok())
                .map(|d| DeviceRow {
                    id: text(d, "id"),
                    kind: if text(d, "kind") == "phone" { "phone".into() } else { "pc".into() },
                    name: text(d, "name"),
                    created_at: num(d, "created_at"),
                    last_seen_at: num(d, "last_seen_at"),
                    online: flag(d, "online"),
                    revoked: d.get("revoked_at").is_some_and(|x| !x.is_null()),
                    not_me: flag(d, "not_me"),
                    is_this: flag(d, "self"),
                })
                .collect()
        })
        .unwrap_or_default()
}

static SERVICE: once_cell::sync::Lazy<AccountService> = once_cell::sync::Lazy::new(AccountService::app);

pub fn service() -> &'static AccountService {
    &SERVICE
}
