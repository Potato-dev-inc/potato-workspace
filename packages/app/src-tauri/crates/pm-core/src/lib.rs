//! The window-free core of Potato Workspace: data paths, the secret store, keys, the device identity and the PC link
//! (`p2p`). Nothing here names Tauri, so a screen-less host program can link it. The app re-exports each module
//! under its old name (`crate::p2p`, `crate::keys`, ...).

pub mod app_paths;
pub mod device_identity;
pub mod device_link;
pub mod host;
#[allow(dead_code)]
pub mod keys;
#[allow(dead_code)]
pub mod p2p;
pub mod secrets;
#[cfg(target_os = "linux")]
mod secrets_file;
pub mod secure_core;
pub mod hooks;
#[cfg(any(test, feature = "test-util"))]
pub mod test_support;

// Route A skeleton (docs: engine move, stages 2 to 6). Empty folders; each later stage moves its files in with `git mv`.
pub mod accounts;
pub mod agent_rules;
pub mod agent_health;
pub mod acp;
pub mod agent_caps;
pub mod agent_contexts;
pub mod agent_run_mode;
pub mod attach;
pub mod capacity_proxy;
pub mod chat_index;
pub mod files;
pub mod pane_outbox;
pub mod project_budget;
pub mod pty;
pub mod questions;
pub mod session_chat;
pub mod tui;
pub mod worktrees;

// Leaf files moved out of the app (stage 1). The app re-exports each under its old name.
pub mod env_probe;
#[cfg(windows)]
pub mod proc_job;
pub mod proc_util;
pub mod secure_file;
pub mod startup_timing;
pub mod wait_reasons;
pub mod app_version;
pub mod write_atomic;
pub mod audit;
pub mod redact;
pub mod actors;
pub mod event_log;
pub mod events;
pub mod git_exclude;
pub mod pane_wait_notify;
pub mod project_path;
pub mod platform;
pub mod canary;
pub mod pane_prompt;
pub mod one_brain;
pub mod path_limit;
pub mod agent_runs;
pub mod opencode;
pub mod agent_pack;
pub mod mcp_install;
pub mod toolbelt;
pub mod usage;
pub mod handoff;
pub mod flight;
pub mod shell_env;
pub mod tools_home;
pub mod agent_adapters;
pub mod wsl;
pub mod ssh;
pub mod loop_guard;
pub mod pane_activity;
pub mod ambient;
pub mod standby;
pub mod operation_error;
pub mod path_refresh;
pub mod prompt_risk;
pub mod model_bridge;
pub mod session_context;
