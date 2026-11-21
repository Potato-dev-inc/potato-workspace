//! P3.1: the workflow and crew rows of the far call table (`calls.rs`, block `P3.1 workflows`). Each runs the SAME inner function the
//! Tauri command runs (`commands/crews.rs`, `commands/workflows.rs`, the `*_now` functions), on this PC, with this PC's own saved
//! crews, own agents and own logins: a workflow a paired PC starts runs its helpers here.
//!
//! The folder a row takes is one of this PC's known projects, given as its opaque id (all a Watch PC has) or its path (Full). Anything
//! else is refused before the command runs. Every Full action leaves one audit line with ids only: no crew text, no folder, no message.

use serde_json::{json, Value};

/// Whether `cmd` is a workflow or crew row (the table, not this test, says which of them exist).
pub(super) fn mine(cmd: &str) -> bool {
    cmd.starts_with("workflows_") || cmd.starts_with("crews_")
}

pub(super) fn folder_with(known: &[(String, String, String)], given: &str, id_of: &dyn Fn(&str) -> String) -> Option<String> {
    let find = |want: &str| known.iter().find(|(path, _, _)| id_of(path) == want).map(|(path, _, _)| path.clone());
    find(given).or_else(|| find(&id_of(given)))
}

/// The ids one Full action leaves in the audit trail (never a name, a folder or any text).
pub(super) fn audit_detail(event: &str, slug: &str, pane: Option<&str>, project: Option<&str>) -> Value {
    json!({ "event": event, "slug": slug, "pane_id": pane, "project": project })
}

#[cfg(not(test))]
mod real {
    use std::collections::BTreeMap;

    use serde::Serialize;
    use serde_json::{json, Value};

    use super::super::app_services::{bad, command_error, known_projects, not_ready, project_id, remote_ok, remote_refusal, Reply};
    use super::super::calls::{arg, text_arg};
    use super::{audit_detail, folder_with};
    use crate::bridge::link_app_handles;
    use crate::commands::{crews as crew_cmds, crews_canvas as canvas_cmds, workflows as workflow_cmds};
    use crate::crews::{model::Crew, workflow};

    fn ok<T: Serialize>(value: T) -> Reply {
        match serde_json::to_value(value) {
            Ok(v) => (200, v),
            Err(e) => command_error(&format!("INTERNAL: {e}")),
        }
    }

    fn done<T: Serialize>(result: Result<T, String>) -> Reply {
        result.map_or_else(|text| command_error(&text), ok)
    }

    /// `given` (an opaque project id, or a path) as the path of one of `known`. The id of a path is the id of that project, so one lookup serves both.
    fn folder_of(known: &[(String, String, String)], given: &str) -> Option<String> {
        folder_with(known, given, &project_id)
    }

    fn audit(node: &str, event: &str, slug: &str, pane: Option<&str>, project: Option<&str>) {
        let summary = match event {
            "workflow.start" => "A paired PC started a workflow's helpers",
            "crew.start" => "A paired PC started a crew",
            "crew.save" => "A paired PC saved a crew",
            _ => "A paired PC removed a crew",
        };
        let who = crate::audit::Who::Device(Some(crate::mobile_pairing::link_device_id(node)));
        crate::audit::record(crate::audit::Kind::Setting, who, summary, audit_detail(event, slug, pane, project));
    }

