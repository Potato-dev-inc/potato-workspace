// The undo bar: after something the person can take back (close an agent, throw away a copy, stop all, delete a
// closed chat, remove a project) one small bar shows for 8 seconds: "Closed Billing tests · Undo".
// One bar at a time. A new one replaces the old one, and the old one is then final (its `commit` runs at once).
// An action that cannot really be taken back later (delete, discard) passes `commit`: it runs when the bar ends,
// and Undo cancels it, so nothing is lost before the person had a chance.
import { useSyncExternalStore } from 'react';

export const UNDO_BAR_MS = 8000;

export interface UndoBarItem {
  /** A new number for every bar. */
  id: number;
  text: string;
  /** Takes the action back. Absent: the bar only tells (no Undo button). */
  undo?: () => Promise<void> | void;
  /** Runs when the bar ends without Undo (the action is final then). */
  commit?: () => Promise<void> | void;
  /** Said when `commit` or `undo` fails. */
  failText?: string;
}

export interface UndoBarInput {
  text: string;
  undo?: UndoBarItem['undo'];
  commit?: UndoBarItem['commit'];
  failText?: string;
  ms?: number;
}

let current: UndoBarItem | null = null;
let nextId = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let left = UNDO_BAR_MS;
let startedAt = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());
const clearTimer = () => {
  if (timer) clearTimeout(timer);
  timer = null;
};

function arm(ms: number, id: number): void {
  clearTimer();
  left = ms;
  startedAt = Date.now();
  timer = setTimeout(() => finish(id), ms);
}

/** Runs the commit of a bar that ends without Undo. A failure shows a short plain bar. */
function settle(item: UndoBarItem): void {
  if (!item.commit) return;
  Promise.resolve()
    .then(() => item.commit?.())
    .catch(() => {
      if (item.failText) showUndo({ text: item.failText });
    });
}

function finish(id: number): void {
  if (!current || current.id !== id) return;
  const item = current;
  current = null;
  clearTimer();
  emit();
  settle(item);
}

/** Shows the bar. Returns its id. */
export function showUndo(input: UndoBarInput): number {
  const previous = current;
  const id = ++nextId;
  current = { id, text: input.text, undo: input.undo, commit: input.commit, failText: input.failText };
  arm(input.ms ?? (input.undo ? UNDO_BAR_MS : 4000), id);
  emit();
  if (previous) settle(previous);
  return id;
}

/** The bar ends now, as if its time ran out (what a close of the window or a sheet means). */
export function finishUndo(id: number): void {
  finish(id);
}

/** Undo: cancels the commit and takes the action back. */
export function runUndo(id?: number): boolean {
  const item = current;
  if (!item || !item.undo || (id !== undefined && item.id !== id)) return false;
  current = null;
  clearTimer();
  emit();
  Promise.resolve()
    .then(() => item.undo?.())
    .catch(() => {
      if (item.failText) showUndo({ text: item.failText });
    });
  return true;
}

/** Holds the time while the pointer or focus is on the bar; it starts again where it stopped. */
export function holdUndo(on: boolean): void {
  if (!current) return;
  if (on) {
    if (!timer) return;
    left = Math.max(1000, left - (Date.now() - startedAt));
    clearTimer();
  } else if (!timer) {
    arm(left, current.id);
  }
}

export function currentUndo(): UndoBarItem | null {
  return current;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useUndoBar(): UndoBarItem | null {
  return useSyncExternalStore(subscribe, currentUndo, currentUndo);
}

/** For tests: forget the bar without running anything. */
export function resetUndoBar(): void {
  current = null;
  clearTimer();
  emit();
}
