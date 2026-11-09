//! Which way `run_agent` runs a worker: `lane` is `"acp"` (a chat session), `"terminal"`, `"auto"`, or left out.
//!
//! * `"acp"` and `"terminal"` are what the caller said.
//! * Left out: the agent's saved "How to run" decides when the person saved a choice; with nothing saved it is `"auto"`.
//! * `"auto"`: a chat session when the Labs switch is on, the agent has an ACP definition and its add-on is installed;
//!   otherwise the terminal. A chat that cannot start under auto (or a saved choice) falls back to the terminal once.
//!
//! Every answer says which way ran (`lane_used`: `acp`, `terminal` or `headless`) and why (`lane_reason`). Pure
//! decisions here; the wiring is in `surface::run` and `agent_runs::routes`.

use serde_json::{json, Value};

use crate::acp::lane::{effective_lane, RunLane};
use crate::operations::OperationError;

/// What the decision needs to know about the app and the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    /// The Labs switch Chat (ACP).
    pub labs_on: bool,
    /// The agent has an ACP definition.
    pub has_definition: bool,
    /// Its chat add-on (the adapter) is installed.
    pub adapter_installed: bool,
    /// The caller asked for a background (headless) run, which has no chat.
    pub headless: bool,
}

/// The way chosen for a new run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// A chat session. `explicit`: the caller said `lane: "acp"`, so a chat that cannot start is an error rather than the
    /// terminal.
    Chat { explicit: bool, reason: String },
    Terminal { reason: String },
}

/// What the answer says about the way that ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaneNote {
    /// `acp`, `terminal` or `headless`.
    pub used: &'static str,
    pub reason: String,
    /// Set when a chat was tried first and did not start: its error code and message.
    pub fallback: Option<(String, String)>,
}

impl LaneNote {
    pub fn acp(reason: &str) -> Self {
        LaneNote { used: "acp", reason: reason.to_string(), fallback: None }
    }
    pub fn terminal(reason: &str) -> Self {
        LaneNote { used: "terminal", reason: reason.to_string(), fallback: None }
    }
    /// A chat was tried and could not start: the terminal ran it instead.
    pub fn fell_back(code: &str, message: &str) -> Self {
        LaneNote {
            used: "terminal",
            reason: format!("Chat (ACP) could not start ({code}), so the terminal ran it instead."),
            fallback: Some((code.to_string(), message.to_string())),
        }
    }
}

/// `lane` is the caller's word, `saved` the agent's saved "How to run" (`None`: the person never changed it).
pub fn plan(lane: Option<&str>, saved: Option<RunLane>, facts: Facts) -> Result<Plan, String> {
    match lane.map(str::trim).filter(|l| !l.is_empty()) {
        Some("acp") => Ok(Plan::Chat { explicit: true, reason: "You asked for lane \"acp\".".into() }),
        Some("terminal") => Ok(Plan::Terminal { reason: "You asked for lane \"terminal\".".into() }),
        Some("auto") => Ok(auto(facts)),
        Some(other) => Err(format!("lane must be \"acp\", \"terminal\" or \"auto\", not {other:?}")),
        None => Ok(match saved {
            None => auto(facts),
            Some(saved) => {
                if facts.headless {
                    Plan::Terminal { reason: "A background run was asked for, and a chat session has no background mode.".into() }
                } else if effective_lane(saved, facts.labs_on, facts.has_definition) == RunLane::Acp {
                    Plan::Chat { explicit: false, reason: "The agent's saved \"How to run\" is Chat (ACP).".into() }
                } else if saved == RunLane::Acp && !facts.labs_on {
                    Plan::Terminal { reason: "The agent's saved \"How to run\" is Chat (ACP), but Chat (ACP) is off in Labs.".into() }
                } else {
                    Plan::Terminal { reason: "The agent's saved \"How to run\" is the terminal.".into() }
                }
            }
        }),
    }
}

