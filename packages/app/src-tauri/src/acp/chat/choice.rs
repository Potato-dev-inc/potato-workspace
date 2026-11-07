//! Model and reasoning (effort) choices for a chat session.
//!
//! The adapters expose these as `configOptions` with stable ids and values that do not always match
//! what an agent asks for ("claude-haiku-5-5" is the `haiku` alias, "low" is the `low` effort). This
//! module maps a request onto the values the agent actually offers, applies them with
//! `session/set_config_option` before the first message, and never falls back to a different model:
//! when nothing matches, the caller gets a clear error instead.

use serde_json::Value;

use super::AcpChat;

const MODEL_CATEGORY: &str = "model";
const MODEL_IDS: &[&str] = &["model"];
const REASONING_CATEGORY: &str = "thought_level";
const REASONING_IDS: &[&str] = &["effort", "reasoning_effort", "reasoning"];

/// What the agent is using after a request, and what could not be honoured exactly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub warnings: Vec<String>,
}

/// Why a request was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChoiceError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for ChoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Apply `model` and `reasoning` (each optional) to `chat`, in that order (the effort levels depend on
/// the model). Nothing is sent into the conversation. Returns what the agent reports in use.
pub fn apply(chat: &AcpChat, model: Option<&str>, reasoning: Option<&str>) -> Result<Applied, ChoiceError> {
    let model = nonempty(model);
    let reasoning = nonempty(reasoning);
    let mut warnings = Vec::new();

    if let Some(requested) = &model {
        let options = chat.session().snapshot().config_options;
        let group = group(&options, MODEL_CATEGORY, MODEL_IDS).ok_or_else(|| ChoiceError {
            code: "ACP_MODEL_NOT_OFFERED",
            message: "This agent does not offer a model setting, so the requested model was not applied.".to_string(),
        })?;
        let (value, name) = select(group, requested).map_err(|offered| ChoiceError {
            code: "ACP_MODEL_NOT_OFFERED",
            message: format!("This agent does not offer the model {requested:?}. It offers: {offered}."),
        })?;
        chat.set_config("model", &value).map_err(|error| ChoiceError {
            code: "ACP_MODEL_FAILED",
            message: format!("The agent did not accept the model {value:?}: {error}"),
        })?;
        if !same_name(&value, requested) {
            warnings.push(format!("Asked for the model {requested}; the agent is using {value} ({name})."));
        }
    }

    if let Some(requested) = &reasoning {
        let options = chat.session().snapshot().config_options;
        let group = group(&options, REASONING_CATEGORY, REASONING_IDS).ok_or_else(|| ChoiceError {
            code: "ACP_REASONING_NOT_OFFERED",
            message: "This agent does not offer a reasoning effort setting, so the requested effort was not applied.".to_string(),
        })?;
        let id = group.get("id").and_then(Value::as_str).unwrap_or("effort").to_string();
        let (value, name) = select(group, requested).map_err(|offered| ChoiceError {
            code: "ACP_REASONING_NOT_OFFERED",
            message: format!("This agent does not offer the reasoning effort {requested:?}. It offers: {offered}."),
        })?;
        chat.set_config(&id, &value).map_err(|error| ChoiceError {
            code: "ACP_REASONING_FAILED",
            message: format!("The agent did not accept the reasoning effort {value:?}: {error}"),
        })?;
        if !same_name(&value, requested) {
            warnings.push(format!("Asked for the reasoning effort {requested}; the agent is using {value} ({name})."));
        }
    }

    let in_use = in_use(chat);
    chat.set_choice_warnings(warnings.clone());
    Ok(Applied { model: in_use.0, reasoning: in_use.1, warnings })
}