    pub(in crate::device_link::pclink) fn run(node: &str, cmd: &str, args: &Value) -> Reply {
        let Some((app, registry)) = link_app_handles() else { return not_ready() };
        let slug = || text_arg(args, "slug").ok_or_else(|| bad("INVALID_ARGUMENT", "slug is required"));
        let folder = || -> Result<(String, String), Reply> {
            let given = text_arg(args, "folder").ok_or_else(|| bad("INVALID_ARGUMENT", "folder is required"))?;
            let path = folder_of(&known_projects(&registry), &given).ok_or_else(|| (404, json!({ "code": "UNKNOWN_PROJECT", "error": "This PC does not know that project. Open it here first." })))?;
            let id = project_id(&path);
            Ok((path, id))
        };
        // A chat shut for other PCs, or one on another computer, is not theirs to read or to hang a workflow under.
        let open_pane = |name: &str| -> Result<String, Reply> {
            let pane = text_arg(args, name).ok_or_else(|| bad("INVALID_ARGUMENT", &format!("{name} is required")))?;
            if let Some(refused) = remote_refusal(&pane) {
                return Err(refused);
            }
            if !remote_ok(&pane) {
                return Err((403, json!({ "error": "This agent is switched off for other PCs on its own PC.", "code": "AGENT_LOCKED" })));
            }
            Ok(pane)
        };
        macro_rules! need {
            ($e:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(reply) => return reply,
                }
            };
        }
        match cmd {
            "crews_list" => ok(crew_cmds::list_now()),
            "crews_starters" => ok(crew_cmds::starters_now()),
            "crews_agents" => ok(crew_cmds::agents_now()),
            "crews_templates" => ok(canvas_cmds::templates_now()),
            "crews_open" => done(canvas_cmds::open_now(need!(slug()))),
            "crews_check" | "crews_try_task" | "crews_follow" => {
                let Some(crew) = arg(args, "crew").and_then(|v| serde_json::from_value::<Crew>(v.clone()).ok()) else { return bad("INVALID_ARGUMENT", "crew is required") };
                match cmd {
                    "crews_check" => ok(canvas_cmds::check_now(&crew)),
                    "crews_follow" => ok(canvas_cmds::follow_now(&registry, &crew)),
                    _ => ok(canvas_cmds::try_task_now(&crew, arg(args, "routingText").and_then(Value::as_str).unwrap_or(""), arg(args, "task").and_then(Value::as_str).unwrap_or(""))),
                }
            }
            "crews_get" => done(crew_cmds::get_now(&need!(slug()))),
            "crews_draft" => done(crew_cmds::draft_now(&registry, &need!(open_pane("paneId")))),
            // Labs "Workflows" is this PC's own switch: off here, nothing is listed and nothing starts.
            "workflows_list" => ok(workflow_cmds::on(&app).then(|| workflow_cmds::list_now(workflow_cmds::style(&app)))),
            "workflows_hidden_count" => ok(if workflow_cmds::on(&app) { workflow_cmds::hidden_now() } else { 0 }),
            "workflows_plan" => {
                if let Some(refused) = workflow::refuse_off(workflow_cmds::on(&app)) {
                    return command_error(&refused.to_string());
                }
                let (path, _) = need!(folder());
                let request = arg(args, "request").and_then(Value::as_str).unwrap_or("");
                done(workflow_cmds::plan_now(&need!(slug()), &path, request, workflow_cmds::style(&app)))
            }
            "workflows_start_helpers" => {
                if let Some(refused) = workflow::refuse_off(workflow_cmds::on(&app)) {
                    return command_error(&refused.to_string());
                }
                let (slug, (path, project), front) = (need!(slug()), need!(folder()), need!(open_pane("frontPane")));
                let out = workflow_cmds::start_helpers_now(registry, app, &slug, &path, &front);
                audit(node, "workflow.start", &slug, Some(&front), Some(&project));
                done(out)
            }
            "crews_start" => {
                let (slug, (path, project)) = (need!(slug()), need!(folder()));
                let agents: BTreeMap<String, String> = arg(args, "agents").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
                let out = crew_cmds::start_now(registry, app, &slug, &path, agents);
                audit(node, "crew.start", &slug, None, Some(&project));
                done(out)
            }
            "crews_save" => {
                let Some(crew) = arg(args, "crew").and_then(|v| serde_json::from_value::<Crew>(v.clone()).ok()) else { return bad("INVALID_ARGUMENT", "crew is required") };
                let out = crew_cmds::save_now(&crew, arg(args, "replace").and_then(Value::as_bool).unwrap_or(false));
                if let Some(saved) = &out.slug {
                    audit(node, "crew.save", saved, None, None);
                }
                ok(out)
            }
            "crews_remove" => {
                let slug = need!(slug());
                let out = crew_cmds::remove_now(&slug);
                if out.is_ok() {
                    audit(node, "crew.remove", &slug, None, None);
                }
                done(out)
            }
            _ => (404, json!({ "error": "not found", "code": "UNKNOWN_ROUTE" })),
        }
    }
}

#[cfg(not(test))]
pub(super) use real::run;

/// Unit tests never reach the app: a test binary that links the window layer (`AppHandle` by value) does not start (see REPO_MAP, "Tests that
/// touch Tauri window APIs"). The tests bring a fake `Services`; the real body is what the app runs.
#[cfg(test)]
pub(super) fn run(_node: &str, _cmd: &str, _args: &Value) -> (u16, Value) {
    (503, json!({ "error": "The app is not ready yet.", "code": "BRIDGE_NOT_READY" }))
}

