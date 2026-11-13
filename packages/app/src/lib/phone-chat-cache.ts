// The last chat of each agent, kept on the phone so it can still be read when the PC cannot be reached (greyed, "as of HH:MM").
// Only the words are kept (what you said, what the agent said, how a turn ended): no tool output, nothing large.
import type { ChatItem } from './sessionChatModel';

/** Items kept per chat. */
export const CACHE_ITEMS = 80;
/** A kept text is cut to this many characters. */
export const CACHE_TEXT_CHARS = 4000;
/** Chats kept on the phone; the oldest goes first. */
export const CACHE_CHATS = 12;

const INDEX = 'pm.phone.chat.index';
const key = (paneId: string) => `pm.phone.chat.${paneId}`;

export interface ChatCache {
  at: number;
  items: ChatItem[];
}

const KEPT = new Set<ChatItem['kind']>(['session', 'user', 'assistant', 'turnEnd']);

export function trimForCache(items: readonly ChatItem[]): ChatItem[] {
  return items
    .filter((item) => KEPT.has(item.kind))
    .slice(-CACHE_ITEMS)
    .map((item) => ('text' in item && typeof item.text === 'string' && item.text.length > CACHE_TEXT_CHARS ? { ...item, text: item.text.slice(0, CACHE_TEXT_CHARS) } : item));
}

export function readChatCache(paneId: string): ChatCache | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(paneId)) ?? 'null') as ChatCache | null;
    if (!parsed || typeof parsed.at !== 'number' || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeChatCache(paneId: string, items: readonly ChatItem[], at: number): void {
  try {
    const kept = trimForCache(items);
    if (kept.length === 0) return;
    localStorage.setItem(key(paneId), JSON.stringify({ at, items: kept } satisfies ChatCache));
    const index = (JSON.parse(localStorage.getItem(INDEX) ?? '[]') as string[]).filter((id) => id !== paneId);
    index.push(paneId);
    while (index.length > CACHE_CHATS) {
      const old = index.shift();
      if (old) localStorage.removeItem(key(old));
    }
    localStorage.setItem(INDEX, JSON.stringify(index));
  } catch {
    /* private mode or full: the phone just does not keep it */
  }
}
