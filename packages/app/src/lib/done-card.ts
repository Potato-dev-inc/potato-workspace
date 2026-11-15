// Where the "Done means" line may show. Three ways to hide it, all kept on this device (the phone has its own):
//   - the global switch (Settings > Agents > Chat), on by default;
//   - "Hide for this chat" (per pane);
//   - "Don't show for this project" (per project folder).
// Reads and writes never throw: with blocked storage the choice still holds until the window closes.
import { useSyncExternalStore } from 'react';

export const DONE_CARD_KEY = 'potato.doneCard.v1';
const CHAT_KEY = 'pm-done-hide-chat:';
const PROJECT_KEY = 'pm-done-hide-project:';

const listeners = new Set<() => void>();
const memory = new Map<string, string>();
// Bumped on every change so useSyncExternalStore sees a new snapshot.
let version = 0;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null): void {
  memory.delete(key);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is blocked: the choice still holds for this session.
    if (value !== null) memory.set(key, value);
  }
  version += 1;
  for (const listener of listeners) listener();
}

export const getDoneCardOn = (): boolean => read(DONE_CARD_KEY) !== '0';
export const setDoneCardOn = (on: boolean): void => write(DONE_CARD_KEY, on ? '1' : '0');
export const chatHidesDone = (paneId: string): boolean => read(CHAT_KEY + paneId) === '1';
export const hideDoneForChat = (paneId: string): void => write(CHAT_KEY + paneId, '1');
export const projectHidesDone = (projectKey: string): boolean => read(PROJECT_KEY + projectKey) === '1';
export const hideDoneForProject = (projectKey: string): void => write(PROJECT_KEY + projectKey, '1');
/** Brings the line back for one chat and one project (Settings turns it back on for everyone with the switch). */
export function showDoneAgain(paneId: string, projectKey: string): void {
  write(CHAT_KEY + paneId, null);
  write(PROJECT_KEY + projectKey, null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while the line may show for this chat and project. Re-renders when any of the three choices change. */
export function useDoneCardAllowed(paneId: string, projectKey: string): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return getDoneCardOn() && !chatHidesDone(paneId) && !projectHidesDone(projectKey);
}

export function useDoneCardSwitch(): [boolean, (on: boolean) => void] {
  useSyncExternalStore(subscribe, () => version, () => version);
  return [getDoneCardOn(), setDoneCardOn];
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key && (event.key === DONE_CARD_KEY || event.key.startsWith(CHAT_KEY) || event.key.startsWith(PROJECT_KEY))) {
      version += 1;
      for (const listener of listeners) listener();
    }
  });
}
