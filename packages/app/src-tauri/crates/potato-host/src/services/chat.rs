//! The chat rows on this machine: start, and the call rows of one chat (`acp_chat_state`, its settings). The rest of the chat (transcript,
//! cards, messages, Stop, close) is `engine_services`, called straight from `HostServices`. A far screen names a chat by its pane id; the
//! rows that start one name a project by its id, and an id this machine did not hand out is "not found" (`UNKNOWN_PROJECT`), never a
//! path from the far side.

use pm_core::device_link::pclink::calls::{arg, text_arg};
use pm_core::device_link::pclink::calls_files::{bad, Reply};
use pm_core::device_link::pclink::engine_services::{self as engine, ChatEnv, ProjectChatEnv};
use serde_json::Value;

use crate::projects::Projects;

/// `POST /pclink/agents/start`: a chat in a known project. A terminal is not on this machine yet.
pub fn start(env: &ProjectChatEnv, projects: &Projects, node: &str, agent: &str, project: &str, lane: &str, body: &Value) -> Reply {
    match lane.trim() {
        "chat" | "acp" => {}
        "terminal" => return super::not_here(),
        _ => return bad("INVALID_ARGUMENT", "lane must be chat or terminal"),
    }
    // A project id only: not a chat id, not a path.
    let Some(folder) = projects.folder_of(project) else { return engine::unknown_project() };
    // "Use my own agents" (a lent sign-in) is not here: the borrower side moves in a later stage, so the default refusal answers.
    let account = match body.get("account").and_then(Value::as_str).map(str::trim).filter(|a| !a.is_empty()) {
        Some(account) => match env.start_account(node, agent, account) {
            Ok(account) => Some(account),
            Err(refused) => return refused,
        },
        None => None,
    };
    engine::start_chat(env, agent, &folder, account)
}

