import { z } from 'zod';

export const SettingsSchema = z.object({
  anthropic_api_key: z.string().optional(),
  openai_api_key: z.string().optional(),
  openrouter_api_key: z.string().optional(),
  /**
   * The person's own AI service for the agent wizard's writer ("Custom AI service"): which service, its base URL and
   * model. The key is never here: it lives in the OS credential store (secret `custom_ai_key`).
   */
  custom_ai: z.object({ preset: z.string(), baseUrl: z.string(), model: z.string() }).optional(),
  /** Mobile terminal text buffer delay before committing to the PTY (autocorrect settling). */
  mobile_input_delay_ms: z.number().int().min(0).max(1000).default(60),
  /** Show the mobile terminal command input bar. When false, the tap target remains invisible. */
  mobile_input_visible: z.boolean().default(true),
  /** Phone: let the keyboard shrink the agent (PTY redraw per open/close). Off keeps the agent at its size. */
  mobile_keyboard_resizes_agent: z.boolean().default(false),
  project_path: z.string().optional(),
  /** Public HTTPS origin for mobile PWA (reverse proxy target). Used in pairing QR. */
  public_pwa_url: z.string().optional(),
  /** Local Vite dev server port the public URL should proxy to (default 1420). */
  dev_server_port: z.number().int().min(1024).max(65535).default(1420),
  /** Orchestrator sidebar width in the workspace (px). */
  sidebar_width: z.number().int().min(300).max(800).default(360),
  /** Desktop UI chrome theme. */
  theme: z.enum(['dark', 'light', 'dim', 'auto']).default('dark'),
  /** Where panes are shown: one cockpit window (orchestration) or a pop-out per pane (individual). Owned by Rust (set_ui_mode). */
  ui_mode: z.enum(['orchestration', 'individual']).default('orchestration'),
  /** Ask before closing a pane window, a cockpit pane or the app while an agent is working. */
  confirm_close_running_pane: z.boolean().default(true),
  /** Keep the PC awake (the screen may still turn off) while an agent works, so locking it does not stop the agents (Rust: keep_awake). */
  keep_awake_while_working: z.boolean().default(true),
  /** A small card jumps out over the work area when an agent is blocked on a question only the Inbox shows (components/cockpit/JumpOutCard). */
  jump_out_cards_enabled: z.boolean().default(true),
  /** The agent that started a helper may answer its safe questions: allow once and any no; the rest goes to the person (Rust: acp::chat::helper_answers). */
  helper_answers_enabled: z.boolean().default(true),
  /** The "Used" strip at the bottom of the sidebar: plan usage per signed-in agent (Rust: usage). */
  show_usage_bar: z.boolean().default(true),
  /** The strip may read Claude's plan usage with the person's own Claude login (on by default, like Orca; Rust: usage::oauth). */
  usage_login_reads: z.boolean().default(true),
  /** Developer option: install MCP configs to launch the bundled Rust binary instead of npm. */
  developer_use_rust_mcp: z.boolean().default(false),
  /** Save the project's files at each agent turn so a turn can be undone (Rust: checkpoints). */
  checkpoints_enabled: z.boolean().default(true),
  /** Checkpoints kept per pane before the oldest are pruned. */
  checkpoints_keep: z.number().int().min(5).max(500).default(50),
  /** Minutes without keyboard or mouse before you count as away (the "While you were away" digest); 0 = off. */
  away_minutes: z.number().int().min(0).max(1440).default(5),
  /** The person's own keyboard shortcuts: { actionId: combo }, "none" = turned off. A missing id keeps its default (lib/shortcuts.ts in the app; Rust: global_shortcuts). */
  keybindings: z.record(z.string(), z.string()).optional(),
  /** Budget every agent run that agents start gets, in turns; 0 = no budget (the default). Rust: budgets. */
  budget_default_turns: z.number().int().min(0).max(10000).default(0),
  /** Same, in wall-clock minutes; 0 = no limit. */
  budget_default_minutes: z.number().int().min(0).max(10080).default(0),
  /** After a turn, a quiet line may say a cheaper or stronger model would fit better. On unless false. Rust: acp::chat::right_size. */
  right_size_suggest: z.boolean().optional(),
  /** Live updates from agents (Claude, Codex): off, or watch only for now. Owned by Rust (settings_store). */
  agent_hooks_mode: z.enum(['off', 'shadow', 'evidence']).optional(),
  /** Per-agent override of agent_hooks_mode, keyed by agent id. */
  agent_hooks_agents: z.record(z.string(), z.enum(['off', 'shadow', 'evidence'])).optional(),
  /** Potato Workspace's helper tools (run_agent, wait_agents) given to every agent pane for its launch. On unless false. Rust: pane_mcp. */
  pane_mcp_enabled: z.boolean().optional(),
  /** What Settings › Agents › "Hand off does" picks: `file` (Quick handoff: save HANDOFF.md) or `new_agent` (Handoff to new agent; the default when absent). App: lib/handoff.ts. */
  handoff_mode: z.enum(["file", "new_agent"]).optional(),
  /** Text added to every quick handoff under "Always remember". */
  handoff_fixed_notes: z.string().optional(),
  /** Missions (Preview, Settings › General › Labs): goal + checks + budget, worked on in rounds. Off unless chosen. Rust: missions. */
  missions_enabled: z.boolean().optional(),
  /** Night Shift (Settings › General › Labs): plan tasks for tonight, review them in the morning. Off unless chosen. Rust: night_shift. */
  night_shift_enabled: z.boolean().optional(),

  /** Chat over the Agent Client Protocol (Settings › General › Labs): agents driven through a protocol instead of their terminal screen. Off unless chosen, and also the kill switch. Rust: acp. */
  acp_chat_enabled: z.boolean().optional(),
  /** What the "+" menu starts: a chat or a terminal. Absent: chat. Shown only while Chat is on. */
  new_agent_start: z.enum(['chat', 'terminal']).optional(),
  /** The main window's X: off (absent) = quit the app, asking first when an agent is working; on = hide to the tray and keep running. Rust: close_to_tray. */
  close_to_tray: z.boolean().optional(),
  /** Show terminals (Settings > General): off = every agent starts as a chat and terminal-only controls are hidden. Absent: off. Open terminals keep working. Rust: show_terminals. */
  show_terminals: z.boolean().optional(),
  /** Model Bridge (Settings › General › Labs): connect a model service with a key and add it to Codex. Off unless chosen. Rust: model_bridge. */
  model_bridge_enabled: z.boolean().optional(),
  /** Spaces (Settings › General › Labs): chat with friends in small groups, computer to computer. Off unless chosen. Rust: spaces. */
  spaces_enabled: z.boolean().optional(),
  /** Share an agent (Settings > General > Labs): lend an agent sign-in to another PC, or borrow one. Off unless chosen. Rust: lend. */
  lend_enabled: z.boolean().optional(),
  /** Devices (Settings > General > Labs): pair two Workspaces and run a chat or terminal on the other one. Off unless chosen. Rust: device_link. */
  devices_enabled: z.boolean().optional(),
  /** Far-away PCs (Settings > General > Labs): pair a PC that is not on your network through your own relay. Off unless chosen. Rust: settings_store. */
  far_pcs_enabled: z.boolean().optional(),
  /** The device door (Labs): an already-paired PC may also make signed read-only calls through this PC's public tunnel address, for devices the person switched it on for. Off unless chosen. Not patchable over the bridge. Rust: device_link::pcdoor. */
  pcdoor_enabled: z.boolean().optional(),
  /** Potato account (Settings > General > Labs): sign in once and see your devices on each other. Off unless chosen. Rust: account. */
  account_enabled: z.boolean().optional(),
  /** Desktop Potato (Settings > General > Labs): a small pet window on the desktop. Off unless chosen. Rust: pet. */
  desktop_pet_enabled: z.boolean().optional(),
  agent_browser_enabled: z.boolean().optional(),
  /** Companion memory and mood (Settings > General > Labs): daily journal, diary and mood per companion. Off unless chosen. */
  companion_vault_enabled: z.boolean().optional(),
  /** Discord bot (Settings > General > Labs): a companion answers in chosen Discord channels with the person's own bot. Off unless chosen. */
  discord_bot_enabled: z.boolean().optional(),
  /** Project guide (Settings > General > Labs): the person's agent writes a short guide to a project when asked. Off unless chosen. Rust: project_guide. */
  project_guide_enabled: z.boolean().optional(),
  /** Mark-up bar (Settings > General > Labs): draw, pick and send marks of a page to the chat that made it; Open in agent browser. Off unless chosen. */
  markup_bar_enabled: z.boolean().optional(),
  /** Browser in the side panel (Settings > General > Labs): the agent browser's page shows in the details column instead of its own window. Off unless chosen. Rust: browser::dock. */
  dock_browser_enabled: z.boolean().optional(),
  /** The Today page (Settings > General > Labs): one line for the whole day, and a way back to any point on it. Off unless chosen. Rust: timeline. */
  timeline_day_enabled: z.boolean().optional(),
  /** Desktop Potato: size 'small' | 'medium' | 'large', hidden-until (epoch ms), quiet. Rust: pet. */
  desktop_pet_size: z.enum(['small', 'medium', 'large']).optional(),
  desktop_pet_quiet: z.boolean().optional(),
  desktop_pet_hidden_until_ms: z.number().optional(),
  /** Get early versions (beta): the updater also reads the beta address and takes the newer version. Off unless chosen. Rust: commands/update_channel. */
  early_versions_enabled: z.boolean().optional(),
  /** Smaller updates (Labs): an update may take the app-only package and leave the built-in tools alone. Off unless chosen. Rust: commands/update_plan. */
  smaller_updates_enabled: z.boolean().optional(),
  /** Crews (Settings > General > Labs): shows saved crews, read-only, and lets the command line check a crew file. Off unless chosen. Rust: crews. */
  crews_enabled: z.boolean().optional(),
  /** Workflows (Settings > General > Labs): a crew with one Front role; the Front starts its helpers itself. Off unless chosen. Rust: crews/workflow. */
  workflows_enabled: z.boolean().optional(),
  /** How the Front of a workflow answers: translator (default) retells in its own words; router shows the helper's own words. */
  workflow_reply_style: z.enum(['translator', 'router']).optional(),
  /** Fixed phone address (Settings > Early features): an address from the third-party OpenTunnel relay. Off unless chosen. Rust: mobile_tunnel/opentunnel. */
  opentunnel_stable_link: z.boolean().optional(),
  // Chat on an SSH machine (Labs, development builds; not patchable over the bridge).
  ssh_chat_enabled: z.boolean().optional(),
  /** The version whose small update failed (written by the app); that version takes the full package. */
  app_only_failed_for: z.string().optional(),
  /** The first-switch sheet for Individual mode was shown and (with "Don't show again") dismissed for good. Absent: show it. */
  individual_explained: z.boolean().optional(),
  /** How the windows move when the mode switches between Orchestration and Individual: Domino (default), Ink, or Off (a quick fade). Rust reads it (switch_anim). */
  mode_switch_animation: z.enum(['domino', 'ink', 'off']).optional(),
  /** Where the pop-out windows go when the mode switches to Individual: side by side in an even grid (default), or cascaded one step down and right each. Rust reads it (window_layout). */
  individual_window_layout: z.enum(['side_by_side', 'cascade']).optional(),
  /** Simple mode: the cockpit with fewer buttons and plain words, for people who do not write code. Off unless chosen. */
  simple_mode: z.boolean().optional(),
  /** Shows the developer rows in Settings (bridge, MCP, storage, file paths). Off unless chosen. Read by the app only. */
  show_developer_settings: z.boolean().optional(),
  /** How the New agent page greets you ("What's up next, <name>?"). Empty or absent: no name. Never derived from the computer. */
  display_name: z.string().max(60).optional(),
  /** App language: follow the system (the default when absent), English or Traditional Chinese. App: i18n/. */
  ui_language: z.enum(['auto', 'en', 'zh-TW']).optional(),
  /** The cards pinned on the New agent page, in order. Absent: none. */
  home_cards: z.array(z.object({ id: z.string().max(40), kind: z.enum(['recent', 'running', 'needs', 'prompt']), text: z.string().max(2000).optional() })).max(12).optional(),
  /** First-run welcome: absent = never decided (shown once on a fresh profile), true = finished or skipped, false = show it again. Rust reads it (first_run). */
  onboarding_done: z.boolean().optional(),
  /** First-run welcome: the step the person was on, so a restart resumes there. */
  onboarding_step: z.string().optional(),
  /** First-run welcome: the folder chosen for the first task, so a restart resumes with it. */
  onboarding_project: z.string().optional(),
  /** First-run welcome: the agent that was ready, so a restart can still offer the first task. */
  onboarding_agent: z.string().optional(),
  /** Optional path to the librarian project indexer script (default scripts/project-indexer.py). */
  librarian_indexer_path: z.string().optional(),
  /** Default OpenCode provider for opencode_native API prompts (write_terminal_input). */
  opencode_model_provider: z.string().optional(),
  /** Default OpenCode model for opencode_native API prompts (write_terminal_input). */
  opencode_model_id: z.string().optional(),
  /** Settings > Agents > Helper agents: the model a helper runs on per agent id when the request names none. Absent: none. Rust reads it (agent_run_mode::helper_model). */
  helper_default_models: z.record(z.string().max(120)).optional(),
  /** Settings > Agents > Default model: the model each agent starts on per agent id when nothing names one. Absent: none. Rust reads it (agent_run_mode::agent_model). */
  agent_default_models: z.record(z.string().max(120)).optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;
