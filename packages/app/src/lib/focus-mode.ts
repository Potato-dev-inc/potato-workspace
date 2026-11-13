// Focus mode: one pane fills the window. The sidebar, the right panel and (in a split view) the other side step
// aside. Not remembered: a new start is always the normal layout. Esc, the same keys, or the button bring it back.
import { useSyncExternalStore } from 'react';

let on = false;
const listeners = new Set<() => void>();

export function isFocusMode(): boolean {
  return on;
}
export function setFocusMode(next: boolean): void {
  if (next === on) return;
  on = next;
  for (const l of listeners) l();
}
export function toggleFocusMode(): void {
  setFocusMode(!on);
}
export function subscribeFocusMode(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useFocusMode(): boolean {
  return useSyncExternalStore(subscribeFocusMode, isFocusMode, isFocusMode);
}
