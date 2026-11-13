// The chats that are starting right now. Each start has its own id, so two starts at once do not share one
// "Starting" slot: ending one leaves the other on screen. The main area shows the newest start.
import { useCallback, useRef, useState } from 'react';

/** A chat (ACP) that is starting: shown as a skeleton in the main area until it is selected or fails. */
export interface ChatStartState {
  /** This start's own id (not the chat's: the chat has none yet). */
  id?: string;
  agentId: string;
  /** The folder the chat starts in (the menu's project). */
  folder: string;
}

/** Add a start; a start with the same id is replaced. Pure. */
export function addStart(list: ChatStartState[], start: ChatStartState): ChatStartState[] {
  return [...list.filter((s) => s.id !== start.id), start];
}

/** Remove one start by id; with no id, the newest one goes (older callers). Pure. */
export function removeStart(list: ChatStartState[], id?: string): ChatStartState[] {
  if (id === undefined) return list.slice(0, -1);
  return list.filter((s) => s.id !== id);
}

/** What the main area shows: the newest start, or null. Pure. */
export const shownStart = (list: ChatStartState[]): ChatStartState | null => list[list.length - 1] ?? null;

export function useChatStarts() {
  const [starts, setStarts] = useState<ChatStartState[]>([]);
  const seq = useRef(0);
  const begin = useCallback((agentId: string, folder: string): string => {
    const id = `chat-start-${++seq.current}`;
    setStarts((l) => addStart(l, { id, agentId, folder }));
    return id;
  }, []);
  const end = useCallback((id?: string) => setStarts((l) => removeStart(l, id)), []);
  return { chatStarting: shownStart(starts), count: starts.length, begin, end };
}
