// Which right-panel sections are folded. One comma list in local storage (`pm.rail.closed`), for the whole app, so a
// section folded in one chat stays folded in the next. Every read and write is guarded: storage can be blocked.
import { useSyncExternalStore } from 'react';

export const RAIL_CLOSED_KEY = 'pm.rail.closed';

export type RailSectionId = 'env' | 'ctx' | 'plan' | 'con' | 'out' | 'chg' | 'bg' | 'files';

let state: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function readStored(): Set<string> {
  try {
    return new Set((window.localStorage.getItem(RAIL_CLOSED_KEY) ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function current(): ReadonlySet<string> {
  if (!state) state = readStored();
  return state;
}

export function isRailSectionClosed(id: string): boolean {
  return current().has(id);
}

export function setRailSectionClosed(id: string, closed: boolean): void {
  // Merge with what is stored NOW, not with this window's copy: another window of the app may have folded or opened
  // a section since this copy was read, and writing the stale copy back would undo that choice.
  const next = readStored();
  if (closed) next.add(id);
  else next.delete(id);
  state = next;
  try {
    window.localStorage.setItem(RAIL_CLOSED_KEY, [...next].join(','));
  } catch {
    // The choice just is not remembered.
  }
  for (const l of listeners) l();
}

/** Another window changed the list: take its copy. */
function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== RAIL_CLOSED_KEY) return;
  state = readStored();
  for (const l of listeners) l();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', onStorage);
}

/** Tests: forget the in-memory list so the next read comes from storage again. */
export function resetRailFoldForTests(): void {
  state = null;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useRailClosed(id: string): [boolean, (closed: boolean) => void] {
  const closed = useSyncExternalStore(subscribe, () => current().has(id), () => false);
  return [closed, (c) => setRailSectionClosed(id, c)];
}
