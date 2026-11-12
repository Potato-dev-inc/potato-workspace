//! The one resolver behind `run_agent`'s lane: what the caller needs (`read_only`, `isolation`, ...) picks the way to
//! run, and `lane` is a hint.
//!
//! * The facts come from the agent's definition and profile (does a chat have a read-only mode, can the terminal
//!   enforce read-only, is the chat add-on there), never from an agent's name.
//! * A lane that cannot honour what the request needs is swapped for one that can, and the answer says so
//!   (`adjusted: [{field, asked, used, why}]`). It is refused only with `strict: true`, or when no lane fits
//!   (`NO_LANE_FITS`, with `context.tried`).
//! * Every refusal carries `try: {tool, args, changes}`: the corrected call, found by running this same resolver on the
//!   corrected arguments, so it is known to start.
//! * Pure: the app and the agent are asked through [`Ctx`], so a test can answer for any agent.

use serde_json::{json, Map, Value};

use super::lanes::{self, CannotChatHint, Facts, Plan};
use super::surface::{chat_agent_ids, chat_cannot_do, text_of, LaneLookup};
use crate::acp::config::AgentConfig;
use crate::operations::OperationError;

/// What the decision asks of the app and the agent.
pub struct Ctx<'a> {
    pub lookup: &'a dyn LaneLookup,
    /// The chat add-on of this agent is installed.
    pub adapter_installed: &'a dyn Fn(&AgentConfig) -> bool,
    /// Every id a chat can be asked for (the near-match source for `UNKNOWN_AGENT`).
    pub chat_ids: Vec<String>,
    /// A chat was tried for this request and could not run it: the corrected call must not use one.
    pub chat_broken: bool,
}

impl Ctx<'_> {
    fn broken(&self) -> Ctx<'_> {
        Ctx { lookup: self.lookup, adapter_installed: self.adapter_installed, chat_ids: self.chat_ids.clone(), chat_broken: true }
    }
}

/// One thing the resolver changed from what the caller asked.
pub fn adjusted(field: &str, asked: &str, used: &str, why: &str) -> Value {
    json!({ "field": field, "asked": asked, "used": used, "why": why })
}

/// How the run goes.
#[derive(Debug)]
pub enum Route {
    Chat { explicit: bool, reason: String, adjusted: Vec<Value> },
    Terminal { reason: String, adjusted: Vec<Value> },
    Refused(OperationError),
}

/// The decision plus what `run` needs to carry it out.
pub struct Decided {
    /// The agent after routing (the native OpenCode agent on 2.x becomes the chat agent).
    pub agent: Option<String>,
    pub config: Option<AgentConfig>,
    pub labs_on: bool,
    pub hint: CannotChatHint,
    pub route: Route,
}

impl Decided {
    pub fn is_start(&self) -> bool {
        !matches!(self.route, Route::Refused(_))
    }
}