/// `auto`: a chat session when Chat (ACP) is on, the agent has a chat way to run and its add-on is installed.
pub fn auto(facts: Facts) -> Plan {
    if facts.headless {
        return Plan::Terminal { reason: "auto: a background run was asked for, and a chat session has no background mode.".into() };
    }
    if !facts.labs_on {
        return Plan::Terminal { reason: "auto: Chat (ACP) is off in Labs.".into() };
    }
    if !facts.has_definition {
        return Plan::Terminal { reason: "auto: this agent has no chat (ACP) way to run.".into() };
    }
    if !facts.adapter_installed {
        return Plan::Terminal { reason: "auto: the chat add-on for this agent is not installed.".into() };
    }
    Plan::Chat { explicit: false, reason: "auto: Chat (ACP) is on and the chat add-on is installed.".into() }
}

/// `lane: "acp"` while Labs Chat (ACP) is off. Not retryable until the person turns the switch on.
pub fn acp_off() -> OperationError {
    let mut error = OperationError::new("ACP_OFF", "Chat (ACP) is off. Turn on Settings > Labs > Chat (ACP), or leave out lane.", false);
    error.context = json!({
        "fix": "Turn on Settings > Labs > Chat (ACP), or leave out lane (or pass lane: \"terminal\") to run the agent in a terminal.",
        "retryable": false,
    });
    error
}

/// `lane: "acp"` with an agent id that has no chat way to run: the ids that do.
pub fn unknown_agent(agent: &str, valid: &[String]) -> OperationError {
    let mut error = OperationError::new(
        "UNKNOWN_AGENT",
        format!("{agent:?} is not an agent with a chat (ACP) way to run. Valid ids: {}.", valid.join(", ")),
        false,
    );
    error.context = json!({ "valid": valid, "fix": "Use one of the valid ids, or run it in a terminal with lane: \"terminal\"." });
    error
}

impl LaneNote {
    fn fallback_json(&self) -> Option<Value> {
        self.fallback.as_ref().map(|(code, message)| json!({ "from": "acp", "to": "terminal", "code": code, "message": message }))
    }

    /// `{lane_used, lane_reason, lane_fallback?}`: what a chat session keeps and its answers show.
    pub fn to_value(&self) -> Value {
        let mut value = json!({ "lane_used": self.used, "lane_reason": self.reason });
        if let (Some(fallback), Some(map)) = (self.fallback_json(), value.as_object_mut()) {
            map.insert("lane_fallback".into(), fallback);
        }
        value
    }

    /// The same for a terminal run, kept on its worker.
    pub fn record(&self) -> crate::operations::LaneNoteRecord {
        crate::operations::LaneNoteRecord { used: self.used.to_string(), reason: self.reason.clone(), fallback: self.fallback_json() }
    }
}

