// The comfort prefs in this computer's browser storage, shared by every window of the app. Reads and
// writes never throw: a locked or missing storage just means the defaults.
import { useSyncExternalStore } from 'react';
import { COMFORT_DEFAULTS, COMFORT_KEY, parseComfort, type ComfortPrefs } from './model';

function readStored(): ComfortPrefs {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(COMFORT_KEY);
    return parseComfort(raw ? JSON.parse(raw) : null);
  } catch {
    return COMFORT_DEFAULTS;
  }
}

let current: ComfortPrefs = readStored();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getComfort(): ComfortPrefs {
  return current;
}

export function subscribeComfort(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Change some prefs, save them, and tell every screen in this window. */
export function setComfort(patch: Partial<ComfortPrefs>): ComfortPrefs {
  current = parseComfort({ ...current, ...patch });
  try {
    localStorage.setItem(COMFORT_KEY, JSON.stringify(current));
  } catch {
    // Storage is blocked: the change still applies for this session.
  }
  notify();
  return current;
}

/** Another window saved new prefs: take them over. Called from the storage event. */
export function refreshComfortFromStorage(): void {
  current = readStored();
  notify();
}

/** The prefs as React state. Every screen that calls this updates when any screen changes them. */
export function useComfort(): [ComfortPrefs, (patch: Partial<ComfortPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribeComfort, getComfort, getComfort);
  return [prefs, setComfort];
}
