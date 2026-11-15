// What's new state: the last version whose card was closed or whose tour was opened (`pm.whatsnew.seen`), the running
// version, and whether the tour is open. Storage is guarded: with none, the card may show again after a restart.
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSyncExternalStore } from 'react';
import { hasTour, latestVersion, normalVersion } from './catalog';

export const SEEN_KEY = 'pm.whatsnew.seen';

export function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

interface State {
  running: string | null;
  tour: { version: string } | null;
  /** Bumped when the seen mark changes, so the Help menu's pill redraws. */
  seen: string | null;
}
let state: State = { running: null, tour: null, seen: null };
const listeners = new Set<() => void>();
function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const snapshot = () => state;

/** Mark a version as seen (its card was closed, or its tour was opened). */
export function markSeen(version: string): void {
  const v = normalVersion(version);
  try {
    window.localStorage.setItem(SEEN_KEY, v);
  } catch {
    /* no storage */
  }
  set({ seen: v });
}

export const isSeen = (version: string | null | undefined): boolean => !!version && normalVersion(readSeen()) === normalVersion(version);

/** The running version, when the shell knows it (the update host reads it once). */
export function setRunningVersion(version: string | null): void {
  if (state.running === version) return;
  set({ running: version });
}

/** The version "What's new" talks about: the running one, else the newest bundled one. */
export function whatsNewVersion(): string {
  const running = normalVersion(state.running);
  return running || latestVersion();
}

/** Open the tour (Help, the palette, Settings, or the card's button). Opening it marks the version as seen. */
export function openTour(version: string = whatsNewVersion()): void {
  if (remote) return askMainWindow({ kind: 'tour', version });
  markSeen(version);
  // No tour for this version (no file, or fewer than 3 cards): the Feature guide is the place to look.
  if (!hasTour(version)) return requestGuide();
  set({ tour: { version } });
}

export function closeTour(): void {
  set({ tour: null });
}

export function useWhatsNewState(): State {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test helper: back to a clean state. */
export function resetWhatsNewForTests(): void {
  set({ running: null, tour: null, seen: null });
}

// Asking the cockpit for a page: the Feature guide, the shortcuts sheet, or a main view.
export const OPEN_GUIDE_EVENT = 'pm:open-guide';
export const OPEN_SHORTCUTS_EVENT = 'pm:open-shortcuts';
export const OPEN_VIEW_EVENT = 'pm:open-view';
export function requestGuide(): void {
  if (remote) return askMainWindow({ kind: 'guide' });
  window.dispatchEvent(new CustomEvent(OPEN_GUIDE_EVENT));
}
export function requestShortcuts(): void {
  if (remote) return askMainWindow({ kind: 'shortcuts' });
  window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
}

// A window with no tour of its own (the standalone Settings window) hands these asks to the cockpit window as an app
// event, the way the Add-an-agent buttons do (lib/addAgentActions.ts). The cockpit answers and comes to the front.
export const WHATSNEW_ASK_EVENT = 'whatsnew://ask';
export type WhatsNewAsk = { kind: 'tour'; version?: string } | { kind: 'guide' } | { kind: 'shortcuts' };
let remote = false;
/** This window has no tour or guide: send those asks to the cockpit window. */
export function setWhatsNewRemote(on: boolean): void {
  remote = on;
}
function askMainWindow(ask: WhatsNewAsk): void {
  try {
    void emit(WHATSNEW_ASK_EVENT, ask).catch(() => undefined);
  } catch {
    // A plain browser has no app events.
  }
}

/** What an ask carries, checked: only the three kinds, and a plain version word. Anything else is dropped. */
export function parseAsk(payload: unknown): WhatsNewAsk | null {
  const p = payload as { kind?: unknown; version?: unknown } | null;
  if (!p || typeof p !== 'object') return null;
  if (p.kind === 'guide' || p.kind === 'shortcuts') return { kind: p.kind };
  if (p.kind === 'tour') return { kind: 'tour', version: typeof p.version === 'string' && /^v?\d+(\.\d+){0,3}$/.test(p.version) ? p.version : undefined };
  return null;
}

/** The cockpit window answers asks from other windows. Returns the way to stop. */
export function listenForWhatsNewAsks(): () => void {
  let off: (() => void) | undefined;
  let stopped = false;
  try {
    void listen<unknown>(WHATSNEW_ASK_EVENT, (e) => {
      const ask = parseAsk(e.payload);
      if (!ask) return;
      const win = getCurrentWindow();
      void win.show().then(() => win.setFocus()).catch(() => undefined);
      if (ask.kind === 'tour') openTour(ask.version);
      else if (ask.kind === 'guide') requestGuide();
      else requestShortcuts();
    })
      .then((u) => (stopped ? u() : (off = u)))
      .catch(() => undefined);
  } catch {
    // A plain browser has no app events.
  }
  return () => {
    stopped = true;
    off?.();
  };
}
