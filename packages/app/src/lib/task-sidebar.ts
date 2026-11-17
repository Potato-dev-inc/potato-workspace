// Background tasks shown in the sidebar. A Background tasks row (a minion, or a command an agent left running) can also be a
// row in the sidebar: nested under the agent that owns it, or on its own. Where each one is shown lives on the PC (Rust
// `task_sidebar`, a file in the app data folder), so the phone's drawer shows the same rows. Here: the list, kept in memory
// and read again on demand, and the moves. A move shows at once and is undone when the PC says no.
//
// A task id is stable for the task's life: `minion:<pane_id>`, `job:<pane_id>:<pid>:<started_ms>`.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> => (isTauri() ? invoke<T>(command, args) : Promise.reject(new Error(`Desktop shell required: ${command}`)));

export type TaskKind = 'minion' | 'command';

export interface TaskPlacement {
  task_id: string;
  kind: TaskKind;
  /** The agent that owns the task (its pane id). A hand-over changes it; a move in the sidebar never does. */
  owner: string;
  /** The agent row it is nested under; null: on its own at the top level. */
  under: string | null;
  name: string;
  /** A command's full line (a tooltip only). */
  command?: string | null;
}

export const minionTaskId = (paneId: string): string => `minion:${paneId}`;
export const jobTaskId = (owner: string, pid: number, startedAtMs: number): string => `job:${owner}:${pid}:${startedAtMs}`;
/** The pane of a minion task id, or null for another kind. */
export const minionPaneOf = (taskId: string): string | null => (taskId.startsWith('minion:') ? taskId.slice('minion:'.length) : null);

export interface TaskSidebarApi {
  get: () => Promise<TaskPlacement[]>;
  show: (row: TaskPlacement) => Promise<TaskPlacement[]>;
  place: (taskId: string, under: string | null) => Promise<TaskPlacement[]>;
  remove: (taskId: string) => Promise<TaskPlacement[]>;
  reorder: (order: string[]) => Promise<TaskPlacement[]>;
}

interface Store {
  rows: TaskPlacement[];
}
const toRows = (store: Store | null | undefined): TaskPlacement[] => (store?.rows ?? []).map((r) => ({ ...r, under: r.under ?? null }));

export const tauriTaskSidebarApi: TaskSidebarApi = {
  get: async () => toRows(await call<Store>('task_sidebar_get')),
  show: async (row) => toRows(await call<Store>('task_sidebar_show', { row })),
  place: async (taskId, under) => toRows(await call<Store>('task_sidebar_place', { taskId, under })),
  remove: async (taskId) => toRows(await call<Store>('task_sidebar_remove', { taskId })),
  reorder: async (order) => toRows(await call<Store>('task_sidebar_reorder', { order })),
};

let api: TaskSidebarApi = tauriTaskSidebarApi;
let rows: readonly TaskPlacement[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const set = (next: readonly TaskPlacement[]) => {
  rows = next;
  emit();
};

/** Reads the list from the PC (no desktop shell: it stays as it is). */
export async function reloadTaskSidebar(): Promise<void> {
  try {
    set(await api.get());
    loaded = true;
  } catch {
    /* no desktop shell: the rows stay in memory */
  }
}

/** Runs a change: shown at once, then the PC's answer replaces the list. A refusal puts the list back. */
async function change(optimistic: (rows: readonly TaskPlacement[]) => readonly TaskPlacement[], call: () => Promise<TaskPlacement[]>): Promise<void> {
  const before = rows;
  set(optimistic(before));
  try {
    set(await call());
  } catch (e) {
    set(before);
    throw e;
  }
}

/** Puts a task in the sidebar, under `row.under` (an agent's pane) or on its own (null). Moves it when it is there already. */
export function showTaskInSidebar(row: TaskPlacement): Promise<void> {
  return change(
    (list) => (list.some((r) => r.task_id === row.task_id) ? list.map((r) => (r.task_id === row.task_id ? row : r)) : [...list, row]),
    () => api.show(row),
  );
}

/** Nests the row under an agent, or sets it on its own (null). */
export function placeTask(taskId: string, under: string | null): Promise<void> {
  return change(
    (list) => list.map((r) => (r.task_id === taskId ? { ...r, under } : r)),
    () => api.place(taskId, under),
  );
}

/** "Back to Background tasks": the row goes. The task keeps running. */
export function removeTaskFromSidebar(taskId: string): Promise<void> {
  return change(
    (list) => list.filter((r) => r.task_id !== taskId),
    () => api.remove(taskId),
  );
}

export function reorderTasks(order: string[]): Promise<void> {
  return change(
    (list) => [...order.flatMap((id) => list.filter((r) => r.task_id === id)), ...list.filter((r) => !order.includes(r.task_id))],
    () => api.reorder(order),
  );
}

/** A hand-over moved the task to another agent: the row follows (this window's copy; the PC did the same). */
export function followHandOver(taskId: string, newOwner: string): void {
  set(rows.map((r) => (r.task_id === taskId ? { ...r, owner: newOwner, under: r.under === r.owner ? newOwner : r.under } : r)));
}

/** The rows, newest list from the PC. Reads once on first use. */
export function useTaskSidebar(): readonly TaskPlacement[] {
  const list = useSyncExternalStore(subscribe, () => rows);
  if (!loaded) {
    loaded = true;
    void reloadTaskSidebar();
  }
  return list;
}

/** The row for a task, or undefined when it is not in the sidebar. */
export const useTaskPlacement = (taskId: string): TaskPlacement | undefined => useTaskSidebar().find((r) => r.task_id === taskId);

export const taskRowsOf = (list: readonly TaskPlacement[], under: string): TaskPlacement[] => list.filter((r) => r.under === under);
export const ownRows = (list: readonly TaskPlacement[]): TaskPlacement[] => list.filter((r) => r.under === null);

/** Tests: use a fake backend and start empty. */
export function setTaskSidebarApiForTest(next: TaskSidebarApi | null, start: readonly TaskPlacement[] = []): void {
  api = next ?? tauriTaskSidebarApi;
  rows = start;
  loaded = next !== null;
  emit();
}
