//! Workflows (Labs "Workflows"): a crew with one role marked Front. The Front agent is the one the person
//! talks to; it reads each request and starts the right helper itself (`run_agent`) from the rules below.
//! This file only builds words and a plan from the crew: the brief the Front gets as its first message, and the
//! list the New agent page shows. Nothing here starts an agent (see `commands/workflows.rs`) and nothing names
//! an agent: ids and labels come from the crew and the caller.

use super::model::{Crew, CrewError, Role, DEFAULT_HELPER_CAP};
use super::validate::fill_folder;
use serde::Serialize;

/// How the Front reports back (Settings > Labs "How the front answers"). The default is Translator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReplyStyle {
    /// The Front retells the result in its own words; the helper's own report stays one click away.
    #[default]
    Translator,
    /// The Front adds a short note and quotes or links the helper's own words.
    Router,
}

impl ReplyStyle {
    pub fn parse(text: &str) -> Self {
        match text.trim() {
            "router" => ReplyStyle::Router,
            _ => ReplyStyle::Translator,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ReplyStyle::Translator => "translator",
            ReplyStyle::Router => "router",
        }
    }
}

/// The Front of a crew; `None` for a plain crew (nothing about it changes).
pub fn front_of(crew: &Crew) -> Option<&Role> {
    crew.roles.iter().find(|r| r.front)
}

/// A crew read as a workflow (derived when read, never saved): a crew with no marked Front uses its lead (the one role
/// that reports to nobody) as the Front, and, with no start mode saved, starts the whole crew at once as the Crews
/// page does (`horde`). Only a flat crew qualifies: every other role reports straight to the lead and no role hands
/// work on (`hands_to`), because a deeper crew would lose its chain in the brief. Any other crew, and a crew that
/// already has a Front, comes back as it is.
pub fn with_default_front(crew: &Crew) -> Crew {
    let mut out = crew.clone();
    if out.roles.iter().any(|r| r.front) || out.roles.iter().any(|r| !r.hands_to.is_empty()) {
        return out;
    }
    let is_root = |r: &Role| r.parent.as_deref().map_or(true, |p| p.trim().is_empty());
    if out.roles.iter().filter(|r| is_root(r)).count() != 1 {
        return out;
    }
    let Some(lead) = out.roles.iter().find(|r| is_root(r)).cloned() else { return out };
    if !out.roles.iter().all(|r| is_root(r) || lead.is_called(r.parent.as_deref().unwrap_or(""))) {
        return out;
    }
    for role in &mut out.roles {
        if is_root(role) {
            role.front = true;
        }
    }
    if out.start_mode.is_none() {
        out.start_mode = Some("horde".to_string());
    }
    out
}

pub fn is_workflow(crew: &Crew) -> bool {
    front_of(crew).is_some()
}

pub fn helpers_of(crew: &Crew) -> Vec<&Role> {
    crew.roles.iter().filter(|r| !r.front).collect()
}

pub fn kind_of(role: &Role) -> &'static str {
    if role.kind.as_deref() == Some("spin_off") {
        "spin_off"
    } else {
        "minion"
    }
}

pub fn helper_cap(crew: &Crew) -> u32 {
    crew.helper_cap.unwrap_or(DEFAULT_HELPER_CAP)
}

pub fn horde(crew: &Crew) -> bool {
    crew.start_mode.as_deref() == Some("horde")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HelperView {
    pub name: String,
    pub agent_type: String,
    pub model: Option<String>,
    pub when_to_use: String,
    pub kind: String,
}

/// What the New agent page needs to start a workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub name: String,
    pub front_name: String,
    pub front_agent: String,
    pub front_model: Option<String>,
    pub helpers: Vec<HelperView>,
    /// `front` or `horde`.
    pub start_mode: String,
    pub helper_cap: u32,
    pub reply_style: String,
    /// The Front's first message (without the person's request).
    pub brief: String,
    /// The brief and then the person's request: what the Front's chat starts with.
    pub first_message: String,
}

pub fn plan(crew: &Crew, folder: &str, style: ReplyStyle, request: &str) -> Option<Plan> {
    let front = front_of(crew)?;
    let brief = front_brief(crew, folder, style)?;
    Some(Plan {
        name: crew.name.clone(),
        front_name: front.name.clone(),
        front_agent: front.agent_type.clone(),
        front_model: front.model.clone(),
        helpers: helpers_of(crew).into_iter().map(view).collect(),
        start_mode: if horde(crew) { "horde" } else { "front" }.to_string(),
        helper_cap: helper_cap(crew),
        reply_style: style.as_str().to_string(),
        first_message: first_message(&brief, request),
        brief,
    })
}

