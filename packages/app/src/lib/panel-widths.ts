// How wide the sidebar and the right panel are. Both are dragged by the person and remembered (local storage; every
// read and write is guarded because storage can be blocked). The numbers and the rules live here, pure, so the
// handle, the sidebar, the panel and the tests all use the same ones.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { isFocusMode, subscribeFocusMode } from './focus-mode';

export const SIDE_DEFAULT = 240;
export const SIDE_MIN = 180;
export const SIDE_MAX = 420;
/** Dragging the sidebar narrower than this snaps it to the thin icon strip. */
export const SIDE_SNAP = 140;
export const SIDE_STRIP = 52;
export const RAIL_DEFAULT = 280;
export const RAIL_MIN = 240;
export const RAIL_MAX = 520;
/** The right panel hides only when the chat beside it would get narrower than this. */
export const CHAT_MIN = 480;
/** One arrow-key press moves a panel edge this far. */
export const KEY_STEP = 16;

export const SIDE_KEY = 'pm.sidebar.width';
export const RAIL_WIDTH_KEY = 'pm.rail.width';
/** What the sidebar key holds when the sidebar is the thin strip. */
const STRIP_VALUE = 'strip';

export interface SideSize {
  /** The width it has when it is not the strip (kept so leaving the strip goes back to it). */
  width: number;
  strip: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A dragged sidebar width as a size: below the snap point it is the strip; else it stays between the limits. */
export function sideFromPx(px: number): SideSize {
  if (!Number.isFinite(px)) return { width: SIDE_DEFAULT, strip: false };
  if (px < SIDE_SNAP) return { width: SIDE_MIN, strip: true };
  return { width: Math.round(clamp(px, SIDE_MIN, SIDE_MAX)), strip: false };
}

/** The pixels a sidebar size takes. */
export function sidePx(size: SideSize): number {
  return size.strip ? SIDE_STRIP : size.width;
}

export function railFromPx(px: number): number {
  return Number.isFinite(px) ? Math.round(clamp(px, RAIL_MIN, RAIL_MAX)) : RAIL_DEFAULT;
}

/** The room the right panel can have: the window, minus the sidebar, minus the chat's minimum. Never below RAIL_MIN. */
export function railRoom(windowWidth: number, side: number): number {
  return windowWidth - side - CHAT_MIN;
}

/** Whether the right panel (at its narrowest) leaves the chat enough room. */
export function railFits(windowWidth: number, side: number): boolean {
  return railRoom(windowWidth, side) >= RAIL_MIN;
}

/** The width the right panel shows at: what was chosen, held back so the chat keeps its minimum. */
export function railShown(chosen: number, windowWidth: number, side: number): number {
  return Math.max(RAIL_MIN, Math.min(chosen, railRoom(windowWidth, side)));
}

// ---------------------------------------------------------------- storage

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The choice just is not remembered.
  }
}

function readSide(): SideSize {
  const raw = read(SIDE_KEY);
  if (raw === STRIP_VALUE) return { width: SIDE_DEFAULT, strip: true };
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? { width: Math.round(clamp(n, SIDE_MIN, SIDE_MAX)), strip: false } : { width: SIDE_DEFAULT, strip: false };
}
function readRail(): number {
  const n = Number(read(RAIL_WIDTH_KEY));
  return read(RAIL_WIDTH_KEY) !== null && Number.isFinite(n) ? railFromPx(n) : RAIL_DEFAULT;
}

// ---------------------------------------------------------------- the shared state

export interface PanelWidths {
  side: SideSize;
  rail: number;
}

let state: PanelWidths | null = null;
const listeners = new Set<() => void>();

function current(): PanelWidths {
  if (!state) state = { side: readSide(), rail: readRail() };
  return state;
}
function emit(): void {
  for (const l of listeners) l();
}

/** Moves the sidebar edge (a drag or a key). `px` is where the edge is now; it is not saved until `saveWidths`. */
export function setSideWidth(px: number): void {
  const next = sideFromPx(px);
  const was = current();
  // A drag that ends up in the strip keeps the last real width, so leaving the strip is not a jump.
  const side = next.strip ? { width: was.side.width, strip: true } : next;
  if (side.width === was.side.width && side.strip === was.side.strip) return;
  state = { ...was, side };
  emit();
}
export function setRailWidth(px: number): void {
  const rail = railFromPx(px);
  const was = current();
  if (rail === was.rail) return;
  state = { ...was, rail };
  emit();
}
export function resetSideWidth(): void {
  state = { ...current(), side: { width: SIDE_DEFAULT, strip: false } };
  emit();
  saveWidths();
}
export function resetRailWidth(): void {
  state = { ...current(), rail: RAIL_DEFAULT };
  emit();
  saveWidths();
}
/** Remembers the widths. */
export function saveWidths(): void {
  const { side, rail } = current();
  write(SIDE_KEY, side.strip ? STRIP_VALUE : String(side.width));
  write(RAIL_WIDTH_KEY, String(rail));
}
/** Tests: forget the in-memory state so the next read comes from storage again. */
export function resetPanelWidthsForTests(): void {
  state = null;
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePanelWidths(): PanelWidths {
  return useSyncExternalStore(subscribe, current, current);
}

export function useWindowInnerWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1400 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

export interface Layout {
  /** Pixels the sidebar takes right now (0 in focus mode). */
  sidePx: number;
  /** Pixels the right panel shows at (before focus mode hides it). */
  railPx: number;
  /** The window leaves the chat enough room beside a right panel. */
  railFits: boolean;
  strip: boolean;
}

/** The sizes the screen uses, with the window and focus mode taken into account. */
export function useLayout(): Layout {
  const { side, rail } = usePanelWidths();
  const w = useWindowInnerWidth();
  const focus = useSyncExternalStore(subscribeFocusMode, isFocusMode, isFocusMode);
  const s = focus ? 0 : sidePx(side);
  return { sidePx: s, railPx: railShown(rail, w, s), railFits: railFits(w, s), strip: side.strip && !focus };
}
