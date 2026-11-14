// "Problems": everything that failed today, in one list (status bar chip and sheet). Errors used to show up in the Inbox, in a
// chat or in a notice and then vanish; here they stay until the person clears them. The list lives in memory and a small
// copy in localStorage (the last 50). Text is passed through the same redaction as "Copy report": no folder paths with a
// user name, no key-looking strings. Nothing here sends anything anywhere.
import { useSyncExternalStore } from 'react';
import { redactReport } from './setup-checks/report';

export const PROBLEMS_KEY = 'pm.problems.v1';
export const PROBLEMS_MAX = 50;

/** The one way out a row offers (the sheet maps each to an action). */
export type ProblemWay = 'open_chat' | 'sign_in' | 'try_again' | 'copy';

export interface Problem {
  /** Stable: the same thing failing again updates the same row. */
  id: string;
  /** When it first happened (epoch ms). */
  at: number;
  /** Plain words, redacted. */
  what: string;
  /** The agent's name, or null. */
  agent: string | null;
  /** The agent's id, for "Sign in". */
  agentId: string | null;
  paneId: string | null;
  way: ProblemWay;
  fixed: boolean;
  /** Longer text for "Copy details" (redacted), or null. */
  details: string | null;
}

export type ProblemInput = Omit<Problem, 'at' | 'fixed' | 'what' | 'details'> & { what: string; details?: string | null; at?: number };

let list: Problem[] = [];
let loaded = false;
const listeners = new Set<() => void>();

const emit = (): void => {
  persist();
  listeners.forEach((l) => l());
};

const isProblem = (v: unknown): v is Problem => {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<Problem>;
  return typeof p.id === 'string' && typeof p.at === 'number' && typeof p.what === 'string' && typeof p.fixed === 'boolean' && typeof p.way === 'string';
};

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(window.localStorage.getItem(PROBLEMS_KEY) ?? 'null') as unknown;
    if (Array.isArray(raw)) {
      // What was open when the app closed is not open now: the feeds report again if it still is.
      list = raw.filter(isProblem).slice(0, PROBLEMS_MAX).map((p) => ({ ...p, paneId: null, fixed: true }));
    }
  } catch {
    list = [];
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(PROBLEMS_KEY, JSON.stringify(list.slice(0, PROBLEMS_MAX)));
  } catch {
    /* no storage: the list only lives in memory */
  }
}

/** Newest first. Same array until something changes (safe for useSyncExternalStore). */
export function problemsSnapshot(): Problem[] {
  load();
  return list;
}

export function subscribeProblems(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Adds a problem, or reopens (and refreshes) the row with the same id. */
export function reportProblem(input: ProblemInput): void {
  load();
  const what = redactReport(input.what);
  const details = input.details ? redactReport(input.details) : null;
  const existing = list.find((p) => p.id === input.id);
  if (existing && !existing.fixed && existing.what === what && existing.paneId === input.paneId) return;
  const row: Problem = {
    id: input.id,
    at: existing && !existing.fixed ? existing.at : (input.at ?? Date.now()),
    what,
    agent: input.agent,
    agentId: input.agentId,
    paneId: input.paneId,
    way: input.way,
    fixed: false,
    details,
  };
  list = [row, ...list.filter((p) => p.id !== input.id)].slice(0, PROBLEMS_MAX);
  emit();
}

/** The thing works again: the row stays (faded) until it is cleared. */
export function fixProblem(id: string): void {
  load();
  const row = list.find((p) => p.id === id);
  if (!row || row.fixed) return;
  list = list.map((p) => (p.id === id ? { ...p, fixed: true } : p));
  emit();
}

/** Removes the fixed rows ("Clear"). */
export function clearFixedProblems(): void {
  load();
  if (!list.some((p) => p.fixed)) return;
  list = list.filter((p) => !p.fixed);
  emit();
}

export const openProblems = (rows: readonly Problem[]): Problem[] => rows.filter((p) => !p.fixed);

/** Tests: forget everything and the "loaded" mark. */
export function resetProblems(): void {
  list = [];
  loaded = false;
  listeners.clear();
}

export function useProblems(): Problem[] {
  return useSyncExternalStore(subscribeProblems, problemsSnapshot, problemsSnapshot);
}
