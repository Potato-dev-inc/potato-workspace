// Which agent's page is open in Settings > Agents, and the deep link that opens one. The open agent is a small store
// the Settings window reads too: with a page open the window hides "Add an agent" and every other group, and the
// title reads "Agents › Claude". The page itself is drawn inside the Agents list row.
import { useSyncExternalStore } from 'react';
import { openSettingsAt } from '../../../lib/openSettingsAt';

/** The row id of the agent list (Settings > Agents). */
export const AGENT_LIST_ROW_ID = 'agent-list';

let current: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** The agent whose page is open, or null for the list. */
export function getOpenAgent(): string | null {
  return current;
}

/** Open an agent's page (or go back to the list with null). */
export function setOpenAgent(agentId: string | null): void {
  if (current === agentId) return;
  current = agentId;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open agent, live. */
export function useOpenAgent(): string | null {
  return useSyncExternalStore(subscribe, getOpenAgent, getOpenAgent);
}

/** Open Settings on the Agents page with this agent's page showing. */
export function openAgentPage(agentId: string): void {
  setOpenAgent(agentId);
  openSettingsAt('agents', AGENT_LIST_ROW_ID);
}

// "Install" on a page of an agent that is not installed: back to "Add an agent" with the name already typed.
let prefill: string | null = null;

/** Go to "Add an agent" with `name` typed in. */
export function openAddAgentWith(name: string): void {
  prefill = name;
  setOpenAgent(null);
  openSettingsAt('agents', 'add-agent');
}

/** The name a link asked "Add an agent" to start with; asking clears it. */
export function takeAddAgentPrefill(): string | null {
  const name = prefill;
  prefill = null;
  return name;
}
