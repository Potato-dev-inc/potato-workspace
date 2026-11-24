// Review the last turn file by file: the files it changed (from the checkpoints), what the person decided about each
// (Keep / Put back), which ones they looked at, and the numbers the counters show. The decisions live here, in memory,
// per pane, so the review section and the right-panel Changes card say the same thing.
//
// A decision and a "looked at" tick belong to one version of a file: the file's content id at the end of the turn
// (`blob`). When the agent edits the file again its id changes, so a Keep goes back to "left" and a tick turns into
// "Changed since you looked".
import { invoke } from '@tauri-apps/api/core';
import type { Host } from './host/host';
import { forHost } from './host/hostApi';
import { useHost } from './host/context';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { errorSentence } from './sayError';

export interface ReviewFile {
  path: string;
  /** `A` added, `M` modified, `D` deleted. */
  status: 'A' | 'M' | 'D' | string;
  added: number;
  deleted: number;
  binary: boolean;
  /** Only the line endings changed (CR/LF): no numbers, left out of totals. Set by the backend when it knows. */
  lineEndingsOnly?: boolean;
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

const farTurnReviewApi = (host: Host): TurnReviewApi => ({
  review: (paneId) => host.invoke<TurnReviewData | null>('checkpoint_turn_review', { paneId }),
  patch: (paneId, fromId, toId, path) => host.invoke<string>('checkpoint_file_patch', { paneId, fromId, toId, path }),
  putBack: (paneId, beforeId, path) => host.invoke<PutBackReport>('checkpoint_put_back', { paneId, beforeId, path }),
});

export const turnReviewApiFor = (host: Host): TurnReviewApi => forHost(host, turnReviewApi, farTurnReviewApi);

/** The last turn's patch of one file, from the checkpoints ('' when that turn did not touch it). The file view falls back to this when git
 * has no diff (a folder that is not a git repo, on this PC or another): the Changes list is made from the same checkpoints, so both agree. */
export async function lastTurnPatch(api: TurnReviewApi, paneId: string, path: string): Promise<string> {
  const norm = (a: string) => a.split('\\').join('/').replace(/^\.\//, '');
  // A tab opened with the file's full path (not the project-relative one the review uses) still finds its file.
  const full = /^([a-zA-Z]:)?\//.test(norm(path));
  const same = (a: string) => norm(a) === norm(path) || (full && norm(path).toLowerCase().endsWith(`/${norm(a).toLowerCase()}`));
  const review = await api.review(paneId);
  const file = review && Array.isArray(review.files) ? review.files.find((f) => same(f.path)) : undefined;
  return review && file && !file.binary ? api.patch(paneId, review.beforeId, review.afterId, file.path) : '';
}

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
const reverted = new Map<string, Map<string, number>>();
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

const touched = new Map<string, number>();

/** The files of a chat changed outside a turn (a Put back, its Undo): the panels that list them read again. */
export function paneFilesTouched(paneId: string): void {
  touched.set(paneId, (touched.get(paneId) ?? 0) + 1);
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

/** How many times `paneFilesTouched` ran for the chat (a key for panels that list its files). */
export function usePaneFilesVersion(paneId: string): number {
  useReviewMarks();
  return touched.get(paneId) ?? 0;
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

/** "Undo last turn" (or a restore) put these files back: they are no longer changes or outputs of the chat, and the chat's past write events still name them. */
export function markReverted(paneId: string, paths: readonly string[]): void {
  let forPane = reverted.get(paneId);
  if (!forPane) reverted.set(paneId, (forPane = new Map()));
  const now = Date.now();
  paths.forEach((p) => forPane.set(p, now));
  emit();
}

/** Take `markReverted` back (the Undo of an undo). */
export function clearReverted(paneId: string, paths: readonly string[]): void {
  paths.forEach((p) => reverted.get(paneId)?.delete(p));
  emit();
}

/** The person put this file back (and the agent has not changed it since): it is no longer a change or an output of the chat. */
// The review names a file project-relative ("r11.txt"); the chat's write events use the host's full path ("/home/x/work/r11.txt"), and a far
// chat's cwd is not the one those events used. So a path matches a mark when it is the same or ends with "/<marked path>".
/** `wroteAt`: when the chat's last write to the file ran. A file the agent writes again after the undo is listed again. */
export const isPutBack = (paneId: string, path: string, wroteAt?: string | null): boolean => {
  const norm = (a: string) => a.split('\\').join('/').replace(/^\.\//, '').toLowerCase();
  const p = norm(path);
  for (const [marked, m] of marks.get(paneId) ?? []) if (m.decision === 'back' && (p === norm(marked) || p.endsWith(`/${norm(marked)}`))) return true;
  for (const [marked, at] of reverted.get(paneId) ?? []) {
    if (!(p === norm(marked) || p.endsWith(`/${norm(marked)}`))) continue;
    const wrote = wroteAt ? Date.parse(wroteAt) : NaN;
    if (wroteAt === undefined || !(wrote > at)) return true;
  }
  return false;
};

/** A later turn changed a file again: its old Keep / Put back no longer applies. */
export function dropStaleDecisions(paneId: string, files: readonly ReviewFile[]): void {
  for (const f of files) {
    const m = markOf(paneId, f.path);
    if (m.decision && m.decidedBlob !== f.blob) clearDecision(paneId, f.path);
  }
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
  reverted.clear();
  emit();
}

// ---------- the review of a pane ----------

export type ReviewLoad =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'error'; message: string }
  | { state: 'ready'; review: TurnReviewData };

/** When a read after a turn change still shows the old turn, read again after these waits (ms): the host writes a turn's end save point after the turn closes (a short turn right after another waits out the host's 10 s snapshot debounce). */
export const SETTLE_WAITS = [1500, 3500, 7000, 10000];

/** The last turn's files, read again whenever the pane's status changes (a turn starting or ending makes save points).
 * `settle`: a change of `status` that leaves the newest turn's end save point as it was is read again a few times, because the
 * host (a far PC above all) closes the turn in the chat before it has written that save point. */
export function useTurnReview(paneId: string, status: string, given?: TurnReviewApi, settle = false): { load: ReviewLoad; reload: () => void } {
  const host = useHost();
  const api = useMemo(() => given ?? turnReviewApiFor(host), [given, host]);
  const [load, setLoad] = useState<ReviewLoad>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  const filesTouched = usePaneFilesVersion(paneId);
  // The end save point last shown ('' = no review); undefined until the first read.
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shown = seen.current;
    const read = (attempt: number) => {
      api.review(paneId).then(
        (review) => {
          if (cancelled) return;
          // A far PC answers "no review" with an empty object (pclink turns null into {}): only a real file list counts.
          const ready = !!review && Array.isArray(review.files);
          setLoad(ready ? { state: 'ready', review } : { state: 'none' });
          const now = ready ? review.afterId : '';
          seen.current = now;
          if (settle && shown !== undefined && now === shown && attempt < SETTLE_WAITS.length) timer = setTimeout(() => read(attempt + 1), SETTLE_WAITS[attempt]);
        },
        (err: unknown) => {
          if (!cancelled) setLoad({ state: 'error', message: errorSentence(err) });
        },
      );
    };
    read(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, paneId, status, tick, settle, filesTouched]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { load, reload };
}
