//! The checks a crew passes before it is saved or started. Like the wizard's deny list, this is pure
//! text checking, and it never names an agent: whether an agent type exists (and whether a model is on
//! that agent's list) comes from the caller (the live registry, or a fake in tests).
//!
//! A task is typed to an agent as a prompt; it is never run through a shell. Even so, it must be
//! plain text: no control characters, a bounded length, and `{folder}` as its only placeholder.

use super::model::{Crew, CrewError, Permissions, Role, DEFAULT_AGENT, KINDS, MAX_ROLES, PLACEHOLDER, RUN_LEVELS, START_MODES, WRITE_LEVELS};

pub const MAX_NAME_CHARS: usize = 60;
pub const MAX_ROLE_NAME_CHARS: usize = 40;
pub const MAX_TASK_CHARS: usize = 4000;
const MAX_AGENT_CHARS: usize = 64;
const MAX_MODEL_CHARS: usize = 80;
/// The most helpers a crew may allow at once.
pub const MAX_HELPERS_CAP: u32 = 64;
/// The most fix loops (checker back to the lead) a crew may allow.
pub const MAX_FIX_LOOPS: u32 = 5;
/// The longest "when to use me" line.
pub const MAX_WHEN_CHARS: usize = 120;
/// The most helper runs per message a workflow may allow.
pub const MAX_HELPER_CAP: u32 = 10;
/// The most warm standbys one role may ask for.
pub const MAX_STANDBYS_PER_ROLE: u8 = 4;

/// What the registry says about an agent type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentState {
    Ready,
    Unknown,
    /// Registered, but it cannot be started as a crew member (a plain shell, say); the reason.
    NotDispatchable(String),
}

