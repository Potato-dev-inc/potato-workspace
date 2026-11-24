//! The far call table: `POST /pclink/call/<command>`. A command the far PC's own window may run (a Tauri command) that a paired PC
//! may run too, with the same arguments (the JSON body) and the same answer, through ONE allowlist. Not in the table means 404.
//!
//! Each row says the least level that may call it and whether its arguments name a chat pane (then that pane's own "not for remote
//! use" rule on the far PC applies, like the `sessions/<id>` routes). `Services::call` runs the same inner function the Tauri
//! command runs. Later phases add rows here and nowhere else; a new row is reviewed like a new public route.
//!
//! S10: some commands are never served, whatever the level: [`REFUSED`].

use super::Level;

/// `(command, least level, args name a pane)`. The chat settings family: read the state and the model list, change the model,
/// effort or permission mode (`acp_chat_set_config`), and Force yes. The press-and-hold rule for "Full access" and Force yes
/// on is enforced by the far PC in `app_services.rs` (`hold: true` in the body), never by the asking side.
pub const TABLE: &[(&str, Level, bool)] = &[
    ("acp_chat_state", Level::Watch, true),
    ("agent_model_options", Level::Watch, false),
    ("acp_chat_set_config", Level::Full, true),
    ("acp_chat_set_force_yes", Level::Full, true),
    // ---- P1.7 chat feed ----
    // Reads Watch; send, stop and the message box Answer; what lets the agent act without asking or changes who drives Full. Served by
    // `calls_chat.rs`; the same inner function as the Tauri command of that name.
    ("session_chat_open", Level::Watch, true),
    ("session_chat_close", Level::Watch, true),
    ("chat_earlier", Level::Watch, true),
    ("chat_picture", Level::Watch, true),
    ("acp_chat_cancel", Level::Answer, true),
    ("pane_message_send", Level::Answer, true),
    ("pane_message_cancel", Level::Answer, true),
    ("pane_message_hold", Level::Answer, true),
    ("pane_message_edit", Level::Answer, true),
    ("pane_messages_list", Level::Answer, true),
    ("acp_chat_keep_waiting", Level::Answer, true),
    ("acp_chat_take_back", Level::Full, true),
    ("acp_chat_set_auto_allow", Level::Full, true),
    ("acp_chat_set_agent_answering", Level::Full, true),
    ("acp_chat_warm", Level::Answer, true),
    // ---- end P1.7 chat feed ----
    // A chat's name, set from another PC (Full; cleaned and cut like a local rename; run by `app_services.rs`).
    ("pane_set_title", Level::Full, true),
    // ---- P2.3 terminal ---- (`terminal.rs`; the pane id is `paneId`; output and replay may hold secrets: Full only (S11))
    ("list_panes", Level::Full, false),
    ("spawn_pane", Level::Full, false),
    ("write_pane_input", Level::Full, true),
    ("resize_pane", Level::Full, true),
    ("kill_pane_cmd", Level::Full, true),
    ("read_pane_screen_replay", Level::Full, true),
    ("read_pane_raw_buffer", Level::Full, true),
    // ---- end P2.3 terminal ----
    // ---- P3.1 workflows ---- (run by `calls_workflows.rs`; the folder a row takes is one of this PC's known projects, by id or path)
    ("crews_list", Level::Watch, false),
    ("crews_starters", Level::Watch, false),
    ("crews_get", Level::Watch, false),
    ("crews_agents", Level::Watch, false),
    ("crews_draft", Level::Watch, true),
    ("crews_templates", Level::Watch, false),
    ("crews_open", Level::Watch, false),
    ("crews_check", Level::Watch, false),
    ("crews_try_task", Level::Watch, false),
    ("crews_follow", Level::Watch, false),
    ("workflows_list", Level::Watch, false),
    ("workflows_hidden_count", Level::Watch, false),
    ("workflows_plan", Level::Watch, false),
    ("workflows_start_helpers", Level::Full, false),
    ("crews_start", Level::Full, false),
    ("crews_save", Level::Full, false),
    ("crews_remove", Level::Full, false),
    // ---- end P3.1 workflows ----
    // ---- P2.2 sign-in ---- (rows run `calls_signin.rs`; the state reads are Watch, anything that starts, stops or tries again is Full)
    ("agents_detect_installed", Level::Watch, false),
    ("agents_health", Level::Watch, false),
    ("agent_login_states", Level::Watch, false),
    ("agent_signin_start", Level::Full, false),
    ("agent_signin_status", Level::Full, false),
    ("agent_signin_stop", Level::Full, false),
    ("chat_signin_start", Level::Full, true),
    ("chat_signin_status", Level::Full, true),
    ("chat_signin_stop", Level::Full, true),
    ("acp_chat_retry_sign_in", Level::Full, true),
    // ---- end P2.2 sign-in ----
    // ---- P2.1 agents/projects ---- (what the New agent page reads; run by `calls_agents.rs`; tests in `calls_agents_tests.rs`)
    ("agents_list", Level::Watch, false),
    ("agent_lane_get", Level::Watch, false),
    ("agent_default_models", Level::Watch, false),
    ("agent_rules_effective", Level::Watch, false),
    ("project_recent", Level::Watch, false),
    // ---- end P2.1 ----
    // ---- P6.1 lend ---- (`calls_lend.rs`; tests in `calls_lend_tests.rs`). The PC the person drives from asks THIS PC to ask it back for the
    // lend its own click promised; it asks only the caller, and the lender decides. Full: it starts a lend-borrowed shim on this PC.
    ("own_borrow_ask", Level::Full, false),
    // What a start from the caller would run on: the far PC's own sign-in state and the caller's own lend (name only). Watch.
    ("own_borrow_plan", Level::Watch, false),
    // ---- end P6.1 lend ----
    // ---- P5 files, git, checkpoints, artifacts, previews, usage ---- (`calls_files.rs`; tests in `calls_files_tests.rs`)
    // What is in a project folder (names, text, diffs, what the agent changed) is Full, as paths are: the far PC reads only inside the
    // chat's own folder (symlinks that lead out are refused). Writes (a save, a put back, an undo) are Full and audited with no text.
    // The artifact pages and the numbers (usage, meters, dev-server ports) are Watch reads; a path in them travels only at Full.
    ("files_list", Level::Full, true),
    ("files_read", Level::Full, true),
    ("files_read_bytes", Level::Full, true),
    ("files_marks", Level::Full, true),
    ("files_diff", Level::Full, true),
    ("files_search_contents", Level::Full, true),
    ("files_search_cancel", Level::Full, false),
    ("project_files_search", Level::Full, true),
    ("files_write", Level::Full, true),
    ("checkpoints_list", Level::Full, true),
    ("checkpoint_diff", Level::Full, true),
    ("checkpoint_turn_review", Level::Full, true),
    ("checkpoint_file_patch", Level::Full, true),
    ("checkpoint_put_back", Level::Full, true),
    ("checkpoint_restore", Level::Full, true),
    ("checkpoint_undo_last", Level::Full, true),
    ("pane_git_branch", Level::Full, true),
    ("artifacts_read", Level::Watch, true),
    ("artifacts_sync", Level::Answer, true),
    ("pane_previews", Level::Watch, false),
    ("pane_usage", Level::Watch, true),
    ("usage_snapshot", Level::Watch, false),
    // One round trip for the reads a chat's screen makes at once when it opens (each part only if the asker's level allows that part's own row).
    ("pane_open_bundle", Level::Watch, true),
    // ---- end P5 ----
    // ---- P6.2 install ---- (run by `calls_install.rs`; Full, from your own PC only, audited by agent id; the plan is built on this PC and a changed command is refused)
    ("agents_install_plan", Level::Full, false),
    ("agents_install_run", Level::Full, false),
    ("agents_install_status", Level::Full, false),
    ("agents_install_finish", Level::Full, false),
    // ---- end P6.2 install ----
    // ---- P4a Ask aside, Hand off, Share, closed chats, search ---- (run by `calls_p4a.rs`; tests in `calls_p4a_tests.rs`)
    // A side question runs the far PC's own agent (Answer); the hand-off steps write or move a file in the project folder (Full); an export
    // is the chat's text, read like the transcript (Watch); a closed chat is listed at Watch, reopened and deleted at Full; search is Watch.
    ("side_question_target", Level::Answer, true),
    ("side_question_ask", Level::Answer, true),
    ("handoff_file_stat", Level::Full, true),
    ("handoff_quick_prepare", Level::Full, true),
    ("handoff_quick_append", Level::Full, true),
    ("handoff_quick_archive", Level::Full, true),
    ("handoff_pane_account", Level::Full, true),
    ("chat_export_html", Level::Watch, true),
    ("chat_export_markdown", Level::Watch, true),
    ("acp_closed_list", Level::Watch, false),
    ("acp_reopen_closed", Level::Full, false),
    ("acp_delete_closed", Level::Full, false),
    ("chat_search", Level::Watch, false),
    ("chat_search_facets", Level::Watch, false),
    // ---- end P4a ----
    // ---- P4b attach and start ---- (run by `calls_attach.rs`; a file's bytes ride `attachment_save_pasted` (the door lets that one call carry 20 MB); a start
    // here takes a project this PC knows and never an account)
    ("attachment_prepare", Level::Full, true),
    ("attachment_save_pasted", Level::Full, true),
    ("acp_chat_start", Level::Full, false),
    // ---- end P4b ----
    // ---- P45 gaps ---- (a chat on a separate copy: its Changes, Keep and Discard run on this PC for the chat's OWN copy (`calls_files.rs`; the handle must
    // be the chat's own, the project is never taken from the asker); a picture's thumbnail for a message box (`calls_attach.rs`; inside the chat's project only))
    ("pane_worktree", Level::Full, true),
    ("worktree_diff", Level::Full, true),
    ("worktree_merge", Level::Full, true),
    ("worktree_discard", Level::Full, true),
    ("attachment_preview", Level::Full, true),
    // ---- end P45 gaps ----
];