/// The chat rows of the call table this machine serves. `None` for any other command (the caller answers NOT_ON_THIS_MACHINE).
pub fn call(env: &ProjectChatEnv, node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    // The lists that need no pane: the agents a far page offers, and the closed chats (the host's own conversations).
    if let Some(reply) = engine::chat_screen_row(env, node, cmd, args) {
        return Some(reply);
    }
    match cmd {
        "agents_list" => return Some((200, engine::agents_list())),
        "acp_closed_list" => return Some((200, engine::closed_list(env, args.get("_full").and_then(Value::as_bool).unwrap_or(false)))),
        _ => {}
    }
    if !matches!(cmd, "acp_chat_state" | "acp_chat_set_config" | "acp_chat_set_force_yes") {
        return None;
    }
    let Some(pane) = text_arg(args, "paneId") else { return Some(engine::pane_required()) };
    if let Some(refused) = engine::remote_refusal(&pane) {
        return Some(refused);
    }
    // A person's own PC (`_marked`, set by `pclink::handle`) is not asked to press and hold; any other PC must hold.
    let held = args.get("hold").and_then(Value::as_bool).unwrap_or(false);
    let hold = held || args.get("_marked").and_then(Value::as_bool).unwrap_or(false);
    Some(match cmd {
        "acp_chat_state" => (200, engine::chat_state(&pane)),
        "acp_chat_set_config" => match (text_arg(args, "optionId"), text_arg(args, "value")) {
            (Some(option), Some(value)) => engine::set_config_as(env, node, &pane, &option, &value, hold, held),
            _ => bad("INVALID_ARGUMENT", "optionId and value are required"),
        },
        _ => {
            let Some(on) = arg(args, "on").and_then(Value::as_bool) else { return Some(bad("INVALID_ARGUMENT", "on is required")) };
            engine::set_force_yes(env, node, &pane, on, hold, held)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::HostServices;
    use pm_core::acp::chat::StartDeps;
    use pm_core::device_link::pclink::engine_services::LiveChatHost;
    use pm_core::device_link::pclink::{handle, Asks, Caller, Level};
    use pm_core::test_support::chat_rig::{agents, conversations_in, Env};
    use pm_core::test_support::wait::{process_permit, wait_until};
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::Arc;

    struct Rig {
        svc: HostServices,
        project_id: String,
        project: PathBuf,
        _gate: pm_core::test_support::wait::Permit<'static>,
    }

    /// A host with one known project and the fake agent as its only agent. All of it lives beside the test exe (the cargo target folder).
    fn rig(name: &str) -> Rig {
        // This test program is its own profile (`profile_before_tests` in main.rs): never the desktop app's data.
        assert_eq!(pm_core::app_paths::profile().as_deref(), Some("host-test"));
        let gate = process_permit();
        let base = std::env::current_exe().unwrap().parent().unwrap().join("host-chat-tests").join(name);
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("a.txt"), "hello").unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let listed = project.to_string_lossy().to_string();
        std::fs::write(data.join("projects.json"), serde_json::to_string(&vec![listed.clone()]).unwrap()).unwrap();
        let projects = Projects::open(&data, None);
        let project_id = projects.id(&listed);
        let cfg = agents("", &base).0["fake"].as_ref().clone();
        let conversations = conversations_in(&base, "");
        let root = base.clone();
        let env = ProjectChatEnv::new(Arc::new(projects.clone()))
            .with_agents(Arc::new(move |agent| (agent == "fake").then(|| cfg.clone())))
            .with_start_deps(move |registry| StartDeps { registry: registry.clone(), host: Arc::new(LiveChatHost), env: Arc::new(Env { root }), conversations: Some(conversations) });
        Rig { svc: HostServices::with_chat("box".into(), projects, env), project_id, project, _gate: gate }
    }

    /// One request from a paired PC at `level`, through pm-core's own route table and rights.
    fn far(rig: &Rig, level: Level, method: &str, target: &str, body: Value) -> (u16, Value) {
        let who = Caller { node: "aa", name: "Windows PC", level: Some(level), marked: false, now_ms: 1 };
        handle(&who, &rig.svc, &Asks::new(), method, target, body.to_string().as_bytes())
    }

    fn items_of(rig: &Rig, pane: &str) -> Vec<Value> {
        far(rig, Level::Watch, "GET", &format!("/pclink/sessions/{pane}/transcript"), Value::Null).1["items"].as_array().cloned().unwrap_or_default()
    }

    fn turn_ended(rig: &Rig, pane: &str, turns: usize) -> bool {
        items_of(rig, pane).iter().filter(|i| i["id"].as_str().is_some_and(|id| id.starts_with("end:"))).count() >= turns
    }

    /// The Windows side's whole round trip on a bot host: start a chat in a known project, read the session list and its transcript, send a
    /// message, find the permission card the agent raised, see that a PC below Full can only say no, approve it at Full and read the result.
    #[test]
    fn a_far_pc_starts_a_chat_reads_it_and_answers_its_permission_card() {
        let rig = rig("flow");
        // Start: the project by its id (no path), the chat's pane id comes back.
        let (status, started) = far(&rig, Level::Full, "POST", "/pclink/agents/start", json!({ "agent": "fake", "project": rig.project_id, "lane": "chat" }));
        assert_eq!(status, 200, "{started}");
        let pane = started["pane_id"].as_str().unwrap().to_string();
        assert_eq!(started["lane"], "acp");

        // The session list names it with this host's own project id and a folder NAME, never a path.
        let (_, listed) = far(&rig, Level::Watch, "GET", "/pclink/sessions", Value::Null);
        let row = listed["sessions"].as_array().unwrap().iter().find(|r| r["id"] == json!(pane)).expect("the chat is listed").clone();
        assert_eq!((row["chat"].clone(), row["project"].clone(), row["folder"].clone()), (json!(true), json!(rig.project_id), json!("project")));
        assert!(!listed.to_string().contains(&rig.project.to_string_lossy().replace('\\', "\\\\")), "no path travels: {listed}");

        // A message: the agent answers and the turn ends; the far PC reads it from the transcript by revision.
        let (status, sent) = far(&rig, Level::Answer, "POST", &format!("/pclink/sessions/{pane}/messages"), json!({ "text": "hello" }));
        assert_eq!(status, 200, "{sent}");
        assert!(wait_until(30, || turn_ended(&rig, &pane, 1)), "the first turn did not end: {:#?}", items_of(&rig, &pane));
        let (_, first) = far(&rig, Level::Watch, "GET", &format!("/pclink/sessions/{pane}/transcript"), Value::Null);
        assert_eq!(first["available"], true);
        let rev = first["rev"].as_u64().unwrap();
        let (_, nothing_new) = far(&rig, Level::Watch, "GET", &format!("/pclink/sessions/{pane}/transcript?since={rev}"), Value::Null);
        assert_eq!(nothing_new["items"].as_array().map(Vec::len), Some(0), "nothing since the last revision");

        // The permission word: the agent parks a tool call and waits. The card shows to a PC; below Full it offers only "no".
        let (status, _) = far(&rig, Level::Answer, "POST", &format!("/pclink/sessions/{pane}/messages"), json!({ "text": "perm" }));
        assert_eq!(status, 200);
        let mut card = Value::Null;
        assert!(
            wait_until(30, || {
                let (_, q) = far(&rig, Level::Full, "GET", "/pclink/questions", Value::Null);
                card = q["questions"].as_array().and_then(|l| l.iter().find(|c| c["pane_id"] == json!(pane)).cloned()).unwrap_or(Value::Null);
                !card.is_null()
            }),
            "no permission card came"
        );
        let card_id = card["id"].as_str().unwrap().to_string();
        let choices: Vec<String> = card["choices"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect();
        let (_, answer_view) = far(&rig, Level::Answer, "GET", "/pclink/questions", Value::Null);
        let below_full: Vec<String> = answer_view["questions"].as_array().unwrap().iter().find(|c| c["id"] == json!(card_id)).unwrap()["choices"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect();
        assert!(!below_full.is_empty() && below_full.len() < choices.len(), "below Full only the no choices: {below_full:?} of {choices:?}");
        let allow = choices.iter().find(|id| !below_full.contains(id)).expect("an allowing choice").clone();
        let (status, refused) = far(&rig, Level::Answer, "POST", &format!("/pclink/questions/{card_id}/answer"), json!({ "choice_id": allow }));
        assert_eq!((status, refused["code"].clone()), (403, json!("APPROVE_NEEDS_FULL")));

        // At Full the same answer goes through, the card is gone, and the turn ends.
        let (status, done) = far(&rig, Level::Full, "POST", &format!("/pclink/questions/{card_id}/answer"), json!({ "choice_id": allow }));
        assert_eq!(status, 200, "{done}");
        assert!(wait_until(30, || turn_ended(&rig, &pane, 2)), "the second turn did not end: {:#?}", items_of(&rig, &pane));
        let (_, after) = far(&rig, Level::Full, "GET", "/pclink/questions", Value::Null);
        assert!(after["questions"].as_array().unwrap().iter().all(|c| c["id"] != json!(card_id)), "the card is gone");

        // The chat screen's other rows: the message box, "keep waiting", the warm-up and "show earlier" answer; the switch that lets the agent act
        // without asking needs the press and hold (a PC that is not the person's own is refused without it); the live feed itself (`session_chat_open`)
        // needs a window to push frames to, so it is not on this machine.
        let row = |cmd: &str, args: Value| far(&rig, Level::Full, "POST", &format!("/pclink/call/{cmd}"), args);
        assert!(row("pane_messages_list", json!({ "paneId": pane })).1.is_array());
        assert_eq!(row("acp_chat_keep_waiting", json!({ "paneId": pane })).0, 200);
        assert_eq!(row("acp_chat_warm", json!({ "paneId": pane })).0, 200);
        assert_eq!(row("chat_earlier", json!({ "paneId": pane, "before": "x" })).0, 200);
        let (status, held) = row("acp_chat_set_auto_allow", json!({ "paneId": pane, "kind": "read", "on": true }));
        assert_eq!((status, held["code"].clone()), (409, json!("NEEDS_HOLD")));
        assert_eq!(row("acp_chat_set_agent_answering", json!({ "paneId": pane, "allowed": true })).0, 409);
        assert_eq!(row("acp_chat_set_force_yes", json!({ "paneId": pane, "on": true })).0, 409, "Force yes needs the press and hold too");
        assert_eq!(row("session_chat_open", json!({ "paneId": pane })).1["code"], "NOT_ON_THIS_MACHINE");
        // The chat's state through the call table (the row the chat screen polls), then Stop and close.
        let (status, state) = far(&rig, Level::Watch, "POST", "/pclink/call/acp_chat_state", json!({ "paneId": pane }));
        assert_eq!(status, 200);
        assert!(state.is_object(), "{state}");
        assert_eq!(far(&rig, Level::Answer, "POST", &format!("/pclink/sessions/{pane}/interrupt"), json!({})).0, 200);
        assert_eq!(far(&rig, Level::Full, "DELETE", &format!("/pclink/sessions/{pane}"), Value::Null).0, 200);
        // The pane goes a moment after the close (the registry reaps it): then the chat is not found.
        assert!(wait_until(30, || far(&rig, Level::Watch, "POST", "/pclink/call/acp_chat_state", json!({ "paneId": pane })) == (200, Value::Null)), "the closed chat is still there");
        assert_eq!(far(&rig, Level::Watch, "GET", &format!("/pclink/sessions/{pane}/transcript"), Value::Null).0, 404, "a closed chat is not found");
        // It is in the closed list now, with its folder's NAME (a Watch PC gets no path); the New agent page's agent list answers too.
        let mut closed = Value::Null;
        assert!(
            wait_until(30, || {
                let (_, list) = far(&rig, Level::Watch, "POST", "/pclink/call/acp_closed_list", json!({}));
                closed = list.as_array().and_then(|rows| rows.iter().find(|r| r["id"] == json!(pane)).cloned()).unwrap_or(Value::Null);
                !closed.is_null()
            }),
            "the closed chat is not listed"
        );
        assert_eq!(closed["cwd"], json!("project"));
        assert!(far(&rig, Level::Watch, "POST", "/pclink/call/agents_list", json!({})).1["agents"].is_array());
    }

    /// The host takes a project id where the far screens send chat ids: each name finds its own folder, and anything else is "not found".
    #[test]
    fn a_chat_id_and_a_project_id_each_find_their_folder_and_nothing_else_does() {
        let rig = rig("ids");
        // A project id starts a chat; an id that is not one (a made-up id, a chat id, a path) does not.
        for project in ["p0000000000000000", "acp-1", "C:/Windows", "../x", rig.project.to_str().unwrap()] {
            let (status, refused) = far(&rig, Level::Full, "POST", "/pclink/agents/start", json!({ "agent": "fake", "project": project, "lane": "chat" }));
            assert_eq!((status, refused["code"].clone()), (404, json!("UNKNOWN_PROJECT")), "{project}");
        }
        // A terminal is not on this machine; an odd lane is a bad request.
        assert_eq!(far(&rig, Level::Full, "POST", "/pclink/agents/start", json!({ "agent": "fake", "project": rig.project_id, "lane": "terminal" })).1["code"], "NOT_ON_THIS_MACHINE");
        assert_eq!(far(&rig, Level::Full, "POST", "/pclink/agents/start", json!({ "agent": "fake", "project": rig.project_id, "lane": "x" })).0, 400);
        // The Files rows: the project id works; a chat id works (its own folder); a closed or unknown id and a path do not.
        let files = |id: &str| far(&rig, Level::Full, "POST", "/pclink/call/files_list", json!({ "paneId": id, "path": "" }));
        let (status, listing) = files(&rig.project_id);
        assert!(status == 200 && listing.to_string().contains("a.txt"), "{listing}");
        let (_, started) = far(&rig, Level::Full, "POST", "/pclink/agents/start", json!({ "agent": "fake", "project": rig.project_id, "lane": "chat" }));
        let pane = started["pane_id"].as_str().expect("the chat started").to_string();
        let (status, listing) = files(&pane);
        assert!(status == 200 && listing.to_string().contains("a.txt"), "a chat id serves its own folder: {listing}");
        for id in ["acp-nobody", "C:/Windows", "../", "..", "/", ""] {
            assert_ne!(files(id).0, 200, "{id}");
        }
        assert_eq!(files("C:/Windows").0, 404);
        assert_eq!(far(&rig, Level::Full, "DELETE", &format!("/pclink/sessions/{pane}"), Value::Null).0, 200);
        assert!(wait_until(30, || files(&pane).0 == 404), "a closed chat id is not a folder any more");
    }
}
