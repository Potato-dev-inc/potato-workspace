//! Sharing a crew as one file ("Share" on the canvas) and reading one back ("Open a shared crew").
//!
//! The file is JSON: `{ format, version, crew, routing_text }`. It never holds sign-ins, keys or folder paths:
//! the crew shape has no such field (every field is on the allow-list of `model::Crew`, and an unknown key is
//! refused when a file is read), and the free text (the jobs and the rules) is redacted when it is written.
//! Reading a file only checks it and describes it: nothing is saved, started or run until the person
//! saves it (and a save passes the same validator as any crew). Plain text only; no network.

use super::model::{Crew, CrewError, Role, MAX_FILE_BYTES};
use super::validate::{normalized, validate_with, AgentState};
use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "potato-crew";
pub const VERSION: u32 = 1;
/// The rules a crew carries are at most this long (the same limit as saving them).
pub const MAX_ROUTING_BYTES: usize = 16 * 1024;
/// A shared file larger than this is not read.
pub const MAX_SHARE_BYTES: usize = 2 * MAX_FILE_BYTES;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shared {
    pub format: String,
    pub version: u32,
    pub crew: Crew,
    #[serde(default)]
    pub routing_text: String,
}

/// What opening a shared file shows before anything changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Preview {
    pub crew: Crew,
    pub routing_text: String,
    pub problems: Vec<CrewError>,
    /// Roles that may merge work.
    pub may_merge: Vec<String>,
    /// Roles that may ask for more helpers.
    pub may_start_helpers: Vec<String>,
    /// Roles whose commands run in their own worktree without asking each time.
    pub runs_commands: Vec<String>,
    /// Helpers the crew would keep ready if it were applied.
    pub standbys: u32,
}

fn bad(code: &'static str, message: &str) -> CrewError {
    CrewError::new(code, message)
}

/// The text of a shared file for `crew` and its rules. Free text goes through `redact`.
pub fn export(crew: &Crew, routing_text: &str, redact: &dyn Fn(&str) -> String) -> Result<String, CrewError> {
    let mut crew = normalized(crew);
    for role in &mut crew.roles {
        role.task = redact(&role.task);
    }
    let shared = Shared { format: FORMAT.into(), version: VERSION, crew, routing_text: redact(routing_text) };
    serde_json::to_string_pretty(&shared).map_err(|e| CrewError::new("CREW_FILE_INVALID", format!("This crew cannot be shared: {e}")))
}

fn names(roles: &[Role], keep: impl Fn(&Role) -> bool) -> Vec<String> {
    roles.iter().filter(|r| keep(r)).map(|r| r.name.clone()).collect()
}

/// Read a shared file and describe it. Nothing is saved or run. A crew with problems is still described
/// (the sheet shows the problems); a file that is not a shared crew is an error.
pub fn read(text: &str, agent_state: &dyn Fn(&str) -> AgentState, model_ok: &dyn Fn(&str, &str) -> bool) -> Result<Preview, CrewError> {
    if text.len() > MAX_SHARE_BYTES {
        return Err(bad("CREW_FILE_TOO_BIG", "This file is too big to be a shared crew."));
    }
    let shared: Shared = serde_json::from_str(text).map_err(|_| bad("CREW_SHARE_INVALID", "This is not a shared crew file."))?;
    if shared.format != FORMAT {
        return Err(bad("CREW_SHARE_INVALID", "This is not a shared crew file."));
    }
    if shared.version != VERSION {
        return Err(bad("CREW_SHARE_VERSION", "This crew file comes from a different version of the app."));
    }
    if shared.routing_text.len() > MAX_ROUTING_BYTES {
        return Err(bad("CREW_ROUTING_TOO_BIG", "The rules in this file are too long."));
    }
    if shared.routing_text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Err(bad("CREW_SHARE_INVALID", "The rules in this file hold characters that are not plain text."));
    }
    let crew = normalized(&shared.crew);
    let problems = validate_with(&crew, agent_state, model_ok);
    let perm = |r: &Role| r.permissions.clone();
    Ok(Preview {
        may_merge: names(&crew.roles, |r| perm(r).is_some_and(|p| p.merge)),
        may_start_helpers: names(&crew.roles, |r| perm(r).is_some_and(|p| p.start_helpers)),
        runs_commands: names(&crew.roles, |r| perm(r).is_some_and(|p| p.run == "worktree")),
        standbys: crew.roles.iter().map(|r| u32::from(r.standbys)).sum(),
        routing_text: shared.routing_text,
        problems,
        crew,
    })
}
