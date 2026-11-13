// "Getting started": six real things a new person should find, each one ticks itself when it happens anywhere in
// the app (a second agent, two side by side, a change reviewed, a turn undone, a phone paired, a limit set).
// The card on the New agent page shows "2 of 6". Hide removes it early. When all six are done the Potato celebrates
// once and the card never comes back. An existing user who already did a thing sees it ticked at once.
// Saved in this window's storage (a convenience: if it is lost the card starts again, it never breaks anything).
// Chat first: none of the six needs a terminal.
import { useSyncExternalStore } from 'react';

export const STEP_IDS = ['second', 'side', 'review', 'undo', 'phone', 'limit'] as const;
export type StepId = (typeof STEP_IDS)[number];

export const GETTING_STARTED_KEY = 'pm.gettingStarted.v1';

export interface GettingStartedState {
  done: StepId[];
  /** "Hide" was pressed. */
  hidden: boolean;
  /** The Potato has celebrated (or the six were already done at the start): the card is gone for good. */
  celebrated: boolean;
  /** The first look at what the person already did was made. */
  seeded: boolean;
}

const EMPTY: GettingStartedState = { done: [], hidden: false, celebrated: false, seeded: false };

const isStep = (v: unknown): v is StepId => typeof v === 'string' && (STEP_IDS as readonly string[]).includes(v);

export function parseState(raw: string | null): GettingStartedState {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as Partial<GettingStartedState> | null;
    return {
      done: Array.isArray(v?.done) ? STEP_IDS.filter((id) => v!.done!.includes(id) && isStep(id)) : [],
      hidden: v?.hidden === true,
      celebrated: v?.celebrated === true,
      seeded: v?.seeded === true,
    };
  } catch {
    return EMPTY;
  }
}

let current: GettingStartedState | null = null;
const listeners = new Set<() => void>();

function read(): GettingStartedState {
  if (current) return current;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(GETTING_STARTED_KEY);
  } catch {
    /* no storage: the card lives until the window closes */
  }
  current = parseState(raw);
  return current;
}

function write(next: GettingStartedState): void {
  current = next;
  try {
    localStorage.setItem(GETTING_STARTED_KEY, JSON.stringify(next));
  } catch {
    /* a convenience only */
  }
  listeners.forEach((l) => l());
}

export function getState(): GettingStartedState {
  return read();
}

/** One step happened. Marking it twice changes nothing. */
export function markStep(id: StepId): void {
  const s = read();
  if (s.done.includes(id)) return;
  write({ ...s, done: STEP_IDS.filter((x) => x === id || s.done.includes(x)) });
}

/** What the person already did before the card was ever shown. If that is all six, the card never shows. */
export function seedSteps(already: readonly StepId[]): void {
  const s = read();
  if (s.seeded) return;
  const done = STEP_IDS.filter((x) => already.includes(x) || s.done.includes(x));
  write({ ...s, done, seeded: true, celebrated: s.celebrated || done.length === STEP_IDS.length });
}

export function hideGettingStarted(): void {
  const s = read();
  if (!s.hidden) write({ ...s, hidden: true });
}

export function markCelebrated(): void {
  const s = read();
  if (!s.celebrated) write({ ...s, celebrated: true });
}

/** For tests: forget everything (and the saved copy). */
export function resetGettingStarted(): void {
  current = null;
  try {
    localStorage.removeItem(GETTING_STARTED_KEY);
  } catch {
    /* nothing to remove */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export interface GettingStartedView extends GettingStartedState {
  doneCount: number;
  total: number;
  allDone: boolean;
}

export function viewOf(s: GettingStartedState): GettingStartedView {
  return { ...s, doneCount: s.done.length, total: STEP_IDS.length, allDone: s.done.length === STEP_IDS.length };
}

let cachedFor: GettingStartedState | null = null;
let cachedView: GettingStartedView | null = null;
function snapshot(): GettingStartedView {
  const s = read();
  if (cachedFor !== s || !cachedView) {
    cachedFor = s;
    cachedView = viewOf(s);
  }
  return cachedView;
}

export function useGettingStarted(): GettingStartedView {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Window event the card's buttons send; the cockpit does the thing (it owns the views). */
export const GETTING_STARTED_EVENT = 'pm:getting-started';
export type GettingStartedAction = 'side' | 'review' | 'undo';

export function requestGettingStarted(action: GettingStartedAction): void {
  window.dispatchEvent(new CustomEvent(GETTING_STARTED_EVENT, { detail: { action } }));
}
