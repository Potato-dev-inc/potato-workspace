// The order the person gave their chats in the sidebar (Projects view). One list of chat ids; a project's chats are
// kept next to each other, so each move just rewrites that project's part. Chats the list does not know yet
// (just opened) come first. Saved in browser storage like the project list next to it. Never throws.
import { useCallback, useEffect, useState } from 'react';

export const LS_CHAT_ORDER = 'pm.sidebar.chatOrder';
const MAX_IDS = 400;

export function readChatOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_CHAT_ORDER) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((x): x is string => typeof x === 'string' && x !== ''))].slice(0, MAX_IDS);
  } catch {
    return [];
  }
}

function writeChatOrder(ids: readonly string[]): void {
  try {
    localStorage.setItem(LS_CHAT_ORDER, JSON.stringify(ids.slice(-MAX_IDS)));
  } catch {
    /* storage is off: the order lasts until the window closes */
  }
}

/** `all` with the ids of `group` replaced by `group` in its new order (placed last, so newer moves stay recent). */
export function withGroupOrder(all: readonly string[], group: readonly string[]): string[] {
  const moved = new Set(group);
  return [...all.filter((id) => !moved.has(id)), ...group];
}

/** The saved chat order and the way to set one project's part; saved on every change. */
export function useChatOrder(): { order: string[]; setGroupOrder: (ids: string[]) => void } {
  const [order, setOrder] = useState<string[]>(readChatOrder);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === LS_CHAT_ORDER && setOrder(readChatOrder());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const setGroupOrder = useCallback((ids: string[]) => {
    const next = withGroupOrder(readChatOrder(), ids);
    writeChatOrder(next);
    setOrder(next);
  }, []);
  return { order, setGroupOrder };
}
