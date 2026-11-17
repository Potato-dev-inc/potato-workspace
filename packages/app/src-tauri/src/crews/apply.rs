//! Apply a crew: get its helpers ready now. Every role with `standbys` above zero gets that many one-time standby
//! helpers (`standby::helpers`) in the folder the person picked. They are made when you apply and are not refilled:
//! `AfterTask::Close`, so a helper that took a task does not start again as a standby. Nothing is started as a task and no pane
//! is opened. Applying twice adds nothing new: a standby with the same name, agent and folder counts as there.
//! Slot for 1.1.8: the role's permissions are saved in the crew, and are applied to the helpers here later.

use super::model::Crew;
use crate::standby::helpers::{AfterTask, NewHelper, StandbyHelper};
use serde::Serialize;

const NAME_MAX: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub role: String,
    pub why: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub to_add: Vec<NewHelper>,
    /// Helpers that are already there.
    pub already: usize,
    pub skipped: Vec<Skipped>,
}

/// The name of the `n`th standby of a role (`n` from 1; the number is left off when the role keeps one).
pub fn helper_name(crew: &str, role: &str, n: usize, of: usize) -> String {
    let suffix = if of > 1 { format!(" {n}") } else { String::new() };
    let base: String = format!("{} · {}", crew.trim(), role.trim());
    let room = NAME_MAX.saturating_sub(suffix.chars().count());
    let base: String = base.chars().take(room).collect();
    format!("{}{}", base.trim_end(), suffix)
}

/// What applying `crew` in `folder` would add. `can_wait` says whether an agent has a chat way to wait on standby.
pub fn plan(crew: &Crew, folder: &str, existing: &[StandbyHelper], can_wait: &dyn Fn(&str) -> bool) -> Plan {
    let mut out = Plan::default();
    for role in crew.roles.iter().filter(|r| r.standbys > 0) {
        if !can_wait(&role.agent_type) {
            out.skipped.push(Skipped { role: role.name.clone(), why: "This agent cannot wait ready in the background.".into() });
            continue;
        }
        let of = role.standbys as usize;
        for n in 1..=of {
            let name = helper_name(&crew.name, &role.name, n, of);
            let there = existing.iter().any(|h| h.name == name && h.agent.eq_ignore_ascii_case(&role.agent_type) && h.project == folder);
            if there {
                out.already += 1;
            } else {
                out.to_add.push(NewHelper {
                    name,
                    agent: role.agent_type.clone(),
                    model: role.model.clone(),
                    project: folder.to_string(),
                    after_task: AfterTask::Close,
                    home: None,
                    kind: None,
                });
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "apply_tests.rs"]
mod tests;
