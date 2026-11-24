// "Done today" on the Inbox: one row per chat whose last turn finished since local midnight, newest first.
// It reads the turn summaries the cockpit already has (no new backend call). "Clear" hides today's rows; it deletes
// no chat. The clear mark is the local day it was made, so tomorrow starts fresh.
import type { TurnSummary } from './cockpit-api';

export const DONE_CLEARED_KEY = 'pm.inbox.doneCleared';

/** How many rows show before "Show all". */
export const DONE_SHOWN = 6;

export type DoneKind = 'review' | 'open' | 'night' | 'setup';

export interface DoneRow {
  paneId: string;
  agent: string;
  endedAtMs: number;
  kind: DoneKind;
  files: number;
  added: number;
  deleted: number;
  /** The receipt's own words about checks ("2 of 2 checks pass"), when the turn has them. */
  checks: string | null;
  /** The turn's own sentence (shown when it has no changes). */
  sentence: string;
}

/** Local midnight of the day that holds `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A day as `YYYY-MM-DD` in local time. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A turn that failed at once because the agent has no sign-in yet is a setup problem, not finished work. */
export const needsSetup = (s: TurnSummary): boolean => (s.files?.count ?? 0) === 0 && /Missing environment variable|isn't set up on this PC/i.test(`${s.sentence} ${s.end.prompt ?? ''}`);

/** Turns that ended since local midnight and stopped cleanly (a turn that waits for an answer is in Needs you). */
export function doneToday(summaries: Iterable<TurnSummary>, now: number): DoneRow[] {
  const from = startOfDay(now);
  const rows: DoneRow[] = [];
  for (const s of summaries) {
    if (s.endedAtMs < from || s.endedAtMs > now + 60_000) continue;
    if (s.end.kind === 'waiting_input') continue;
    const files = s.files?.count ?? 0;
    rows.push({
      paneId: s.paneId,
      agent: s.agent,
      endedAtMs: s.endedAtMs,
      kind: files > 0 ? 'review' : needsSetup(s) ? 'setup' : 'open',
      files,
      added: s.files?.added ?? 0,
      deleted: s.files?.deleted ?? 0,
      checks: s.receipt?.checks?.trim() || null,
      sentence: s.sentence,
    });
  }
  return rows.sort((a, b) => b.endedAtMs - a.endedAtMs);
}

/** Today's clear mark, if any. Storage can be missing: then nothing is hidden. */
export function doneClearedToday(now: number): boolean {
  try {
    return window.localStorage.getItem(DONE_CLEARED_KEY) === dayKey(now);
  } catch {
    return false;
  }
}

export function clearDoneToday(now: number): void {
  try {
    window.localStorage.setItem(DONE_CLEARED_KEY, dayKey(now));
  } catch {
    /* no storage: the list comes back on reload */
  }
}

/** "14:02" for today. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
