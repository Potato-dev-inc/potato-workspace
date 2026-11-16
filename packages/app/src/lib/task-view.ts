// The details column beside a chat's right panel: what it shows (the full Background tasks page, or one minion's
// read-only view), whether it fills the window beside the sidebar, and which finished rows the person cleared.
// Per chat pane, in memory for this run. The rail's rows, the chat's "Minion: …" rows and the column itself all
// read this one store, so a click anywhere opens the same view.
import { useSyncExternalStore } from 'react';

export type TaskView = { kind: 'page' } | { kind: 'minion'; id: string };

export interface TaskViewState {
  view: TaskView;
  /** Fills the window beside the left sidebar: the chat and the right panel step aside. */
  full: boolean;
}

const byPane = new Map<string, TaskViewState>();
const cleared = new Map<string, ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function put(paneId: string, view: TaskView): void {
  const was = byPane.get(paneId);
  // Opening another view keeps the "fill the window" choice; opening the same one again changes nothing.
  if (was && JSON.stringify(was.view) === JSON.stringify(view)) return;
  byPane.set(paneId, { view, full: was?.full ?? false });
  emit();
}

/** Opens one minion's read-only view in the column. */
export function openMinionView(paneId: string, minionId: string): void {
  put(paneId, { kind: 'minion', id: minionId });
}

/** Opens the full Background tasks page in the column. */
export function openTasksPage(paneId: string): void {
  put(paneId, { kind: 'page' });
}

export function closeTaskView(paneId: string): void {
  if (byPane.delete(paneId)) emit();
}

export function setTaskFull(paneId: string, full: boolean): void {
  const was = byPane.get(paneId);
  if (!was || was.full === full) return;
  byPane.set(paneId, { ...was, full });
  emit();
}

/** The trash button: the finished rows with these ids leave the list (nothing is stopped or deleted). */
export function clearFinishedTasks(paneId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  cleared.set(paneId, new Set([...(cleared.get(paneId) ?? NONE), ...ids]));
  emit();
}

export function useTaskView(paneId: string): TaskViewState | null {
  return useSyncExternalStore(subscribe, () => byPane.get(paneId) ?? null);
}

export function useClearedTasks(paneId: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => cleared.get(paneId) ?? NONE);
}

/** Tests: forget everything. */
export function resetTaskViews(): void {
  byPane.clear();
  cleared.clear();
  emit();
}
