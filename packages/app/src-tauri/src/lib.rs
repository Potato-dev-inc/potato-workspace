#![recursion_limit = "512"]

mod accounts;
mod acp;
mod actors;
mod agent_authority;
mod agent_run_mode;
mod audit;
mod ambient;
mod agent_adapters;
mod agent_contexts;
pub mod agent_runs;
mod agent_health;
mod agent_install;
mod agent_store;
mod agent_caps;
pub mod agent_hooks;
pub mod app_lifecycle;
mod autostart;
pub mod app_paths;
mod bridge;
pub use bridge::identity as bridge_identity;
mod budgets;
mod canary;
mod channels;
mod branch_from;
pub mod checkpoints;
mod commands;
mod context_pack;
mod crash;
mod event_log;
mod git_exclude;
mod handoff;
mod issue_intake;
mod ci_fix;
mod events;
mod mcp_hints;
mod mcp_install;
mod mcp_runtime;
mod pane_mcp;
pub mod mcp_sessions;
mod mcp_status;
mod missions;
mod mobile_pairing;
mod mobile_tunnel;
pub mod night_shift;
mod tunnel_config;
mod uninstall;
mod one_brain;
mod companion;
mod crews;
mod discord_alerts;
mod opencode;
pub mod operations;
pub mod wait_reasons;
#[cfg(test)]
mod sleep_budget_tests;
#[cfg(test)]
mod operations_contract_tests;
mod pane_activity;
mod pane_jobs;
mod pane_preview;
mod point;
mod loop_guard;
mod panic;
mod askbar;
mod hidden_runs;
mod side_question;
mod attach;
mod attention;
mod second_opinion;
pub mod pane_outbox;
mod pane_prompt;
mod first_run;
mod plain_mode;
mod plans_report;
mod usage;
mod prompt_risk;
mod package_check;
pub mod questions;
mod push;
pub mod redact;
mod flight;
mod secure_file;
mod app_windows;
mod cockpit;
mod mini_bar;
mod switch_anim;
mod window_layout;
mod ui_mode;
mod pane_windows;
mod tray;
mod pane_wait;
mod pane_wait_notify;
mod platform;
pub mod redirection_trust;
mod project_ir;
#[cfg(windows)]
pub mod proc_job;
pub mod proc_util;
mod path_limit;
mod project_path;
mod projections;
mod pty;
#[cfg(test)]
mod replay;
#[cfg(feature = "dev-fake-tui")]
#[doc(hidden)]
pub mod fake_tui;
mod pwa_server;
#[cfg(test)]
mod tunnel_auth_tests;
#[cfg(test)]
mod device_caps_tests;
mod session_context;
mod chat_index;
mod import_orca;
mod session_chat;
mod scores;
mod secrets;
mod settings_store;
mod show_terminals;
mod settings_patch;
mod settings_safety;
mod global_shortcuts;
mod shell_env;
mod startup_timing;
mod review_desk;
mod spaces;
mod secure_core;
mod tamper;
pub mod shell_exec;
mod standby;
mod team;
#[allow(dead_code)]
mod keys;
#[allow(dead_code)]
mod p2p;
mod terminal_chat;
pub mod tool_registry;
mod toolbelt;
mod agent_pack;
mod tui;
pub mod turn_summary;
mod worker_launch;
pub mod worktrees;
pub mod watch_command;
pub mod env_probe;
mod webview_service_worker;
mod live_room;
mod model_bridge;
// Share an agent: Lend through my PC (Labs `lend_enabled`).
mod capacity_proxy;
mod keep_awake;
mod wsl;
mod collision;
mod notify_levels;
mod files;
// Desktop Potato (Labs `desktop_pet_enabled`): a small pet window. Reserved lines at the end.
mod pet;
#[cfg(test)]
mod conformance_suite;

use commands::AppState;
use std::path::{Path, PathBuf};
use tauri::{Listener, Manager};

