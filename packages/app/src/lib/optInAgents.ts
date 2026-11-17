// Agents that are not in "Your agents" until the person adds them: Aider, Cursor (agent) and OpenCode (API). An agent
// that is already installed (someone who uses it) always shows, and so does one the person added through "Add an
// agent". The agents stay registered in the app; this only decides which ones the Settings list offers.
import { useSyncExternalStore } from 'react';

export const OPT_IN_AGENT_IDS: readonly string[] = ['aider', 'cursor', 'opencode_native'];
export const LS_ADDED_AGENTS = 'pm.agents.added';
export const ADDED_AGENTS_EVENT = 'pm:added-agents-changed';

export function readAddedAgents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_ADDED_AGENTS) ?? 'null');
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== ''))] : [];
  } catch {
    return [];
  }
}

/** Remember that the person chose this agent. Never throws. */
export function markAgentAdded(agentId: string): void {
  const id = agentId.trim().toLowerCase();
  if (!id) return;
  const now = readAddedAgents();
  if (now.includes(id)) return;
  try {
    localStorage.setItem(LS_ADDED_AGENTS, JSON.stringify([...now, id]));
    window.dispatchEvent(new Event(ADDED_AGENTS_EVENT));
  } catch {
    /* storage is off: the agent shows once it is installed */
  }
}

/** Does "Your agents" list this agent? Everything but the opt-in ones, unless installed or added. */
export function listedInYourAgents(row: { id: string; installed: boolean }, added: readonly string[]): boolean {
  return !OPT_IN_AGENT_IDS.includes(row.id) || row.installed || added.includes(row.id);
}

let cache: { raw: string | null; list: string[] } | null = null;
function snapshot(): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_ADDED_AGENTS);
  } catch {
    /* no storage */
  }
  if (!cache || cache.raw !== raw) cache = { raw, list: readAddedAgents() };
  return cache.list;
}
const EMPTY: string[] = [];

export function useAddedAgents(): string[] {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(ADDED_AGENTS_EVENT, cb);
      window.addEventListener('storage', cb);
      return () => {
        window.removeEventListener(ADDED_AGENTS_EVENT, cb);
        window.removeEventListener('storage', cb);
      };
    },
    snapshot,
    () => EMPTY,
  );
}
