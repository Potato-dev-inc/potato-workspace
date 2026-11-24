// The docked agent browser, the app's side (Labs "Browser in the side panel", `dock_browser_enabled`).
//
// The browser pane reports the rectangle of its page area in window pixels, or null while it is hidden (the column is
// folded, the pane is folded, another chat is shown, the pane is closed). Rust (`browser/dock.rs`) puts the page, a native
// child webview, exactly there, and hides it (it does not size it to zero) on null. One listener, because there is one page.
// The calls below are the pane's buttons: tabs, back, forward, reload, the address, mark up, pop out, dock back, and the
// freeze that keeps the page from drawing over a menu.
import { invoke } from '@tauri-apps/api/core';
import { listen } from './events';
import { useEffect, useState } from 'react';
import { loadSettings } from './settings';
import { tauri } from './tauri';

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Listener = (paneId: string, rect: PageRect | null) => void;
let listener: Listener | null = null;
const last = new Map<string, PageRect>();

const same = (a: PageRect | undefined, b: PageRect | null): boolean => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** The browser follows the page rectangle through this. Returns the way to stop. */
export function onBrowserRect(fn: Listener): () => void {
  listener = fn;
  for (const [id, rect] of last) fn(id, rect);
  return () => {
    if (listener === fn) listener = null;
  };
}

/** The pane says where its page is now (null: hidden). Repeats of the same rectangle are not passed on. */
export function reportBrowserRect(paneId: string, rect: PageRect | null): void {
  if (rect === null ? !last.has(paneId) : same(last.get(paneId), rect)) return;
  if (rect === null) last.delete(paneId);
  else last.set(paneId, rect);
  listener?.(paneId, rect);
}

/** Where the page is now, for tests and for a browser that starts after the pane. */
export function currentBrowserRect(paneId: string): PageRect | null {
  return last.get(paneId) ?? null;
}

/** Any pane's page rectangle (there is one page at a time), or null when none is showing. */
export function anyBrowserRect(): PageRect | null {
  for (const rect of last.values()) return rect;
  return null;
}

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Is the Labs switch "Browser in the side panel" on? Off until the app answers. */
export function useDockBrowserEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    // Rust keeps the page in its own window on Linux (see `dock::enabled`), so the pane is not offered there.
    if (!inTauri()) return undefined;
    let disposed = false;
    let off: (() => void) | undefined;
    // The OS comes from Rust (`std::env::consts::OS`); WebKitGTK's user agent was not a reliable signal.
    const read = () =>
      Promise.all([loadSettings(), tauri.getAppInstallInfo()]).then(
        ([s, info]) => !disposed && setOn(info?.platform !== 'linux' && (s as { dock_browser_enabled?: boolean }).dock_browser_enabled === true),
        () => undefined,
      );
    void read();
    listen('settings://changed', () => void read())
      .then((un) => (disposed ? un() : (off = un)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return on;
}

/**
 * Keeps Rust told where the page is, and opens the pane when an agent opens a page. Mount once, in the cockpit.
 * `onOpen` gets the chat that asked (or null for the chat in front).
 */
export function startDockBrowserBridge(onOpen: (paneId: string | null) => void): () => void {
  if (!inTauri()) return () => undefined;
  const stopRect = onBrowserRect((_id, rect) => {
    // A pane that hides while another one shows must not hide the page of the other.
    const now = rect ?? anyBrowserRect();
    void invoke('dock_browser_rect', { rect: now }).catch(() => undefined);
  });
  let off: (() => void) | undefined;
  let disposed = false;
  listen<{ paneId?: string | null }>('dock-browser-open', (e) => onOpen(e.payload?.paneId ?? null))
    .then((un) => (disposed ? un() : (off = un)))
    .catch(() => undefined);
  return () => {
    disposed = true;
    stopRect();
    off?.();
  };
}

/** One tab of the pane, as Rust sees it. */
export interface DockTab {
  id: string;
  title: string;
  url: string;
  error: string;
  active: boolean;
  /** The page is in a window of its own. */
  popped: boolean;
}

export const dockTabs = (): Promise<DockTab[]> => invoke<DockTab[]>('dock_browser_tabs').catch(() => []);

/** Follows the tab list. Returns the way to stop. */
export function onDockTabs(fn: (tabs: DockTab[]) => void): () => void {
  if (!inTauri()) return () => undefined;
  let off: (() => void) | undefined;
  let disposed = false;
  listen<DockTab[]>('dock-browser-tabs', (e) => fn(e.payload ?? []))
    .then((un) => (disposed ? un() : (off = un)))
    .catch(() => undefined);
  return () => {
    disposed = true;
    off?.();
  };
}

const call = (cmd: string, args?: Record<string, unknown>): Promise<void> => invoke<void>(cmd, args).catch(() => undefined);

export const dockNav = (kind: 'back' | 'forward' | 'reload' | 'go', url?: string) => call('dock_browser_nav', { kind, url });
export const dockMarkUp = () => call('dock_browser_mark_up');
export const dockSelect = (id: string) => call('dock_browser_select', { id });
export const dockClose = (id: string) => call('dock_browser_close', { id });
/** `auto`: the pane has no tab and opens a start page by itself (Rust steps aside when a page is being opened). */
export const dockNewTab = (auto = false) => call('dock_browser_new_tab', { auto });
export const dockPopOut = (id: string) => call('dock_browser_popout', { id });
export const dockBack = (id: string) => call('dock_browser_dockback', { id });

/** A picture of the page in front, for the pane to show while something is drawn over it. Empty when there is none. */
export const dockSnapshot = (): Promise<ArrayBuffer> => invoke<ArrayBuffer>('dock_browser_snapshot').catch(() => new ArrayBuffer(0));
/** Hide the page (a menu, a sheet or a drag is over it), or show it again. */
export const dockFreeze = (frozen: boolean) => call('dock_browser_freeze', { frozen });

/** Only plain web addresses go to the person's own browser. */
export const isWebAddress = (url: string): boolean => /^https?:\/\/[^\s/]+/i.test(url.trim());
/** Open this page in the person's own browser (the system default), through the app's existing opener. */
export const dockOpenOutside = (url: string) => (isWebAddress(url) ? call('open_external_url', { url: url.trim() }) : Promise.resolve());
