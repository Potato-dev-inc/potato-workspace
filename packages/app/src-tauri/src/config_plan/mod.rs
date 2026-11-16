//! Change the app's setup in two steps: PLAN (what would change, in plain words, nothing touched), then APPLY (exactly that
//! plan, by its id). The command line (`potato-workspace standby add ...`) and the MCP tool `workspace_config` are both thin
//! clients of the `/config/*` routes (`bridge/routes/config.rs`); the rules live here.
//!
//! * A plan is kept in memory for ten minutes and used once. It remembers a fingerprint of the state it was made against; if
//!   that state changed before apply (someone edited the standby list, a setting moved) apply refuses with `PLAN_STALE`.
//! * What a plan may hold is a short allowlist: settings the catalog lists (never a secret, never `ui_mode`), and standby
//!   helpers (add, remove from the agent, close). Logins, lending and devices are not here and cannot be added by a file.
//! * Standby words: "remove" only detaches (the helper keeps running as a free warm agent); "close" stops it and drops it.
//! * A plan is checked against a COPY of the standby list, so a refusal (too many standbys, a missing folder) happens at plan
//!   time and apply has nothing left to fail on but the disk.
//! * Who must say yes (the person's Allow card for an agent caller) is decided by the route, not here.

mod live;
#[cfg(test)]
pub(crate) mod tests;

pub use live::LiveWorld;

use crate::standby::helpers::{AfterTask, HelperStore, NewHelper, StandbyHelper};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// How long a plan can wait for its apply.
pub const PLAN_TTL_MS: u64 = 10 * 60_000;
const MAX_PLANS: usize = 32;
const MAX_OPS: usize = 12;

/// Words an error carries: `(code, plain sentence)`.
pub type Refusal = (&'static str, String);

fn refuse<T>(code: &'static str, message: impl Into<String>) -> Result<T, Refusal> {
    Err((code, message.into()))
}

/// What the plan code needs from the machine. The live one is [`LiveWorld`]; tests use a fake.
pub trait World {
    /// `GET /settings/catalog`: `{settings:[{key,type,default,saved,effective,labs}], refused:[..], ..}`.
    fn catalog(&self) -> Value;
    fn patch_settings(&self, patch: &Value);
    fn helper_store(&self) -> HelperStore;
    /// The standby list with each helper's state (`GET /config/standby`).
    fn standby_view(&self) -> Value;
    /// Changes the standby list and saves it, all or nothing.
    fn edit_helpers(&self, change: &mut dyn FnMut(&mut HelperStore) -> Result<(), String>) -> Result<(), String>;
    /// Can this agent wait on standby (it has a chat way to run)?
    fn agent_can_wait(&self, agent: &str) -> bool;
    fn folder_exists(&self, path: &str) -> bool;
    fn default_project(&self) -> Option<String>;
    fn new_id(&self) -> String;
    /// A helper was added, detached or closed: start, refresh or stop its session now.
    fn helpers_changed(&self, closed: &[String]);
}

/// One planned step, already resolved against the state it was planned on.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Settings(Map<String, Value>),
    StandbyAdd(NewHelper),
    /// Detach: it stays running as a free warm agent.
    StandbyRemove { id: String, name: String },
    /// Stop it and drop it from the list.
    StandbyClose { id: String, name: String },
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub id: String,
    pub created_ms: u64,
    pub steps: Vec<Step>,
    /// Plain lines for the person, values included (the plan result the agent shows them).
    pub lines: Vec<String>,
    /// What the Allow card shows: the same, with no setting VALUES.
    pub card_lines: Vec<String>,
    fingerprint: u64,
}

/// What `plan` hands back.
#[derive(Debug, Serialize)]
pub struct PlanView {
    pub plan_id: String,
    pub expires_in_s: u64,
    pub lines: Vec<String>,
    pub changes: Vec<Value>,
    pub changes_anything: bool,
}

/// What `apply` hands back.
#[derive(Debug, Serialize)]
pub struct Applied {
    pub applied: bool,
    pub lines: Vec<String>,
    pub standby_added: Vec<Value>,
}

/// Plans waiting for their apply.
#[derive(Default)]
pub struct PlanStore {
    plans: Mutex<HashMap<String, Plan>>,
}

static STORE: Lazy<PlanStore> = Lazy::new(PlanStore::default);

pub fn store() -> &'static PlanStore {
    &STORE
}

