// "Search in files" asked for from outside the Files card (the command palette): the right panel opens, the Files section
// unfolds and its box switches to "Inside files" and takes the cursor. One request waits at a time; the card clears it.
import { useSyncExternalStore } from 'react';

export interface ContentSearchRequest {
  paneId: string;
  /** Tells two requests for the same pane apart. */
  nonce: number;
}

let pending: ContentSearchRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of [...listeners]) l();
}

export function requestContentSearch(paneId: string): void {
  pending = { paneId, nonce: ++nonce };
  emit();
}

/** The request for any pane (the pane view opens its right panel for it). */
export function usePendingContentSearch(): ContentSearchRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
}

export function clearContentSearchRequest(request: ContentSearchRequest): void {
  if (pending?.nonce !== request.nonce) return;
  pending = null;
  emit();
}

/** Tests start with no request. */
export function resetContentSearchRequest(): void {
  pending = null;
  emit();
}