/// Name prefixes of commands that no PC may call, even at Full (S10): accounts and sign-ins, anything that reads or writes a login,
/// token or key, trust and pairing, the audit, lending, the phone, security settings, shell hops (`ssh_`), updates and uninstall,
/// tool catalog changes, Discord and Team sends.
pub const REFUSED: &[&str] = &[
    "account", "adapter_key", "agent_authority", "app_update", "audit", "bridge_", "credential", "device", "discord_", "keystore", "labs", "lend_",
    "mcp_", "mobile_", "pair", "phone_", "relay", "secret", "settings", "ssh_", "team_", "token", "tool", "uninstall",
];

pub fn refused(cmd: &str) -> bool {
    REFUSED.iter().any(|p| cmd.starts_with(p))
}

/// The level `cmd` needs, or `None` when it is not a far call (unknown, or refused). Sits beside `pclink::need` and is as strict.
pub fn need(cmd: &str) -> Option<Level> {
    if refused(cmd) {
        return None;
    }
    TABLE.iter().find(|(c, _, _)| *c == cmd).map(|(_, level, _)| *level)
}

/// Whether the arguments of `cmd` name a chat pane (`paneId`).
pub fn names_pane(cmd: &str) -> bool {
    TABLE.iter().any(|(c, _, pane)| *c == cmd && *pane)
}