/// Adds a chat's saved note (`lane_used`, `lane_reason`, `lane_fallback`, `account`) to its answer.
pub fn merge_note(answer: &mut Value, note: &Value) {
    if let (Some(map), Some(note)) = (answer.as_object_mut(), note.as_object()) {
        for (key, value) in note {
            map.insert(key.clone(), value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts { labs_on: true, has_definition: true, adapter_installed: true, headless: false }
    }

    fn is_chat(plan: &Plan) -> bool {
        matches!(plan, Plan::Chat { .. })
    }

    #[test]
    fn auto_picks_a_chat_only_when_labs_the_definition_and_the_add_on_are_all_there() {
        assert!(is_chat(&auto(facts())));
        for facts in [
            Facts { labs_on: false, ..facts() },
            Facts { has_definition: false, ..facts() },
            Facts { adapter_installed: false, ..facts() },
            Facts { headless: true, ..facts() },
        ] {
            let Plan::Terminal { reason } = auto(facts) else { panic!("{facts:?} must be the terminal") };
            assert!(reason.starts_with("auto:"), "{reason}");
        }
    }

    #[test]
    fn a_missing_lane_is_auto_unless_the_person_saved_a_choice() {
        assert!(is_chat(&plan(None, None, facts()).unwrap()), "nothing saved: auto picks the chat");
        assert!(matches!(plan(None, None, Facts { adapter_installed: false, ..facts() }).unwrap(), Plan::Terminal { .. }));
        // A saved choice decides, whatever auto would say.
        assert!(is_chat(&plan(None, Some(RunLane::Acp), facts()).unwrap()));
        assert!(matches!(plan(None, Some(RunLane::TerminalChat), facts()).unwrap(), Plan::Terminal { .. }));
        let Plan::Terminal { reason } = plan(None, Some(RunLane::Acp), Facts { labs_on: false, ..facts() }).unwrap() else { panic!() };
        assert!(reason.contains("off in Labs"), "{reason}");
    }

    #[test]
    fn an_explicit_terminal_choice_is_never_auto_even_with_labs_on_and_the_add_on_installed() {
        let Plan::Terminal { reason } = plan(None, Some(RunLane::Terminal), facts()).unwrap() else { panic!("explicit terminal must stay the terminal") };
        assert!(reason.contains("terminal"), "{reason}");
        assert!(is_chat(&plan(None, None, facts()).unwrap()), "unset is auto");
    }

    #[test]
    fn words_the_caller_chose_win() {
        assert_eq!(plan(Some("acp"), None, Facts { labs_on: false, ..facts() }).unwrap(), Plan::Chat { explicit: true, reason: "You asked for lane \"acp\".".into() });
        assert!(matches!(plan(Some("terminal"), Some(RunLane::Acp), facts()).unwrap(), Plan::Terminal { .. }));
        assert!(is_chat(&plan(Some("auto"), Some(RunLane::Terminal), facts()).unwrap()));
        assert!(matches!(plan(Some("auto"), None, Facts { has_definition: false, ..facts() }).unwrap(), Plan::Terminal { .. }));
        assert!(plan(Some("pty"), None, facts()).unwrap_err().contains("\"auto\""));
    }

    #[test]
    fn the_labs_gate_error_has_a_code_a_message_a_fix_and_is_not_retryable() {
        let error = acp_off();
        assert_eq!(error.code, "ACP_OFF");
        assert_eq!(error.message, "Chat (ACP) is off. Turn on Settings > Labs > Chat (ACP), or leave out lane.");
        assert!(!error.recoverable);
        assert_eq!(error.context["retryable"], false);
        assert!(error.context["fix"].as_str().unwrap().contains("Settings > Labs"));
    }

    #[test]
    fn a_chat_note_carries_lane_used_reason_and_a_fallback_and_merges_into_an_answer() {
        let note = LaneNote::acp("auto: Chat (ACP) is on and the chat add-on is installed.");
        let mut answer = json!({ "status": "completed" });
        merge_note(&mut answer, &note.to_value());
        assert_eq!(answer["lane_used"], "acp");
        assert!(answer["lane_reason"].as_str().unwrap().starts_with("auto:"));
        assert!(answer.get("lane_fallback").is_none());
        let fell = LaneNote::fell_back("ACP_ADDON_MISSING", "Chat needs a small add-on");
        let record = fell.record();
        assert_eq!((record.used.as_str(), record.fallback.as_ref().unwrap()["code"].as_str()), ("terminal", Some("ACP_ADDON_MISSING")));
        let (used, reason, fallback) = record.report(true);
        assert_eq!(used, "headless", "a later fallback to headless wins");
        assert!(reason.contains("terminal ran it instead") && fallback.is_some());
        assert_eq!(record.report(false).0, "terminal");
    }

    #[test]
    fn the_lane_note_survives_the_workers_save_and_load() {
        let worker = crate::operations::WorkerPersist { lane_note: Some(LaneNote::fell_back("ACP_START_FAILED", "x").record()), ..Default::default() };
        let back: crate::operations::WorkerPersist = serde_json::from_str(&serde_json::to_string(&worker).unwrap()).unwrap();
        assert_eq!(back.lane_note, worker.lane_note);
        let older: crate::operations::WorkerPersist = serde_json::from_str("{}").unwrap();
        assert!(older.lane_note.is_none(), "runs saved before this field still load");
    }

    #[test]
    fn an_unknown_agent_lists_the_valid_ids() {
        let error = unknown_agent("nope", &["claude".to_string(), "codex".to_string()]);
        assert_eq!(error.code, "UNKNOWN_AGENT");
        assert!(error.message.contains("claude, codex"));
        assert_eq!(error.context["valid"], json!(["claude", "codex"]));
    }
}
