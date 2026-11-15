// A pane's chat, or one of its file tabs, in its own window ("Open in a new window"). The window is another view of the
// same pane: no second agent starts. While the chat is out, the pane shows a note with "Put back"; closing the window
// puts it back (the Rust side tells every window with `tabwin://closed`). A file tab simply leaves the pane's tab row
// and returns to it. Same pattern as an artifact's "Open in a window" (`artifacts_pop_out`).
import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { closeFileTab, fileTabId, openFileTab, pathOfTab } from './file-tabs';

export const CHAT_TAB = 'chat';
export const TAB_CLOSED_EVENT = 'tabwin://closed';

/** The tab name the window commands use for a file. */
export const fileWindowTab = (path: string): string => fileTabId(path);

export interface TabClosed {
  paneId: string;
  tab: string;
}

export interface TabWindowsApi {
  open(paneId: string, tab: string, title: string): Promise<void>;
  putBack(paneId: string, tab: string): Promise<void>;
  /** Calls `cb` when any tab window closes. Returns the stop function. */
  onClosed(cb: (e: TabClosed) => void): Promise<() => void>;
}

export const tabWindowsApi: TabWindowsApi = {
  open: (paneId, tab, title) => invoke<void>('tab_window_open', { paneId, tab, title }),
  putBack: (paneId, tab) => invoke<void>('tab_window_put_back', { paneId, tab }),
  onClosed: async (cb) => {
    try {
      return await listen<TabClosed>(TAB_CLOSED_EVENT, (e) => cb(e.payload));
    } catch {
      return () => undefined; // not inside the app (a browser preview)
    }
  },
};

// Which panes have their chat out in a window (this app run only).
const chatOut = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function publish(): void {
  snapshot = new Set(chatOut);
  for (const l of [...listeners]) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The chat of this pane is open in its own window. */
export function useChatInWindow(paneId: string): boolean {
  return useSyncExternalStore(subscribe, () => snapshot).has(paneId);
}

export function isChatInWindow(paneId: string): boolean {
  return chatOut.has(paneId);
}

/** Opens the pane's chat in its own window; the pane shows a "Put back" note meanwhile. */
export async function openChatInWindow(paneId: string, title: string, api: TabWindowsApi = tabWindowsApi): Promise<void> {
  await api.open(paneId, CHAT_TAB, title);
  chatOut.add(paneId);
  publish();
}

/** Opens a file tab in its own window; it leaves the pane's tab row until the window closes. */
export async function openFileInWindow(paneId: string, path: string, title: string, api: TabWindowsApi = tabWindowsApi): Promise<void> {
  await api.open(paneId, fileWindowTab(path), title);
  closeFileTab(paneId, path);
}

/** Closes the chat's window from the pane's note (the same as closing the window). */
export async function putChatBack(paneId: string, api: TabWindowsApi = tabWindowsApi): Promise<void> {
  await api.putBack(paneId, CHAT_TAB);
}

/** A window closed: its chat or file is back in the pane. */
export function applyTabClosed(e: TabClosed): void {
  if (e.tab === CHAT_TAB) {
    if (chatOut.delete(e.paneId)) publish();
    return;
  }
  const path = pathOfTab(e.tab);
  if (path !== null) openFileTab(e.paneId, path);
}

/** Mounted once in the cockpit: puts a tab back when its window closes. */
export function useTabWindowRestore(api: TabWindowsApi = tabWindowsApi): void {
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    void api.onClosed(applyTabClosed).then((stop) => (gone ? stop() : (off = stop)));
    return () => {
      gone = true;
      off?.();
    };
  }, [api]);
}

/** Tests start with every chat in its pane. */
export function resetTabWindows(): void {
  chatOut.clear();
  publish();
}