/// Decides the lane for a `run_agent` body and, for a refusal, finds the call that works.
pub fn decide(value: &Value, ctx: &Ctx) -> Decided {
    let mut decided = decide_inner(value, ctx);
    if let Route::Refused(error) = &mut decided.route {
        let alt = decided.agent.clone().filter(|a| Some(a.as_str()) != value.get("agent_type").and_then(Value::as_str));
        attach_try(error, value, ctx, alt.as_deref());
    }
    decided
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn refused(error: OperationError, agent: Option<String>, config: Option<AgentConfig>, labs_on: bool, hint: CannotChatHint) -> Decided {
    Decided { agent, config, labs_on, hint, route: Route::Refused(error) }
}

fn decide_inner(value: &Value, ctx: &Ctx) -> Decided {
    let strict = flag(value, "strict");
    let mut lane = text_of(value, "lane");
    let mut agent = text_of(value, "agent_type");
    let mut adjustments: Vec<Value> = Vec::new();
    let mut routed: Option<String> = None;
    let labs_on = ctx.lookup.labs_on();
    let bare_hint = CannotChatHint { agent: agent.clone(), ..Default::default() };
    // An agent whose native terminal lane is gone (a version gate): its runs go to its chat lane, and say so.
    if agent.as_deref() == Some("opencode_native") {
        match crate::opencode::edition::route_native_run(lane.as_deref(), ctx.lookup.opencode_major()) {
            Ok(Some(why)) => {
                routed = Some(why);
                agent = Some("opencode".to_string());
                lane = Some("acp".to_string());
            }
            Ok(None) => {}
            Err(why) if strict => {
                return refused(OperationError::new("OPENCODE_NATIVE_UNAVAILABLE", why, false), Some("opencode".to_string()), None, labs_on, bare_hint);
            }
            Err(_) => {
                let why = "OpenCode 2.x has no terminal attach, so this run went to the OpenCode chat (ACP) lane.";
                adjustments.push(adjusted("lane", "terminal", "acp", why));
                routed = Some(why.to_string());
                agent = Some("opencode".to_string());
                lane = Some("acp".to_string());
            }
        }
    }
    let saved = agent.as_deref().and_then(|a| ctx.lookup.saved(a));
    let config = agent.as_deref().and_then(|a| ctx.lookup.config_for(a));
    let headless = flag(value, "headless");
    let read_only = flag(value, "read_only");
    let chat_ro = config.as_ref().is_some_and(super::read_only::supported);
    let terminal_ro = agent.as_deref().is_some_and(|a| ctx.lookup.terminal_read_only(a));
    let hint = CannotChatHint { agent: agent.clone(), chat_read_only: chat_ro, terminal_read_only: terminal_ro };
    let chat_ready = !ctx.chat_broken && labs_on && config.as_ref().is_some_and(|cfg| (ctx.adapter_installed)(cfg));
    // What a chat cannot honour. A chat that has a read-only mode honours `read_only`; the terminal keeps the run when
    // it can enforce read-only itself (unless the lane was insisted on), so an agent that worked before runs as before.
    let mut terminal_only = chat_cannot_do(value);
    if read_only && chat_ro && (lane.as_deref() == Some("acp") || !terminal_ro) {
        terminal_only.retain(|field| *field != "read_only");
    }
    let facts = Facts { labs_on, has_definition: config.is_some(), adapter_installed: config.as_ref().is_some_and(|cfg| (ctx.adapter_installed)(cfg)), headless, terminal_only: terminal_only.clone() };
    let plan = match lanes::plan(lane.as_deref(), saved, facts) {
        Ok(plan) => plan,
        Err(why) => return refused(OperationError::new("INVALID_ARGUMENT", why, false), agent, config, labs_on, hint),
    };
    // The terminal can run it unless the request needs read-only and this agent cannot enforce it there.
    let terminal_ok = !read_only || agent.is_none() || terminal_ro;
    let asked_lane = lane.clone().filter(|l| l == "acp" || l == "terminal");
    let route = match plan {
        Plan::Terminal { reason } if terminal_ok => Route::Terminal { reason, adjusted: adjustments },
        Plan::Terminal { reason } => {
            // Read-only was asked and the terminal cannot enforce it: a chat that can, if one can start.
            if chat_ro && chat_ready && terminal_only.is_empty() {
                if strict && asked_lane.as_deref() == Some("terminal") {
                    let agent_name = agent.clone().unwrap_or_default();
                    let error = OperationError::new("READ_ONLY_UNSUPPORTED", crate::agent_runs::read_only_unsupported_message(&agent_name, false), false);
                    return refused(error, agent, config, labs_on, hint);
                }
                let why = "read_only cannot be enforced in a terminal for this agent, and a chat can.";
                if asked_lane.as_deref() == Some("terminal") {
                    adjustments.push(adjusted("lane", "terminal", "acp", why));
                }
                if headless {
                    adjustments.push(adjusted("headless", "true", "false", "A chat has no background mode."));
                }
                Route::Chat { explicit: true, reason: routed.clone().unwrap_or_else(|| format!("{why} ({reason})")), adjusted: adjustments }
            } else {
                return refused(no_lane_fits(&hint, labs_on, config.is_some(), chat_ready, &terminal_only, read_only, terminal_ro), agent, config, labs_on, hint);
            }
        }
        Plan::CannotChat { fields } => {
            if strict {
                return refused(lanes::cannot_chat(&fields, &hint), agent, config, labs_on, hint);
            }
            if terminal_ok {
                let why = format!("{} need{} the terminal (a chat cannot honour {}).", fields.join(", "), if fields.len() == 1 { "s" } else { "" }, if fields.len() == 1 { "it" } else { "them" });
                adjustments.push(adjusted("lane", "acp", "terminal", &why));
                Route::Terminal { reason: format!("You asked for lane \"acp\", but {why}"), adjusted: adjustments }
            } else {
                return refused(no_lane_fits(&hint, labs_on, config.is_some(), chat_ready, &fields, read_only, terminal_ro), agent, config, labs_on, hint);
            }
        }
        Plan::Chat { .. } if ctx.chat_broken => {
            return refused(no_lane_fits(&hint, labs_on, config.is_some(), false, &terminal_only, read_only, terminal_ro), agent, config, labs_on, hint);
        }
        Plan::Chat { explicit, reason } => {
            let Some(agent_id) = agent.clone() else {
                return refused(OperationError::new("INVALID_ARGUMENT", "agent_type is required with lane: \"acp\"", false), agent, config, labs_on, hint);
            };
            // An id that is no agent at all: the ids that can be asked for. (The terminal says UNKNOWN_AGENT_TYPE.)
            if explicit && config.is_none() && !ctx.lookup.registered(&agent_id) {
                return refused(lanes::unknown_agent(&agent_id, &ctx.chat_ids), agent, config, labs_on, hint);
            }
            if explicit && !labs_on {
                return refused(lanes::acp_off(), agent, config, labs_on, hint);
            }
            Route::Chat { explicit, reason: routed.clone().unwrap_or(reason), adjusted: adjustments }
        }
    };
    Decided { agent, config, labs_on, hint, route }
}

/// Nothing runs this request: each way and what stops it.
fn no_lane_fits(hint: &CannotChatHint, labs_on: bool, has_definition: bool, chat_ready: bool, fields: &[&str], read_only: bool, terminal_ro: bool) -> OperationError {
    let agent = hint.agent.as_deref().unwrap_or("this agent");
    let chat_blocked = if !has_definition {
        "this agent has no chat (ACP) way to run".to_string()
    } else if !labs_on {
        "Chat (ACP) is off in Labs".to_string()
    } else if !chat_ready {
        "its chat add-on is not installed".to_string()
    } else {
        let others: Vec<&str> = fields.iter().copied().filter(|f| *f != "read_only").collect();
        if !others.is_empty() {
            format!("a chat cannot honour {}", others.join(", "))
        } else {
            "it has no read-only chat mode".to_string()
        }
    };
    let terminal_blocked = if read_only && !terminal_ro { "read_only cannot be enforced in a terminal for this agent".to_string() } else { "not available".to_string() };
    let mut error = OperationError::new("NO_LANE_FITS", format!("No way to run {agent} fits this request. Nothing was started."), false);
    error.context = json!({
        "tried": [{ "lane": "acp", "blocked_by": chat_blocked }, { "lane": "terminal", "blocked_by": terminal_blocked }],
        "retryable": false,
    });
    error
}

// ---- the corrected call ----------------------------------------------------------------------------------------

/// The args a corrected call starts from: what the caller sent, without the pieces that are not theirs or would clash.
fn clean_args(value: &Value) -> Map<String, Value> {
    let mut map = value.as_object().cloned().unwrap_or_default();
    // Filled in on the way here, or tied to the first attempt.
    map.remove("idempotency_key");
    map.remove("account_source");
    if map.get("headless").and_then(Value::as_bool) == Some(false) {
        map.remove("headless");
    }
    map.retain(|_, v| !v.is_null());
    map
}

/// What the corrected call gives up, in the order tried: nothing, the model, then the options that weaken the run.
const DROPS: &[&[&str]] = &[&[], &["model", "reasoning"], &["read_only"], &["isolation"], &["read_only", "isolation"], &["model", "reasoning", "read_only", "isolation"]];

/// A refusal from the run itself (the chat started and could not do it), with the call that works.
pub fn with_try(mut error: OperationError, value: &Value, ctx: &Ctx, chat_broken: bool) -> OperationError {
    if chat_broken {
        attach_try(&mut error, value, &ctx.broken(), None);
    } else {
        attach_try(&mut error, value, ctx, None);
    }
    error
}

fn attach_try(error: &mut OperationError, value: &Value, ctx: &Ctx, alt_agent: Option<&str>) {
    let base = clean_args(value);
    let found = if error.code == "UNKNOWN_AGENT" { near_agent_try(&base, ctx) } else { lane_try(&base, ctx).or_else(|| alt_agent.and_then(|alt| agent_try(&base, ctx, alt))) };
    let Some((args, changes, weakens)) = found else { return };
    let mut call = json!({ "tool": "run_agent", "args": Value::Object(args), "changes": changes });
    if !weakens.is_empty() {
        call["weakens"] = json!(weakens);
    }
    if !error.context.is_object() {
        error.context = json!({});
    }
    // `try` replaces the free-text fix.
    if let Some(map) = error.context.as_object_mut() {
        map.remove("fix");
        map.insert("try".into(), call);
    }
}

fn starts(args: &Map<String, Value>, ctx: &Ctx) -> bool {
    decide_inner(&Value::Object(args.clone()), ctx).is_start()
}

fn lane_try(base: &Map<String, Value>, ctx: &Ctx) -> Option<(Map<String, Value>, Vec<String>, Vec<&'static str>)> {
    for drops in DROPS {
        for lane in [None, Some("terminal"), Some("acp")] {
            let mut args = base.clone();
            let mut changes = Vec::new();
            let mut weakens = Vec::new();
            for key in *drops {
                let present = match args.get(*key) {
                    Some(Value::Bool(b)) => *b,
                    Some(Value::String(s)) => !s.is_empty() && s != "none",
                    Some(_) => true,
                    None => false,
                };
                if present {
                    args.remove(*key);
                    changes.push(format!("{key}: dropped"));
                    if *key == "read_only" || *key == "isolation" {
                        weakens.push(if *key == "read_only" { "read_only" } else { "isolation" });
                    }
                }
            }
            let old = base.get("lane").and_then(Value::as_str);
            match lane {
                None => {
                    if args.remove("lane").is_some() {
                        changes.push(format!("lane: {} -> (left out)", old.unwrap_or("")));
                    }
                }
                Some(l) => {
                    if old != Some(l) {
                        changes.push(format!("lane: {} -> {l}", old.unwrap_or("(left out)")));
                    }
                    args.insert("lane".into(), json!(l));
                }
            }
            if args == *base || (changes.is_empty() && *drops != DROPS[0]) {
                continue;
            }
            if starts(&args, ctx) {
                return Some((args, changes, weakens));
            }
        }
    }
    None
}

/// The valid id nearest to a misspelt one: a shared prefix, containment, or a couple of typos.
pub fn near_id(asked: &str, valid: &[String]) -> Option<String> {
    let a = asked.trim().to_ascii_lowercase().replace('-', "_");
    valid
        .iter()
        .filter_map(|id| {
            let v = id.to_ascii_lowercase();
            let d = edit_distance(&a, &v);
            let close = d <= 2 || (a.len() >= 3 && (v.starts_with(&a) || a.starts_with(&v) || v.contains(&a)));
            close.then_some((d, id))
        })
        .min_by_key(|(d, id)| (*d, id.len()))
        .map(|(_, id)| id.clone())
}

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(ca != cb)).min(row[j] + 1).min(cur + 1);
            prev = cur;
        }
    }
    row[b.len()]
}

