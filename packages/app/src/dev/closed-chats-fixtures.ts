// Closed chats for the harness: what the mocked `acp_closed_list`, `acp_reopen_closed` and delete commands answer.
// Example data only. Without a `closedChats` scenario there are none, so the sidebar shows no Closed chats row.
import type { ClosedChat } from '../lib/closedChats';

export interface ClosedChatsScenario {
  /** The closed chats the mock starts with. */
  chats: ClosedChat[];
}

const HOUR = 3_600_000;
const WORK = 'C:/Users/dev/work';

export const EXAMPLE_CLOSED_CHATS: ClosedChat[] = [
  { id: 'acp-closed-1', agent: 'claude', label: 'Claude', cwd: `${WORK}/potato-workspace`, updated_ms: Date.now() - 2 * HOUR, title: 'Fix the login redirect after sign-in' },
  { id: 'acp-closed-2', agent: 'codex', label: 'Codex', cwd: `${WORK}/potato-site`, updated_ms: Date.now() - 26 * HOUR, title: 'Why is the docs build so slow?' },
  { id: 'acp-closed-3', agent: 'claude', label: 'Claude', cwd: `${WORK}/acp-lab`, updated_ms: Date.now() - 5 * 24 * HOUR, title: null },
];

/** `handled: false` leaves the command to the normal mock. The list lives for the page, so Delete and Reopen work. */
export function closedChatsMock(s: ClosedChatsScenario | undefined, state: { chats: ClosedChat[] | null }, cmd: string, args: Record<string, unknown>): { handled: boolean; value?: unknown } {
  if (!cmd.startsWith('acp_closed_') && cmd !== 'acp_reopen_closed' && cmd !== 'acp_delete_closed' && cmd !== 'acp_delete_all_closed') return { handled: false };
  state.chats ??= [...(s?.chats ?? [])];
  switch (cmd) {
    case 'acp_closed_list':
      return { handled: true, value: [...state.chats].sort((a, b) => b.updated_ms - a.updated_ms) };
    case 'acp_reopen_closed':
      state.chats = state.chats.filter((c) => c.id !== args.id);
      return { handled: true, value: String(args.id) };
    case 'acp_delete_closed':
      state.chats = state.chats.filter((c) => c.id !== args.id);
      return { handled: true, value: null };
    case 'acp_delete_all_closed': {
      const n = state.chats.length;
      state.chats = [];
      return { handled: true, value: n };
    }
    default:
      return { handled: false };
  }
}