/// The model and reasoning the agent reports right now (from its `configOptions`).
pub fn in_use(chat: &AcpChat) -> (Option<String>, Option<String>) {
    let options = chat.session().snapshot().config_options;
    let current = |category: &str, ids: &[&str]| {
        group(&options, category, ids)
            .and_then(|g| g.get("currentValue"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    (current(MODEL_CATEGORY, MODEL_IDS), current(REASONING_CATEGORY, REASONING_IDS))
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

fn group<'a>(options: &'a [Value], category: &str, ids: &[&str]) -> Option<&'a Value> {
    options
        .iter()
        .find(|o| o.get("category").and_then(Value::as_str) == Some(category))
        .or_else(|| options.iter().find(|o| o.get("id").and_then(Value::as_str).is_some_and(|id| ids.contains(&id))))
        .filter(|o| o.get("options").and_then(Value::as_array).is_some_and(|list| !list.is_empty()))
}

fn choices(group: &Value) -> Vec<(String, String)> {
    group
        .get("options")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|option| {
                    let value = option.get("value").and_then(Value::as_str)?.to_string();
                    let name = option.get("name").and_then(Value::as_str).unwrap_or(&value).to_string();
                    Some((value, name))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Lower-case words of a model/effort name. Filler words that never distinguish a choice are dropped.
fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .filter(|w| !matches!(*w, "claude" | "anthropic" | "model" | "the" | "latest" | "auto" | "default" | "version"))
        .map(str::to_string)
        .collect()
}

fn is_number(word: &str) -> bool {
    !word.is_empty() && word.bytes().all(|b| b.is_ascii_digit())
}

/// Why the request did not match: the offered values, for the error text.
type Offered = String;

fn offered_text(list: &[(String, String)]) -> Offered {
    let mut names: Vec<String> = list
        .iter()
        .map(|(value, name)| if value == name { value.clone() } else { format!("{value} ({name})") })
        .collect();
    names.sort();
    names.join(", ")
}

/// Pick the offered value `requested` names. An exact value or name wins; otherwise the words must
/// identify one family, and a requested version must be present unless the agent offers only a
/// version-less alias for that family. Never substitutes a different version.
fn select(group: &Value, requested: &str) -> Result<(String, String), Offered> {
    let list = choices(group);
    let wanted = words(requested);
    if let Some(hit) = list.iter().find(|(value, _)| value.eq_ignore_ascii_case(requested.trim())) {
        return Ok(hit.clone());
    }
    if let Some(hit) = list.iter().find(|(_, name)| name.eq_ignore_ascii_case(requested.trim())) {
        return Ok(hit.clone());
    }

    let alpha: Vec<&String> = wanted.iter().filter(|w| !is_number(w)).collect();
    let numbers: Vec<&String> = wanted.iter().filter(|w| is_number(w)).collect();
    let family: Vec<&(String, String)> = list
        .iter()
        .filter(|(value, name)| {
            let candidate = words(&format!("{value} {name}"));
            !alpha.is_empty() && alpha.iter().all(|word| candidate.contains(word))
        })
        .collect();

    if family.is_empty() {
        return Err(offered_text(&list));
    }
    if numbers.is_empty() {
        return Ok(family[0].clone());
    }

    let numbers_in = |text: &str| words(text).into_iter().filter(|w| is_number(w)).collect::<Vec<_>>();
    let numbers_of = |(value, name): &(String, String)| -> Vec<String> {
        let from_value = numbers_in(value);
        if from_value.is_empty() { numbers_in(name) } else { from_value }
    };
    if let Some(hit) = family.iter().find(|choice| {
        let candidate = numbers_of(choice);
        !numbers.is_empty() && contains_sequence(&candidate, &numbers)
    }) {
        return Ok((*hit).clone());
    }
    // No versioned match. A version-less alias ("haiku") is the agent's current model for that
    // family; a different version ("haiku-4-5" for a 5.5 request) is a silent substitution, refused.
    if let Some(hit) = family.iter().find(|choice| numbers_of(choice).is_empty()) {
        return Ok((*hit).clone());
    }
    Err(offered_text(&list))
}

/// True when `wanted` appears inside `have` in order, an occurrence per element (so [5,5] does not
/// match [3,5], while [5] does).
fn contains_sequence(have: &[String], wanted: &[&String]) -> bool {
    let mut at = 0;
    for word in have {
        if at < wanted.len() && word == wanted[at] {
            at += 1;
        }
    }
    at == wanted.len()
}

/// True when `value` already is what `requested` says (so no warning is needed).
fn same_name(value: &str, requested: &str) -> bool {
    let a = words(value);
    let b = words(requested);
    !a.is_empty() && a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn group_with(options: Value) -> Value {
        json!({ "id": "model", "category": "model", "currentValue": "sonnet", "options": options })
    }

    #[test]
    fn an_exact_value_wins() {
        let g = group_with(json!([{"value": "sonnet", "name": "Sonnet"}, {"value": "opus", "name": "Opus"}]));
        assert_eq!(select(&g, "opus").unwrap().0, "opus");
        assert_eq!(select(&g, "Opus").unwrap().0, "opus");
    }

    #[test]
    fn a_full_model_name_matches_the_agents_alias() {
        let g = group_with(json!([{"value": "sonnet", "name": "Sonnet"}, {"value": "haiku", "name": "Haiku"}]));
        assert_eq!(select(&g, "claude-haiku-5-5").unwrap().0, "haiku");
        assert_eq!(select(&g, "haiku 5.5").unwrap().0, "haiku");
    }

    #[test]
    fn a_versioned_name_matches_the_same_version_only() {
        let g = group_with(json!([
            {"value": "haiku-3-5", "name": "Haiku 3.5"},
            {"value": "haiku-4-5", "name": "Haiku 4.5"},
            {"value": "haiku-5-5", "name": "Haiku 5.5"}
        ]));
        assert_eq!(select(&g, "claude-haiku-5-5").unwrap().0, "haiku-5-5");
        assert_eq!(select(&g, "haiku 4.5").unwrap().0, "haiku-4-5");
    }

    #[test]
    fn a_different_version_is_refused_not_substituted() {
        let g = group_with(json!([{"value": "haiku-4-5", "name": "Haiku 4.5"}]));
        let err = select(&g, "claude-haiku-5-5").unwrap_err();
        assert!(err.contains("haiku-4-5"), "{err}");
    }

    #[test]
    fn an_effort_named_by_the_agent_is_found_by_category() {
        let g = json!({
            "id": "reasoning_effort",
            "category": "thought_level",
            "currentValue": "medium",
            "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]
        });
        assert_eq!(select(&g, "low").unwrap().0, "low");
        assert!(select(&g, "medium").is_err(), "a value it does not offer is refused");
    }
}