/// Command-line modes of the app executable that run without a window (`acp-bridge --agent <id>`: a chat
/// adapter for an agent that has no ACP). `Some(exit code)` when one ran; `main` exits with it. `None`:
/// start the app as usual.
pub fn run_cli_subcommand() -> Option<i32> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some(uninstall::HELPER_FLAG) {
        return uninstall::helper::run_cli(&args);
    }
    acp::bridge::run_cli(&args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything is spawned and before the single-instance lock: an app the installer started
    // inherits a policy that stops its panes following links; start a fresh copy and exit.
    let redirection = redirection_trust::guard_at_startup();
    if redirection == redirection_trust::Outcome::Exit {
        std::process::exit(0);
    }
    startup_timing::mark("app", "app_start");
    worker_launch::init_from_env();
    shell_env::apply_to_process();

    flight::logfile::init(&app_paths::app_data_dir());
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,puppet_master_app_lib=debug")
            }),
        )
        .with_target(false)
        // Console as before, plus the last lines kept in memory for the diagnostic file.
        .with_writer(flight::applog::Tee)
        .init();
    if let redirection_trust::Outcome::Continue(Some(note)) = &redirection {
        tracing::warn!("{note}");
    }

    // `POTATO_WORKSPACE_PROFILE=<name>`: a separate app (own identifier, so its own settings store,
    // webview data and single-instance lock). The default profile keeps the configured identifier.
    let mut context = tauri::generate_context!();
    if app_paths::profile().is_some() {
        context.config_mut().identifier = app_paths::app_id();
    }

    tauri::Builder::default()
        // A second launch opens the running app's cockpit and exits, so it never starts
        // another bridge or rewrites the bridge port file.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch opens the primary window (the cockpit); `--new-pane <agent>` opens only
            // a pop-out pane (no Settings) through the same code path as the tray's "New pane" menu.
            match tray::second_launch_action(args.as_slice()) {
                tray::SecondLaunch::Settings => cockpit::open_primary_window(app),
                // A sign-in start while the app runs: no window, no focus.
                tray::SecondLaunch::Quiet => tracing::info!("sign-in start while running: nothing shown"),
                tray::SecondLaunch::NewPane(agent) => {
                    let app = app.clone();
                    std::thread::spawn(move || match tray::new_pane(&app, &agent) {
                        Ok(id) => tracing::info!(%agent, pane = %id, "second launch: opened new pane"),
                        Err(e) => tracing::warn!(%agent, error = %e, "second launch: new pane failed"),
                    });
                }
            }
        }))
        .plugin(autostart::plugin())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .manage(commands::SessionChatState::default())
        .manage(live_room::service::LiveRoomState::default())
        .manage(commands::ChatImportState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_panes,
            spaces::commands::spaces_view,
            spaces::commands::space_create,
            spaces::commands::space_invite_create,
            spaces::commands::space_invite_cancel,
            spaces::commands::space_join,
            spaces::commands::space_join_answer,
            spaces::commands::space_join_cancel,
            spaces::commands::space_detail,
            spaces::commands::space_messages,
            spaces::commands::space_send,
            spaces::commands::space_read,
            spaces::commands::space_channel_create,
            spaces::commands::space_channel_rename,
            spaces::commands::space_channel_archive,
            spaces::commands::space_remove_member,
            spaces::commands::space_leave,
            spaces::commands::space_forget,
            spaces::commands::space_block,
            spaces::commands::space_react,
            spaces::commands::space_delete,
            spaces::commands::space_file_offer,
            spaces::commands::space_file_get,
            spaces::commands::space_file_save,
            spaces::commands::space_presence,
            spaces::commands::space_show_online,
            commands::session_chat_open,
            commands::session_chat_close,
            commands::chat_search,
            commands::chat_search_facets,
            commands::chat_index_status,
            commands::chat_index_set_enabled,
            commands::chat_index_clear,
            commands::chat_import_state,
            commands::chat_import_look,
            commands::chat_import_start,
            commands::chat_import_browse,
            commands::chat_import_cancel,
            commands::chat_import_dismiss,
            commands::chat_import_clear,
            commands::chat_import_open,
            commands::chat_import_resume_plan,
            commands::chat_import_continue_as_chat,
            commands::chat_export_html,
            commands::chat_export_markdown,
            commands::chat_export_save,
            commands::live_room_preview,
            commands::live_room_start,
            commands::live_room_stop,
            commands::live_room_pause,
            commands::live_room_resume,
            commands::live_room_status,
            commands::live_room_copy_link,
            commands::live_room_config_get,
            commands::live_room_config_set,
            commands::model_bridge_list,
            commands::model_bridge_save_key,
            commands::model_bridge_remove,
            commands::model_bridge_add_custom,
            commands::model_bridge_preview,
            commands::model_bridge_apply,
            commands::model_bridge_undo,
            commands::lend_state,
            commands::lend_test_link,
            commands::lend_profile_save,
            commands::lend_profile_delete,
            commands::lend_key_set,
            commands::lend_account_add,
            commands::lend_request,
            commands::lend_answer,
            commands::lend_revoke,
            commands::lend_return,
            commands::lend_start_agent,
            commands::lend_export_pm,
            commands::lend_import_pm,
            commands::keep_going_targets,
            commands::keep_going_continue,
            commands::keep_going_lineage,
            commands::keep_going_brief,
            commands::keep_going_settings_get,
            commands::keep_going_settings_set,
            commands::package_check_lookup,
            commands::package_check_settings_get,
            commands::package_check_settings_set,
            commands::branch_preview,
            commands::branch_start,
            commands::branch_lineage,
            commands::branch_brief,
            commands::pane_message_send,
            commands::pane_message_cancel,
            commands::pane_message_hold,
            commands::pane_message_edit,
            commands::pane_messages_list,
            commands::attachments::attachment_prepare,
            commands::attachments::attachment_save_pasted,
            commands::attachments::attachment_preview,
            commands::attachments::project_files_search,
            commands::attachments::clipboard_file_paths,
            commands::handoff_file::handoff_file_stat,
            commands::handoff_file::handoff_quick_prepare,
            commands::handoff_file::handoff_quick_append,
            commands::handoff_file::handoff_open_file,
            commands::handoff_file::handoff_quick_archive,
            commands::handoff_file::handoff_pane_account,
            commands::point_open_preview,
            commands::point_state,
            commands::point_arm,
            commands::point_remove_pick,
            commands::point_compose,
            commands::point_send,
            commands::point_edit_in_chat,
            commands::point_take_draft,
            commands::point_discard,
            commands::point_box_hide,
            commands::point_open_blocked_link,
            team::commands::team_state,
            team::commands::team_config_get,
            team::commands::team_ping,
            team::commands::team_default_name,
            team::commands::team_config_set,
            team::commands::team_send,
            team::commands::team_draft_dismiss,
            team::commands::team_card_dismiss,
            team::commands::team_ci_claim,
            team::commands::team_pull,
            team::commands::team_queue,
            team::commands::team_job_apply,
            team::commands::team_job_discard,
            team::commands::team_job_diff,
            team::commands::team_create,
            team::commands::team_invite,
            team::commands::team_join,
            team::commands::team_leave,
            team::commands::team_join_approve,
            team::commands::team_join_decline,
            team::commands::team_member_remove,
            team::commands::team_gaps_clear,
            team::commands::team_merge_plan,
            team::commands::team_merge_when_green,
            team::commands::team_job_start,
            team::commands::team_member_confirm_github,
            team::commands::team_relay_deploy,
            commands::spawn_pane,
            commands::wsl_status,
            commands::wsl_check,
            commands::wsl_places_get,
            commands::wsl_place_set,
            commands::spawn_pane_in_linux,
            commands::kill_pane_cmd,
            commands::kill_all_panes,
            uninstall::commands::uninstall_allowed,
            uninstall::commands::uninstall_plan,
            uninstall::commands::uninstall_run,
            uninstall::commands::settings_reset,
            commands::write_pane_input,
            commands::read_pane_buffer,
            commands::read_pane_snapshot,
            commands::read_pane_raw_buffer,
            commands::read_pane_screen_replay,
            commands::agents_list,
            commands::pane_activities,
            commands::pane_previews,
            commands::pane_jobs,
            commands::pane_jobs_all,
            commands::pane_job_stop,
            commands::loop_status,
            commands::loop_signals,
            commands::loop_dismiss,
            commands::loop_settings_get,
            commands::loop_settings_set,
            commands::stop_all_agents,
            commands::askbar_settings_get,
            commands::askbar_settings_set,
            commands::askbar_agents,
            commands::askbar_clipboard,
            commands::askbar_hide,
            commands::askbar_resize,
            commands::askbar_ask,
            commands::askbar_continue,
            commands::askbar_notices,
            commands::askbar_notice_dismiss,
            commands::askbar_notice_open,
            commands::side_question_target,
            commands::side_question_ask,
            commands::agents_health,
            commands::agents_health_test,
            commands::agents_install_plan,
            commands::agents_install_run,
            commands::agents_install_status,
            commands::agents_install_finish,
            commands::agent_store_list,
            commands::agent_store_detail,
            commands::agent_store_add,
            commands::agent_store_remove,
            commands::agent_store_record_install,
            commands::agent_store_uninstall_plan,
            commands::agent_store_uninstall_run,
            commands::agent_store_record_check,
            commands::agent_store_check_source,
            commands::canary_status,
            commands::canary_check,
            commands::canary_set_auto,
            commands::canary_dismiss_notice,
            commands::canary_open_captures,
            commands::agents_definitions_list,
            commands::agents_definitions_reload,
            commands::agents_definitions_validate,
            commands::agents_definition_approve,
            commands::agents_definition_preview,
            commands::agents_check_file,
            commands::agents_create_fixtures_dir,
            commands::agents_add_generic,
            commands::agents_export_definition,
            commands::agents_import_definition,
            commands::agents_definition_revoke,
            commands::agents_definition_remove,
            commands::agents_definition_restore,
            commands::agents_definitions_removed,
            commands::agents_definition_purge,
            commands::agents_definitions_purge_all,
            commands::agents_definitions_consent,
            commands::agents_source_set,
            commands::agents_extra_dir,
            commands::agents_project_scan,
            commands::agent_wizard_start,
            commands::agent_wizard_probe,
            commands::agent_wizard_verify,
            commands::agent_wizard_livetest,
            commands::agent_wizard_visibletest,
            commands::agent_wizard_capture,
            commands::agent_wizard_finish,
            commands::agent_wizard_cancel,
            commands::agent_wizard_acp_detect,
            commands::agent_wizard_acp_finish,
            commands::agent_wizard_ask,
            commands::list_agent_contexts,
            commands::read_agent_context,
            commands::inspect_agent_model,
            commands::switch_agent_model,
            commands::agent_model_options,
            commands::replay_pane_timeline,
            commands::get_workspace_state,
            commands::list_tasks,
            commands::list_locks,
            commands::get_coordination_storage_info,
            commands::read_agent_inbox,
            commands::get_audit,
            commands::build_context_pack,
            commands::resize_pane,
            commands::reclaim_pane_size,
            commands::set_project_path,
            commands::get_project_path_cmd,
            commands::install_npm_mcp_configs,
            commands::install_global_npm_mcp_configs,
            commands::uninstall_npm_mcp_configs,
            commands::uninstall_global_npm_mcp_configs,
            commands::get_mcp_status,
            commands::toolbelt_list,
            commands::toolbelt_add,
            commands::toolbelt_update,
            commands::toolbelt_remove,
            commands::toolbelt_sync_preview,
            commands::toolbelt_sync_apply,
            commands::toolbelt_import_preview,
            commands::toolbelt_import_apply,
            commands::agent_pack_preview,
            commands::agent_pack_apply,
            commands::agent_pack_undo,
            commands::agent_pack_inspect,
            commands::agent_pack_custom_save,
            commands::agent_pack_custom_forget,
            commands::push_settings_event,
            commands::sync_public_settings,
            commands::dev_labs_override_active,
            commands::create_mobile_pairing_session,
            commands::list_paired_mobile_devices,
            commands::revoke_paired_mobile_device,
            commands::set_paired_mobile_device_caps,
            commands::bridge_local_secret,
            commands::bridge_local_secret_status,
            commands::get_mobile_tunnel_info,
            commands::profile_bridge_url,
            commands::get_tunnel_status,
            commands::set_tunnel_config,
            commands::restart_tunnel,
            commands::test_tunnel_connection,
            commands::diagnostic_preview,
            commands::diagnostic_show,
            commands::diagnostic_save,
            commands::log_ui_error,
            commands::perf_summary,
            commands::last_run_status,
            commands::app_log_lines,
            app_lifecycle::get_app_install_info,
            app_lifecycle::open_external_url,
            app_lifecycle::launch_uninstall,
            app_lifecycle::autostart_get,
            app_lifecycle::autostart_set,
            commands::app_update_check,
            commands::app_update_busy,
            commands::app_update_install,
            commands::get_worker_launch,
            commands::exit_app,
            commands::get_opencode_key_status,
            commands::secret_storage_info,
            commands::secret_set,
            commands::secret_get_masked,
            commands::secret_delete,
            commands::secret_get_custom_ai_key,
            commands::confirm_pane_window_close,
            commands::set_opencode_automation_settings,
            commands::set_opencode_key_settings,
            commands::set_opencode_key_profile,
            commands::capture_opencode_key_profile,
            commands::rotate_opencode_key,
            commands::accounts_list,
            commands::accounts_add,
            commands::accounts_rename,
            commands::accounts_remove,
            commands::accounts_set_helper_login,
            commands::standby_get_status,
            commands::standby_set_config,
            commands::standby_set_current_project,
            commands::get_ui_mode,
            commands::set_ui_mode,
            commands::plan_mode_switch,
            commands::report_pane_order,
            commands::mode_switch_begin,
            commands::switch_overlay_ready,
            commands::switch_overlay_done,
            commands::mode_switch_preview,
            commands::mini_bar_focus_pane,
            commands::mini_bar_fit,
            commands::mini_bar_toast_left,
            commands::take_individual_fallback,
            commands::open_cockpit,
            commands::pane_set_title,
            commands::memory_get,
            commands::memory_save,
            commands::memory_sync,
            commands::memory_set_project_enabled,
            commands::memory_global_enabled,
            commands::memory_set_global_enabled,
            commands::one_brain_remember,
            commands::one_brain_forget,
            commands::one_brain_set_project_enabled,
            commands::open_settings,
            settings_patch::settings_patch,
            settings_safety::settings_recovery_status,
            settings_safety::settings_restore_last_good,
            settings_safety::settings_recovery_dismiss,
            global_shortcuts::global_shortcut_set,
            global_shortcuts::global_shortcuts_status,
            commands::pane_prompt,
            commands::answer_pane_prompt,
            commands::terminal_chat_prompt,
            commands::terminal_chat_answer,
            commands::attention_snapshot,
            commands::checkpoints_list,
            commands::checkpoint_diff,
            commands::checkpoint_restore,
            commands::checkpoint_undo_last,
            commands::wb_overview,
            commands::wb_declare,
            commands::wb_start,
            commands::wb_status,
            commands::wb_stop,
            commands::wb_finding,
            commands::wb_findings,
            commands::wb_diff,
            commands::wb_undo_plan,
            commands::wb_undo,
            commands::wb_recheck,
            commands::wb_settings_get,
            commands::wb_settings_set,
            commands::tamper_check,
            commands::mission_list,
            commands::mission_get,
            commands::mission_detect,
            commands::mission_start,
            commands::mission_stop,
            commands::mission_pause,
            commands::mission_resume,
            commands::mission_decide,
            commands::turn_summaries,
            commands::changes_blame,
            commands::presence_cockpit_focus,
            commands::away_digest_pending,
            commands::away_digest_dismiss,
            commands::interrupt_pane,
            commands::new_pane,
            commands::pane_run_info,
            commands::budget_for_pane,
            commands::budget_adjust,
            commands::pane_usage,
            commands::plans_report,
            commands::usage_snapshot,
            commands::agent_scores,
            commands::pick_agent,
            commands::pane_worktree,
            commands::pane_git_branch,
            commands::night_state,
            commands::night_plans,
            commands::night_checks_get,
            commands::night_checks_set,
            commands::night_start,
            commands::night_stop,
            commands::night_keep,
            commands::night_throw_away,
            commands::night_keep_all_ready,
            commands::night_seen,
            commands::night_report_html,
            commands::night_report_save,
            commands::night_settings_get,
            commands::night_settings_set,
            commands::night_get,
            commands::issue_intake_view,
            commands::issue_intake_save,
            commands::issue_intake_check_folder,
            commands::issue_intake_act,
            commands::issue_intake_poll_now,
            commands::review_desk_list,
            commands::review_desk_count,
            commands::review_desk_detail,
            commands::review_desk_keep,
            commands::review_desk_throw_away,
            commands::review_desk_unmark,
            commands::review_desk_fix,
            commands::ci_fix_view,
            commands::ci_fix_save_settings,
            commands::ci_fix_offer,
            commands::ci_fix_act,
            commands::ci_fix_log,
            commands::ci_fix_poll_now,
            commands::collision_list,
            commands::collision_ignore,
            commands::collision_settings_get,
            commands::collision_settings_set,
            commands::worktree_list,
            commands::worktree_diff,
            commands::second_opinion_agents,
            commands::second_opinion_start,
            commands::second_opinion_poll,
            commands::second_opinion_cancel,
            commands::second_opinion_send,
            commands::worktree_merge,
            commands::worktree_discard,
            commands::plain_check_folder,
            commands::plain_start,
            commands::plain_preview,
            commands::plain_open_preview,
            commands::plain_send,
            commands::crews_list,
            commands::crews_get,
            commands::crews_starters,
            commands::crews_agents,
            commands::crews_draft,
            commands::crews_save,
            commands::crews_remove,
            commands::crews_start,
            commands::first_run_state,
            commands::first_run_start_task,
            commands::first_run_task_status,
            commands::first_run_pane_mcp,
            commands::project_recent,
            commands::project_forget,
            commands::project_remember,
            commands::project_pick_folder,
            commands::project_git_state,
            commands::project_git_init_plan,
            commands::project_git_init,
            commands::project_preset_get,
            commands::project_preset_set,
            commands::project_preset_import_conductor,
            commands::worktree_pr_prepare,
            commands::worktree_pr_create,
            commands::worktree_pr_checks,
            commands::pane_transcript,
            commands::questions_list,
            commands::question_answer,
            commands::question_dismiss,
            commands::agent_authority_get,
            commands::agent_authority_set,
            commands::telegram_status,
            commands::telegram_set_token,
            commands::telegram_pair_start,
            commands::telegram_pair_decide,
            commands::telegram_set_enabled,
            commands::telegram_set_options,
            commands::telegram_forget,
            commands::discord_alerts_status,
            commands::discord_alerts_set_url,
            commands::discord_alerts_clear,
            commands::discord_alerts_set_kinds,
            commands::discord_alerts_test,
            commands::acp_chat_start,
            commands::acp_chat_cancel,
            commands::acp_chat_keep_waiting,
            commands::acp_chat_state,
            commands::acp_chat_set_config,
            commands::acp_chat_set_agent_answering,
            commands::acp_chat_set_auto_allow,
            commands::acp_conversation_of_terminal,
            commands::acp_chat_retry_sign_in,
            commands::acp_addon_status,
            commands::acp_addon_install,
            commands::acp_addon_remove,
            commands::agent_lane_get,
            terminal_chat::start::terminal_chat_start,
            commands::agent_lane_set,
            commands::acp_overlay_detect,
            commands::acp_overlay_resolve,
            commands::acp_overlay_install,
            commands::acp_overlay_set,
            commands::acp_overlay_remove,
            commands::acp_adapter_key_set,
            commands::acp_adapter_key_status,
            commands::acp_adapter_key_clear,
            commands::acp_chat_remove,
            commands::acp_chat_restart,
            commands::acp_conversations_list,
            commands::acp_closed_list,
            commands::acp_reopen_closed,
            commands::acp_delete_closed,
            commands::acp_delete_all_closed,
            commands::acp_conversations_restore,
            commands::acp_conversation_create,
            commands::acp_open_in_terminal,
            commands::acp_back_to_chat,
            commands::acp_conversation_notices_seen,
            commands::agent_run_mode_get,
            commands::agent_run_mode_set,
            commands::helper_visibility_get,
            commands::helper_visibility_set,
            commands::keep_helpers_open_get,
            commands::keep_helpers_open_set,
            commands::close_helpers_with_agent_get,
            commands::close_helpers_with_agent_set,
            commands::most_helpers_at_once_get,
            commands::most_helpers_at_once_set,
            commands::hidden_runs_list,
            commands::hidden_runs_dismiss,
            commands::audit_recent,
            commands::audit_verify,
            commands::companion_list,
            commands::companion_get,
            commands::companion_agents,
            commands::companion_create,
            commands::companion_update,
            commands::companion_archive,
            commands::companion_delete,
            commands::companion_wake,
            commands::companion_sleep,
            commands::companion_restart,
            commands::companion_rehome,
            commands::companion_memory_get,
            commands::companion_memory_save,
            commands::companion_pending_decide,
            commands::companion_skill_approve,
            commands::companion_skill_get,
            commands::companion_skill_save,
            commands::companion_skill_remove,
            commands::companion_outside_change_decide,
            commands::companion_tidy_up,
            commands::companion_checkins_set,
            commands::companion_feed,
            commands::companion_open_folder,
            commands::agent_caps_get,
            commands::agent_caps_list,
            commands::agent_caps_recheck,
            commands::add_agent_start,
            commands::add_agent_status,
            commands::add_agent_cancel,
            commands::add_agent_approve_install,
            commands::add_agent_approve_check,
            commands::add_agent_skip_check,
            commands::agents_detect_installed,
            commands::orca_import_scan,
            commands::orca_import_add,
            commands::get_pane_remote,
            commands::set_pane_remote,
            commands::notify_prefs_get,
            commands::notify_bell_set,
            commands::notify_quiet_set,
            commands::notify_snooze,
            commands::notify_prefs_import,
            commands::path_kind::path_kinds,
            commands::files_list,
            commands::files_read,
            commands::files_marks,
            commands::files_reveal,
            commands::files_diff,
            commands::list_control_asks,
            commands::answer_control_ask,
            commands::pet_set_expanded,
            commands::pet_start_drag,
            commands::pet_move_by,
            commands::pet_fullscreen_busy,
        ])
        .setup(|app| {
            commands::startup_probe(app.handle().clone());
            // The window hears when an agent's capability table changes (agent-caps://changed).
            {
                use tauri::Emitter;
                let handle = app.handle().clone();
                agent_caps::set_notifier(move |agent_id| {
                    let _ = handle.emit("agent-caps://changed", serde_json::json!({ "agent_id": agent_id }));
                });
            }
            // An agent that updated itself since the last check gets its free checks again (drift).
            agent_caps::drift::spawn_startup_check();
            // Agents keep working when the PC is locked: hold it awake while any pane is busy.
            keep_awake::spawn(app.state::<AppState>().registry.clone());
            // Copy (never move) the data release 1.0.3 left under the old names once: the home and
            // companion folders, and the paired phones / tunnel / push files in the app data folder.
            // The old files stay untouched and nothing already saved under the new names is overwritten.
            app_paths::migrate_legacy_home_data();
            app_paths::migrate_legacy_app_data();
            // First, so a panic anywhere below leaves a file behind (the console and the in-memory
            // log tail die with the process).
            flight::lastrun::check_at_start(&app_paths::app_data_dir());
            crash::install(app_paths::app_data_dir());
            // Terminal agents die with the app (job object); anything a crashed run left behind is ended now.
            pty::term_job::init();
            pty::orphans::init(&app_paths::app_data_dir());
            // Before the first window: an older version's desktop service worker would serve its UI.
            webview_service_worker::remove_at_startup(app.path().app_local_data_dir().ok());
            // Register approved declarative agent definitions before anything resolves a profile.
            tui::declarative::loader::reload();
            bridge::start_definitions_watcher(app.handle().clone());
            // An installed copy keeps these under `<install>/resources/` (Tauri copies the `resources/...`
            // entries of tauri.conf.json with that folder name); a dev run has them elsewhere.
            let resource_dir = app.path().resource_dir().ok();
            let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from));
            let find_resource =
                |rel: &str| mcp_runtime::installed_resource(resource_dir.as_deref(), exe_dir.as_deref(), rel);
            if let Some(resource) = find_resource("mcp-stdio.bundle.cjs") {
                mcp_runtime::set_bundled_mcp_script(resource);
            }
            if let Some(cli) = find_resource("puppet-master-cli.bundle.mjs") {
                if let Some(dir) = cli.parent() {
                    crate::watch_command::set_resource_dir(dir.to_path_buf());
                }
            }
            let rust_mcp_name = if cfg!(windows) {
                "bin/puppet-master-mcp.exe"
            } else {
                "bin/puppet-master-mcp"
            };
            if let Some(resource) = find_resource(rust_mcp_name) {
                mcp_runtime::set_bundled_mcp_binary(resource);
            }
            if mcp_runtime::bundled_mcp_binary().is_none() {
                // A dev build has no installed resource folder: look where the binary is built or
                // staged (the package's dist, the staged `resources/bin`, next to the running exe).
                if let Some(dev) = mcp_runtime::dev_mcp_binary(Path::new(env!("CARGO_MANIFEST_DIR")), exe_dir.as_deref()) {
                    mcp_runtime::set_bundled_mcp_binary(dev);
                }
            }
            if mcp_runtime::bundled_mcp_script().is_none() {
                let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../mcp-server/dist/index.js");
                // Prefer the non-canonical path: Windows canonicalize() adds \\?\ and breaks MCP configs.
                if dev.is_file() {
                    mcp_runtime::set_bundled_mcp_script(dev);
                } else if let Ok(canon) = dev.canonicalize() {
                    if canon.is_file() {
                        mcp_runtime::set_bundled_mcp_script(canon);
                    }
                }
            }
            if let Some(script) = mcp_runtime::bundled_mcp_script() {
                tracing::info!(path = %script.display(), "bundled MCP server");
            }
            if let Some(binary) = mcp_runtime::bundled_mcp_binary() {
                tracing::info!(path = %binary.display(), "bundled Rust MCP server");
            }

            app_paths::write_app_exe_file();
            let port_file = app_paths::bridge_port_file();
            let pairing_file = app_paths::pairing_file();
            if let Err(err) = event_log::init_global_event_log(event_log::event_log_path()) {
                tracing::warn!(%err, "event log not initialized");
            }
            let initial_project_path = {
                let state = app.state::<AppState>();
                pty::registry_get_project_path(&state.registry)
            };
            event_log::set_active_project_path(Some(PathBuf::from(initial_project_path)));

            let registry = app.state::<AppState>().registry.clone();
            let bridge_url = match bridge::start_embedded_bridge(
                registry,
                app.handle().clone(),
                port_file,
                pairing_file,
            ) {
                Ok(handle) => {
                    tracing::info!(url = %handle.url, "embedded bridge started");
                    Some(handle.url)
                }
                Err(err) => {
                    tracing::warn!(%err, "embedded bridge not started — external MCP unavailable");
                    None
                }
            };

            push::init(app.state::<AppState>().registry.clone());

            // Chat conversations that were live come back, lazily: no adapter starts until one is used.
            {
                let state = app.state::<AppState>();
                let report = commands::acp_restore_at_start(app.handle(), &state);
                tracing::info!(restored = report.restored.len(), in_terminal = report.in_terminal.len(), failed = report.failed.len(), "acp: conversations restored");
            }

            // Text your agents: starts only if the person turned Telegram on before.
            channels::start(app.handle().clone(), app.state::<AppState>().registry.clone());
            discord_alerts::init();

            #[cfg(debug_assertions)]
            let _ = &bridge_url;

            #[cfg(not(debug_assertions))]
            {
                if let Some(url) = bridge_url {
                    if let Err(err) = mobile_tunnel::start_mobile_tunnel(app.handle(), url) {
                        tracing::warn!(%err, "mobile tunnel not started");
                    }
                }
            }

            app.handle().listen("terminal-data", move |event| {
                let payload = event.payload();
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                    let pane_id = value.get("pane_id").and_then(|v| v.as_str()).unwrap_or("");
                    let data = value.get("data").and_then(|v| v.as_array());
                    if !pane_id.is_empty() {
                        if let Some(bytes) = data {
                            let raw: Vec<u8> = bytes
                                .iter()
                                .filter_map(|v| v.as_u64().map(|n| n as u8))
                                .collect();
                            let offset = value.get("offset").and_then(|v| v.as_u64());
                            bridge::push_terminal_sse(pane_id, &raw, offset);
                        }
                    }
                }
            });

            let registry_for_panes = app.state::<AppState>().registry.clone();
            pane_windows::init(app.handle(), registry_for_panes.clone());
            secrets::migrate_on_startup();
            // What broke it: remove test copies an earlier run left behind (SPEC n33 section 3.4).
            #[cfg(not(test))]
            checkpoints::bisect::live::live().sweep_stale();
            settings_store::load_saved_public_settings(app.handle());
            agent_run_mode::migrate_legacy_defaults_once(app.handle());
            // With the Labs switch on (known now), each conversation that came back is a chat pane in the pane list.
            // Nothing starts yet: the adapter starts when the chat is read or a message is sent.
            if acp::chat_enabled() {
                let state = app.state::<AppState>();
                let deps = commands::acp_chat::live_deps(app.handle(), &state.registry);
                let panes = acp::chat::restore_panes(&deps);
                tracing::info!(panes = panes.len(), "acp: chat panes restored");
            }
            ui_mode::load_saved();
            // A standalone worker host (`--worker`) is a user-launched single-terminal window with
            // its own webview, and opens nothing else.
            let worker = worker_launch::worker_launch().is_some();
            if worker {
                app_windows::open_worker_host_window(app.handle());
            }
            if let Err(e) = tray::init(app.handle()) {
                tracing::warn!(error = %e, "tray icon failed to start");
            }
            // A normal start opens the primary window (same as a tray click: always the cockpit, in
            // either UI mode; Individual mode still puts Settings in its own window). A sign-in start,
            // a worker host and a headless start (`--no-window` / `POTATO_WORKSPACE_NO_WINDOW`) leave only
            // the tray.
            let args = std::env::args().collect::<Vec<_>>();
            let no_window_env = std::env::var(cockpit::NO_WINDOW_ENV).ok();
            if cockpit::startup_window(&args, worker, no_window_env.as_deref()) {
                cockpit::open_startup_windows(app.handle());
            } else {
                tracing::info!(worker, "started without a window: tray only");
            }
            ambient::init(app.handle());
            standby::init(registry_for_panes.clone(), app.handle().clone());
            acp::warm::init(registry_for_panes.clone());
            canary::init(app.handle().clone());
            // The Agent Wizard's panes (guided capture, visible test) go through the app's pane registry. The
            // host is installed here, not referenced from the wizard module, so the Tauri window code stays out
            // of the unit-test executables.
            tui::declarative::wizard::visible::host::install(std::sync::Arc::new(
                tui::declarative::wizard::visible::registry_host::RegistryHost::new(registry_for_panes.clone(), app.handle().clone()),
            ));
            pane_activity::init(registry_for_panes.clone(), app.handle().clone());
            loop_guard::init(app.handle().clone());
            global_shortcuts::load_overrides();
            panic::init_shortcut(app.handle());
            mini_bar::init_mode_shortcut(app.handle());
            turn_summary::start_presence();
            attention::init();
            askbar::glue::init(app.handle());
            // The mode-switch overlay is built hidden now and reused, so the first switch has no startup lag.
            switch_anim::glue::init(app.handle());
            team::init(app.handle().clone(), registry_for_panes.clone());
            // Share an agent keeps only the handle here; nothing is built until its Labs switch is on.
            capacity_proxy::init(app.handle().clone());
            issue_intake::live::start(registry_for_panes.clone(), app.handle().clone());
            ci_fix::live::start(registry_for_panes.clone(), app.handle().clone());
            companion::live::start(app.handle().clone(), registry_for_panes.clone());
            // A room a crash left on the relay is ended now (its own thread: it may wait for the network).
            live_room::service::cleanup_at_boot(app_paths::app_data_dir());
            app.handle().listen("pty://panes-changed", move |_event| {
                bridge::push_panes_sse(&registry_for_panes);
            });

            app.handle().listen("pty://status", |event| {
                let payload = event.payload();
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) {
                    let pane_id = value.get("pane_id").and_then(|v| v.as_str()).unwrap_or("");
                    let status = value.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    if !pane_id.is_empty() && !status.is_empty() {
                        bridge::push_pane_status_sse(pane_id, status);
                    }
                }
            });

            // Desktop Potato: builds its window only if the Labs switch is on (nothing happens otherwise).
            pet::init(app.handle());
            startup_timing::mark("app", "app_setup_done");
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Closing the last window (cockpit, a pane, Settings) must not end the app: it stays in the tray.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                crash::record_exit(&app_paths::app_data_dir(), *code, "ExitRequested");
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } = &event {
                if app_windows::on_close_requested(app_handle, label) {
                    api.prevent_close();
                }
                if pane_windows::on_close_requested(app_handle, label) {
                    api.prevent_close();
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                // From here on panes go because the app ends: chats stop but stay restorable.
                acp::chat::begin_app_shutdown();
                crash::record_exit(&app_paths::app_data_dir(), None, "Exit");
                // The link ends with the app: best effort, the relay's time limit ends it otherwise.
                if let Some(room) = app_handle.try_state::<live_room::service::LiveRoomState>() {
                    room.stop_all(live_room::publisher::StopReason::AppQuit);
                }
                standby::shutdown();
                acp::warm::shutdown();
                // The computer may sleep again: a Night Shift hold must not outlive the app.
                night_shift::power::release_all();
                if let Some(chat) = app_handle.try_state::<commands::SessionChatState>() {
                    chat.shutdown();
                }
                bridge::port_file::release_owned(&app_paths::bridge_port_file());
                if let Some(state) = app_handle.try_state::<AppState>() {
                    // The process ends right after this: wait for every tree to be stopped.
                    pty::registry_kill_all_and_wait(&state.registry);
                }
            }
        });
}
