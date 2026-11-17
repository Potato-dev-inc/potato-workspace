// The "more than usual" note under a finished answer (a small mark and one tip). On by default. "Don't show again"
// under the note turns it off for every chat on this device; the chat View menu switch turns it back on. Kept in the
// same browser storage as the other chat-look switches (done-card, message rail), so every window agrees.
// Reads and writes never throw: with blocked storage the choice still holds until the window closes.
import { useSyncExternalStore } from 'react';

export const USUAL_NOTES_KEY = 'potato.usualNotes.v1';

const listeners = new Set<() => void>();
// Used only while storage is blocked; otherwise the stored value is the truth.
let memory: string | null = null;
let version = 0;

function read(): string | null {
  try {
    return localStorage.getItem(USUAL_NOTES_KEY) ?? memory;
  } catch {
    return memory;
  }
}

export const getUsualNotesOn = (): boolean => read() !== '0';

export function setUsualNotesOn(on: boolean): void {
  const value = on ? '1' : '0';
  try {
    localStorage.setItem(USUAL_NOTES_KEY, value);
    memory = null;
  } catch {
    // Storage is blocked: the choice still holds for this session.
    memory = value;
  }
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while the "more than usual" note may show. Re-renders when the switch changes here or in another window. */
export function useUsualNotesOn(): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return getUsualNotesOn();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === USUAL_NOTES_KEY) {
      version += 1;
      for (const listener of listeners) listener();
    }
  });
}