fn view(role: &Role) -> HelperView {
    HelperView {
        name: role.name.clone(),
        agent_type: role.agent_type.clone(),
        model: role.model.clone(),
        when_to_use: role.when_to_use.clone().unwrap_or_default(),
        kind: kind_of(role).to_string(),
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The plain words the Front is given first: its rules, the shared note, its helpers and how to start them, the
/// limits, and how to report back. It is shown in the chat as the first message, so nothing in it is hidden.
pub fn front_brief(crew: &Crew, folder: &str, style: ReplyStyle) -> Option<String> {
    let front = front_of(crew)?;
    let helpers = helpers_of(crew);
    let cap = helper_cap(crew);
    let mut out = String::new();
    out.push_str(&format!(
        "You are the front of the workflow \"{}\". Read each request from the person, decide which helper fits, start that helper yourself, and report back. Work in this folder: {folder}\n\n",
        crew.name
    ));
    let rules = fill_folder(&front.task, folder);
    if !rules.trim().is_empty() {
        out.push_str(&format!("Your rules:\n{}\n\n", rules.trim()));
    }
    if let Some(note) = crew.how_i_work.as_deref().filter(|n| !n.trim().is_empty()) {
        out.push_str(&format!("How we work (everyone in this workflow follows this):\n{}\n\n", fill_folder(note, folder).trim()));
    }
    if helpers.is_empty() {
        out.push_str("You have no helpers. Do the work yourself.

");
    } else if horde(crew) {
        out.push_str("Your helpers. The app starts all of them right after this message, under you. Do not start new ones for these roles. A short note with the pane id of each one follows as your next message. Wait for it. Use a helper only when its \"use for\" fits the request. Do small things yourself.
");
        for h in &helpers {
            let when = h.when_to_use.as_deref().unwrap_or("any task that fits it");
            out.push_str(&format!("- {} - use for: {when}.
", h.name));
        }
        out.push_str("
To give a helper a task, call run_agent with its pane_id and the task, or followup_task with its handle. Write the task so the helper needs nothing else: the goal, the files, what done looks like, and what not to touch.

");
    } else {
        out.push_str("Your helpers. Start one only when its \"use for\" fits the request. Do small things yourself.
");
        for h in &helpers {
            let kind = kind_of(h);
            let model = h.model.as_deref().map(|m| format!(", model: {m}")).unwrap_or_default();
            let when = h.when_to_use.as_deref().unwrap_or("any task that fits it");
            out.push_str(&format!("- {} - use for: {when}. Start it with run_agent (as: {kind}, agent_type: {}{model}).
", h.name, h.agent_type));
            let job = fill_folder(&h.task, folder);
            if !job.trim().is_empty() {
                out.push_str(&format!("  Its rules: {}
", one_line(&job)));
            }
        }
        out.push_str("
To start a helper, call run_agent with the project_path above, and the agent_type, model and as shown for it, and a task that says exactly what to do. Write the task so the helper needs nothing else: the goal, the files, what done looks like, and what not to touch. When you name a model, a fresh agent starts. Leave the model out only if any model is fine: run_agent may then take a waiting standby of that agent instead, on that standby's own model.

");
    }
    out.push_str(&format!(
        "Limits:\n- Start at most {cap} helper run{} for each message from the person. After that, stop and ask the person what to do next.\n- When a helper asks for permission or an answer, the person answers in this chat. Never answer a helper's question or approval yourself, even a small one: do not use answer_prompt for a helper. Tell the person what it asks.\n- Do not let helpers start other helpers.\n\n",
        if cap == 1 { "" } else { "s" }
    ));
    out.push_str(match style {
        ReplyStyle::Translator => "How to answer: when a helper finishes, tell the person the result in your own words, short and plain. Say which helper did it. The helper's own report stays one click away for the person, and the app shows changed files and test results, so do not paste them. Do not claim more than the helper reported.\n",
        ReplyStyle::Router => "How to answer: when a helper finishes, add one or two short lines of your own, then show the helper's own final report as it is (quote it); do not retell it. The app shows changed files and test results, so do not retell those.\n",
    });
    Some(out)
}

/// The first message of a started workflow: the brief, then what the person asked.
pub fn first_message(brief: &str, request: &str) -> String {
    format!("{}\nThe person's request:\n{}", brief.trim_end(), request.trim())
}

/// The note the Front gets once the whole horde has started: which pane is which helper.
pub fn horde_note(started: &[(String, String)]) -> String {
    let mut out = String::from("Your helpers are started and waiting. Do not start new ones for these roles.
");
    for (role, pane) in started {
        out.push_str(&format!("- {role}: pane_id {pane}
"));
    }
    out.push_str("Give a helper a task with run_agent(pane_id, task) or followup_task.
");
    out
}

/// Why a workflow command is refused before it does anything (`None`: go on).
pub fn refuse_off(enabled: bool) -> Option<CrewError> {
    (!enabled).then(|| CrewError::new("WORKFLOWS_OFF", "Workflows are turned off in Settings > Labs."))
}

/// Whole-horde start: the crew must be a workflow in horde mode, and the Front's pane must be a live pane.
pub fn refuse_horde_start(crew: &Crew, front_pane_live: bool) -> Option<CrewError> {
    if !is_workflow(crew) {
        return Some(CrewError::new("WORKFLOW_NOT_FOUND", "There is no such workflow."));
    }
    if !horde(crew) {
        return Some(CrewError::new("WORKFLOW_NOT_HORDE", "This workflow starts only the main agent. It does not start its helpers now."));
    }
    if !front_pane_live {
        return Some(CrewError::new("WORKFLOW_NO_FRONT", "The front agent is not open any more."));
    }
    None
}

/// The task a helper gets when the whole horde starts now: its rules and the shared note, and to wait for the front.
pub fn horde_task(crew: &Crew, helper: &Role, folder: &str) -> String {
    let mut out = format!("You are \"{}\", a helper in the workflow \"{}\". Work in this folder: {folder}\n\n", helper.name, crew.name);
    out.push_str(&format!("Your rules:\n{}\n\n", fill_folder(&helper.task, folder).trim()));
    if let Some(note) = crew.how_i_work.as_deref().filter(|n| !n.trim().is_empty()) {
        out.push_str(&format!("How we work:\n{}\n\n", fill_folder(note, folder).trim()));
    }
    if let Some(when) = helper.when_to_use.as_deref() {
        out.push_str(&format!("The front sends you: {when}.\n"));
    }
    out.push_str("Wait now. Do nothing until the front sends you a task. Then do it and give a clear final report.\n");
    out
}
