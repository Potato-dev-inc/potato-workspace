// A page the agent made, open BESIDE the chat: a pane of its own between the chat and the right panel. The chat stays
// mounted and keeps its place; this pane only adds room to its right (or, "full width", lies over the whole row).
//
// State is per chat pane and in memory for this run (like the open files). Only the pane's width is remembered
// (`pm.artside.width`). The right panel's "Outputs" rows call `openArtifactBeside(id)`; the chat card calls it too.
import { useSyncExternalStore } from 'react';
import { noteArtifactTitle } from './artifact-tabs';

export interface ArtifactSide {
  id: string;
  /** The page lies over the chat and the right panel (the "full width" button). */
  full: boolean;
}

export const ARTSIDE_DEFAULT = 520;
export const ARTSIDE_MIN = 320;
export const ARTSIDE_MAX = 900;
export const ARTSIDE_KEY = 'pm.artside.width';
/** The chat beside the page never gets narrower than this (the page gives way). */
export const ARTSIDE_CHAT_MIN = 360;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A dragged width as one the pane takes. */
export function sideWidthFromPx(px: number): number {
  return Number.isFinite(px) ? Math.round(clamp(px, ARTSIDE_MIN, ARTSIDE_MAX)) : ARTSIDE_DEFAULT;
}

/** The width shown: what was chosen, held back so the chat keeps `ARTSIDE_CHAT_MIN` (never below the minimum). */
export function sideWidthShown(chosen: number, rowWidth: number, railPx: number): number {
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) return chosen;
  return Math.max(ARTSIDE_MIN, Math.min(chosen, rowWidth - railPx - ARTSIDE_CHAT_MIN));
}

function readWidth(): number {
  try {
    const raw = window.localStorage.getItem(ARTSIDE_KEY);
    return raw === null ? ARTSIDE_DEFAULT : sideWidthFromPx(Number(raw));
  } catch {
    return ARTSIDE_DEFAULT;
  }
}

const byPane = new Map<string, ArtifactSide>();
let width: number | null = null;
/** The chat pane a call without a pane means (the one on screen; set by the pane view). */
let activePane: string | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The pane view says which chat pane is on screen, so `openArtifactBeside(id)` from the right panel knows where to open. */
export function setActiveArtifactPane(paneId: string | null): void {
  activePane = paneId;
}

/**
 * Opens a page beside the chat. `paneId` is the chat that made it; the right panel's Outputs rows may leave it out
 * and get the chat on screen. Returns false when there is no chat to open it beside.
 */
export function openArtifactBeside(id: string, paneId?: string, title?: string): boolean {
  const pane = paneId ?? activePane;
  if (!pane) return false;
  if (title) noteArtifactTitle(id, title);
  const was = byPane.get(pane);
  // Opening another page keeps the full-width choice; opening the same one again changes nothing.
  if (was?.id === id) return true;
  byPane.set(pane, { id, full: was?.full ?? false });
  emit();
  return true;
}

const wantsPoint = new Set<string>();
/** "Try it" on Point and fix: the page that opens beside this chat starts in pick mode. */
export function requestArtifactPoint(paneId: string): void {
  wantsPoint.add(paneId);
}
/** The side page asks once it is loaded: true when a pick was requested (and forgets the request). */
export function takeArtifactPoint(paneId: string): boolean {
  return wantsPoint.delete(paneId);
}

export function closeArtifactBeside(paneId: string): void {
  if (byPane.delete(paneId)) emit();
}

export function setArtifactFull(paneId: string, full: boolean): void {
  const cur = byPane.get(paneId);
  if (!cur || cur.full === full) return;
  byPane.set(paneId, { ...cur, full });
  emit();
}

export function useArtifactSide(paneId: string): ArtifactSide | null {
  return useSyncExternalStore(subscribe, () => byPane.get(paneId) ?? null);
}

export function setArtifactSideWidth(px: number): void {
  const next = sideWidthFromPx(px);
  if (next === (width ?? readWidth())) return;
  width = next;
  emit();
}
export function saveArtifactSideWidth(): void {
  try {
    window.localStorage.setItem(ARTSIDE_KEY, String(width ?? readWidth()));
  } catch {
    // Just not remembered.
  }
}
export function resetArtifactSideWidth(): void {
  width = ARTSIDE_DEFAULT;
  emit();
  saveArtifactSideWidth();
}
export function useArtifactSideWidth(): number {
  return useSyncExternalStore(subscribe, () => width ?? (width = readWidth()));
}

/** Tests: forget everything. */
export function resetArtifactSideForTests(): void {
  byPane.clear();
  wantsPoint.clear();
  width = null;
  activePane = null;
  emit();
}
