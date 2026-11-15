// Standby helpers (parked helpers, not the warm pool in standby.ts): helpers the person keeps parked for a project. They start now, wait, and use no tokens while they
// wait; the next matching task uses one. The pool lives in the backend (a later change next to the warm pool); this
// is the shape the helpers bar draws. Until the backend lists any, `useStandbys()` is empty and the bar shows nothing for them.
import { useSyncExternalStore } from 'react';

export interface Standby {
  id: string;
  /** The agent's id (its logo comes from the registry). */
  agent: string;
  /** What the chip says: the role, such as "Reviewer". */
  name: string;
  model?: string | null;
  /** `ready`: waiting. `busy`: a task is using it (the chip then reads as a working helper). */
  state: 'ready' | 'busy';
  /** The project folder it belongs to. */
  project?: string | null;
}

let current: readonly Standby[] = [];
const listeners = new Set<() => void>();

/** The backend (or a test) sets the list. */
export function setStandbys(next: readonly Standby[]): void {
  current = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useStandbys(): readonly Standby[] {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
