// Messages typed while the PC cannot be reached. They wait on the phone, per chat, and are never sent by themselves: when the PC is
// back the person is asked once ("Send the message you wrote while it was away?"), because the agent may have moved on.

export interface QueuedMessage {
  id: string;
  text: string;
  at: number;
}

/** Enough for a bad train ride; a person does not type more than this into a chat that cannot answer. */
export const MAX_QUEUED = 10;

const key = (paneId: string) => `pm.phone.queue.${paneId}`;

export function readQueue(paneId: string): QueuedMessage[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(paneId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is QueuedMessage => !!m && typeof m.id === 'string' && typeof m.text === 'string' && typeof m.at === 'number').slice(0, MAX_QUEUED);
  } catch {
    return [];
  }
}

export function writeQueue(paneId: string, list: readonly QueuedMessage[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(key(paneId));
    else localStorage.setItem(key(paneId), JSON.stringify(list));
  } catch {
    /* private mode: the queue lives for this visit only */
  }
}

/** The queue with one more message, or null when it is full. */
export function enqueue(list: readonly QueuedMessage[], text: string, at: number): QueuedMessage[] | null {
  if (list.length >= MAX_QUEUED) return null;
  const id = `q${at.toString(36)}${list.length}`;
  return [...list, { id, text, at }];
}
