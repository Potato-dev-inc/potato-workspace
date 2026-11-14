// The "message rail" switch (Settings > Agents > All agents): the thin stack of dashes beside the chat's scroll bar.
// On by default. It lives in this device's browser storage (the phone has its own); reads and writes never throw.
import { useSyncExternalStore } from 'react';

export const MESSAGE_RAIL_KEY = 'potato.messageRail.v1';

function readStored(): boolean {
  try {
    return typeof localStorage === 'undefined' ? true : localStorage.getItem(MESSAGE_RAIL_KEY) !== '0';
  } catch {
    return true;
  }
}

let current = readStored();
const listeners = new Set<() => void>();

export const getMessageRail = (): boolean => current;

export function subscribeMessageRail(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setMessageRail(on: boolean): void {
  current = on;
  try {
    localStorage.setItem(MESSAGE_RAIL_KEY, on ? '1' : '0');
  } catch {
    // Storage is blocked: the change still holds for this session.
  }
  for (const listener of listeners) listener();
}

/** Another window changed the switch: take it over. Called from the storage event. */
export function refreshMessageRailFromStorage(): void {
  current = readStored();
  for (const listener of listeners) listener();
}

export function useMessageRail(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribeMessageRail, getMessageRail, getMessageRail), setMessageRail];
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === MESSAGE_RAIL_KEY) refreshMessageRailFromStorage();
  });
}