impl PlanStore {
    fn put(&self, plan: Plan, now: u64) {
        let mut plans = self.plans.lock();
        plans.retain(|_, p| now.saturating_sub(p.created_ms) < PLAN_TTL_MS);
        if plans.len() >= MAX_PLANS {
            if let Some(oldest) = plans.values().min_by_key(|p| p.created_ms).map(|p| p.id.clone()) {
                plans.remove(&oldest);
            }
        }
        plans.insert(plan.id.clone(), plan);
    }

    /// A plan's lines for an Allow card (no values). `None` when the plan is unknown or expired.
    pub fn card_lines(&self, id: &str, now: u64) -> Option<Vec<String>> {
        let plans = self.plans.lock();
        let plan = plans.get(id)?;
        (now.saturating_sub(plan.created_ms) < PLAN_TTL_MS).then(|| plan.card_lines.clone())
    }

    /// Takes the plan out (a plan is used once, whatever comes of it).
    fn take(&self, id: &str, now: u64) -> Result<Plan, Refusal> {
        let plan = self.plans.lock().remove(id);
        match plan {
            None => refuse("PLAN_UNKNOWN", "There is no such plan. It may have been used already or may have expired. Make a new plan."),
            Some(plan) if now.saturating_sub(plan.created_ms) >= PLAN_TTL_MS => {
                refuse("PLAN_STALE", "That plan is more than ten minutes old, so nothing was changed. Make a new plan.")
            }
            Some(plan) => Ok(plan),
        }
    }
}

const SECRETISH: [&str; 6] = ["secret", "token", "password", "passwd", "apikey", "credential"];

fn looks_secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase().replace('_', "");
    SECRETISH.iter().any(|word| lower.contains(word)) || lower.contains("privatekey")
}

fn known_keys(obj: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), Refusal> {
    match obj.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(extra) => refuse("INVALID_ARGUMENT", format!("{what} has no field \"{extra}\". Allowed: {}.", allowed.join(", "))),
        None => Ok(()),
    }
}

fn text(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn type_matches(kind: &str, value: &Value) -> bool {
    match kind {
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "string" => value.is_string(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        _ => true,
    }
}

fn show_value(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 80 {
        format!("{}...", text.chars().take(80).collect::<String>())
    } else {
        text
    }
}

/// The helper a person means by `target`: an id, or a name (case does not matter). A name two standbys share is refused.
pub fn find_helper<'a>(store: &'a HelperStore, target: &str) -> Result<&'a StandbyHelper, Refusal> {
    let target = target.trim();
    if target.is_empty() {
        return refuse("INVALID_ARGUMENT", "Say which standby, by its name.");
    }
    if let Some(found) = store.helpers.iter().find(|h| h.id == target) {
        return Ok(found);
    }
    let named: Vec<&StandbyHelper> = store.helpers.iter().filter(|h| h.name.eq_ignore_ascii_case(target)).collect();
    match named.as_slice() {
        [one] => Ok(one),
        [] => refuse("NOT_FOUND", format!("There is no standby called \"{target}\". Run \"standby list\" to see them.")),
        _ => refuse("AMBIGUOUS", format!("More than one standby is called \"{target}\". Use its id (from \"standby list --json\").")),
    }
}

fn after_task_of(raw: Option<String>) -> Result<AfterTask, Refusal> {
    match raw.as_deref() {
        None | Some("wait") => Ok(AfterTask::Wait),
        Some("close") => Ok(AfterTask::Close),
        Some(other) => refuse("INVALID_ARGUMENT", format!("after_task is \"wait\" or \"close\", not \"{other}\".")),
    }
}

fn fingerprint(world: &dyn World, steps: &[Step]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let catalog = world.catalog();
    for step in steps {
        if let Step::Settings(patch) = step {
            for key in patch.keys() {
                let saved = catalog["settings"].as_array().and_then(|all| all.iter().find(|e| e["key"] == json!(key))).map(|e| e["saved"].to_string());
                (key, saved).hash(&mut hasher);
            }
        }
    }
    if steps.iter().any(|s| !matches!(s, Step::Settings(_))) {
        let store = world.helper_store();
        for h in &store.helpers {
            (&h.id, &h.name, &h.agent, &h.model, &h.project, h.after_task as u8, &h.home, h.warm).hash(&mut hasher);
        }
        (store.settings.max, store.helpers.len()).hash(&mut hasher);
    }
    hasher.finish()
}