fn trimmed(text: &Option<String>) -> Option<String> {
    text.as_ref().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Trim the names the way the sheet shows them. Applied before `validate` on every save.
pub fn normalized(crew: &Crew) -> Crew {
    Crew {
        name: crew.name.trim().to_string(),
        roles: crew
            .roles
            .iter()
            .map(|r| Role {
                id: r.id.trim().to_string(),
                name: r.name.trim().to_string(),
                agent_type: r.agent_type.trim().to_string(),
                task: r.task.trim().to_string(),
                parent: trimmed(&r.parent),
                model: trimmed(&r.model),
                permissions: r.permissions.as_ref().map(|p| Permissions { write_scope: trimmed(&p.write_scope), ..p.clone() }),
                standbys: r.standbys,
                hands_to: r.hands_to.iter().map(|h| h.trim().to_string()).collect(),
                check: r.check,
                position: r.position,
                front: r.front,
                kind: trimmed(&r.kind),
                when_to_use: trimmed(&r.when_to_use),
            })
            .collect(),
        budget: crew.budget.clone(),
        max_helpers: crew.max_helpers,
        fix_loops: crew.fix_loops,
        routing_file: trimmed(&crew.routing_file),
        how_i_work: trimmed(&crew.how_i_work),
        start_mode: trimmed(&crew.start_mode),
        helper_cap: crew.helper_cap,
    }
}

/// Every problem of `crew` (empty = fine). Models are not checked: see `validate_with`.
pub fn validate(crew: &Crew, agent_state: &dyn Fn(&str) -> AgentState) -> Vec<CrewError> {
    validate_with(crew, agent_state, &|_, _| true)
}

/// `validate`, and `model_ok(agent, model)` says whether a model is fine for an agent (agents without a
/// list of models say yes). Only asked for a ready agent that a role names.
pub fn validate_with(crew: &Crew, agent_state: &dyn Fn(&str) -> AgentState, model_ok: &dyn Fn(&str, &str) -> bool) -> Vec<CrewError> {
    let mut out = Vec::new();
    if let Some(why) = bad_name(&crew.name, MAX_NAME_CHARS) {
        out.push(CrewError::new("CREW_NAME", format!("The crew name {why}.")));
    }
    if crew.roles.is_empty() {
        out.push(CrewError::new("CREW_NO_ROLES", "A crew needs at least one role."));
    }
    if crew.roles.len() > MAX_ROLES {
        out.push(CrewError::new("CREW_TOO_MANY_ROLES", format!("A crew holds at most {MAX_ROLES} roles; this one has {}.", crew.roles.len())));
    }
    check_limits(crew, &mut out);
    for (i, role) in crew.roles.iter().enumerate() {
        check_role(role, &mut out, agent_state, model_ok);
        let earlier = crew.roles[..i].iter().any(|r| r.name.eq_ignore_ascii_case(&role.name) || r.key().eq_ignore_ascii_case(role.key()));
        if earlier && !role.name.is_empty() {
            out.push(CrewError::for_role("CREW_DUPLICATE_ROLE", &role.name, format!("Two roles are called \"{}\". Give each role its own name.", role.name)));
        }
    }
    check_tree(crew, &mut out);
    check_edges(crew, &mut out);
    check_workflow(crew, &mut out);
    out
}

/// The workflow fields. A crew without a Front is a plain crew; its (unused) workflow fields are still checked for shape.
fn check_workflow(crew: &Crew, out: &mut Vec<CrewError>) {
    let fronts: Vec<&Role> = crew.roles.iter().filter(|r| r.front).collect();
    if fronts.len() > 1 {
        out.push(CrewError::new("CREW_FRONTS", "A workflow has one Front; this one marks more than one."));
    }
    if let Some(front) = fronts.first() {
        if front.parent.is_some() {
            out.push(CrewError::for_role("CREW_FRONT_NOT_LEAD", &front.name, format!("The Front ({}) must be the lead of the crew.", front.name)));
        }
        for role in crew.roles.iter().filter(|r| !r.front) {
            // v1: every helper reports to the Front; no helper-to-helper chains.
            if role.parent.as_deref().is_some_and(|p| !front.is_called(p)) {
                out.push(CrewError::for_role("CREW_WORKFLOW_CHAIN", &role.name, format!("{} must report to the Front ({}); helpers do not report to each other.", role.name, front.name)));
            }
            if role.when_to_use.is_none() {
                out.push(CrewError::for_role("CREW_WHEN_TO_USE", &role.name, format!("Say when to use {} (one line, like \"hard coding tasks\").", role.name)));
            }
        }
    }
    for role in &crew.roles {
        if let Some(kind) = role.kind.as_deref() {
            if !KINDS.contains(&kind) || role.front {
                out.push(CrewError::for_role("CREW_KIND", &role.name, format!("{}: kind can be minion or spin_off (helpers only).", role.name)));
            }
        }
        if let Some(when) = role.when_to_use.as_deref() {
            if when.chars().count() > MAX_WHEN_CHARS || when.chars().any(char::is_control) {
                out.push(CrewError::for_role("CREW_WHEN_TO_USE", &role.name, format!("The \"when to use\" line of {} must be one short line.", role.name)));
            }
        }
    }
    if let Some(mode) = crew.start_mode.as_deref() {
        if !START_MODES.contains(&mode) {
            out.push(CrewError::new("CREW_START_MODE", "start_mode can be front or horde."));
        }
    }
    if crew.helper_cap.is_some_and(|n| n == 0 || n > MAX_HELPER_CAP) {
        out.push(CrewError::new("CREW_HELPER_CAP", format!("helper_cap must be between 1 and {MAX_HELPER_CAP}.")));
    }
    if let Some(note) = crew.how_i_work.as_deref() {
        if let Some(why) = bad_task(note) {
            out.push(CrewError::new("CREW_HOW_I_WORK", format!("The shared note {why}.")));
        }
    }
}

/// Crew-wide numbers and the routing file name.
fn check_limits(crew: &Crew, out: &mut Vec<CrewError>) {
    if let Some(file) = crew.routing_file.as_deref() {
        if !plain_file_name(file) {
            out.push(CrewError::new("CREW_ROUTING_FILE", format!("The routing file \"{file}\" must be a plain file name ending in .md, with no folders.")));
        }
    }
    if let Some(n) = crew.max_helpers {
        if n == 0 || n > MAX_HELPERS_CAP {
            out.push(CrewError::new("CREW_MAX_HELPERS", format!("max_helpers must be between 1 and {MAX_HELPERS_CAP}.")));
        } else {
            let warm: u32 = crew.roles.iter().map(|r| u32::from(r.standbys)).sum();
            if warm > n {
                out.push(CrewError::new("CREW_STANDBYS_OVER", format!("The roles ask for {warm} warm standbys, but max_helpers is {n}.")));
            }
        }
    }
    if crew.fix_loops.is_some_and(|n| n > MAX_FIX_LOOPS) {
        out.push(CrewError::new("CREW_FIX_LOOPS", format!("fix_loops can be at most {MAX_FIX_LOOPS}.")));
    }
    if let Some(budget) = &crew.budget {
        if budget.turns == Some(0) || budget.minutes == Some(0) {
            out.push(CrewError::new("CREW_BUDGET", "A budget of 0 turns or 0 minutes can never run. Leave it out for no limit."));
        }
    }
}

fn check_role(role: &Role, out: &mut Vec<CrewError>, agent_state: &dyn Fn(&str) -> AgentState, model_ok: &dyn Fn(&str, &str) -> bool) {
    if let Some(why) = bad_name(&role.name, MAX_ROLE_NAME_CHARS) {
        out.push(CrewError::for_role("CREW_ROLE_NAME", &role.name, format!("A role name {why}.")));
    }
    if !role.id.is_empty() && !plain_id(&role.id) {
        out.push(CrewError::for_role("CREW_ROLE_ID", &role.name, format!("The id \"{}\" of {} may only use letters, digits, - and _.", role.id, role.name)));
    }
    // The default agent has no registry entry until the crew starts (`agents::resolve_defaults`).
    if role.agent_type != DEFAULT_AGENT {
        check_agent(role, out, agent_state, model_ok);
    }
    if let Some(why) = bad_task(&role.task) {
        out.push(CrewError::for_role("CREW_TASK", &role.name, format!("The task of {} {why}.", role.name)));
    }
    if role.standbys > MAX_STANDBYS_PER_ROLE {
        out.push(CrewError::for_role("CREW_STANDBYS", &role.name, format!("{} asks for {} warm standbys; at most {MAX_STANDBYS_PER_ROLE}.", role.name, role.standbys)));
    }
    if let Some(p) = &role.permissions {
        check_permissions(role, p, out);
    }
}

fn check_agent(role: &Role, out: &mut Vec<CrewError>, agent_state: &dyn Fn(&str) -> AgentState, model_ok: &dyn Fn(&str, &str) -> bool) {
    if !plain_agent_id(&role.agent_type) {
        out.push(CrewError::for_role("CREW_AGENT_UNKNOWN", &role.name, format!("\"{}\" is not an agent id.", role.agent_type)));
        return;
    }
    match agent_state(&role.agent_type) {
        AgentState::Ready => {
            if let Some(model) = role.model.as_deref() {
                if bad_name(model, MAX_MODEL_CHARS).is_some() {
                    out.push(CrewError::for_role("CREW_MODEL_UNKNOWN", &role.name, format!("The model of {} is not a model name.", role.name)));
                } else if !model_ok(&role.agent_type, model) {
                    out.push(CrewError::for_role("CREW_MODEL_UNKNOWN", &role.name, format!("The agent \"{}\" has no model called \"{model}\" (role {}).", role.agent_type, role.name)));
                }
            }
        }
        AgentState::Unknown => out.push(CrewError::for_role(
            "CREW_AGENT_UNKNOWN",
            &role.name,
            format!("The agent \"{}\" for {} is not set up here.", role.agent_type, role.name),
        )),
        AgentState::NotDispatchable(why) => out.push(CrewError::for_role("CREW_AGENT_NOT_DISPATCHABLE", &role.name, format!("{} cannot take a task: {why}", role.name))),
    }
}

fn check_permissions(role: &Role, p: &Permissions, out: &mut Vec<CrewError>) {
    let bad = |what: String| CrewError::for_role("CREW_PERMISSION", &role.name, format!("{}: {what}", role.name));
    if !WRITE_LEVELS.contains(&p.write.as_str()) {
        out.push(bad(format!("write can be {}, not \"{}\".", WRITE_LEVELS.join(", "), p.write)));
    }
    if !RUN_LEVELS.contains(&p.run.as_str()) {
        out.push(bad(format!("run can be {}, not \"{}\".", RUN_LEVELS.join(", "), p.run)));
    }
    match (p.write.as_str(), p.write_scope.as_deref()) {
        ("scoped", None) => out.push(bad("write \"scoped\" needs write_scope, the one folder it may write in.".to_string())),
        ("scoped", Some(scope)) if !plain_id(scope) => out.push(bad("write_scope must be a plain folder name (letters, digits, - and _).".to_string())),
        ("scoped", Some(_)) => {}
        (_, Some(_)) => out.push(bad("write_scope only goes with write \"scoped\".".to_string())),
        _ => {}
    }
    if !p.read && (p.write != "none" || p.run != "none") {
        out.push(bad("a role that cannot read cannot write or run commands either.".to_string()));
    }
    // Only the lead (no parent) merges or starts helpers; a worker never does.
    if role.parent.is_some() && (p.merge || p.start_helpers) {
        out.push(bad("only the lead (the role with no parent) may merge or start helpers.".to_string()));
    }
    if p.merge && p.run == "none" {
        out.push(bad("a role that merges needs to run commands (run is not \"none\").".to_string()));
    }
}

/// One root, every parent a role of the crew, no loops.
fn check_tree(crew: &Crew, out: &mut Vec<CrewError>) {
    let index = |name: &str| crew.roles.iter().position(|r| r.is_called(name));
    let mut roots = 0;
    for role in &crew.roles {
        match role.parent.as_deref() {
            None => roots += 1,
            Some(parent) if index(parent).is_none() => out.push(CrewError::for_role(
                "CREW_PARENT_UNKNOWN",
                &role.name,
                format!("{} is under \"{parent}\", which is not a role of this crew.", role.name),
            )),
            Some(_) => {}
        }
    }
    if !crew.roles.is_empty() && roots != 1 {
        out.push(CrewError::new("CREW_ROOTS", format!("A crew needs exactly one lead (a role with no parent); this one has {roots}.")));
    }
    for (i, role) in crew.roles.iter().enumerate() {
        if loops(crew, i, &index) {
            out.push(CrewError::for_role("CREW_CYCLE", &role.name, format!("{} is its own parent, directly or through other roles.", role.name)));
        }
    }
}

/// Walking up from `start` comes back to `start`.
fn loops(crew: &Crew, start: usize, index: &dyn Fn(&str) -> Option<usize>) -> bool {
    let mut at = start;
    for _ in 0..=crew.roles.len() {
        let Some(parent) = crew.roles[at].parent.as_deref().and_then(index) else { return false };
        if parent == start {
            return true;
        }
        at = parent;
    }
    false
}

/// `hands_to` edges: each names another role of the crew; every role has a route from the lead (down the
/// parent links and along edges); and the only loop is a checker handing back to the lead.
fn check_edges(crew: &Crew, out: &mut Vec<CrewError>) {
    let n = crew.roles.len();
    let index = |name: &str| crew.roles.iter().position(|r| r.is_called(name));
    let root = crew.roles.iter().position(|r| r.parent.is_none());
    let mut edges: Vec<(usize, usize)> = Vec::new();
    for (from, role) in crew.roles.iter().enumerate() {
        for target in &role.hands_to {
            match index(target) {
                None => out.push(CrewError::for_role("CREW_EDGE_UNKNOWN", &role.name, format!("{} hands work to \"{target}\", which is not a role of this crew.", role.name))),
                Some(to) if to == from => out.push(CrewError::for_role("CREW_EDGE_SELF", &role.name, format!("{} hands work to itself.", role.name))),
                Some(to) => edges.push((from, to)),
            }
        }
    }
    if let Some(root) = root {
        let mut seen = vec![false; n];
        let mut stack = vec![root];
        seen[root] = true;
        while let Some(at) = stack.pop() {
            let children = crew.roles.iter().enumerate().filter(|(_, r)| r.parent.as_deref().and_then(index) == Some(at)).map(|(i, _)| i);
            let handed = edges.iter().filter(|(f, _)| *f == at).map(|(_, t)| *t);
            for next in children.chain(handed).collect::<Vec<_>>() {
                if !seen[next] {
                    seen[next] = true;
                    stack.push(next);
                }
            }
        }
        for (i, role) in crew.roles.iter().enumerate() {
            if !seen[i] {
                out.push(CrewError::for_role("CREW_NO_ROUTE", &role.name, format!("No work can reach {}: nothing hands to it and the lead is not above it.", role.name)));
            }
        }
    }
    // Take away the checker -> lead edges (the one allowed loop); whatever is left must not loop.
    let rest: Vec<(usize, usize)> = edges.iter().filter(|(f, t)| !(crew.roles[*f].check && Some(*t) == root)).copied().collect();
    for (i, role) in crew.roles.iter().enumerate() {
        if reaches(&rest, i, i, n) {
            out.push(CrewError::for_role("CREW_EDGE_CYCLE", &role.name, format!("Work can loop back to {}. Only a checker may hand back to the lead.", role.name)));
        }
    }
}

/// `from` can reach `to` over `edges` in at least one step.
fn reaches(edges: &[(usize, usize)], from: usize, to: usize, n: usize) -> bool {
    let mut seen = vec![false; n];
    let mut stack: Vec<usize> = edges.iter().filter(|(f, _)| *f == from).map(|(_, t)| *t).collect();
    while let Some(at) = stack.pop() {
        if at == to {
            return true;
        }
        if !std::mem::replace(&mut seen[at], true) {
            stack.extend(edges.iter().filter(|(f, _)| *f == at).map(|(_, t)| *t));
        }
    }
    false
}

/// Letters, digits, `-` and `_`.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ROLE_NAME_CHARS && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// `difficulty.md`: a file name in the crew's own place, never a path.
fn plain_file_name(name: &str) -> bool {
    name.len() > 3
        && name.len() <= 64
        && name.ends_with(".md")
        && !name.starts_with('.')
        && !name.contains("..")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn bad_name(name: &str, max: usize) -> Option<&'static str> {
    let t = name.trim();
    if t.is_empty() {
        Some("cannot be empty")
    } else if t.chars().count() > max {
        Some("is too long")
    } else if t.chars().any(char::is_control) {
        Some("has characters that cannot be shown")
    } else {
        None
    }
}

/// Agent ids are plain: letters, digits, `_`, `-`, `.`.
fn plain_agent_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_AGENT_CHARS && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

fn bad_task(task: &str) -> Option<&'static str> {
    let t = task.trim();
    if t.is_empty() {
        return Some("is empty");
    }
    if t.chars().count() > MAX_TASK_CHARS {
        return Some("is too long");
    }
    if t.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Some("has characters that cannot be shown");
    }
    if unknown_placeholder(t).is_some() {
        return Some("uses a placeholder other than {folder}");
    }
    None
}

/// The first `{word}` that is not `{folder}`. Braces with other things inside (code, JSON) are text.
fn unknown_placeholder(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(len) = text[i + 1..].find('}') {
                let word = &text[i + 1..i + 1 + len];
                let plain = !word.is_empty() && word.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
                if plain && word.as_bytes()[0].is_ascii_alphabetic() && format!("{{{word}}}") != PLACEHOLDER {
                    return Some(word);
                }
            }
        }
        i += 1;
    }
    None
}

/// `{folder}` filled in.
pub fn fill_folder(task: &str, folder: &str) -> String {
    task.replace(PLACEHOLDER, folder)
}
