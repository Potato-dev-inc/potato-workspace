// What the mocked `agent_caps_*` commands answer, for the Settings > Agents screenshots. Example data only.
// Claude has a mix (some proven yes, one no, the rest not seen yet), OpenCode is terminal only, Cursor Agent has nothing yet.
import type { AgentCaps, Cap } from '../lib/agentCaps';

const AT = '2026-11-13T01:02:03Z';
const none: Cap = { value: 'unknown', source: 'unknown', proof: '', at: null };
const cap = (value: 'yes' | 'no', source: Cap['source']): Cap => ({ value, source, proof: 'example', at: AT });

function caps(agentId: string, label: string, over: Partial<AgentCaps>): AgentCaps {
  return {
    schema: 1, agent_id: agentId, label, level: 'l0', level_proof: cap('yes', 'handshake'), program_version: null,
    chat: none, resume: none, shows_steps: none, edits_files: none, asks_before_edit: none, asks_before_shell: none,
    model_pick: none, models: [], models_total: 0, stop: none, images: none, usage: none, read_only: none, ...over,
  };
}

const ALL: AgentCaps[] = [
  caps('claude', 'Claude', {
    chat: cap('yes', 'definition'), resume: cap('yes', 'handshake'), model_pick: cap('yes', 'handshake'), asks_before_edit: cap('yes', 'seen'),
    images: cap('no', 'handshake'), models: ['opus', 'sonnet', 'haiku'], models_total: 3,
  }),
  caps('codex', 'Codex', {
    chat: cap('yes', 'definition'), resume: cap('yes', 'handshake'), shows_steps: cap('yes', 'seen'), edits_files: cap('yes', 'seen'),
    stop: cap('yes', 'seen'), usage: cap('yes', 'seen'), images: cap('yes', 'handshake'),
  }),
  caps('opencode', 'OpenCode', { level: 'l5', chat: cap('no', 'check') }),
  caps('cursor_agent', 'Cursor Agent', {}),
];

export function agentCapsMock(cmd: string, args: Record<string, unknown>): { handled: true; value: unknown } | { handled: false } {
  if (cmd === 'agent_caps_list') return { handled: true, value: ALL };
  if (cmd === 'agent_caps_get') return { handled: true, value: ALL.find((c) => c.agent_id === args.agentId) ?? caps(String(args.agentId), String(args.agentId), {}) };
  return { handled: false };
}
