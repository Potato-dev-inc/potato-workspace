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
/** A window narrower than this shows the sidebar as the thin strip, so the content pane keeps the room. */
export const NARROW_WINDOW = 800;
export const RAIL_DEFAULT = 300;
export const RAIL_MIN = 240;
export const RAIL_MAX = 520;
/** Dragging the right panel narrower than this closes it (the remembered width stays the last good one). */
export const RAIL_SNAP = 200;
/** The right panel hides only when the chat beside it would get narrower than this. */
export const CHAT_MIN = 480;
/** The details column (the dock) to the right of the right panel. */
export const DOCK_DEFAULT = 460;
export const DOCK_MIN = 340;
export const DOCK_MAX = 720;
/** A stacked dock pane never gets shorter than this (its header and a line of body). */
export const DOCK_PANE_MIN = 160;
/** One arrow-key press moves a panel edge this far. */
export const KEY_STEP = 16;

export const SIDE_KEY = 'pm.sidebar.width';
export const RAIL_WIDTH_KEY = 'pm.rail.width';
export const DOCK_WIDTH_KEY = 'pm.dock.width';
export const DOCK_SPLIT_KEY = 'pm.dock.split';
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

/** Whether the sidebar is the strip at this window width: chosen by the person, or forced by a narrow window. */
export function sideIsStrip(size: SideSize, windowWidth: number): boolean {
  return size.strip || windowWidth < NARROW_WINDOW;
}

/** The pixels a sidebar size takes. */
export function sidePx(size: SideSize): number {
  return size.strip ? SIDE_STRIP : size.width;
}

export function railFromPx(px: number): number {
  return Number.isFinite(px) ? Math.round(clamp(px, RAIL_MIN, RAIL_MAX)) : RAIL_DEFAULT;
}

export function dockFromPx(px: number): number {
  return Number.isFinite(px) ? Math.round(clamp(px, DOCK_MIN, DOCK_MAX)) : DOCK_DEFAULT;
}

/** The relative heights of the dock's stacked panes, by slot ("view", "terminal", "browser"). Only ratios matter. */
export type DockWeights = Record<string, number>;

/**
 * A splitter between two neighbouring panes moved to `topPx` (the upper pane's new height) inside `pairPx` (both panes
 * together). Their weights keep the same sum, and neither pane gets shorter than DOCK_PANE_MIN.
 */
export function moveSplit(weights: DockWeights, upper: string, lower: string, topPx: number, pairPx: number): DockWeights {
  const sum = (weights[upper] ?? 1) + (weights[lower] ?? 1);
  if (!Number.isFinite(topPx) || pairPx <= 2 * DOCK_PANE_MIN) return weights;
  const top = clamp(topPx, DOCK_PANE_MIN, pairPx - DOCK_PANE_MIN);
  const w = (top / pairPx) * sum;
  return { ...weights, [upper]: Math.round(w * 1000) / 1000, [lower]: Math.round((sum - w) * 1000) / 1000 };
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

/** The chat beside the right panel and the dock keeps at least this much (the composer stays usable); the dock gives way first. */
export const CHAT_FLOOR = 320;
/** The narrowest the dock gets squeezed to for that (a dragged width is still held to DOCK_MIN). */
export const DOCK_SQUEEZE_MIN = 240;

/** The width the dock shows at: what was chosen, held back so the chat keeps CHAT_FLOOR. */
export function dockShown(chosen: number, windowWidth: number, side: number, rail: number): number {
  return Math.max(DOCK_SQUEEZE_MIN, Math.min(chosen, windowWidth - side - rail - CHAT_FLOOR));
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

function readDock(): number {
  const raw = read(DOCK_WIDTH_KEY);
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) ? dockFromPx(n) : DOCK_DEFAULT;
}
function readWeights(): DockWeights {
  try {
    const parsed: unknown = JSON.parse(read(DOCK_SPLIT_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0)) as DockWeights;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- the shared state

export interface PanelWidths {
  side: SideSize;
  rail: number;
  /** The details column's width. */
  dock: number;
  /** How the dock's stacked panes share its height. */
  split: DockWeights;
}

let state: PanelWidths | null = null;
const listeners = new Set<() => void>();

function current(): PanelWidths {
  if (!state) state = { side: readSide(), rail: readRail(), dock: readDock(), split: readWeights() };
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
export function setDockWidth(px: number): void {
  const dock = dockFromPx(px);
  const was = current();
  if (dock === was.dock) return;
  state = { ...was, dock };
  emit();
}
export function resetDockWidth(): void {
  state = { ...current(), dock: DOCK_DEFAULT };
  emit();
  saveWidths();
}
/** Moves the splitter between two dock panes. Not saved until `saveWidths`. */
export function setDockSplit(split: DockWeights): void {
  state = { ...current(), split };
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
  const { side, rail, dock, split } = current();
  write(SIDE_KEY, side.strip ? STRIP_VALUE : String(side.width));
  write(RAIL_WIDTH_KEY, String(rail));
  write(DOCK_WIDTH_KEY, String(dock));
  write(DOCK_SPLIT_KEY, JSON.stringify(split));
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
  const strip = sideIsStrip(side, w);
  const s = focus ? 0 : sidePx({ ...side, strip });
  return { sidePx: s, railPx: railShown(rail, w, s), railFits: railFits(w, s), strip: strip && !focus };
}
