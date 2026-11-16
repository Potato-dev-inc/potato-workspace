// Helpers with no progress for N minutes ("Stuck?"). The backend samples the helper panes and says when one is stuck
// (`pane-stall`); this keeps the answer per pane for the rows and the chat, and sends the three buttons.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useSyncExternalStore } from 'react';

let current: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

/** The backend (or a test) sets what is stuck now: pane id -> minutes. */
export function setStalls(next: ReadonlyMap<string, number>): void {
  current = next;
  for (const l of listeners) l();
}

/** One pane's answer: minutes without progress, or null. */
export function setStall(paneId: string, minutes: number | null): void {
  const next = new Map(current);
  if (minutes === null) next.delete(paneId);
  else next.set(paneId, minutes);
  setStalls(next);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let started = false;
/** Reads the list once and follows `pane-stall` events. Does nothing outside the desktop app. */
export function startStallSync(): void {
  if (started || !isTauri()) return;
  started = true;
  void invoke<{ pane_id: string; minutes: number }[]>('stalls_list')
    .then((rows) => setStalls(new Map(rows.map((r) => [r.pane_id, r.minutes] as const))))
    .catch(() => undefined);
  void listen<{ pane_id: string; minutes: number | null }>('pane-stall', (e) => setStall(e.payload.pane_id, e.payload.minutes)).catch(() => undefined);
}

/** Minutes this pane has had no progress, or null when it is not stuck. */
export function useStall(paneId: string | null | undefined): number | null {
  useEffect(() => startStallSync(), []);
  return useSyncExternalStore(
    subscribe,
    () => (paneId ? (current.get(paneId) ?? null) : null),
    () => null,
  );
}

/** Every pane that is stuck now (pane id -> minutes). The map is replaced, never changed, so it is a stable snapshot. */
const EMPTY: ReadonlyMap<string, number> = new Map();
export function useStalls(): ReadonlyMap<string, number> {
  useEffect(() => startStallSync(), []);
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
}

export interface StallApi {
  nudge: (paneId: string) => Promise<void>;
  stop: (paneId: string) => Promise<void>;
  respawn: (paneId: string) => Promise<void>;
}

export const tauriStallApi: StallApi = {
  nudge: (paneId) => invoke<void>('stall_nudge', { paneId }),
  stop: (paneId) => invoke<void>('stall_stop', { paneId }),
  respawn: async (paneId) => {
    await invoke<string>('stall_respawn', { paneId });
  },
};

export const STALL_CHOICES = [0, 1, 2, 3, 5, 10, 15, 30, 60];

export const tauriStallSettingApi = {
  get: () => invoke<{ value: number }>('stall_minutes_get'),
  set: (value: number) => invoke<{ value: number }>('stall_minutes_set', { value }),
};
export type StallSettingApi = typeof tauriStallSettingApi;
