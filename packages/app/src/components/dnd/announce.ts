// One polite message for screen readers, read out by `DragLayer` (which is always mounted in the cockpit).
// Used after a keyboard move ("Moved X to place 2 of 4"): the move itself has no other sign for a blind person.
import { useSyncExternalStore } from 'react';

let message = '';
const listeners = new Set<() => void>();
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export function announce(text: string): void {
  message = text;
  for (const l of listeners) l();
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    message = '';
    for (const l of listeners) l();
  }, 3000);
}

export function useAnnouncement(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => message,
  );
}