/// An argument as the Tauri command takes it (`paneId`); `pane_id` is accepted too.
pub fn arg<'a>(args: &'a serde_json::Value, camel: &str) -> Option<&'a serde_json::Value> {
    let snake: String = camel.chars().flat_map(|c| if c.is_ascii_uppercase() { vec!['_', c.to_ascii_lowercase()] } else { vec![c] }).collect();
    args.get(camel).or_else(|| args.get(snake.as_str()))
}

pub fn text_arg(args: &serde_json::Value, camel: &str) -> Option<String> {
    arg(args, camel).and_then(serde_json::Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command names the Tauri handler list registers (`lib.rs`).
    fn tauri_commands() -> Vec<String> {
        include_str!("../../../../../src/lib.rs")
            .split("commands::")
            .skip(1)
            // `commands::handoff_file::handoff_file_stat` registers the command `handoff_file_stat`: the last part of the path.
            .map(|rest| rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == ':').collect::<String>().rsplit("::").next().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn the_table_names_exactly_these_commands_at_these_levels() {
        // Each phase pins its own block of rows in its own tests file; this pins the chat-settings block.
        let rows: Vec<_> = TABLE.iter().take(4).map(|(c, l, p)| (*c, l.as_str(), *p)).collect();
        assert_eq!(
            rows[..4],
            [("acp_chat_state", "watch", true), ("agent_model_options", "watch", false), ("acp_chat_set_config", "full", true), ("acp_chat_set_force_yes", "full", true)]
        );
        assert_eq!(need("acp_chat_state"), Some(Level::Watch));
        assert_eq!(need("acp_chat_set_config"), Some(Level::Full));
        assert_eq!(need("not_a_command"), None);
        assert_eq!(need(""), None);
    }

    #[test]
    fn every_row_is_a_real_tauri_command_and_none_is_refused() {
        let known = tauri_commands();
        for (cmd, _, _) in TABLE {
            // The one far-only row: it runs rows that are real commands (`calls_files::bundle_parts`), each at its own level.
            if *cmd != "pane_open_bundle" {
                assert!(known.iter().any(|k| k == cmd), "{cmd} is not in the Tauri handler list");
            }
            assert!(!refused(cmd), "{cmd} is in the refused list");
        }
    }

    #[test]
    fn nothing_that_exports_logins_tokens_keys_or_opens_a_tunnel_is_ever_served() {
        for cmd in [
            "account_sign_in", "account_state", "accounts_list", "accounts_set_helper_login", "adapter_key_set", "adapter_key_status", "agent_authority_set",
            "audit_recent", "bridge_local_secret", "devices_set_permission", "devices_open_account_pc", "devices_make_link", "lend_export_pm", "lend_start_agent",
            "lend_key_set", "phone_activity_list", "secret_get_masked", "secret_set", "settings_reset", "ssh_open", "ssh_fs_read", "app_update_install",
            "uninstall_run", "mcp_reconnect", "toolbelt_add", "team_send", "discord_bot_set_token", "mobile_pair",
        ] {
            assert_eq!(need(cmd), None, "{cmd}");
        }
        // Every such command the app really has is refused, at the table and by name.
        let mut seen = 0;
        for cmd in tauri_commands().into_iter().filter(|c| refused(c)) {
            seen += 1;
            assert_eq!(need(&cmd), None, "{cmd}");
        }
        assert!(seen > 50, "the handler list was read ({seen})");
        // Even a row added by mistake stays shut: `need` asks the refused list first.
        assert!(refused("account_sign_in") && refused("lend_request") && refused("ssh_hosts"));
    }

    #[test]
    fn arguments_are_read_as_the_tauri_command_takes_them() {
        let args = serde_json::json!({ "paneId": " p1 ", "option_id": "effort", "on": true });
        assert_eq!(text_arg(&args, "paneId").as_deref(), Some("p1"));
        assert_eq!(text_arg(&args, "optionId").as_deref(), Some("effort"));
        assert_eq!(text_arg(&args, "value"), None);
        assert!(names_pane("acp_chat_state") && !names_pane("agent_model_options") && !names_pane("nope"));
    }
}
