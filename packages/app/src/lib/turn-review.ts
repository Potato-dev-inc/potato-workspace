// Review the last turn file by file: the files it changed (from the checkpoints), what the person decided about each
// (Keep / Put back), which ones they looked at, and the numbers the counters show. The decisions live here, in memory,
// per pane, so the review section and the right-panel Changes card say the same thing.
//
// A decision and a "looked at" tick belong to one version of a file: the file's content id at the end of the turn
// (`blob`). When the agent edits the file again its id changes, so a Keep goes back to "left" and a tick turns into
// "Changed since you looked".
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { errorSentence } from './sayError';

export interface ReviewFile {
  path: string;
  /** `A` added, `M` modified, `D` deleted. */
  status: 'A' | 'M' | 'D' | string;
  added: number;
  deleted: number;
  binary: boolean;
  /** The file's content id at the end of the turn; empty for a deleted file. */
  blob: string;
}

export interface TurnReviewData {
  turn: number;
  /** The save point the turn started from: Put back returns a file to it. */
  beforeId: string;
  afterId: string;
  files: ReviewFile[];
  truncated: boolean;
}

export interface PutBackReport {
  safetyId: string | null;
  /** `written`, `removed` or `nothing`. */
  action: 'written' | 'removed' | 'nothing' | string;
}

/** The calls the review needs (a test double can stand in). */
export interface TurnReviewApi {
  review(paneId: string): Promise<TurnReviewData | null>;
  patch(paneId: string, fromId: string, toId: string, path: string): Promise<string>;
  putBack(paneId: string, beforeId: string, path: string): Promise<PutBackReport>;
}

export const turnReviewApi: TurnReviewApi = {
  review: (paneId) => invoke<TurnReviewData | null>('checkpoint_turn_review', { paneId }),
  patch: (paneId, fromId, toId, path) => invoke<string>('checkpoint_file_patch', { paneId, fromId, toId, path }),
  putBack: (paneId, beforeId, path) => invoke<PutBackReport>('checkpoint_put_back', { paneId, beforeId, path }),
};

// ---------- decisions and ticks ----------

export type Decision = 'kept' | 'back';

interface Mark {
  decision?: Decision;
  /** The version the decision was made about. */
  decidedBlob?: string;
  /** The version the person looked at. */
  lookedBlob?: string;
  /** The save point to bring a put-back file back from (its Undo). */
  safetyId?: string | null;
}

const marks = new Map<string, Map<string, Mark>>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version += 1;
  listeners.forEach((l) => l());
};

function markOf(paneId: string, path: string): Mark {
  return marks.get(paneId)?.get(path) ?? {};
}

function patchMark(paneId: string, path: string, change: Partial<Mark>): void {
  let forPane = marks.get(paneId);
  if (!forPane) marks.set(paneId, (forPane = new Map()));
  forPane.set(path, { ...forPane.get(path), ...change });
  emit();
}

/** Re-renders when any decision or tick changes. */
export function useReviewMarks(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
    () => version,
  );
}

export function keepFile(paneId: string, file: ReviewFile): void {
  patchMark(paneId, file.path, { decision: 'kept', decidedBlob: file.blob, safetyId: null });
}

export function putBackMark(paneId: string, file: ReviewFile, safetyId: string | null): void {
  patchMark(paneId, file.path, { decision: 'back', decidedBlob: file.blob, safetyId });
}

/** Take a decision back (the Undo of a put back). */
export function clearDecision(paneId: string, path: string): void {
  patchMark(paneId, path, { decision: undefined, decidedBlob: undefined, safetyId: null });
}

export function lookedAt(paneId: string, file: ReviewFile): void {
  if (markOf(paneId, file.path).lookedBlob === file.blob) return;
  patchMark(paneId, file.path, { lookedBlob: file.blob });
}

export type LookState = 'none' | 'looked' | 'changed';

export interface FileState {
  decision: Decision | null;
  look: LookState;
  /** The save point a put-back file comes back from. */
  safetyId: string | null;
}

export function stateOf(paneId: string, file: ReviewFile): FileState {
  const m = markOf(paneId, file.path);
  return {
    decision: m.decision && m.decidedBlob === file.blob ? m.decision : null,
    look: m.lookedBlob === undefined ? 'none' : m.lookedBlob === file.blob ? 'looked' : 'changed',
    safetyId: m.safetyId ?? null,
  };
}

export interface ReviewCounts {
  total: number;
  kept: number;
  back: number;
  left: number;
  looked: number;
}

export function countsFor(paneId: string, files: readonly ReviewFile[]): ReviewCounts {
  let kept = 0;
  let back = 0;
  let looked = 0;
  for (const f of files) {
    const s = stateOf(paneId, f);
    if (s.decision === 'kept') kept += 1;
    else if (s.decision === 'back') back += 1;
    if (s.look === 'looked') looked += 1;
  }
  return { total: files.length, kept, back, left: files.length - kept - back, looked };
}

/** For tests: forget every decision. */
export function resetReviewMarks(): void {
  marks.clear();
  emit();
}

// ---------- the review of a pane ----------

export type ReviewLoad =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'error'; message: string }
  | { state: 'ready'; review: TurnReviewData };

/** The last turn's files, read again whenever the pane's status changes (a turn starting or ending makes save points). */
export function useTurnReview(paneId: string, status: string, api: TurnReviewApi = turnReviewApi): { load: ReviewLoad; reload: () => void } {
  const [load, setLoad] = useState<ReviewLoad>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.review(paneId).then(
      (review) => {
        if (!cancelled) setLoad(review ? { state: 'ready', review } : { state: 'none' });
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ state: 'error', message: errorSentence(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, paneId, status, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { load, reload };
}
