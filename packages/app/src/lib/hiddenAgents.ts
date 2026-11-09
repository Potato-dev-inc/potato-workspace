// Hidden agents: the agents the person does not want in the "New agent" menu. Saved in this browser's storage by the
// agent's id (like pinned chats). Hiding only changes the menu; the agent stays installed and registered.
// Rules: the menu always keeps at least one agent shown (`canHideAgent`), and if every agent in the list is hidden
// (for example after the others were removed) the menu shows them all again rather than an empty list.
import { useCallback, useEffect, useState } from 'react';

export const LS_HIDDEN_AGENTS = 'pm.newAgent.hidden';
/** Same-window change signal: two places in one window (menu and Settings) stay in step. */
export const HIDDEN_AGENTS_EVENT = 'pm:hidden-agents-changed';

/** The hidden agent ids, saved order. Never throws; broken storage reads as nothing hidden. */
export function readHiddenAgents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_HIDDEN_AGENTS) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== ''))];
  } catch {
    return [];
  }
}

/** Remember the hidden ids and tell the other places in this window. Never throws. */
export function writeHiddenAgents(ids: readonly string[]): void {
  try {
    localStorage.setItem(LS_HIDDEN_AGENTS, JSON.stringify([...new Set(ids)]));
  } catch {
    /* storage is off: the choice lasts until the window closes */
  }
  try {
    window.dispatchEvent(new Event(HIDDEN_AGENTS_EVENT));
  } catch {
    /* no window (tests without DOM): nothing to tell */
  }
}

/** `ids` with `id` hidden or shown again. */
export function withAgentHidden(ids: readonly string[], id: string, hidden: boolean): string[] {
  const rest = ids.filter((x) => x !== id);
  return hidden ? [...rest, id] : rest;
}

/**
 * The entries the menu shows: every entry whose type is not hidden, in the same order. When that would leave
 * nothing, all entries are shown (an empty menu helps nobody).
 */
export function visibleAgentEntries<T extends { type: string }>(entries: readonly T[], hidden: readonly string[]): T[] {
  const shown = entries.filter((entry) => !hidden.includes(entry.type));
  return shown.length > 0 ? shown : [...entries];
}

/** May `id` be hidden now? Only when at least one other entry would stay shown. */
export function canHideAgent<T extends { type: string }>(entries: readonly T[], hidden: readonly string[], id: string): boolean {
  return entries.some((entry) => entry.type !== id && !hidden.includes(entry.type));
}

/** The hidden ids and the way to change them. Every change is saved and sent to the other places in this window. */
export function useHiddenAgents(): { hidden: string[]; setAgentHidden: (id: string, hidden: boolean) => void; showAll: () => void } {
  const [hidden, setHidden] = useState<string[]>(readHiddenAgents);
  useEffect(() => {
    const sync = () => setHidden(readHiddenAgents());
    const onStorage = (e: StorageEvent) => e.key === LS_HIDDEN_AGENTS && sync();
    window.addEventListener('storage', onStorage);
    window.addEventListener(HIDDEN_AGENTS_EVENT, sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(HIDDEN_AGENTS_EVENT, sync);
    };
  }, []);
  const setAgentHidden = useCallback((id: string, next: boolean) => {
    const saved = withAgentHidden(readHiddenAgents(), id, next);
    writeHiddenAgents(saved);
    setHidden(saved);
  }, []);
  const showAll = useCallback(() => {
    writeHiddenAgents([]);
    setHidden([]);
  }, []);
  return { hidden, setAgentHidden, showAll };
}
