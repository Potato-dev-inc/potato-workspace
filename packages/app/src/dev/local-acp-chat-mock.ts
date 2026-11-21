// One chat of THIS PC over ACP for the harness, with the same transcript and the same settings as a far chat (`p14-far-chat`): the local
// side of "the far chat next to the local chat". Dev only. `list_panes`, the chat reader and the settings commands answer for it.
import type { PaneInfo } from '../lib/tauri-types';
import type { ChatItem } from '../lib/sessionChatModel';
import { farChatState } from './devices-fixtures';

export interface LocalAcpChatScenario {
  paneId: string;
  title: string;
  /** The folder's name on this PC. */
  cwd: string;
  items: ChatItem[];
}

type Handler = { handled: true; value: unknown } | { handled: false };

export function localAcpPane(s: LocalAcpChatScenario): PaneInfo {
  return { id: s.paneId, agent_type: 'claude', pid: 1, status: 'idle', created_at: Date.now() - 600_000, last_output_at: Date.now() - 5_000, cwd: s.cwd, cols: 120, rows: 32, title: s.title, lane: 'acp' } as PaneInfo;
}

export function createLocalAcpChatMock(s: LocalAcpChatScenario | undefined): (cmd: string, a: Record<string, unknown>) => Handler {
  if (!s) return () => ({ handled: false });
  const state = farChatState(s.paneId);
  return (cmd, a) => {
    if (a.paneId !== s.paneId && cmd !== 'agent_model_options' && cmd !== 'agent_lane_get') return { handled: false };
    switch (cmd) {
      case 'session_chat_open':
        return { handled: true, value: { available: true, reason: null, source: 'acp', items: s.items, waitingFor: null } };
      case 'acp_chat_state':
        return { handled: true, value: state };
      case 'acp_chat_set_config':
        state.configOptions = (state.configOptions as { id: string }[]).map((o) => (o.id === a.optionId ? { ...o, currentValue: a.value } : o));
        return { handled: true, value: state };
      case 'acp_chat_set_force_yes':
        state.forceYes = a.on === true;
        return { handled: true, value: state };
      default:
        return { handled: false };
    }
  };
}
