//! The app's answers to the engine's questions (`pm_core::hooks::EngineHooks`): each one calls the code that stays in the app.

use std::sync::Arc;

use parking_lot::Mutex;
use pm_core::acp::journal::Page;
use pm_core::agent_run_mode::started_as::StartedAgentTypes;
use pm_core::hooks::{EngineHooks, HookLaunch, PromptWatch};
use pm_core::opencode::OpenCodeModelRef;
use pm_core::pty::registry::{PaneRegistry, SpawnPaneArgs};
use pm_core::tui::pane_mcp::PaneMcpLaunch;
use pm_core::tui::{LaunchEnv, TuiProfile};

struct AppHooks;

impl EngineHooks for AppHooks {
    fn agent_hooks_revoke(&self, pane_id: &str) {
        crate::agent_hooks::revoke(pane_id);
    }
    fn agent_hooks_prepare(&self, agent: &str, pane_id: &str, cwd: &str, user_args: &[String]) -> HookLaunch {
        crate::agent_hooks::prepare_spawn(agent, pane_id, cwd, user_args)
    }
    fn pane_key_mint(&self, pane_id: &str) -> Option<String> {
        Some(crate::agent_authority::pane_keys::mint(pane_id))
    }
    fn pane_key_revoke(&self, pane_id: &str) {
        crate::agent_authority::pane_keys::revoke(pane_id);
    }
    fn force_yes_forget(&self, pane_id: &str) {
        crate::agent_rules::terminal::forget(pane_id);
    }
    fn force_yes_maybe_enabled(&self, pane_id: &str, agent: &str) -> bool {
        crate::agent_rules::terminal::maybe_enabled(pane_id, agent)
    }
    fn agent_terminals_stop_owned_by(&self, owner: &str) {
        crate::agent_terminals::stop_owned_by(owner);
    }
    fn agent_terminals_stop_all(&self) {
        crate::agent_terminals::stop_all();
    }
    fn pane_removed(&self) {
        crate::pane_windows::notify_pane_removed();
    }
    fn pane_resized(&self, pane_id: &str, cols: u16, rows: u16) {
        crate::bridge::notify_pane_resized(pane_id, cols, rows);
    }
    fn pty_resized_by_lease(&self, pane_id: &str, cols: u16, rows: u16) {
        crate::bridge::notify_pty_resized_by_lease(pane_id, cols, rows);
    }
    fn panes_changed(&self) {
        crate::bridge::notify_panes_changed();
    }
    fn pane_title(&self, pane_id: &str) -> Option<String> {
        crate::ambient::store::get(pane_id)
    }
    fn pane_title_observe_input(&self, pane_id: &str, agent: &str, screen_line: &str, text: &str, append_newline: bool) -> bool {
        crate::ambient::store::observe_input(pane_id, agent, screen_line, text, append_newline)
    }
    fn pane_title_changed(&self, pane_id: &str) {
        if let Some(app) = crate::tauri_host::app() {
            crate::ambient::announce_title_change(&app, pane_id);
        }
    }
    fn standby_seat(&self, pane_id: &str) -> Option<String> {
        crate::standby::seat_panes::get(pane_id)
    }
    fn mcp_session_client_name(&self, session_id: &str) -> Option<String> {
        crate::mcp_sessions::session_client_name(session_id)
    }
    fn canary_before_run(&self, agent: &str) {
        crate::canary::before_run(agent);
    }
    fn one_brain_sync_on_spawn(&self, cwd: &str) {
        crate::one_brain::sync_on_spawn(cwd);
    }
    fn pane_ended(&self, pane_id: &str) {
        if let Some(app) = crate::tauri_host::app() {
            crate::commands::pane_ended(&app, pane_id);
        }
    }
    fn build_id(&self) -> String {
        env!("PM_BUILD_ID").to_string()
    }
    fn pane_account_launch(&self, agent_type: &str, account: &str) -> Result<(LaunchEnv, String), String> {
        crate::accounts::launch_for(agent_type, account)
    }
    fn pane_mcp_prepare(&self, profile: &dyn TuiProfile, pane_id: &str, user_args: &[String], pane_key: Option<&str>) -> PaneMcpLaunch {
        crate::pane_mcp::prepare(profile, pane_id, user_args, pane_key)
    }
    fn fake_tui_hold_output_chunk(&self, bytes: &[u8]) {
        #[cfg(feature = "dev-fake-tui")]
        crate::fake_tui::hold_output_chunk(bytes);
        #[cfg(not(feature = "dev-fake-tui"))]
        let _ = bytes;
    }
    fn capacity_note_pane(&self, grant: &str, pane_id: &str) {
        crate::capacity_proxy::note_pane(grant, pane_id);
    }
    fn prompt_watch(&self, pane_id: &str, agent_type: &str, registry: &Arc<Mutex<PaneRegistry>>) -> Option<Box<dyn PromptWatch>> {
        Some(Box::new(AppPromptWatch {
            pane_id: pane_id.to_string(),
            agent_type: agent_type.to_string(),
            registry: Arc::clone(registry),
            track: crate::pane_prompt::PromptTrack::default(),
        }))
    }
    fn opencode_spawn_native(&self, registry: &Arc<Mutex<PaneRegistry>>, args: SpawnPaneArgs) -> Result<String, String> {
        let app = crate::tauri_host::app().ok_or_else(|| "OpenCode's own screen needs the app window.".to_string())?;
        crate::opencode::native::spawn_native_pane(Arc::clone(registry), &app, args)
    }
    fn opencode_write_native_input(&self, registry: &Arc<Mutex<PaneRegistry>>, pane_id: &str, text: &str, model: Option<&OpenCodeModelRef>) -> Result<(), String> {
        let app = crate::tauri_host::app().ok_or_else(|| "OpenCode's own screen needs the app window.".to_string())?;
        crate::opencode::write_native_input(registry, &app, pane_id, text, model)
    }
    fn started_agent_types(&self) -> StartedAgentTypes {
        crate::agent_run_mode::started_agent_types()
    }
    fn close_helpers_with_agent(&self) -> bool {
        crate::agent_run_mode::close_helpers_with_agent()
    }
    fn chat_is_remote_pane(&self, pane_id: &str) -> bool {
        crate::acp::chat::is_remote_pane(pane_id)
    }
    fn chat_app_is_shutting_down(&self) -> bool {
        crate::acp::chat::app_is_shutting_down()
    }
    fn chat_pid(&self, pane_id: &str) -> Option<u32> {
        crate::acp::chat::get(pane_id)?.session().connection().map(|conn| conn.pid())
    }
    fn chat_earlier(&self, pane_id: &str, before: &str, limit: usize) -> Page {
        crate::acp::chat::get(pane_id).map(|chat| chat.earlier(before, limit)).unwrap_or_default()
    }
    fn chat_terminal_input(&self, pane_id: &str, text: &str, append_newline: bool) -> Option<Result<(), String>> {
        crate::acp::chat::terminal_input(pane_id, text, append_newline)
    }
    fn worktree_is_isolated(&self, cwd: &str) -> bool {
        crate::worktrees::origin_of_cwd(cwd).is_some()
    }
    fn worktree_release_closed_pane(&self, pane_id: &str, cwd: &str) {
        crate::agent_runs::pane_close::release_worktree_of_closed_pane(pane_id, cwd);
    }
    fn canary_note_not_ready(&self, agent: &str) {
        crate::canary::note_signal(agent, crate::canary::Signal::NotReady);
    }
    fn canary_note_ambiguous_idle(&self, agent: &str) {
        crate::canary::note_signal(agent, crate::canary::Signal::AmbiguousIdle);
    }
    fn standby_account_changed(&self, agent: &str) {
        crate::standby::note_account_changed(agent);
    }
    fn lend_launch_env(&self, agent: &str, grant: &str) -> Result<LaunchEnv, String> {
        crate::capacity_proxy::borrowed_launch_env(agent, grant)
    }
    fn lend_chat(&self, agent: &str, grant: &str) -> Result<pm_core::capacity_proxy::BorrowedChat, String> {
        crate::capacity_proxy::borrowed_chat(agent, grant)
    }
    fn lend_label(&self, grant: &str) -> Option<String> {
        crate::capacity_proxy::borrowed_label(grant)
    }
    fn lend_rows(&self) -> Vec<serde_json::Value> {
        crate::capacity_proxy::borrowed_rows()
    }
    fn lend_profile_name(&self, account_id: &str) -> Option<String> {
        crate::capacity_proxy::lend_profile_name(account_id)
    }
    fn canary_version_of(&self, agent: &str) -> Option<String> {
        crate::canary::version_of(agent)
    }
    fn cli_version_line(&self, command: &pm_core::tui::VersionCommand) -> Option<String> {
        match pm_core::agent_health::run_version(command, pm_core::agent_health::VERSION_TIMEOUT) {
            pm_core::agent_health::VersionOutcome::Version(line) => Some(line),
            _ => None,
        }
    }
    fn bridge_chat_table(&self, agent: &str) -> Result<(String, Vec<String>), String> {
        crate::acp::bridge::available_for(agent)?;
        crate::acp::bridge::bridge_table_parts(agent)
    }
    fn mcp_bundled_available(&self) -> bool {
        crate::mcp_runtime::using_bundled_mcp()
    }
    fn mcp_chat_default_servers(&self) -> Vec<serde_json::Value> {
        if !crate::mcp_runtime::using_bundled_mcp() {
            return Vec::new();
        }
        let launch = crate::mcp_runtime::mcp_launch_spec();
        vec![serde_json::json!({
            "name": crate::mcp_install::MCP_SERVER_NAME,
            "command": launch.command,
            "args": launch.args,
            "env": [{
                "name": crate::app_paths::BRIDGE_PORT_FILE_ENV,
                "value": crate::app_paths::bridge_port_file_env_value(),
            }],
        })]
    }
    fn chat_history_will_be_replayed(&self, conversation: &str) {
        crate::acp::chat::history_will_be_replayed(conversation);
    }
    fn chat_start_failure_sentence(&self, label: &str, error: &pm_core::acp::error::AcpError) -> String {
        crate::acp::chat::start_failure_sentence(label, error)
    }
    fn ssh_chat_spawn(&self, cfg: &pm_core::acp::config::AgentConfig, host: &dyn pm_core::acp::config::HostEnv, ssh: &pm_core::ssh::model::SshHost, folder: &str) -> Result<pm_core::acp::conn::SpawnSpec, pm_core::acp::error::AcpError> {
        crate::acp::config::resolve_remote_spawn(cfg, &crate::acp::config::WithRealSsh(host), ssh, folder)
    }
    fn ssh_chat_failure_sentence(&self, host_name: &str, program: &str, stderr_tail: &[String]) -> Option<String> {
        crate::ssh::acp::failure_sentence(host_name, program, stderr_tail)
    }
    fn read_only_run_table(&self, agent: &str) -> bool {
        crate::agent_runs::read_only_run_table(agent)
    }
    fn store_added_agent(&self, agent: &str) -> bool {
        let rec = crate::agent_store::record::load(&crate::agent_store::record::default_path());
        rec.agents.get(agent).is_some_and(|r| !r.catalog.is_empty())
    }
    // ----- The chat surface (stage 6) -----
    fn standby_config(&self) -> Option<pm_core::standby::config::StandbyConfig> {
        crate::standby::config_snapshot()
    }
    fn standby_default_project(&self, registry: &Mutex<PaneRegistry>) -> String {
        crate::standby::default_project(registry)
    }
    fn usage_plan_percent(&self, agent_id: &str) -> Option<f64> {
        let snapshot = crate::usage::cached()?;
        snapshot
            .rows
            .iter()
            .filter(|row| row.agent_id == agent_id)
            .flat_map(|row| row.windows.iter().map(|w| w.used_percent))
            .fold(None, |best: Option<f64>, p| Some(best.map_or(p, |b| b.max(p))))
    }
    fn question_answered(&self, question: &pm_core::questions::Question) {
        crate::agent_authority::consent::on_resolved(question);
        // A pause card for a run that used its budget: apply "Add turns" / "Stop here".
        crate::budgets::answer_applied(question);
        crate::handoff::on_resolved(question);
        // A card about a GitHub issue: start the run, open the draft PR, throw the copy away.
        crate::issue_intake::live::on_resolved(question);
        // A card about a failed CI check: start the fix, push it, stop watching.
        crate::ci_fix::live::on_resolved(question);
    }
    fn question_dismissed(&self, question: &pm_core::questions::Question) {
        crate::agent_authority::consent::on_resolved(question);
        crate::issue_intake::live::on_resolved(question);
        crate::ci_fix::live::on_resolved(question);
    }
    fn question_fix_id_valid(&self, id: &str) -> bool {
        crate::ci_fix::model::valid_fix_id(id)
    }
    fn question_notify(&self, question: &pm_core::questions::Question) {
        crate::push::notify_question(question);
    }
    fn attention_changed(&self) {
        crate::attention::on_changed();
    }
    fn push_sse(&self, frame: String) {
        crate::bridge::push_sse(frame);
    }
    fn pane_has_open_run(&self, pane_id: &str, cwd: &str) -> bool {
        crate::bridge::pane_has_open_run(pane_id, cwd)
    }
    fn chat_move_send_refusal(&self, pane_id: &str) -> Option<String> {
        crate::chat_move::book().send_refusal(pane_id)
    }
    fn handover_turn_ended_soon(&self, pane_id: &str) {
        crate::handover::turn_ended_soon(pane_id);
    }
    fn handover_forget(&self, pane_id: &str) {
        crate::handover::forget(crate::handover::book(), pane_id);
    }
    fn chat_copy_make(&self, project: &std::path::Path, store: &std::path::Path) -> Result<pm_core::hooks::ChatCopy, pm_core::acp::chat::StartError> {
        crate::acp::chat::copy::make(project, store)
    }
    fn chat_copy_release_if_pristine(&self, link: &pm_core::acp::record::CopyLink) -> bool {
        crate::acp::chat::copy::release_if_pristine(link)
    }
    fn chat_copy_sweep_closed(&self, conversations: &pm_core::acp::conversations::Conversations) {
        crate::acp::chat::copy::sweep_closed(conversations);
    }
}

