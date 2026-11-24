#![recursion_limit = "512"]
mod test_manifest;

mod account;
mod accounts;
mod acp;
use pm_core::actors;
mod agent_authority;
mod agent_terminals;
pub use pm_core::agent_rules;
mod agent_run_mode;
mod audit;
mod ambient;
pub use pm_core::agent_adapters;
mod agent_contexts;
pub mod agent_runs;
mod agent_health;
mod agent_install;
mod agent_store;
mod agent_caps;
pub mod agent_hooks;
pub mod app_lifecycle;
mod autostart;
pub use pm_core::app_paths;
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
use pm_core::git_exclude;
mod handoff;
mod handover;
mod task_sidebar;
mod issue_intake;
mod routines;
mod ci_fix;
use pm_core::events;
mod mcp_hints;
mod mcp_install;
mod mcp_drift;
mod mcp_runtime;
mod pane_mcp;
pub mod mcp_sessions;
mod mcp_status;
mod missions;
mod mobile_pairing;
mod mobile_tunnel;
pub mod night_shift;
mod tunnel_config;
mod domain_book;
mod own_domain;
mod phone_port;
mod worker_origins;
pub use pm_core::tools_home;
mod uninstall;
mod one_brain;
mod companion;
mod config_plan;
mod crews;
mod discord_alerts;
mod discord_bot;
mod opencode;
pub mod operations;
pub use pm_core::wait_reasons;
#[cfg(test)]
mod sleep_budget_tests;
#[cfg(test)]
mod operations_contract_tests;
mod pane_activity;
mod pane_jobs;
mod pane_preview;
mod point;
mod markup;
// The agent browser (Labs `agent_browser_enabled`): agents read and click pages on this computer.
pub mod browser;
mod loop_guard;
mod panic;
mod askbar;
mod hidden_runs;
mod side_question;
use pm_core::attach;
mod attention;
mod second_opinion;
pub use pm_core::pane_outbox;
mod pane_prompt;
mod first_run;
mod plain_mode;
mod plans_report;
mod usage;
mod prompt_risk;
mod package_check;
pub use pm_core::questions;
#[cfg(test)]
mod questions_router_tests;
mod push;
pub mod redact;
#[cfg(test)]
mod redact_sink_tests;
mod redact_sources;
mod flight;
use pm_core::secure_file;
mod app_windows;
mod cockpit;
mod mini_bar;
mod switch_anim;
mod window_layout;
mod ui_mode;
mod pane_windows;
mod deep_link;
mod desktop_toast;
mod tray;
mod pane_wait;
mod phone_log;
use pm_core::pane_wait_notify;
pub use pm_core::platform;
pub mod redirection_trust;
mod project_ir;
#[cfg(windows)]
pub use pm_core::proc_job;
pub use pm_core::proc_util;
#[cfg(test)]
mod proc_util_guard;
pub use pm_core::path_limit;
mod project_path;
mod project_location;
pub use pm_core::project_budget;
mod projections;
pub use pm_core::pty;
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
use pm_core::session_context;
pub use pm_core::chat_index;
mod chat_move;
mod import_orca;
pub use pm_core::session_chat;
mod scores;
use pm_core::secrets;
mod settings_store;
mod show_terminals;
mod settings_patch;
mod settings_safety;
mod global_shortcuts;
pub use pm_core::shell_env;
mod startup_chores;
use pm_core::startup_timing;
mod startup_trace;
mod review_desk;
mod spaces;
use pm_core::secure_core;
mod tauri_host;
mod engine_hooks;
#[cfg(test)]
mod pty_app_tests;
mod wizard_registry_host;
mod wizard_ladder;
#[cfg(test)]
mod wizard_ladder_tests;
mod tamper;
pub mod shell_exec;
mod standby;
mod team;
use pm_core::keys;
use pm_core::p2p;
// Devices: pair another PC and run agents on it (Labs `devices_enabled`).
use pm_core::device_identity;
mod agent_dispatch;
mod own_lend;
mod device_link;
mod terminal_chat;
pub mod tool_registry;
mod toolbelt;
mod agent_pack;
mod timeline;
pub use pm_core::tui;
pub mod turn_summary;
mod worker_launch;
pub mod worktrees;
pub mod watch_command;
pub use pm_core::env_probe;
mod webview_service_worker;
mod live_room;
mod model_bridge;
// Share an agent: Lend through my PC (Labs `lend_enabled`).
mod capacity_proxy;
mod keep_awake;
pub use pm_core::wsl;
mod ssh;
mod collision;
mod notify_levels;
mod artifacts;
mod project_guide;
use pm_core::files;
// Open in my editor (desk review).
mod editor;
// Desktop Potato (Labs `desktop_pet_enabled`): a small pet window. Reserved lines at the end.
mod pet;
#[cfg(test)]
mod conformance_suite;
#[cfg(test)]
use pm_core::test_support;

