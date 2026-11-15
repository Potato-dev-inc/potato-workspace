// "Leaving my desk": the state the PC keeps (`mobile_pairing::desk_away`), the small store that shares it between the status bar,
// the palette and the banner, and the phone's bridge calls. The PC decides everything; this only shows and asks.
import { useSyncExternalStore } from 'react';
import { NOT_AWAY, type DeskAway, type DeskLength } from './desk-away-types';
import { tauri } from './tauri';

export { DESK_LENGTHS, NOT_AWAY } from './desk-away-types';
export type { DeskAway, DeskLength } from './desk-away-types';

/** What the PC's screen can do about it. */
export interface DeskApi {
  get: () => Promise<DeskAway>;
  start: (length: DeskLength, lockScreen: boolean) => Promise<DeskAway>;
  back: () => Promise<DeskAway>;
  /** The switch changed somewhere (the phone flipped it, or its time ran out). Resolves to the way to stop listening. */
  onChange: (cb: (state: DeskAway) => void) => Promise<() => void>;
}

export const tauriDeskApi: DeskApi = {
  get: () => tauri.getDeskAway(),
  start: (length, lockScreen) => tauri.startDeskAway(length, lockScreen),
  back: () => tauri.endDeskAway(),
  onChange: (cb) => tauri.onDeskAway(cb),
};

/** `true` while the switch is on at `now` (a state whose end time has passed counts as over before the PC says so). */
export function isAway(state: DeskAway, now = Date.now()): boolean {
  return state.away && (state.until_ms == null || state.until_ms > now);
}

export interface DeskStore {
  getState: () => DeskAway;
  subscribe: (listener: () => void) => () => void;
  start: (length: DeskLength, lockScreen: boolean) => Promise<void>;
  back: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** One store per api: every piece of screen that shows the switch reads the same one. */
export function createDeskStore(api: DeskApi): DeskStore {
  let state: DeskAway = NOT_AWAY;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (value: DeskAway) => {
    // Whatever the PC says, a state that is not a state (an old PC, a test) counts as "not away".
    const next = value && typeof value.away === 'boolean' ? value : NOT_AWAY;
    state = next;
    if (timer) clearTimeout(timer);
    timer = undefined;
    // The PC lets it go on its own at the end time; look again just after, so the screen never shows a stale "Away".
    if (next.away && typeof next.until_ms === 'number') {
      const wait = Math.min(Math.max(next.until_ms - Date.now() + 500, 500), 2 ** 31 - 1);
      timer = setTimeout(() => void refresh(), wait);
    }
    listeners.forEach((l) => l());
  };
  const refresh = async () => {
    try {
      set(await api.get());
    } catch {
      /* the PC could not be asked: keep what is shown */
    }
  };
  const begin = () => {
    if (started) return;
    started = true;
    void refresh();
    void api.onChange(set).catch(() => undefined);
  };
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      begin();
      return () => void listeners.delete(listener);
    },
    start: async (length, lockScreen) => set(await api.start(length, lockScreen)),
    back: async () => set(await api.back()),
    refresh,
  };
}

let shared: DeskStore | null = null;
/** The store the app itself uses (the PC's own commands). */
export function deskStore(): DeskStore {
  return (shared ??= createDeskStore(tauriDeskApi));
}

export function useDeskAway(store: DeskStore = deskStore()): [DeskAway, DeskStore] {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return [state, store];
}

// --- the phone's side: the same switch over the bridge ------------------------------------------------------------

export interface DeskPhoneApi {
  get: () => Promise<DeskAway>;
  start: (length: DeskLength, lockScreen: boolean) => Promise<DeskAway>;
  back: () => Promise<DeskAway>;
}

// --- the sheet that asks how long (opened from the status bar chip and the palette) ---------------------------------

let sheetOpen = false;
const sheetListeners = new Set<() => void>();
const subscribeSheet = (listener: () => void) => {
  sheetListeners.add(listener);
  return () => void sheetListeners.delete(listener);
};

export function setDeskSheetOpen(open: boolean): void {
  if (sheetOpen === open) return;
  sheetOpen = open;
  sheetListeners.forEach((l) => l());
}

export function openDeskSheet(): void {
  setDeskSheetOpen(true);
}

export function useDeskSheetOpen(): boolean {
  return useSyncExternalStore(subscribeSheet, () => sheetOpen, () => sheetOpen);
}

const LOCK_KEY = 'pm-desk-lock-screen';

/** The person's last choice for "Lock screen control" (a convenience only: the sheet works without it). */
export function readLockChoice(): boolean {
  try {
    return window.localStorage.getItem(LOCK_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLockChoice(on: boolean): void {
  try {
    window.localStorage.setItem(LOCK_KEY, on ? '1' : '0');
  } catch {
    /* private window: the choice is simply not remembered */
  }
}
