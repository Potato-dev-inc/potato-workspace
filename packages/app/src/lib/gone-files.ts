// Files a chat made that are no longer on disk: a file tab that could not read its file says so here, and the Outputs list then shows the file
// struck through with "Remove" (it still names it, the chat wrote it). In memory for this run only. A file read again fine clears the mark.
import { useSyncExternalStore } from 'react';

const gone = new Set<string>();
const hidden = new Set<string>();
const listeners = new Set<() => void>();
let snapshot = '';

const keyOf = (paneId: string, path: string) => `${paneId}\n${path}`;
const changed = () => {
  snapshot = [...gone, '|', ...hidden].join('\n');
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function markGone(paneId: string, path: string, isGone: boolean): void {
  const k = keyOf(paneId, path);
  if (isGone === gone.has(k)) return;
  if (isGone) {
    gone.add(k);
    hidden.delete(k);
  } else gone.delete(k);
  changed();
}

export function removeGone(paneId: string, path: string): void {
  hidden.add(keyOf(paneId, path));
  changed();
}

/** What the Outputs list asks of one file: `gone` (struck through, with Remove) or `hidden` (removed by the person). */
export function useGoneFiles(): (paneId: string, path: string) => 'gone' | 'hidden' | null {
  useSyncExternalStore(subscribe, () => snapshot);
  return (paneId, path) => (hidden.has(keyOf(paneId, path)) ? 'hidden' : gone.has(keyOf(paneId, path)) ? 'gone' : null);
}
