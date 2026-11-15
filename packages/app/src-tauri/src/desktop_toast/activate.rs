//! A button was pressed: the link Windows handed back becomes one of three things (open the app on that
//! chat, answer through the one attention route, or a short note saying why nothing happened).
//!
//! The link is untrusted: it only names a grant this app issued (`rules::Grants`). Nothing is typed unless the
//! grant is live, and then `attention::answer` checks the card against the live screen again, exactly as it
//! does for a phone.

use super::rules::{self, Act, Grants, Redeem};
use crate::attention::answer::{Caller, Reply, Request, Via};
use parking_lot::Mutex;
use serde_json::Value;

/// Who the answer is recorded as: the person at this PC.
pub const DEVICE_ID: &str = "this-pc";
pub const DEVICE_NAME: &str = "This PC";

/// Everything outside the decision, so it is tested with a fake.
pub trait Env {
    fn now_ms(&self) -> u64;
    /// The one attention answer route.
    fn answer(&self, caller: &Caller, item_id: &str, request: &Request) -> Reply;
    /// Bring the app forward, on this chat when there is one.
    fn open(&self, pane_id: Option<&str>);
    /// A short message toast ("This question was already answered.").
    fn note(&self, text: &str);
    fn grants(&self) -> &Mutex<Grants>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Not ours, or a link nobody issued: nothing happened.
    Ignored,
    Opened,
    /// The answer went through; the label of the choice.
    Answered(String),
    /// Nothing was typed; the note that was shown.
    Stale(&'static str),
}

pub fn caller() -> Caller {
    Caller { device_id: DEVICE_ID.into(), device_name: DEVICE_NAME.into(), caps: crate::attention::caps::DeviceCaps::desktop(), via: Via::DesktopToast }
}

pub fn activate(env: &dyn Env, url: &str) -> Outcome {
    let Some((act, nonce)) = rules::parse_link(url) else { return Outcome::Ignored };
    let redeemed = env.grants().lock().redeem(&nonce, act, env.now_ms());
    let grant = match redeemed {
        Redeem::Unknown => return Outcome::Ignored,
        Redeem::Spent => return stale(env, rules::MSG_ANSWERED),
        Redeem::Expired => return stale(env, rules::MSG_EXPIRED),
        Redeem::Granted(grant) => grant,
    };
    if act == Act::Open {
        env.open(grant.pane_id.as_deref());
        return Outcome::Opened;
    }
    let Some(choice) = grant.choice.clone() else { return stale(env, rules::MSG_FAILED) };
    let request = Request {
        choice: Some(choice),
        text: None,
        prompt_id: Some(grant.prompt_id.clone()).filter(|id| !id.is_empty()),
        occurrence: Some(grant.occurrence),
        fingerprint: Some(grant.fingerprint.clone()),
        // One answer per card, whichever way it arrives: a second press returns the first result.
        answer_key: Some(format!("toast-{}", grant.item_id)),
    };
    let (status, body) = env.answer(&caller(), &grant.item_id, &request);
    if status >= 400 {
        return stale(env, rules::MSG_FAILED);
    }
    reading(env, &body)
}

fn reading(env: &dyn Env, body: &Value) -> Outcome {
    match body["outcome"].as_str() {
        Some("answered") => {
            let label = body["choice_label"].as_str().unwrap_or("Answered").to_string();
            env.note(&label);
            Outcome::Answered(label)
        }
        Some("already_answered") | Some("gone") => stale(env, rules::MSG_ANSWERED),
        Some("changed") => stale(env, rules::MSG_CHANGED),
        _ => stale(env, rules::MSG_FAILED),
    }
}

fn stale(env: &dyn Env, message: &'static str) -> Outcome {
    env.note(message);
    Outcome::Stale(message)
}

/// The real thing: the app, the registry and the Windows toast.
pub struct LiveEnv {
    pub app: tauri::AppHandle,
}

impl Env for LiveEnv {
    fn now_ms(&self) -> u64 {
        crate::push::now_ms()
    }

    fn answer(&self, caller: &Caller, item_id: &str, request: &Request) -> Reply {
        let Some(registry) = crate::bridge::live_registry() else {
            return (503, serde_json::json!({"error": "not_ready"}));
        };
        let env = crate::attention::answer::RealEnv { registry, app: self.app.clone() };
        crate::attention::answer::answer(&env, caller, item_id, request)
    }

    fn open(&self, pane_id: Option<&str>) {
        crate::cockpit::open_cockpit(&self.app, pane_id);
    }

    fn note(&self, text: &str) {
        super::show_note(text);
    }

    fn grants(&self) -> &Mutex<Grants> {
        super::grants()
    }
}
