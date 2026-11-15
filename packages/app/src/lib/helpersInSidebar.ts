// The "Show helpers in the sidebar" switch (Settings > Agents > How helpers run). ON by default (founder 2026-11-15: helpers show
// under the agent that started them, as before). Off leaves them only in the bar above the chat, with a count on the agent's row.
// It lives in this device's browser storage (the phone keeps its own indented list); reads and writes never throw.
import { useSyncExternalStore } from 'react';

export const HELPERS_IN_SIDEBAR_KEY = 'potato.helpersInSidebar.v1';

function readStored(): boolean {
  try {
    return typeof localStorage === 'undefined' ? true : localStorage.getItem(HELPERS_IN_SIDEBAR_KEY) !== '0';
  } catch {
    return true;
  }
}

let current = readStored();
const listeners = new Set<() => void>();

export const getHelpersInSidebar = (): boolean => current;

export function subscribeHelpersInSidebar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setHelpersInSidebar(on: boolean): void {
  current = on;
  try {
    localStorage.setItem(HELPERS_IN_SIDEBAR_KEY, on ? '1' : '0');
  } catch {
    // Storage is blocked: the change still holds for this session.
  }
  for (const listener of listeners) listener();
}

/** Another window changed the switch: take it over. Called from the storage event. */
export function refreshHelpersInSidebarFromStorage(): void {
  current = readStored();
  for (const listener of listeners) listener();
}

export function useHelpersInSidebar(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribeHelpersInSidebar, getHelpersInSidebar, getHelpersInSidebar), setHelpersInSidebar];
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === HELPERS_IN_SIDEBAR_KEY) refreshHelpersInSidebarFromStorage();
  });
}
