// The files a pane has open as tabs beside its chat. Kept in memory for this run only (a file tab is not a pane:
// closing the app forgets them, and the phone never sees them). One "open this" request waits at a time per pane;
// the pane view clears it once it has switched to the tab.
import { useSyncExternalStore } from 'react';

export interface PaneFiles {
  /** Paths relative to the project folder, in the order they were opened. */
  files: readonly string[];
  /** The file to bring to the front, until the pane view has done it. */
  focus: { path: string; nonce: number } | null;
}

const EMPTY: PaneFiles = { files: [], focus: null };
const byPane = new Map<string, PaneFiles>();
const listeners = new Set<() => void>();
let nonce = 0;

function put(paneId: string, next: PaneFiles): void {
  if (next.files.length === 0 && !next.focus) byPane.delete(paneId);
  else byPane.set(paneId, next);
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The tab id a file has in the pane's tab row. */
export const fileTabId = (path: string): `file:${string}` => `file:${path}`;

/** The path a tab id names, or null when the tab is not a file. */
export function pathOfTab(tab: string): string | null {
  return tab.startsWith('file:') ? tab.slice(5) : null;
}

/** Opens a file in a tab of this pane (or brings its tab to the front). */
export function openFileTab(paneId: string, path: string): void {
  const cur = byPane.get(paneId) ?? EMPTY;
  put(paneId, { files: cur.files.includes(path) ? cur.files : [...cur.files, path], focus: { path, nonce: ++nonce } });
}

/** Closes a file tab. */
export function closeFileTab(paneId: string, path: string): void {
  const cur = byPane.get(paneId);
  if (!cur) return;
  put(paneId, { files: cur.files.filter((p) => p !== path), focus: cur.focus?.path === path ? null : cur.focus });
}

/** The pane view switched to the file: stop offering it. */
export function clearFileFocus(paneId: string, nonceSeen: number): void {
  const cur = byPane.get(paneId);
  if (!cur?.focus || cur.focus.nonce !== nonceSeen) return;
  put(paneId, { files: cur.files, focus: null });
}

export function usePaneFiles(paneId: string): PaneFiles {
  return useSyncExternalStore(subscribe, () => byPane.get(paneId) ?? EMPTY);
}

/** Forgets every open file (tests start from none). */
export function resetFileTabs(): void {
  byPane.clear();
  for (const l of [...listeners]) l();
}
