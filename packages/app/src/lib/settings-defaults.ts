// What a setting is when nothing is saved. Its own file so the Settings window (changed-from-default dots, Reset)
// can read it without pulling in the storage code in settings.ts.
import type { Settings } from '@potato-workspace/shared';

export const DEFAULT_SETTINGS: Settings = {
  mobile_input_delay_ms: 60,
  mobile_input_visible: true,
  mobile_keyboard_resizes_agent: false,
  dev_server_port: 1420,
  sidebar_width: 360,
  theme: 'dark',
  ui_mode: 'orchestration',
  developer_use_rust_mcp: false,
  confirm_close_running_pane: true,
  keep_awake_while_working: true,
  show_usage_bar: true,
  usage_login_reads: true,
  checkpoints_enabled: true,
  checkpoints_keep: 50,
  away_minutes: 5,
  budget_default_turns: 0,
  budget_default_minutes: 0,
  agent_hooks_mode: 'shadow',
  // Chat is on until the person turns it off (the "+" menu starts chats by default). Rust: settings_store.
  acp_chat_enabled: true,
  // Terminals are hidden until the person turns them on (Settings > General). Rust: show_terminals.
  show_terminals: false,
};
