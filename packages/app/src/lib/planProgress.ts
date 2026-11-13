// How far the agent's task list has come, and where each chat's progress is kept so the sidebar and the board can
// draw their thin line without the chat being open. Pure helpers plus a tiny in-memory store (the open chat publishes).
import { useSyncExternalStore } from 'react';
import type { PlanItem } from './sessionChatModel';

export interface PlanProgress {
  done: number;
  total: number;
  /** The step in progress, else the first one still to do; null when all are done. */
  current: string | null;
  allDone: boolean;
}

/** Counts of a task list, or null when there is no list. */
export function planProgress(items: readonly PlanItem[]): PlanProgress | null {
  if (items.length === 0) return null;
  const done = items.filter((item) => item.status === 'completed').length;
  const open = items.find((item) => item.status === 'in_progress') ?? items.find((item) => item.status === 'pending');
  return { done, total: items.length, current: open?.text ?? null, allDone: done === items.length };
}

const store = new Map<string, PlanProgress>();
const listeners = new Set<() => void>();

const same = (a: PlanProgress | undefined, b: PlanProgress | null): boolean =>
  a === undefined ? b === null : b !== null && a.done === b.done && a.total === b.total && a.current === b.current;

/** A chat says how far its list is. `null` (no list) forgets it. */
export function publishPlanProgress(paneId: string, progress: PlanProgress | null): void {
  if (same(store.get(paneId), progress)) return;
  if (progress) store.set(paneId, progress);
  else store.delete(paneId);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The progress of a pane's list that is still going on, or null (no list, or all done). */
export function usePlanProgress(paneId: string | undefined): PlanProgress | null {
  const value = useSyncExternalStore(subscribe, () => (paneId ? store.get(paneId) : undefined));
  return value && !value.allDone ? value : null;
}
