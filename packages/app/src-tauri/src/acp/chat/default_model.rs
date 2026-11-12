//! The model a new chat starts on when nobody named one.
//!
//! Order, decided in one place (`choose`): the request's model (applied by the caller afterwards, strictly,
//! `choice::apply`), then the helper default model (`helper_default_models`, only when an agent started this chat as its
//! helper), then the agent default (`agent_default_models`, Settings > Agents; an older app setting named by `[acp.default_model]` when none is saved), then the model the person last
//! picked in a chat of this agent, then the agent's own default. A model the agent does not offer is never sent: the agent keeps its own choice and the result
//! carries a note. Generic: which setting and which words come from the definition.

use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::AcpChat;
use crate::acp::config::DefaultModel;

static SETTINGS: Mutex<Option<Value>> = Mutex::new(None);

/// Called with the public settings whenever they change.
pub fn note_settings(public: &Value) {
    *SETTINGS.lock() = Some(public.clone());
}

fn settings() -> Value {
    SETTINGS.lock().clone().unwrap_or(Value::Null)
}

/// Where a starting model came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Request,
    Helper,
    AgentDefault,
    LastPicked,
}

/// The resolver: the first of request, helper default, agent default, last picked that says something. `None`: keep the
/// agent's own default.
pub fn choose(request: Option<&str>, helper: Option<&str>, agent_default: Option<&str>, last_picked: Option<&str>) -> Option<(String, Source)> {
    let pick = |v: Option<&str>| v.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    pick(request)
        .map(|v| (v, Source::Request))
        .or_else(|| pick(helper).map(|v| (v, Source::Helper)))
        .or_else(|| pick(agent_default).map(|v| (v, Source::AgentDefault)))
        .or_else(|| pick(last_picked).map(|v| (v, Source::LastPicked)))
}

/// The model the app settings name, as the agent writes it (`provider/model`). A saved id that already has a
/// provider is used as saved.
pub fn setting_value(rule: &DefaultModel, settings: &Value) -> Option<String> {
    let text = |key: &str| settings.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let id = text(&rule.model_setting)?;
    let sep = if rule.separator.is_empty() { "/" } else { rule.separator.as_str() };
    if id.contains(sep) {
        return Some(id);
    }
    let provider = text(&rule.provider_setting).or_else(|| Some(rule.provider_fallback.trim().to_string()).filter(|p| !p.is_empty()));
    Some(match provider {
        Some(p) => format!("{p}{sep}{id}"),
        None => id,
    })
}

/// The models people picked last, one per agent. `at` is a parameter so tests use a temp file.
#[derive(Debug, Clone)]
pub struct LastPicked {
    path: PathBuf,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct PickedFile {
    agents: BTreeMap<String, String>,
}

impl LastPicked {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn in_app_data() -> Self {
        Self::at(crate::app_paths::app_data_dir().join("acp_last_model.json"))
    }

    fn read(&self) -> PickedFile {
        std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn get(&self, agent: &str) -> Option<String> {
        self.read().agents.get(&agent.trim().to_ascii_lowercase()).cloned()
    }

    pub fn set(&self, agent: &str, value: &str) {
        let mut file = self.read();
        file.agents.insert(agent.trim().to_ascii_lowercase(), value.to_string());
        if let Ok(text) = serde_json::to_string(&file) {
            let _ = std::fs::write(&self.path, text);
        }
    }
}

/// The value to send (one the agent offers), nothing when no model is chosen (or the request names one: the caller
/// applies that, strictly), or the note to show when the chosen model is not offered. The helper default counts only
/// when `is_helper`; the agent default for every agent, the last pick only when the definition has a `[acp.default_model]` rule.
pub fn plan(chat: &AcpChat, rule: Option<&DefaultModel>, settings: &Value, store: &LastPicked, request: Option<&str>, is_helper: bool) -> Result<Option<String>, String> {
    let helper = if is_helper { crate::agent_run_mode::helper_default_for(settings, chat.agent_id()) } else { None };
    let setting = crate::agent_run_mode::agent_default_for(settings, chat.agent_id()).or_else(|| rule.and_then(|rule| setting_value(rule, settings)));
    let last = rule.and_then(|_| store.get(chat.agent_id()));
    let Some((wanted, source)) = choose(request, helper.as_deref(), setting.as_deref(), last.as_deref()) else { return Ok(None) };
    if source == Source::Request {
        return Ok(None);
    }
    match super::choice::offered_model(chat, &wanted) {
        Some(value) => Ok(Some(value)),
        None => Err(format!("Your {} model '{}' isn't available here. {} is using its own default model.", chat.label(), wanted, chat.label())),
    }
}

/// Applies the starting model right after the session opened. Never fails the start.
pub fn apply_at_start(chat: &AcpChat, request: Option<&str>, is_helper: bool) {
    apply_with(chat, &settings(), &LastPicked::in_app_data(), request, is_helper);
}

pub fn apply_with(chat: &AcpChat, settings: &Value, store: &LastPicked, request: Option<&str>, is_helper: bool) {
    let rule = chat.session().config().default_model.clone();
    match plan(chat, rule.as_ref(), settings, store, request, is_helper) {
        Ok(Some(value)) => {
            if super::choice::in_use(chat).0.as_deref() != Some(value.as_str()) {
                if let Err(error) = chat.set_config("model", &value) {
                    chat.set_choice_warnings(vec![format!("The {} model {value} could not be set: {error}", chat.label())]);
                }
            }
        }
        Ok(None) => {}
        Err(note) => chat.set_choice_warnings(vec![note]),
    }
}

/// The person picked `value` for `option_id` in this chat: remember it when it is the model setting.
pub fn remember_pick(chat: &AcpChat, option_id: &str, value: &str) {
    if chat.session().config().default_model.is_some() && super::choice::is_model_option(chat, option_id) {
        LastPicked::in_app_data().set(chat.agent_id(), value);
    }
}