/// One pane's prompt watcher: the structured prompt card for the window, the attention queue and Force yes.
struct AppPromptWatch {
    pane_id: String,
    agent_type: String,
    registry: Arc<Mutex<PaneRegistry>>,
    track: crate::pane_prompt::PromptTrack,
}

impl PromptWatch for AppPromptWatch {
    fn observe(&mut self, waiting: bool, screen: &str) {
        let agent_type = self.agent_type.clone();
        // The pane is waiting: a menu no profile describes still gets its card by shape.
        let Some(prompt) = crate::pane_prompt::next_prompt_event(&mut self.track, waiting, || {
            crate::pane_prompt::detect_in_screen_with_status(&agent_type, screen, false, Some("waiting_input"))
                .and_then(|p| crate::pane_prompt::PanePrompt::from_detected(&p))
        }) else {
            return;
        };
        if self.track.last_was_refresh() {
            // The same question with its menu now fully drawn: the card follows the screen.
            crate::attention::on_prompt_refresh(&self.pane_id, prompt.as_ref());
        } else {
            crate::attention::on_prompt(&self.pane_id, waiting, prompt.as_ref());
            // A new occurrence: an answer to it is not a repeat of the last one.
            crate::pane_prompt::answers::note_prompt_event(&self.pane_id);
        }
        // Force yes (`agent_rules`): a person's switch for this pane or its agent may answer a low-risk approval. It runs a
        // moment later, on its own thread, once the menu is fully drawn.
        if prompt.is_some() && !self.track.last_was_refresh() && crate::agent_rules::terminal::maybe_enabled(&self.pane_id, &self.agent_type) {
            let (registry, pane_id) = (Arc::clone(&self.registry), self.pane_id.clone());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                crate::pane_prompt::force_yes::try_answer(&registry, &pane_id);
            });
        }
        pm_core::host::emit("pty://prompt", serde_json::json!({ "pane_id": self.pane_id, "prompt": prompt }));
    }
}

/// Set once at start (`lib.rs` setup); a second call keeps the first. Tests that go through the engine call it too.
pub fn install() {
    pm_core::hooks::set(Arc::new(AppHooks));
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_hook_key_name_is_the_one_the_bridge_reads() {
        assert_eq!(pm_core::hooks::PANE_KEY_ENV, crate::mcp_sessions::PANE_KEY_ENV);
    }
}

/// Unit tests run the engine with the app's answers, as the real app does: they are installed before any test starts
/// (a start-up function the loader runs; no crate needed).
#[cfg(test)]
mod install_before_tests {
    extern "C" fn init() {
        super::install();
    }
    #[cfg(target_os = "windows")]
    #[link_section = ".CRT$XCU"]
    #[used]
    static INIT: extern "C" fn() = init;
    #[cfg(target_os = "linux")]
    #[link_section = ".init_array"]
    #[used]
    static INIT: extern "C" fn() = init;
    #[cfg(target_os = "macos")]
    #[link_section = "__DATA,__mod_init_func"]
    #[used]
    static INIT: extern "C" fn() = init;
}
