// Pinned chats: the ones the person keeps at the top of the sidebar. Saved by the pane's id, newest pin first.
// A rename changes only the shown name, never the id, so a pin survives it.
import { useCallback, useEffect, useState } from 'react';

export const LS_PINNED_PANES = 'pm.sidebar.pinned';
const MAX_PINNED = 100;

/** The pinned ids, newest pin first. Never throws; broken storage reads as no pins. */
export function readPinnedPanes(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_PINNED_PANES) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== ''))].slice(0, MAX_PINNED);
  } catch {
    return [];
  }
}

/** Remember the pinned ids. Never throws. */
export function writePinnedPanes(ids: readonly string[]): void {
  try {
    localStorage.setItem(LS_PINNED_PANES, JSON.stringify(ids.slice(0, MAX_PINNED)));
  } catch {
    /* storage is off: pins last until the window closes */
  }
}

/** `ids` with `id` pinned (first) or unpinned. */
export function withPin(ids: readonly string[], id: string, pinned: boolean): string[] {
  const rest = ids.filter((x) => x !== id);
  return pinned ? [id, ...rest] : rest;
}

/** Splits `items` into the pinned ones (in pin order, newest first) and the rest (order kept). */
export function splitPinned<T>(items: readonly T[], idOf: (item: T) => string, pins: readonly string[]): { pinned: T[]; rest: T[] } {
  const byId = new Map(items.map((item) => [idOf(item), item] as const));
  const pinned = pins.flatMap((id) => (byId.has(id) ? [byId.get(id) as T] : []));
  const taken = new Set(pinned);
  return { pinned, rest: items.filter((item) => !taken.has(item)) };
}

/** The pinned ids and the way to change them; saved on every change. */
export function usePinnedPanes(): { pins: string[]; setPinned: (id: string, pinned: boolean) => void } {
  const [pins, setPins] = useState<string[]>(readPinnedPanes);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === LS_PINNED_PANES && setPins(readPinnedPanes());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const setPinned = useCallback((id: string, pinned: boolean) => {
    const next = withPin(readPinnedPanes(), id, pinned);
    writePinnedPanes(next);
    setPins(next);
  }, []);
  return { pins, setPinned };
}
