//! `run_agent(model)` check: an agent that has a known model list refuses a name that is not on it, with the closest
//! names and a `try` that works. An agent without a list passes the name through as before.
//!
//! The list comes from the agent's profile (`TuiProfile::model_check_list`) for the terminal and from the session's own
//! model setting for a chat (`acp::chat::choice`). Nothing here matches on an agent's name.

use serde_json::json;

use crate::operations::OperationError;

/// At most this many known names go into a refusal.
const MAX_KNOWN: usize = 12;

/// Whether `model` is fine for `agent_type`. `Ok` when the agent has no list to check against.
pub(crate) fn check_for_agent(agent_type: &str, model: &str) -> Result<(), OperationError> {
    let profile = crate::tui::profile_for(agent_type);
    let Some(known) = profile.model_check_list() else { return Ok(()) };
    check_against(agent_type, model, &known, |m| profile.model_spelling_valid(m))
}

/// The pure decision: `model` is on `known` (ignoring case and spaces), or `spelling_ok` takes it, or it is refused.
pub(crate) fn check_against(agent_type: &str, model: &str, known: &[String], spelling_ok: impl Fn(&str) -> bool) -> Result<(), OperationError> {
    let asked = model.trim();
    if asked.is_empty() || known.is_empty() || known.iter().any(|k| k.eq_ignore_ascii_case(asked)) || spelling_ok(asked) {
        return Ok(());
    }
    Err(unknown_model(agent_type, asked, known))
}

/// `UNKNOWN_MODEL` with `known` (at most 12, the closest first), `closest` and a machine-readable `try`.
pub(crate) fn unknown_model(agent_type: &str, asked: &str, known: &[String]) -> OperationError {
    let closest = closest(asked, known);
    let mut shown: Vec<String> = known.to_vec();
    if let Some(best) = &closest {
        shown.retain(|k| k != best);
        shown.insert(0, best.clone());
    }
    shown.truncate(MAX_KNOWN);
    let message = match &closest {
        Some(best) => format!("{agent_type} does not have a model called {asked:?}. Did you mean {best:?}?"),
        None => format!("{agent_type} does not have a model called {asked:?}. Pick one of the known models, or leave model out."),
    };
    let try_this = match &closest {
        Some(best) => json!({ "tool": "run_agent", "change": { "model": best } }),
        None => json!({ "tool": "run_agent", "omit": ["model"] }),
    };
    let mut error = OperationError::new("UNKNOWN_MODEL", message, false);
    error.context = json!({ "agent_type": agent_type, "asked": asked, "known": shown, "closest": closest, "try": try_this });
    error
}

/// The known name nearest to `asked`, when one is near enough to be a typo or a different spelling.
pub(crate) fn closest(asked: &str, known: &[String]) -> Option<String> {
    let want = squash(asked);
    if want.is_empty() {
        return None;
    }
    let mut best: Option<(usize, &String)> = None;
    for candidate in known {
        let have = squash(candidate);
        if have.is_empty() {
            continue;
        }
        let mut distance = edit_distance(&want, &have);
        // "claude-sonnet-4-5" for "sonnet": one contains the other.
        if want.contains(&have) || have.contains(&want) {
            distance = distance.min(1);
        }
        if best.is_none_or(|(d, _)| distance < d) {
            best = Some((distance, candidate));
        }
    }
    let (distance, name) = best?;
    let limit = (want.chars().count().max(squash(name).chars().count()) / 3).max(2);
    (distance <= limit).then(|| name.clone())
}

fn squash(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if ca == *cb { diagonal } else { 1 + diagonal.min(above).min(row[j]) };
            diagonal = above;
        }
    }
    row[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_known_model_passes_in_any_case() {
        let known = names(&["opus", "sonnet"]);
        assert!(check_against("x", "Sonnet", &known, |_| false).is_ok());
        assert!(check_against("x", "  opus ", &known, |_| false).is_ok());
    }

    #[test]
    fn a_typo_is_refused_with_the_closest_name_and_a_try_that_works() {
        let known = names(&["opus", "sonnet", "haiku"]);
        let error = check_against("x", "sonet", &known, |_| false).unwrap_err();
        assert_eq!(error.code, "UNKNOWN_MODEL");
        assert_eq!(error.context["closest"], "sonnet");
        assert_eq!(error.context["known"][0], "sonnet");
        let fixed = error.context["try"]["change"]["model"].as_str().unwrap();
        assert!(check_against("x", fixed, &known, |_| false).is_ok(), "the suggested try passes the same check");
    }

    #[test]
    fn nothing_near_gives_no_closest_and_a_try_that_leaves_model_out() {
        let known = names(&["opus", "sonnet", "haiku"]);
        let error = check_against("x", "gpt-9-turbo-max", &known, |_| false).unwrap_err();
        assert!(error.context["closest"].is_null());
        assert_eq!(error.context["try"]["omit"][0], "model");
    }

    #[test]
    fn the_known_list_in_a_refusal_is_capped() {
        let known: Vec<String> = (0..40).map(|i| format!("model-{i}")).collect();
        let error = check_against("x", "zzz", &known, |_| false).unwrap_err();
        assert_eq!(error.context["known"].as_array().unwrap().len(), MAX_KNOWN);
    }

    #[test]
    fn a_spelling_the_agent_takes_passes_even_off_the_list() {
        let known = names(&["opus"]);
        assert!(check_against("x", "claude-opus-4-1", &known, |m| m.starts_with("claude-")).is_ok());
    }

    #[test]
    fn an_agent_without_a_list_passes_any_text() {
        assert!(check_for_agent("codex", "whatever-model").is_ok());
        assert!(check_against("x", "anything", &[], |_| false).is_ok());
    }

    #[test]
    fn claude_checks_by_its_profile_without_matching_its_name_here() {
        assert!(check_for_agent("claude", "sonnet").is_ok());
        assert!(check_for_agent("claude", "claude-sonnet-4-5").is_ok());
        assert!(check_for_agent("claude", "sonnet[1m]").is_ok());
        let error = check_for_agent("claude", "sonet").unwrap_err();
        assert_eq!(error.context["closest"], "sonnet");
    }
}
