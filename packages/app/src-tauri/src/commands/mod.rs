//! Tauri command surface — thin wrappers around the PTY registry.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

mod acp_conversations;
mod acp_install;
mod agent_caps;
mod agent_install;
mod agent_store;
mod agent_wizard;
mod agent_models;
mod agents;
mod ambient;
mod askbar;
mod side_question;
mod canary;
mod app;
mod app_update;
pub(crate) mod update_plan;
mod disk_space;
pub(crate) mod update_channel;
mod checkpoints;
mod timeline;
mod companion;
mod tamper;
mod missions;
mod turn_summary;
mod budgets;
mod project_budget;
mod cockpit;
mod discord_alerts;
mod discord_bot;
mod notify_levels;
mod terminal_chat_prompt;
mod jobs;
mod coordination;
mod diagnostics;
mod ui_log;
mod loop_guard;
mod attention;
pub(crate) mod attachments;
pub(crate) mod handoff_file;
mod mcp;
mod one_brain;
mod opencode_keys;
mod pane_close;
mod pane_outbox;
mod pane_git;
mod panes;
mod secrets;
mod accounts;
mod agent_authority;
mod agent_rules;
pub mod acp_chat;
mod acp_lane;
mod acp_overlay;
mod acp_adapter_keys;
mod acp_remove;
mod agent_run_mode;
mod questions;
mod standby;
mod standby_helpers;
mod worktrees;
mod first_run;
mod crews;
mod crews_canvas;
mod crews_talk;
mod plain_mode;
mod plans;
mod usage;
mod scores;
mod second_opinion;
mod session_chat;
mod chat_signin;
mod chat_more;
mod chat_index_settings;
mod chat_import;
mod import_orca;
mod chat_export;
mod chat_move;
mod helper_adopt;
mod keep_going;
mod branch_from;
mod tunnel;
mod desk_away;
mod pane_remote;
mod toolbelt;
mod agent_pack;
pub(crate) mod point;
mod browser_check;
mod channels;
mod live_room;
mod devices;
mod account;
mod lend;
mod model_bridge;
pub(crate) mod night;
mod routines;
mod issue_intake;
mod package_check;
mod review_desk;
mod wsl;
mod wsl_upgrade;
mod ssh;
mod what_broke_it;
mod ci_fix;
mod collision;
mod editor;
mod files_view;
mod files_stream;
mod artifacts_view;
mod markup;
mod tab_windows;
mod project_guide;
mod add_agent;
mod agents_detect;
pub(crate) mod path_kind;

pub use acp_conversations::*;
pub use acp_install::*;
pub use app_update::*;
pub use disk_space::*;
pub use agent_install::*;
pub use agent_store::*;
pub use agent_caps::*;
pub use agents_detect::*;
pub use agent_wizard::*;
pub use agent_models::*;
pub use attention::*;
pub use agents::*;
pub use ambient::*;
pub use askbar::*;
pub use side_question::*;
pub use canary::*;
pub use app::*;
pub use checkpoints::*;
pub use timeline::*;
pub use companion::*;
pub use tamper::*;
pub use missions::*;
pub use turn_summary::*;
pub use budgets::*;
pub use project_budget::*;
pub use cockpit::*;
pub use discord_alerts::*;
pub use discord_bot::*;
pub use notify_levels::*;
pub use terminal_chat_prompt::*;
pub use jobs::*;
pub use coordination::*;
pub use diagnostics::*;
pub use ui_log::*;
pub use loop_guard::*;
pub use mcp::*;
pub use one_brain::*;
pub use opencode_keys::*;
pub use pane_close::*;
pub use pane_git::*;
pub use panes::*;
pub use secrets::*;
pub use accounts::*;
pub use agent_authority::*;
pub use agent_rules::*;
pub use acp_chat::*;
pub use acp_lane::*;
pub use acp_overlay::*;
pub use acp_adapter_keys::*;
pub use acp_remove::*;
pub use agent_run_mode::*;
pub use questions::*;
pub use standby::*;
pub use standby_helpers::*;
pub use worktrees::*;
pub use first_run::*;
pub use crews::*;
pub use crews_canvas::*;
pub use crews_talk::*;
pub use plain_mode::*;
pub use plans::*;
pub use usage::*;
pub use scores::*;
pub use second_opinion::*;
pub use pane_outbox::*;
pub use session_chat::*;
pub use chat_index_settings::*;
pub use chat_more::*;
pub use chat_signin::*;
pub use chat_import::*;
pub use import_orca::*;
pub use chat_export::*;
pub use chat_move::*;
pub use helper_adopt::*;
pub use keep_going::*;
pub use branch_from::*;
pub use tunnel::*;
pub use desk_away::*;
pub use pane_remote::*;
pub use toolbelt::*;
pub use agent_pack::*;
mod pet;
pub use pet::*;
pub use point::*;
pub use browser_check::*;
pub use channels::*;
pub use live_room::*;
pub use devices::*;
pub use account::*;
pub use lend::*;
pub use model_bridge::*;
pub use what_broke_it::*;
pub use night::*;
pub use routines::*;
pub use issue_intake::*;
pub use package_check::*;
pub use review_desk::*;
pub use wsl::*;
pub use wsl_upgrade::*;
pub use ssh::*;
pub use ci_fix::*;
pub use editor::*;
pub use files_view::*;
pub use files_stream::*;
pub use artifacts_view::*;
pub use markup::*;
pub use tab_windows::*;
pub use project_guide::*;
pub use collision::*;
pub use add_agent::*;

use crate::pty::agents::AgentType;
use crate::pty::{
    registry_get_project_path, registry_kill_all, registry_kill_pane_and_helpers, registry_read_buffer,
    registry_read_raw_buffer, registry_read_screen_replay_at, registry_read_snapshot, registry_resize, registry_set_project_path,
    registry_spawn_pane, registry_write_input, PaneInfo, PaneRegistry, SpawnPaneArgs,
};
use crate::settings_store;

#[derive(Default)]
pub struct AppState {
    pub registry: Arc<Mutex<PaneRegistry>>,
    pub public_settings: Mutex<Value>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Mutex::new(PaneRegistry::new())),
            public_settings: Mutex::new(settings_store::default_public_settings()),
        }
    }
}

fn developer_use_rust_mcp(state: &State<'_, AppState>) -> bool {
    state
        .public_settings
        .lock()
        .get("developer_use_rust_mcp")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}
