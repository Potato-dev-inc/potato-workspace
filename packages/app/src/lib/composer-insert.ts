// "Put this text in that chat's message box": the Files card (Mention in chat) and the file tab (Tell the agent) hand
// text to a pane's Chat box here. It waits per pane until the box takes it (the box may not be on screen yet), then
// the box adds it to what the person already typed. Nothing is sent: the person reads it and presses Send.
const waiting = new Map<string, string[]>();
const listeners = new Set<(paneId: string) => void>();

/** Adds text for the pane's message box and wakes whoever shows it. */
export function pushComposerInsert(paneId: string, text: string): void {
  if (!text.trim()) return;
  waiting.set(paneId, [...(waiting.get(paneId) ?? []), text]);
  for (const l of [...listeners]) l(paneId);
}

/** Takes everything waiting for the pane (joined by a blank line), or null. */
export function takeComposerInserts(paneId: string): string | null {
  const list = waiting.get(paneId);
  if (!list || list.length === 0) return null;
  waiting.delete(paneId);
  return list.join('\n\n');
}

export function onComposerInsert(cb: (paneId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Drops everything waiting (tests). */
export function resetComposerInserts(): void {
  waiting.clear();
}
