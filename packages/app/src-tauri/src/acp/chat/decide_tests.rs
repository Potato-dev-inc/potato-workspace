//! The lane resolver over every agent: whatever a caller asks, the first call starts a run or the refusal's `try`
//! starts one in one more call. Nothing real runs; the facts come from the agent definitions and profiles.

use serde_json::{json, Value};

use super::decide::{decide, near_id, Ctx, Route};
use super::surface::LaneLookup;
use crate::acp::config::{AgentConfig, HostEnv};
use crate::acp::lane::RunLane;

/// The facts of the real agents, with the app settings set by each test.
struct Facts {
    labs: bool,
    major: Option<u32>,
}

impl LaneLookup for Facts {
    fn labs_on(&self) -> bool {
        self.labs
    }
    fn config_for(&self, agent: &str) -> Option<AgentConfig> {
        crate::acp::config::find_builtin(agent)
    }
    fn saved(&self, _: &str) -> Option<RunLane> {
        None
    }
    fn adapter_installed(&self, _: &AgentConfig, _: &dyn HostEnv) -> bool {
        true
    }
    fn opencode_major(&self) -> Option<u32> {
        self.major
    }
}

fn every_agent() -> Vec<String> {
    let mut ids = crate::tui::registered_agent_ids();
    for id in crate::acp::config::builtin_agents().into_iter().map(|c| c.id).chain(["opencode_native".to_string()]) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

fn run_decide(facts: &Facts, body: &Value) -> super::decide::Decided {
    let installed = |_: &AgentConfig| true;
    let ctx = Ctx { lookup: facts, adapter_installed: &installed, chat_ids: crate::acp::config::builtin_agents().into_iter().map(|c| c.id).collect(), chat_broken: false };
    decide(body, &ctx)
}

fn start_of(route: &Route) -> Option<&'static str> {
    match route {
        Route::Chat { .. } => Some("acp"),
        Route::Terminal { .. } => Some("terminal"),
        Route::Refused(_) => None,
    }
}

#[test]
fn every_agent_every_lane_every_flag_starts_or_says_the_call_that_does() {
    let lane_less_codes = ["NO_LANE_FITS", "ACP_OFF", "UNKNOWN_AGENT"];
    let mut cells = 0;
    let mut refusals = 0;
    for labs in [true, false] {
        for major in [None, Some(1), Some(2)] {
            let facts = Facts { labs, major };
            for agent in every_agent() {
                for lane in [None, Some("auto"), Some("acp"), Some("terminal")] {
                    for headless in [false, true] {
                        for (flag, extra) in [
                            ("plain", json!({})),
                            ("read_only", json!({ "read_only": true })),
                            ("isolation", json!({ "isolation": "worktree" })),
                            ("model", json!({ "model": "m" })),
                            ("all", json!({ "read_only": true, "isolation": "worktree", "model": "m" })),
                        ] {
                            for strict in [false, true] {
                                let mut body = json!({ "task": "t", "agent_type": agent, "project_path": "p", "headless": headless });
                                if let Some(lane) = lane {
                                    body["lane"] = json!(lane);
                                }
                                if strict {
                                    body["strict"] = json!(true);
                                }
                                for (k, v) in extra.as_object().unwrap() {
                                    body[k] = v.clone();
                                }
                                let cell = format!("{agent} lane={lane:?} headless={headless} {flag} strict={strict} labs={labs} opencode={major:?}");
                                cells += 1;
                                let decided = run_decide(&facts, &body);
                                let Route::Refused(error) = &decided.route else { continue };
                                refusals += 1;
                                if !strict {
                                    assert!(lane_less_codes.contains(&error.code.as_str()), "{cell}: {} is a lane-specific refusal without strict: {}", error.code, error.message);
                                }
                                let call = &error.context["try"];
                                assert_eq!(call["tool"], "run_agent", "{cell}: {} has no try: {}", error.code, error.context);
                                let again = run_decide(&facts, &call["args"]);
                                assert!(start_of(&again.route).is_some(), "{cell}: try {call} still refuses: {:?}", again.route);
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(cells > 1000 && refusals > 0, "{cells} cells, {refusals} refusals");
}

#[test]
fn the_field_report_read_only_opencode_starts_on_the_first_call_whatever_the_lane() {
    for major in [Some(1), Some(2)] {
        let facts = Facts { labs: true, major };
        for lane in [None, Some("acp"), Some("terminal")] {
            let mut body = json!({ "task": "t", "agent_type": "opencode", "project_path": "p", "read_only": true });
            if let Some(lane) = lane {
                body["lane"] = json!(lane);
            }
            let decided = run_decide(&facts, &body);
            assert_eq!(start_of(&decided.route), Some("acp"), "lane {lane:?}, opencode {major:?}: {:?}", decided.route);
            if lane == Some("terminal") {
                let Route::Chat { adjusted, .. } = &decided.route else { unreachable!() };
                assert_eq!(adjusted[0]["field"], "lane");
                assert_eq!((adjusted[0]["asked"].as_str(), adjusted[0]["used"].as_str()), (Some("terminal"), Some("acp")));
            }
        }
    }
}

#[test]
fn strict_keeps_the_lane_and_refuses_with_the_call_that_works() {
    let facts = Facts { labs: true, major: Some(2) };
    let body = json!({ "task": "t", "agent_type": "opencode", "project_path": "p", "read_only": true, "lane": "terminal", "strict": true });
    let Route::Refused(error) = run_decide(&facts, &body).route else { panic!("strict must refuse") };
    assert_eq!(error.code, "READ_ONLY_UNSUPPORTED");
    assert_eq!(error.context["try"]["args"]["strict"], true);
    assert!(error.context["try"]["args"].get("lane").is_none(), "{}", error.context);
    assert!(error.context.get("fix").is_none(), "try replaces the free-text fix");
}

#[test]
fn an_unknown_agent_with_a_near_match_names_the_call_with_the_right_id() {
    let facts = Facts { labs: true, major: None };
    let body = json!({ "task": "t", "agent_type": "opencod", "project_path": "p", "lane": "acp" });
    let Route::Refused(error) = run_decide(&facts, &body).route else { panic!("unknown id") };
    assert_eq!(error.code, "UNKNOWN_AGENT");
    assert_eq!(error.context["try"]["args"]["agent_type"], "opencode", "{}", error.context);
    assert_eq!(near_id("claud", &["claude".into(), "codex".into()]).as_deref(), Some("claude"));
    assert_eq!(near_id("zzzzzz", &["claude".into(), "codex".into()]), None);
}

#[test]
fn the_try_leaves_out_the_first_attempts_idempotency_key() {
    let facts = Facts { labs: false, major: None };
    let body = json!({ "task": "t", "agent_type": "opencode", "project_path": "p", "lane": "acp", "idempotency_key": "k1" });
    let Route::Refused(error) = run_decide(&facts, &body).route else { panic!("labs off") };
    assert_eq!(error.code, "ACP_OFF");
    assert!(error.context["try"]["args"].get("idempotency_key").is_none());
}