/// Reads one `ops` entry into a step and the lines that describe it, checking it against `scratch` (a copy of the standby
/// list that every earlier step already changed).
fn read_op(world: &dyn World, catalog: &Value, scratch: &mut HelperStore, raw: &Value, lines: &mut Vec<String>, card: &mut Vec<String>) -> Result<Step, Refusal> {
    let Some(obj) = raw.as_object() else { return refuse("INVALID_ARGUMENT", "Each op must be an object with a \"kind\".") };
    let kind = text(obj, "kind").unwrap_or_default();
    match kind.as_str() {
        "settings" => {
            known_keys(obj, &["kind", "patch"], "A settings op")?;
            let Some(patch) = obj.get("patch").and_then(Value::as_object).filter(|p| !p.is_empty()) else {
                return refuse("INVALID_ARGUMENT", "A settings op needs a \"patch\" object with at least one setting.");
            };
            let refused: Vec<&str> = catalog["refused"].as_array().map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            let entries = catalog["settings"].as_array().cloned().unwrap_or_default();
            let mut names = Vec::new();
            for (key, value) in patch {
                if looks_secret(key) || refused.contains(&key.as_str()) {
                    return refuse("REFUSED", format!("\"{key}\" cannot be read or changed from here."));
                }
                let Some(entry) = entries.iter().find(|e| e["key"] == json!(key)) else {
                    return refuse("UNKNOWN_SETTING", format!("\"{key}\" is not a setting that can be changed from here. Read the settings catalog to see which ones are."));
                };
                if !value.is_null() && !type_matches(entry["type"].as_str().unwrap_or("any"), value) {
                    return refuse("INVALID_ARGUMENT", format!("{key} takes a {}, got {}.", entry["type"].as_str().unwrap_or("value"), show_value(value)));
                }
                let from = &entry["saved"];
                let to = if value.is_null() { &entry["default"] } else { value };
                if from == to {
                    lines.push(format!("setting {key}: already {} (no change)", show_value(to)));
                } else {
                    lines.push(format!("setting {key}: {} -> {}", show_value(from), show_value(to)));
                }
                names.push(key.clone());
            }
            card.push(format!("Change settings: {}", names.join(", ")));
            Ok(Step::Settings(patch.clone()))
        }
        "standby_add" => {
            known_keys(obj, &["kind", "name", "agent", "model", "project", "after_task"], "A standby_add op")?;
            let agent = text(obj, "agent").unwrap_or_default().to_ascii_lowercase();
            if agent.is_empty() {
                return refuse("INVALID_ARGUMENT", "A standby needs an agent, like \"opencode\".");
            }
            if !world.agent_can_wait(&agent) {
                return refuse("INVALID_ARGUMENT", "That agent has no chat way to run yet, so it cannot wait on standby.");
            }
            let Some(project) = text(obj, "project").or_else(|| world.default_project()) else {
                return refuse("INVALID_ARGUMENT", "No project folder is open. Give a \"project\" folder.");
            };
            if !world.folder_exists(&project) {
                return refuse("INVALID_ARGUMENT", "That project folder does not exist.");
            }
            let input = NewHelper { name: text(obj, "name").unwrap_or_default(), agent, model: text(obj, "model"), project, after_task: after_task_of(text(obj, "after_task"))?, home: None };
            let added = scratch.add(input.clone(), "plan".into()).map_err(|e| ("REFUSED", e))?;
            let model = added.model.clone().map(|m| format!(", {m}")).unwrap_or_default();
            let line = format!("standby: add \"{}\" ({}{model}; {})", added.name, added.agent, if added.after_task == AfterTask::Close { "closes after a task" } else { "waits after a task" });
            lines.push(line.clone());
            card.push(line);
            Ok(Step::StandbyAdd(NewHelper { name: added.name, ..input }))
        }
        "standby_remove" | "standby_close" => {
            known_keys(obj, &["kind", "target"], "A standby op")?;
            let found = find_helper(scratch, &text(obj, "target").unwrap_or_default())?.clone();
            let (id, name) = (found.id, found.name);
            if kind == "standby_remove" {
                scratch.detach(&id).map_err(|e| ("NOT_FOUND", e))?;
                let line = format!("standby: remove \"{name}\" from its agent (it keeps running as a free warm agent)");
                lines.push(line.clone());
                card.push(line);
                Ok(Step::StandbyRemove { id, name })
            } else {
                scratch.remove(&id);
                let line = format!("standby: close \"{name}\" (it stops and leaves the list)");
                lines.push(line.clone());
                card.push(line);
                Ok(Step::StandbyClose { id, name })
            }
        }
        "" => refuse("INVALID_ARGUMENT", "Each op needs a \"kind\": settings, standby_add, standby_remove or standby_close."),
        other => refuse("INVALID_ARGUMENT", format!("Unknown op kind \"{other}\". Use settings, standby_add, standby_remove or standby_close.")),
    }
}

