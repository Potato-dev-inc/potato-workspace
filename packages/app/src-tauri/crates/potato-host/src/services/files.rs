//! The far Files and git rows on this machine. The folder is a chat of this machine (its own folder) or a project it knows, named by its id (`projects.rs`):
//! a path never travels. The rows themselves are pm-core's (`pclink::calls_files`), the same code the app runs. Chat, worktree and
//! checkpoint rows are not here yet, so they answer NOT_ON_THIS_MACHINE (`services/mod.rs`).

use pm_core::device_link::pclink::calls::text_arg;
use pm_core::device_link::pclink::calls_files::{bad, cancel_search, is_project_row, in_root, record_change, Reply};
use serde_json::{json, Value};

use pm_core::device_link::pclink::engine_services::ProjectChatEnv;

/// Runs one row this machine serves. None for any other command, which the caller answers NOT_ON_THIS_MACHINE.
pub fn call(env: &ProjectChatEnv, node: &str, cmd: &str, args: &Value) -> Option<Reply> {
    if cmd == "files_search_cancel" {
        return Some(cancel_search(args));
    }
    if !is_project_row(cmd) {
        return None;
    }
    let Some(id) = text_arg(args, "paneId") else {
        return Some(bad("INVALID_ARGUMENT", "paneId is required"));
    };
    let Some(root) = env.folder_of_pane_or_project(&id) else {
        return Some((404, json!({ "code": "UNKNOWN_PROJECT", "error": "That folder is not one of this machine's projects." })));
    };
    let reply = in_root(&root, cmd, args)?;
    if cmd == "files_write" && reply.0 == 200 {
        record_change(node, cmd, &id, text_arg(args, "path").as_deref());
    }
    Some(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::Projects;
    use pm_core::device_link::pclink::engine_services::ProjectChatEnv;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// A data folder and one project folder beside the test exe (the cargo target folder), emptied each time.
    fn setup(name: &str) -> (ProjectChatEnv, Projects, String, PathBuf) {
        let base = std::env::current_exe().unwrap().parent().unwrap().join("host-files-tests").join(name);
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("a.txt"), "hello").unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let listed = project.to_string_lossy().to_string();
        std::fs::write(data.join("projects.json"), serde_json::to_string(&vec![listed.clone()]).unwrap()).unwrap();
        let projects = Projects::open(&data, None);
        let id = projects.id(&listed);
        (ProjectChatEnv::new(Arc::new(projects.clone())), projects, id, project)
    }

    #[test]
    fn a_known_project_lists_reads_saves_and_shows_git_status() {
        let (env, _projects, id, project) = setup("works");
        let list = call(&env, "aa", "files_list", &json!({ "paneId": id, "path": "" })).unwrap();
        assert_eq!(list.0, 200);
        assert!(list.1.to_string().contains("a.txt"));
        let read = call(&env, "aa", "files_read", &json!({ "paneId": id, "path": "a.txt" })).unwrap();
        assert!(read.1.to_string().contains("hello"));
        // Saves only over an existing file; `overwrite` skips the "changed on disk since you opened it" check.
        let saved = call(&env, "aa", "files_write", &json!({ "paneId": id, "path": "a.txt", "text": "new", "baseVersion": null, "overwrite": true })).unwrap();
        assert_eq!(saved.0, 200, "{}", saved.1);
        assert_eq!(std::fs::read_to_string(project.join("a.txt")).unwrap(), "new");
        // Not a git folder: the branch is null, not an error.
        assert_eq!(call(&env, "aa", "pane_git_branch", &json!({ "paneId": id })).unwrap(), (200, Value::Null));
    }

    #[test]
    fn an_unknown_id_a_path_and_a_row_not_here_are_refused() {
        let (env, _projects, id, _) = setup("refused");
        assert_eq!(call(&env, "aa", "files_list", &json!({ "paneId": "0000000000000000", "path": "" })).unwrap().0, 404);
        assert_ne!(call(&env, "aa", "files_read", &json!({ "paneId": id, "path": "../x" })).unwrap().0, 200);
        assert_ne!(call(&env, "aa", "files_read", &json!({ "paneId": "C:/Windows", "path": "a.txt" })).unwrap().0, 200);
        assert!(call(&env, "aa", "checkpoints_list", &json!({ "paneId": id })).is_none(), "not a file row: the caller answers not here");
    }
}