use commands::AppState;
use std::path::{Path, PathBuf};
use tauri::{Listener, Manager};

/// Command-line modes of the app executable that run without a window (`acp-bridge --agent <id>`: a chat
/// adapter for an agent that has no ACP). `Some(exit code)` when one ran; `main` exits with it. `None`:
/// start the app as usual.
pub fn run_cli_subcommand() -> Option<i32> {
    redact_sources::install();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some(uninstall::HELPER_FLAG) {
        return uninstall::helper::run_cli(&args);
    }
    acp::bridge::run_cli(&args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    redact_sources::install(); // before anything is masked: pm-core cannot list the app's own secrets
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
        // After single-instance (its `deep-link` feature hands a link opened while we run to this plugin).
        .plugin(tauri_plugin_deep_link::init())
        .plugin(autostart::plugin())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .manage(deep_link::PendingJoinLink::default())
        .register_asynchronous_uri_scheme_protocol("pmfile", commands::files_stream_protocol)
        .register_asynchronous_uri_scheme_protocol("pmfar", device_link::far_preview::serve)
        .register_asynchronous_uri_scheme_protocol("potato-artifact", commands::artifact_serve_protocol)
        .register_asynchronous_uri_scheme_protocol("potato-start", commands::start_page_protocol)
        .manage(commands::SessionChatState::default())
        .manage(live_room::service::LiveRoomState::default())
        .manage(commands::ChatImportState::default())
        .invoke_handler(device_link::far_preview::guarded(tauri::generate_handler![
            deep_link::take_pending_join_link,
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
            commands::chat_signin_start,
            commands::chat_signin_status,
            commands::chat_signin_stop,
            commands::agent_signin_start,
            commands::agent_signin_status,
            commands::agent_login_states,
            commands::agent_signin_stop,
            commands::chat_earlier,
            commands::chat_picture,
            commands::chat_draft_get,
            commands::chat_draft_set,
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
            commands::pane_set_helper_of,
            commands::task_sidebar_get,
            commands::task_sidebar_show,
            commands::task_sidebar_place,
            commands::task_sidebar_remove,
            commands::task_sidebar_reorder,
            commands::task_hand_over,
            commands::task_hand_over_cancel,
            commands::chat_move_status,
            commands::chat_move_begin,
            commands::chat_move_history,
            commands::chat_move_prepare_work,
            commands::chat_move_finish,
            commands::chat_move_abort,
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
            commands::account_state,
            commands::account_sign_in,
            commands::account_cancel_sign_in,
            commands::account_devices,
            commands::account_revoke_device,
            commands::account_approve_device,
            commands::account_sign_out_here,
            commands::devices_state,
            commands::devices_show_code,
            commands::devices_cancel_code,
            commands::devices_join,
            commands::devices_pair_answer,
            commands::devices_pair_pick,
            commands::devices_account_pcs,
            commands::devices_set_open_from_account,
            commands::devices_dismiss_removed_pc,
            commands::devices_open_account_pc,
            commands::devices_rename,
            commands::devices_set_permission,
            commands::devices_account_default_answer,
            commands::devices_remove,
            commands::devices_full_asks,
            commands::devices_full_ask_answer,
            commands::devices_set_route,
            commands::devices_make_link,
            commands::devices_join_link,
            commands::devices_activity,
            commands::devices_set_web,
            commands::devices_set_pcdoor,
            commands::devices_set_agents_send,
            commands::devices_set_lend,
            commands::devices_set_device_route,
            commands::devices_disconnect,
            commands::devices_request,
            commands::devices_chat_export,
            commands::devices_subscribe,
            commands::devices_unsubscribe,
            commands::devices_set_files,
            commands::far_preview_open,
            commands::devices_files_folders,
            commands::devices_files_set_folders,
            commands::devices_files_roots,
            commands::devices_files_list,
            commands::devices_files_preview,
            commands::devices_files_copy,
            commands::devices_files_send,
            commands::devices_transfer_cancel,
            commands::devices_transfers_clear,
            commands::lend_state,
            commands::lend_test_link,
            commands::lend_recheck_lent,
            commands::lend_profile_save,
            commands::lend_profile_delete,
            commands::lend_key_set,
            commands::lend_account_add,
            commands::lend_signin_start,
            commands::lend_signin_status,
            commands::lend_signin_stop,
            commands::lend_request,
            commands::lend_request_own,
            commands::lend_far_offer,
            commands::lend_far_note_pane,
            commands::lend_far_renew,
            commands::own_borrow_ask,
            commands::own_borrow_plan,
            commands::lend_offers,
            commands::lend_answer,
            commands::lend_revoke,
            commands::lend_return,
            commands::lend_grant_dismiss,
            commands::lend_past_clear,
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
            commands::attachments::attachment_read_local,
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
            commands::browser_check_enabled,
            commands::browser_check_it,
            commands::browser_open_window,
            commands::point_state,
            commands::point_arm,
            commands::point_remove_pick,
            commands::point_compose,
            commands::point_send,
            commands::point_edit_in_chat,
            commands::point_take_draft,
            commands::point_discard,
            commands::point_recheck_run,
            commands::point_recheck_dismiss,
            commands::point_box_hide,
            commands::point_open_blocked_link,
            team::commands::team_state,
            team::commands::team_config_get,
            team::commands::team_ping,
            team::commands::team_presence_report,
            team::commands::team_share_set,
            team::shelf::commands::shelf_state,
            team::shelf::commands::shelf_suggest,
            team::shelf::commands::shelf_preview,
            team::shelf::commands::shelf_add,
            team::shelf::commands::shelf_undo,
            team::shelf::commands::shelf_dismiss,
            team::commands::team_default_name,
            team::commands::team_config_set,
            team::commands::team_reconnect,
            team::commands::team_move_relay,
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
            team::commands::team_invite_lookup,
            team::commands::team_invite_accept,
            team::commands::worker_check,
            team::worker_update::worker_update_step,
            team::worker_update::worker_update_cancel,
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
            team::direct::commands::team_tasks_state,
            team::direct::commands::team_task_pass,
            team::direct::commands::team_task_withdraw,
            team::direct::commands::team_task_seen,
            team::direct::commands::team_task_accept,
            team::direct::commands::team_task_decline,
            team::direct::commands::team_task_started,
            team::direct::commands::team_task_done,
            team::direct::commands::team_task_unpack,
            team::direct::commands::team_tasks_handover_set,
            team::direct::commands::team_task_repo_check,
            commands::spawn_pane,
            commands::wsl_status,
            commands::wsl_check,
            commands::wsl_places_get,
            commands::wsl_place_set,
            commands::wsl_upgrade,
            commands::spawn_pane_in_linux,
            commands::ssh_hosts,
            commands::ssh_check,
            commands::ssh_add,
            commands::ssh_check_saved,
            commands::ssh_setup,
            commands::ssh_update,
            commands::ssh_remove,
            commands::ssh_open,
            commands::ssh_chat_start,
            commands::ssh_remote_panes,
            commands::ssh_fs_list,
            commands::ssh_fs_read,
            commands::ssh_git_status,
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
            commands::pane_jobs_finished,
            commands::agent_terminal_stop,
            commands::agent_terminal_output,
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
            commands::mcp_tools_drift,
            commands::mcp_reconnect,
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
            browser::dock::dock_browser_rect,
            browser::dock::dock_browser_snapshot,
            browser::dock::dock_browser_freeze,
            browser::dock::dock_browser_tabs,
            browser::dock::dock_browser_nav,
            browser::dock::dock_browser_mark_up,
            browser::dock::dock_browser_select,
            browser::dock::dock_browser_close,
            browser::dock::dock_browser_new_tab,
            browser::dock::dock_browser_popout,
            browser::dock::dock_browser_dockback,
            commands::create_mobile_pairing_session,
            commands::list_paired_mobile_devices,
            commands::phone_activity_list,
            commands::phone_activity_clear,
            commands::revoke_paired_mobile_device,
            commands::rename_paired_mobile_device,
            commands::device_names,
            commands::set_paired_mobile_device_caps,
            commands::bridge_local_secret,
            commands::bridge_local_secret_status,
            commands::get_mobile_tunnel_info,
            commands::profile_bridge_url,
            commands::get_tunnel_status,
            commands::set_link_temporary,
            commands::set_link_mode,
            commands::check_own_domain,
            commands::domain_book_files,
            commands::set_phone_port,
            commands::set_tunnel_config,
            commands::restart_tunnel,
            commands::test_tunnel_connection,
            commands::enable_opentunnel,
            commands::disable_opentunnel,
            commands::forget_opentunnel_address,
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
            commands::tools_status,
            commands::tools_repair,
            commands::get_worker_launch,
            commands::exit_app,
            commands::get_opencode_key_status,
            commands::secret_storage_info,
            commands::secret_set,
            commands::secret_get_masked,
            commands::secret_delete,
            commands::secret_found_on_pc,
            commands::secret_use_found,
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
            commands::accounts_sign_out,
            commands::accounts_set_helper_login,
            commands::standby_get_status,
            commands::standby_set_config,
            commands::standby_set_current_project,
            commands::standby_helpers_get,
            commands::standby_helper_add,
            commands::standby_helper_update,
            commands::standby_helper_remove,
            commands::standby_helper_detach,
            commands::standby_helper_open,
            commands::standby_helper_take_back,
            commands::standby_helper_start,
            commands::standby_helpers_set_limits,
            commands::standby_helpers_set_never_close,
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
            commands::timeline_day,
            commands::timeline_point_diff,
            commands::timeline_now_diff,
            commands::timeline_file_patch,
            commands::timeline_go_back,
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
            commands::project_budget_limits,
            commands::project_budget_set,
            commands::project_budget_status,
            commands::project_budget_raise,
            commands::right_size_pending,
            commands::right_size_switch,
            commands::right_size_dismiss,
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
            commands::routines_view,
            commands::routines_agents,
            commands::routines_create,
            commands::routines_set_enabled,
            commands::routines_delete,
            commands::routines_run_now,
            commands::routines_stop_run,
            commands::routines_set_limit,
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
            commands::crews_templates,
            commands::crews_open,
            commands::crews_check,
            commands::crews_save_canvas,
            commands::crews_try_task,
            commands::crews_apply,
            commands::crews_follow,
            commands::crews_export_file,
            commands::crews_import_read,
            commands::crews_talk,
            commands::crews_start,
            commands::workflows_list,
            commands::workflows_hidden_count,
            commands::workflows_plan,
            commands::workflows_start_helpers,
            commands::crew_marks_sync,
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
            commands::discord_bot_status,
            commands::discord_bot_set_token,
            commands::discord_bot_clear,
            commands::discord_bot_save_settings,
            commands::discord_bot_test,
            commands::acp_chat_start,
            commands::acp_chat_cancel,
            commands::acp_chat_take_back,
            commands::acp_chat_keep_waiting,
            commands::acp_chat_state,
            commands::acp_chat_warm,
            commands::acp_chat_set_config,
            commands::acp_chat_set_agent_answering,
            commands::acp_chat_set_force_yes,
            commands::agent_rules_overview,
            commands::agent_rules_effective,
            commands::agent_rules_set_force_yes_agent,
            commands::agent_rules_fences,
            commands::agent_rules_fence_add,
            commands::agent_rules_fence_remove,
            commands::agent_rules_pin_get,
            commands::agent_rules_pin_set,
            commands::pane_set_force_yes,
            commands::pane_force_yes,
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
            commands::acp_chat_copy,
            commands::acp_chat_copy_keep,
            commands::acp_chat_copy_discard,
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
            commands::agent_default_models,
            commands::agent_run_mode_set,
            commands::helper_visibility_get,
            commands::helper_visibility_set,
            commands::started_agents_get,
            commands::started_agents_set,
            commands::keep_helpers_open_get,
            commands::keep_helpers_open_set,
            commands::close_helpers_with_agent_get,
            commands::close_helpers_with_agent_set,
            commands::most_helpers_at_once_get,
            commands::most_helpers_at_once_set,
            commands::stall_minutes_get,
            commands::stall_minutes_set,
            commands::stalls_list,
            commands::stall_nudge,
            commands::stall_stop,
            commands::stall_respawn,
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
            commands::companion_set_default,
            commands::companion_delete,
            commands::companion_wake,
            commands::companion_sleep,
            commands::companion_restart,
            commands::companion_rehome,
            commands::companion_memory_get,
            commands::companion_journal,
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
            commands::get_desk_away,
            commands::start_desk_away,
            commands::end_desk_away,
            commands::get_pane_remote,
            commands::set_pane_remote,
            commands::notify_prefs_get,
            commands::notify_bell_set,
            commands::notify_quiet_set,
            commands::notify_pc_set,
            commands::notify_snooze,
            commands::notify_prefs_import,
            commands::path_kind::path_kinds,
            commands::files_list,
            commands::files_search_contents,
            commands::files_search_cancel,
            commands::artifacts_sync,
            commands::artifacts_read,
            commands::guide_state,
            commands::guide_estimate,
            commands::guide_start,
            commands::guide_stop,
            commands::guide_read_page,
            commands::guide_read_diagram,
            commands::guide_delete,
            commands::guide_video_state,
            commands::guide_video_start,
            commands::guide_video_stop,
            commands::guide_video_show,
            commands::artifacts_open_in_browser,
            commands::artifacts_share_make,
            commands::artifacts_share_list,
            commands::artifacts_share_stop,
            commands::artifacts_pop_out,
            commands::artifacts_open_in_agent_browser,
            commands::markup_capture,
            commands::markup_send,
            commands::markup_targets,
            commands::markup_less_motion,
            commands::tab_window_open,
            commands::tab_window_put_back,
            commands::files_read,
            commands::files_marks,
            commands::files_reveal,
            commands::files_diff,
            commands::files_read_bytes,
            commands::files_open_bytes,
            commands::files_write,
            commands::files_open_default,
            commands::list_control_asks,
            commands::answer_control_ask,
            commands::pet_set_expanded,
            commands::pet_start_drag,
            commands::pet_move_by,
            commands::pet_fullscreen_busy,
            commands::disk_space,
            // Desk review: file-by-file review, Put back, Open in my editor.
            commands::checkpoint_turn_review,
            commands::checkpoint_put_back,
            commands::checkpoint_file_patch,
            commands::editors_found,
            commands::open_in_editor,
        ]))
        .setup(|app| {
            startup_trace::mark("setup_begin");
            // The engine's seam to this app: window events and the runtime (`pm_core::host`) and the app's answers (`pm_core::hooks`). First of all, so no
            // pane started later in setup runs without them.
            tauri_host::install(app.handle().clone());
            engine_hooks::install();
            deep_link::setup(app.handle());
            desktop_toast::init(app.handle());
            commands::startup_probe(app.handle().clone());
            tools_home::tidy_on_start();
            // The window hears when an agent's capability table changes (agent-caps://changed).
            {
                use tauri::Emitter;
                let handle = app.handle().clone();
                agent_caps::set_notifier(move |agent_id| {
                    let _ = handle.emit("agent-caps://changed", serde_json::json!({ "agent_id": agent_id }));
                });
            }
            // Agents keep working when the PC is locked: hold it awake while any pane is busy.
            keep_awake::spawn(app.state::<AppState>().registry.clone());
            agent_runs::stall::spawn(app.state::<AppState>().registry.clone(), app.handle().clone());
            // Copy (never move) the data release 1.0.3 left under the old names once: the home and
            // companion folders, and the paired phones / tunnel / push files in the app data folder.
            // The old files stay untouched and nothing already saved under the new names is overwritten.
            app_paths::migrate_legacy_home_data();
            app_paths::migrate_legacy_app_data();
            startup_trace::mark("legacy_migrations");
            // First, so a panic anywhere below leaves a file behind (the console and the in-memory
            // log tail die with the process).
            flight::lastrun::check_at_start(&app_paths::app_data_dir());
            crash::install(app_paths::app_data_dir());
            startup_trace::mark("crash_handler");
            // Terminal agents die with the app (job object); anything a crashed run left behind is ended now.
            pty::term_job::init();
            pty::orphans::init(&app_paths::app_data_dir());
            startup_trace::mark("pty_cleanup");
            // Before the first window: an older version's desktop service worker would serve its UI.
            webview_service_worker::remove_at_startup(app.path().app_local_data_dir().ok());
            // Register approved declarative agent definitions before anything resolves a profile.
            tui::declarative::loader::reload();
            bridge::start_definitions_watcher(app.handle().clone());
            startup_trace::mark("agent_definitions");
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
            if mcp_runtime::bundled_mcp_binary().is_none() && !cfg!(debug_assertions) {
                // An installed (release) copy: the program next to the app, before any dev location.
                if let Some(installed) = mcp_runtime::installed_mcp_binary(exe_dir.as_deref()) {
                    mcp_runtime::set_bundled_mcp_binary(installed);
                }
            }
            if mcp_runtime::bundled_mcp_binary().is_none() {
                // A dev build has no installed resource folder: look where the binary is built or
                // staged (the package's dist, the staged `resources/bin`, next to the running exe).
                // An installed copy ships the one next to the app only, and is found by the last of these.
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

            startup_trace::mark("mcp_resources");
            mcp_install::refresh_on_start();
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

            startup_trace::mark("bridge");
            push::init(app.state::<AppState>().registry.clone());

            // Chat conversations that were live come back, lazily: no adapter starts until one is used.
            {
                let state = app.state::<AppState>();
                let report = commands::acp_restore_at_start(app.handle(), &state);
                tracing::info!(restored = report.restored.len(), in_terminal = report.in_terminal.len(), failed = report.failed.len(), "acp: conversations restored");
            }

            startup_trace::mark("acp_restore");

            // Telegram, Discord alerts, the phone tunnel, the stale-copy sweep and the agent version check are
            // not needed for the first screen: they run on one background thread once the window is open.
            let chores = startup_chores::chores_for_setup(
                app.handle().clone(),
                app.state::<AppState>().registry.clone(),
                bridge_url,
            );

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
            opencode::keys::migrate_profiles_to_secret_store();
            toolbelt::store::migrate_on_startup();
            startup_trace::mark("pane_windows_secrets");
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
            startup_trace::mark("settings_ui_mode");
            // A standalone worker host (`--worker`) is a user-launched single-terminal window with
            // its own webview, and opens nothing else.
            let worker = worker_launch::worker_launch().is_some();
            if worker {
                app_windows::open_worker_host_window(app.handle());
            }
            // A normal start opens the primary window (same as a tray click: always the cockpit, in
            // either UI mode; Individual mode still puts Settings in its own window). A sign-in start,
            // a worker host and a headless start (`--no-window` / `POTATO_WORKSPACE_NO_WINDOW`) leave only
            // the tray.
            let args = std::env::args().collect::<Vec<_>>();
            let no_window_env = std::env::var(cockpit::NO_WINDOW_ENV).ok();
            // The window first, then the tray (built on this thread right after: it can be slow), then the
            // chores (one background thread, in order).
            let open_window = || {
                if cockpit::startup_window(&args, worker, no_window_env.as_deref()) {
                    cockpit::open_startup_windows(app.handle());
                } else {
                    tracing::info!(worker, "started without a window: tray only");
                }
                startup_trace::mark("window_open");
                tray::init_after_window(app.handle());
            };
            let chore_log_dir = app_paths::app_data_dir();
            startup_chores::open_then_run(
                open_window,
                chores,
                |name, ms| tracing::info!("startup_chore name={name} ms={ms}"),
                move || {
                    startup_trace::mark("chores_done");
                    startup_trace::finish(&chore_log_dir);
                },
            );
            ambient::init(app.handle());
            standby::init(registry_for_panes.clone(), app.handle().clone());
            acp::warm::init(registry_for_panes.clone());
            canary::init(app.handle().clone());
            // The Agent Wizard's panes (guided capture, visible test) go through the app's pane registry. The
            // host is installed here, not referenced from the wizard module, so the Tauri window code stays out
            // of the unit-test executables.
            tui::declarative::wizard::visible::host::install(std::sync::Arc::new(
                wizard_registry_host::RegistryHost::new(registry_for_panes.clone(), app.handle().clone()),
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
            team::direct::init(app.handle().clone());
            device_link::app::init(app.handle().clone());
            issue_intake::live::start(registry_for_panes.clone(), app.handle().clone());
            ci_fix::live::start(registry_for_panes.clone(), app.handle().clone());
            routines::live::start(registry_for_panes.clone(), app.handle().clone());
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
            startup_trace::mark("setup_done");
            startup_trace::finish(&app_paths::app_data_dir());
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
                device_link::app::shutdown();
                // The tunnel program (cloudflared) is this app's own child: stop it so none is left behind.
                mobile_tunnel::stop_for_uninstall();
                standby::shutdown();
                // A lend sign-in's hidden pane (the sign-in step of a lend profile) ends with the app.
                capacity_proxy::signin_pane::app_panes().stop_all();
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
