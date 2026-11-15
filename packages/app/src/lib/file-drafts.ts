// Unsaved edits of the files open as tabs. A draft lives here, not in the file tab, so it survives switching to
// another tab and back (the file tab is built again each time). It is kept in memory for this run only; closing the
// file tab forgets it. A file with a draft shows a dot on its tab.
import { useSyncExternalStore } from 'react';

export interface FileDraft {
  /** What the person has typed. */
  text: string;
  /** The text and the version of the file when the edit started: what "Revert" goes back to, and what a save checks. */
  baseText: string;
  baseVersion: string;
}

const drafts = new Map<string, FileDraft>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

const keyOf = (paneId: string, path: string) => `${paneId}\n${path}`;

function changed(): void {
  snapshot = new Set(drafts.keys());
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getDraft = (paneId: string, path: string): FileDraft | undefined => drafts.get(keyOf(paneId, path));

export function setDraft(paneId: string, path: string, draft: FileDraft): void {
  drafts.set(keyOf(paneId, path), draft);
  changed();
}

export function clearDraft(paneId: string, path: string): void {
  if (drafts.delete(keyOf(paneId, path))) changed();
}

/** Whether a file has unsaved edits. */
export const hasDraft = (paneId: string, path: string): boolean => drafts.has(keyOf(paneId, path));

/** The files that have unsaved edits (a set of `hasDraftKey` keys; use `isDirty`). */
export function useDraftKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export const isDirty = (keys: ReadonlySet<string>, paneId: string, path: string): boolean => keys.has(keyOf(paneId, path));

/** For tests. */
export function resetFileDrafts(): void {
  drafts.clear();
  changed();
}
