//! Structured results: ask a helper to end its final message with a fenced `potato-result` JSON
//! block, and read it back tolerantly. A missing or broken block never fails a run.

use serde_json::Value;

/// Appended to the task sent to a helper. The example is deliberately not valid JSON, so the
/// prompt echoed back on a terminal screen is never mistaken for an answer. It is ONE line with no
/// line break: a newline typed into a terminal pane can submit the task early, and a multi-line
/// task fails the "typed text is visible in the input box" check of prompt delivery.
pub const STRUCTURED_RESULT_INSTRUCTION: &str = " End your final message with a fenced block tagged potato-result holding JSON, like ```potato-result {\"summary\": <string>, \"files_changed\": [<path>], \"checks_run\": [<command>], \"open_questions\": [<string>]} ```";

/// The task as sent to the helper: `task` plus the instruction, unless the caller opted out.
pub fn with_instruction(task: &str, enabled: Option<bool>) -> String {
    if enabled == Some(false) || task.contains("```potato-result") {
        task.to_string()
    } else {
        format!("{task}{STRUCTURED_RESULT_INSTRUCTION}")
    }
}

/// The last valid `potato-result` block in `text`. Invalid JSON, or JSON without a string
/// `summary`, is ignored; an earlier valid block then still counts.
pub fn parse(text: &str) -> Option<Value> {
    const FENCE: &str = "```potato-result";
    let mut found = None;
    let mut rest = text;
    while let Some(at) = rest.find(FENCE) {
        let after = &rest[at + FENCE.len()..];
        let Some(end) = after.find("```") else { break };
        if let Ok(value) = serde_json::from_str::<Value>(after[..end].trim()) {
            if value.get("summary").is_some_and(Value::is_string) {
                found = Some(normalize(&value));
            }
        }
        rest = &after[end + 3..];
    }
    found
}

/// The four documented fields, with the lists coerced to arrays of strings.
fn normalize(value: &Value) -> Value {
    let list = |key: &str| -> Value {
        Value::Array(
            value
                .get(key)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(|s| Value::String(s.into())))
                        .collect()
                })
                .unwrap_or_default(),
        )
    };
    serde_json::json!({
        "summary": value["summary"],
        "files_changed": list("files_changed"),
        "checks_run": list("checks_run"),
        "open_questions": list("open_questions"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_block() {
        let text = "done\n```potato-result\n{\"summary\":\"ok\",\"files_changed\":[\"a.rs\"],\"checks_run\":[],\"open_questions\":[\"q\"]}\n```\n";
        let v = parse(text).unwrap();
        assert_eq!(v["summary"], "ok");
        assert_eq!(v["files_changed"][0], "a.rs");
        assert_eq!(v["open_questions"][0], "q");
    }

    #[test]
    fn invalid_json_or_missing_summary_is_ignored() {
        assert!(parse("```potato-result\n{nope}\n```").is_none());
        assert!(parse("```potato-result\n{\"files_changed\":[]}\n```").is_none());
        assert!(parse("```potato-result\n{\"summary\":\"x\"").is_none());
    }

    #[test]
    fn last_valid_block_wins_and_a_broken_last_one_does_not_hide_an_earlier() {
        let two = "```potato-result\n{\"summary\":\"one\"}\n```\nmore\n```potato-result\n{\"summary\":\"two\"}\n```";
        assert_eq!(parse(two).unwrap()["summary"], "two");
        let broken_last = "```potato-result\n{\"summary\":\"one\"}\n```\n```potato-result\n{bad\n```";
        assert_eq!(parse(broken_last).unwrap()["summary"], "one");
    }

    #[test]
    fn missing_block_and_the_echoed_instruction_give_nothing() {
        assert!(parse("just text").is_none());
        assert!(parse(&with_instruction("task", None)).is_none());
    }

    #[test]
    fn instruction_is_appended_once_and_can_be_opted_out() {
        let on = with_instruction("do it", None);
        assert!(on.starts_with("do it") && on.contains("potato-result"));
        assert_eq!(with_instruction(&on, Some(true)), on);
        assert_eq!(with_instruction("do it", Some(false)), "do it");
    }
}
