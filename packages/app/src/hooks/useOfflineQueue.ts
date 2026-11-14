// The messages that wait for the PC in one chat. `add` keeps a message while the PC cannot be reached; once it can, the bar asks, and
// `sendAll` sends them in order (stopping at the first one the PC refuses) or `discard` throws them away.
import { useCallback, useEffect, useState } from 'react';
import { enqueue, readQueue, writeQueue, type QueuedMessage } from '../lib/phone-queue';

export interface OfflineQueue {
  waiting: QueuedMessage[];
  /** Keeps the message. Resolves to null, or one plain sentence (the queue is full). */
  add: (text: string) => string | null;
  discard: () => void;
  /** Takes one waiting message out. */
  remove: (id: string) => void;
  /** Replaces the words of one waiting message (it keeps its place). An empty text removes nothing and is refused (false). */
  edit: (id: string, text: string) => boolean;
  /** Sends every waiting message with `send`; those that went are removed. Resolves to null, or the first refusal. */
  sendAll: (send: (text: string) => Promise<string | null>) => Promise<string | null>;
}

export function useOfflineQueue(paneId: string, fullMessage: string): OfflineQueue {
  const [waiting, setWaiting] = useState<QueuedMessage[]>(() => readQueue(paneId));
  useEffect(() => setWaiting(readQueue(paneId)), [paneId]);

  const commit = useCallback(
    (next: QueuedMessage[]) => {
      writeQueue(paneId, next);
      setWaiting(next);
    },
    [paneId],
  );

  const add = useCallback(
    (text: string) => {
      const next = enqueue(readQueue(paneId), text, Date.now());
      if (!next) return fullMessage;
      commit(next);
      return null;
    },
    [paneId, fullMessage, commit],
  );

  const discard = useCallback(() => commit([]), [commit]);
  const remove = useCallback((id: string) => commit(readQueue(paneId).filter((m) => m.id !== id)), [paneId, commit]);

  const edit = useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      commit(readQueue(paneId).map((m) => (m.id === id ? { ...m, text: trimmed } : m)));
      return true;
    },
    [paneId, commit],
  );

  const sendAll = useCallback(
    async (send: (text: string) => Promise<string | null>) => {
      let rest = readQueue(paneId);
      while (rest.length > 0) {
        const refused = await send(rest[0].text);
        if (refused) {
          commit(rest);
          return refused;
        }
        rest = rest.slice(1);
        commit(rest);
      }
      return null;
    },
    [paneId, commit],
  );

  return { waiting, add, discard, remove, edit, sendAll };
}