/// The same request for the agent it was routed to (the agent it asked for has no way left).
fn agent_try(base: &Map<String, Value>, ctx: &Ctx, alt: &str) -> Option<(Map<String, Value>, Vec<String>, Vec<&'static str>)> {
    let mut swapped = base.clone();
    swapped.insert("agent_type".into(), json!(alt));
    let change = format!("agent_type: {} -> {alt}", base.get("agent_type").and_then(Value::as_str).unwrap_or(""));
    if starts(&swapped, ctx) {
        return Some((swapped, vec![change], Vec::new()));
    }
    let (args, mut changes, weakens) = lane_try(&swapped, ctx)?;
    changes.insert(0, change);
    Some((args, changes, weakens))
}

fn near_agent_try(base: &Map<String, Value>, ctx: &Ctx) -> Option<(Map<String, Value>, Vec<String>, Vec<&'static str>)> {
    let asked = base.get("agent_type").and_then(Value::as_str)?;
    let near = near_id(asked, &ctx.chat_ids)?;
    let mut args = base.clone();
    args.insert("agent_type".into(), json!(near));
    let changes = vec![format!("agent_type: {asked} -> {near}")];
    starts(&args, ctx).then_some((args, changes, Vec::new()))
}

/// The ids a chat can be asked for, for [`Ctx`].
pub fn live_chat_ids() -> Vec<String> {
    chat_agent_ids()
}
