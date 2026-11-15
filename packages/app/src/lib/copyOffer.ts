// Whether "Work on a copy" is offered on the New agent page. Kept on this device (the phone has its own):
//   - the global switch (Settings > Agents > Where agents start), on by default;
//   - a choice for one project that wins over the global one: "Always offer" or "Never offer".
// This only hides the option. A copy a person already started keeps working, and nothing is deleted.
// Reads and writes never throw: with blocked storage the choice still holds until the window closes.
import { useSyncExternalStore } from 'react';

export const COPY_OFFER_KEY = 'potato.copyOffer.v1';
const PROJECT_KEY = 'pm-copy-offer-project:';

export type ProjectOffer = 'default' | 'on' | 'off';

const listeners = new Set<() => void>();
const memory = new Map<string, string>();
// Bumped on every change so useSyncExternalStore sees a new snapshot.
let version = 0;

/** One project, one key: slashes, case and a trailing slash do not matter. */
export const copyProjectKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

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
    if (value !== null) memory.set(key, value);
  }
  version += 1;
  for (const listener of listeners) listener();
}

export const getCopyOfferGlobal = (): boolean => read(COPY_OFFER_KEY) !== '0';
export const setCopyOfferGlobal = (on: boolean): void => write(COPY_OFFER_KEY, on ? '1' : '0');

export function getProjectOffer(path: string | null): ProjectOffer {
  if (!path) return 'default';
  const value = read(PROJECT_KEY + copyProjectKey(path));
  return value === 'on' || value === 'off' ? value : 'default';
}

export function setProjectOffer(path: string, offer: ProjectOffer): void {
  write(PROJECT_KEY + copyProjectKey(path), offer === 'default' ? null : offer);
}

/** True when New agent should show "Work on a copy" for this folder. */
export function copyOffered(path: string | null): boolean {
  const own = getProjectOffer(path);
  return own === 'default' ? getCopyOfferGlobal() : own === 'on';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders when the global switch or any project choice changes. */
export function useCopyOffered(path: string | null): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return copyOffered(path);
}

export function useCopyOfferGlobal(): [boolean, (on: boolean) => void] {
  useSyncExternalStore(subscribe, () => version, () => version);
  return [getCopyOfferGlobal(), setCopyOfferGlobal];
}

export function useProjectOffer(path: string | null): [ProjectOffer, (offer: ProjectOffer) => void] {
  useSyncExternalStore(subscribe, () => version, () => version);
  return [getProjectOffer(path), (offer) => path && setProjectOffer(path, offer)];
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key && (event.key === COPY_OFFER_KEY || event.key.startsWith(PROJECT_KEY))) {
      version += 1;
      for (const listener of listeners) listener();
    }
  });
}