fn step_kind(step: &Step) -> &'static str {
    match step {
        Step::Settings(_) => "settings",
        Step::StandbyAdd(_) => "standby_add",
        Step::StandbyRemove { .. } => "standby_remove",
        Step::StandbyClose { .. } => "standby_close",
    }
}

/// Makes a plan from `{ "ops": [ ... ] }`. Nothing is changed.
pub fn plan(world: &dyn World, plans: &PlanStore, body: &Value, now: u64) -> Result<PlanView, Refusal> {
    let Some(ops) = body.get("ops").and_then(Value::as_array).filter(|o| !o.is_empty()) else {
        return refuse("INVALID_ARGUMENT", "A plan needs \"ops\": a list with at least one change.");
    };
    if ops.len() > MAX_OPS {
        return refuse("INVALID_ARGUMENT", format!("A plan holds at most {MAX_OPS} changes."));
    }
    if let Some(extra) = body.as_object().and_then(|o| o.keys().find(|k| !matches!(k.as_str(), "ops" | "op"))) {
        return refuse("INVALID_ARGUMENT", format!("A plan has no field \"{extra}\"."));
    }
    let catalog = world.catalog();
    let mut scratch = world.helper_store();
    let (mut lines, mut card, mut steps) = (Vec::new(), Vec::new(), Vec::new());
    let mut changes = Vec::new();
    for raw in ops {
        let before = lines.len();
        let step = read_op(world, &catalog, &mut scratch, raw, &mut lines, &mut card)?;
        for line in &lines[before..] {
            changes.push(json!({ "op": step_kind(&step), "summary": line }));
        }
        steps.push(step);
    }
    let changes_anything = lines.iter().any(|l| !l.ends_with("(no change)"));
    let id = format!("plan-{}", world.new_id());
    let made = Plan { id: id.clone(), created_ms: now, fingerprint: fingerprint(world, &steps), steps, lines: lines.clone(), card_lines: card };
    plans.put(made, now);
    Ok(PlanView { plan_id: id, expires_in_s: PLAN_TTL_MS / 1000, lines, changes, changes_anything })
}

/// Runs the plan with this id. A plan that no longer matches the state it was made against is refused (`PLAN_STALE`) and
/// nothing is changed.
pub fn apply(world: &dyn World, plans: &PlanStore, plan_id: &str, now: u64) -> Result<Applied, Refusal> {
    let plan = plans.take(plan_id, now)?;
    if fingerprint(world, &plan.steps) != plan.fingerprint {
        return refuse("PLAN_STALE", "The app changed since this plan was made, so nothing was changed. Make a new plan and look at it again.");
    }
    let mut added = Vec::new();
    let mut closed = Vec::new();
    let has_standby = plan.steps.iter().any(|s| !matches!(s, Step::Settings(_)));
    if has_standby {
        world
            .edit_helpers(&mut |store| {
                added.clear();
                closed.clear();
                for step in &plan.steps {
                    match step {
                        Step::Settings(_) => {}
                        Step::StandbyAdd(input) => {
                            let made = store.add(input.clone(), format!("sb-{}", world.new_id()))?;
                            added.push(json!({ "id": made.id, "name": made.name, "agent": made.agent, "model": made.model }));
                        }
                        Step::StandbyRemove { id, .. } => store.detach(id)?,
                        Step::StandbyClose { id, .. } => {
                            if !store.remove(id) {
                                return Err("That standby is gone.".to_string());
                            }
                            closed.push(id.clone());
                        }
                    }
                }
                Ok(())
            })
            .map_err(|e| ("APPLY_FAILED", e))?;
    }
    for step in &plan.steps {
        if let Step::Settings(patch) = step {
            world.patch_settings(&Value::Object(patch.clone()));
        }
    }
    if has_standby {
        world.helpers_changed(&closed);
    }
    Ok(Applied { applied: true, lines: plan.lines, standby_added: added })
}
