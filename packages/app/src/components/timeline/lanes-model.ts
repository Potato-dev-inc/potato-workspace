// Pure model of the Today line: journal rows -> lanes of marks, a time axis with long idle gaps folded,
// clusters for busy stretches, snapping of the time handle and the keyboard order. No React, no clock.
import type { MessageKey } from '../../i18n';
import type { TimelineDay, TimelineRow } from '../../lib/timeline';

export type MarkShape = 'turn' | 'hollow' | 'undo' | 'stop';

export interface Mark {
  /** Stable id: `project|key|id`. */
  id: string;
  row: TimelineRow;
  /** Index into the lanes of the same `buildLanes` call. */
  lane: number;
  shape: MarkShape;
  /** The save point is gone: drawn faded, cannot be gone back to. */
  faded: boolean;
  /** A helper's worktree: drawn in its parent's lane with a small branch tick. */
  branch: boolean;
  /** The folder this point is of no longer exists. */
  folderGone: boolean;
  helper: boolean;
}

export interface LaneView {
  project: string;
  name: string;
  folderGone: boolean;
  /** Oldest first. */
  marks: Mark[];
  lastMs: number;
}

export interface Filters {
  /** A lane's `project`, or `all`. */
  project: string;
  /** An agent type, or `all`. */
  agent: string;
  showHelpers: boolean;
}

export const NO_FILTERS: Filters = { project: 'all', agent: 'all', showHelpers: false };

export function markId(row: Pick<TimelineRow, 'project' | 'key' | 'id'>): string {
  return `${row.project}|${row.key}|${row.id}`;
}

/** A folder spelled for comparing: slashes, no trailing slash, lower case for Windows paths. */
export function folderKey(path: string): string {
  const slashed = path.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^[a-zA-Z]:/.test(slashed) || slashed.startsWith('//') ? slashed.toLowerCase() : slashed;
}

function inside(child: string, parent: string): boolean {
  const c = folderKey(child);
  const p = folderKey(parent);
  return c !== p && c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** Which rows are marks: one per finished turn, plus go-backs and stops. Starts of turns are not marks. */
function shapeOf(row: TimelineRow): MarkShape | null {
  if (row.kind === 'undo') return 'undo';
  if (row.kind === 'stop') return 'stop';
  if (row.kind === 'after') return row.files === 0 ? 'hollow' : 'turn';
  // A helper's own step (mission, What broke it) is one mark per step whatever its kind.
  if (row.helper) return 'turn';
  return null;
}

/**
 * Lanes of marks, most recent activity first. A project that sits inside another lane's project (a worktree)
 * is drawn inside that parent lane, its marks carrying `branch`. Filters drop marks (and lanes with none left).
 */
export function buildLanes(day: Pick<TimelineDay, 'lanes'>, filters: Filters = NO_FILTERS): LaneView[] {
  const projects = day.lanes.map((l) => l.project);
  // The nearest enclosing lane of each lane, if any.
  const parentOf = (project: string): string | null => {
    const parents = projects.filter((p) => inside(project, p));
    if (parents.length === 0) return null;
    return parents.reduce((a, b) => (folderKey(a).length >= folderKey(b).length ? a : b));
  };
  const lanes: LaneView[] = [];
  const index = new Map<string, number>();
  for (const lane of day.lanes) {
    if (parentOf(lane.project) !== null) continue;
    index.set(folderKey(lane.project), lanes.length);
    lanes.push({ project: lane.project, name: lane.name, folderGone: lane.folderGone, marks: [], lastMs: 0 });
  }
  for (const lane of day.lanes) {
    const parent = parentOf(lane.project);
    const target = index.get(folderKey(parent ?? lane.project));
    if (target === undefined) continue;
    for (const row of lane.rows) {
      const shape = shapeOf(row);
      if (!shape) continue;
      if (row.helper && !filters.showHelpers) continue;
      if (filters.agent !== 'all' && row.agentType !== filters.agent && row.kind !== 'undo') continue;
      lanes[target].marks.push({ id: markId(row), row, lane: target, shape, faded: row.gone, branch: parent !== null, folderGone: lane.folderGone, helper: row.helper });
    }
  }
  for (const lane of lanes) {
    lane.marks.sort((a, b) => a.row.atMs - b.row.atMs || a.row.id.localeCompare(b.row.id, undefined, { numeric: true }));
    lane.lastMs = lane.marks.reduce((m, k) => Math.max(m, k.row.atMs), 0);
  }
  const kept = lanes.filter((l) => l.marks.length > 0 && (filters.project === 'all' || folderKey(l.project) === folderKey(filters.project)));
  kept.sort((a, b) => b.lastMs - a.lastMs);
  kept.forEach((lane, i) => lane.marks.forEach((m) => (m.lane = i)));
  return kept;
}

/** Distinct agent types in a day, for the Agents filter. */
export function agentTypes(day: Pick<TimelineDay, 'lanes'>): string[] {
  const seen = new Set<string>();
  for (const lane of day.lanes) for (const row of lane.rows) if (row.agentType) seen.add(row.agentType);
  return [...seen].sort();
}

/** Every mark of every lane in time order (the order the arrow keys walk). */
export function markOrder(lanes: LaneView[]): Mark[] {
  return lanes.flatMap((l) => l.marks).sort((a, b) => a.row.atMs - b.row.atMs || a.lane - b.lane || a.row.id.localeCompare(b.row.id, undefined, { numeric: true }));
}

/** Left / right: the previous or next mark in time across all lanes. The ends stay where they are. */
export function stepMark(order: Mark[], currentId: string | null, dir: 1 | -1): Mark | null {
  if (order.length === 0) return null;
  const at = order.findIndex((m) => m.id === currentId);
  if (at < 0) return dir === 1 ? order[0] : order[order.length - 1];
  return order[Math.min(order.length - 1, Math.max(0, at + dir))];
}

/** Up / down: the mark in the neighbouring lane that is closest in time. */
export function stepLane(lanes: LaneView[], current: Mark | null, dir: 1 | -1): Mark | null {
  if (!current) return null;
  const next = lanes[current.lane + dir];
  if (!next || next.marks.length === 0) return current;
  return next.marks.reduce((best, m) => (Math.abs(m.row.atMs - current.row.atMs) < Math.abs(best.row.atMs - current.row.atMs) ? m : best));
}

/** The handle snaps to the nearest mark at or before the pointer in a lane (the first one when none is before it). */
export function snapMark(marks: Mark[], ms: number): Mark | null {
  if (marks.length === 0) return null;
  let found: Mark | null = null;
  for (const m of marks) {
    if (m.row.atMs <= ms) found = m;
    else break;
  }
  return found ?? marks[0];
}

// ---- the time axis -----------------------------------------------------------------------------------------

/** Idle gaps longer than this are folded into a short dashed break. */
export const FOLD_GAP_MS = 60 * 60 * 1000;
/** The time kept visible on each side of a fold, so the marks do not touch the break. */
const FOLD_KEEP_MS = 10 * 60 * 1000;
/** Width of a folded break. */
export const FOLD_WIDTH_PX = 28;

export interface Fold {
  fromMs: number;
  toMs: number;
  x0: number;
  x1: number;
}

export interface Axis {
  startMs: number;
  endMs: number;
  widthPx: number;
  folds: Fold[];
  xOf: (ms: number) => number;
  /** The time at a position. Inside a fold: the nearer edge. */
  msAt: (x: number) => number;
  /** Whole hours inside the window (not inside a fold). */
  ticks: { ms: number; x: number }[];
}

/**
 * The axis for a window. `times` are the mark times: a stretch between two of them (or a window edge) longer than
 * an hour becomes a fold of fixed width, and the rest of the width goes to the time that is left, in proportion.
 */
export function buildAxis(times: number[], startMs: number, endMs: number, widthPx: number): Axis {
  const end = Math.max(endMs, startMs + 1);
  const points = [...new Set([startMs, end, ...times.filter((t) => t > startMs && t < end)])].sort((a, b) => a - b);
  // Folded stretches: [from, to] with from = earlier point + keep, to = later point - keep.
  const foldRanges: { fromMs: number; toMs: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i] - points[i - 1] > FOLD_GAP_MS) foldRanges.push({ fromMs: points[i - 1] + FOLD_KEEP_MS, toMs: points[i] - FOLD_KEEP_MS });
  }
  const foldedMs = foldRanges.reduce((sum, f) => sum + (f.toMs - f.fromMs), 0);
  const liveMs = end - startMs - foldedMs;
  const livePx = Math.max(1, widthPx - foldRanges.length * FOLD_WIDTH_PX);
  const pxPerMs = liveMs > 0 ? livePx / liveMs : 0;
  const folds: Fold[] = [];
  // x of a time, walking the folds in order.
  const xOf = (ms: number): number => {
    const t = Math.min(end, Math.max(startMs, ms));
    let x = 0;
    let cursor = startMs;
    for (const f of foldRanges) {
      if (t <= f.fromMs) return x + (t - cursor) * pxPerMs;
      x += (f.fromMs - cursor) * pxPerMs;
      if (t < f.toMs) return x + ((t - f.fromMs) / (f.toMs - f.fromMs)) * FOLD_WIDTH_PX;
      x += FOLD_WIDTH_PX;
      cursor = f.toMs;
    }
    return x + (t - cursor) * pxPerMs;
  };
  for (const f of foldRanges) folds.push({ ...f, x0: xOf(f.fromMs), x1: xOf(f.toMs) });
  const msAt = (x: number): number => {
    const px = Math.min(widthPx, Math.max(0, x));
    for (const f of folds) {
      if (px > f.x0 && px < f.x1) return px - f.x0 < f.x1 - px ? f.fromMs : f.toMs;
    }
    // Walk back from the right edge of the live stretches.
    let ms = startMs;
    let cx = 0;
    for (const f of [...folds, { fromMs: end, toMs: end, x0: xOf(end), x1: xOf(end) }]) {
      if (px <= f.x0) return pxPerMs > 0 ? ms + (px - cx) / pxPerMs : ms;
      ms = f.toMs;
      cx = f.x1;
    }
    return end;
  };
  const ticks: { ms: number; x: number }[] = [];
  const hour = 60 * 60 * 1000;
  for (let t = Math.ceil(startMs / hour) * hour; t <= end; t += hour) {
    if (folds.some((f) => t > f.fromMs && t < f.toMs)) continue;
    ticks.push({ ms: t, x: xOf(t) });
  }
  return { startMs, endMs: end, widthPx, folds, xOf, msAt, ticks };
}

/** The window of a day line: from a quarter hour before the first mark to the end (now, or a quarter hour after the last mark). */
export function dayWindow(lanes: LaneView[], nowMs: number, isToday: boolean): { startMs: number; endMs: number } {
  const all = markOrder(lanes);
  const quarter = 15 * 60 * 1000;
  if (all.length === 0) return { startMs: nowMs - 60 * 60 * 1000, endMs: nowMs };
  const first = all[0].row.atMs;
  const last = all[all.length - 1].row.atMs;
  return { startMs: first - quarter, endMs: isToday ? Math.max(nowMs, last + quarter) : last + quarter };
}

/** The window that opens a busy stretch: its marks with a few minutes of room, at least twenty minutes wide. */
export function clusterWindow(marks: Mark[]): { startMs: number; endMs: number } {
  const first = marks[0].row.atMs;
  const last = marks[marks.length - 1].row.atMs;
  const room = Math.max(5 * 60 * 1000, (20 * 60 * 1000 - (last - first)) / 2);
  return { startMs: first - room, endMs: last + room };
}

/** The "1 hour" zoom: a window an hour wide around a time. */
export function hourWindow(centerMs: number): { startMs: number; endMs: number } {
  const half = 30 * 60 * 1000;
  return { startMs: centerMs - half, endMs: centerMs + half };
}

// ---- busy stretches ------------------------------------------------------------------------------------------

/** Marks closer than this many pixels join a busy stretch (when there are more than `CLUSTER_MIN`). */
export const CLUSTER_GAP_PX = 24;
export const CLUSTER_MIN = 6;

export type LaneItem =
  | { type: 'mark'; mark: Mark; x: number }
  | { type: 'cluster'; marks: Mark[]; x0: number; x1: number };

/**
 * One lane's items left to right: single marks, and a pill for each busy stretch. A mark belongs to a busy stretch when
 * more than `CLUSTER_MIN` marks (itself included) start within `CLUSTER_GAP_PX` of it; overlapping stretches join.
 */
export function laneItems(marks: Mark[], axis: Axis): LaneItem[] {
  const placed = marks.filter((m) => m.row.atMs >= axis.startMs && m.row.atMs <= axis.endMs).map((m) => ({ mark: m, x: axis.xOf(m.row.atMs) }));
  // [first, last] index ranges that are busy.
  const busy: [number, number][] = [];
  let j = 0;
  for (let i = 0; i < placed.length; i++) {
    if (j < i) j = i;
    while (j + 1 < placed.length && placed[j + 1].x - placed[i].x < CLUSTER_GAP_PX) j++;
    if (j - i + 1 > CLUSTER_MIN) {
      const last = busy[busy.length - 1];
      if (last && i <= last[1]) last[1] = Math.max(last[1], j);
      else busy.push([i, j]);
    }
  }
  const items: LaneItem[] = [];
  let at = 0;
  for (const [from, to] of busy) {
    for (; at < from; at++) items.push({ type: 'mark', mark: placed[at].mark, x: placed[at].x });
    const group = placed.slice(from, to + 1);
    items.push({ type: 'cluster', marks: group.map((g) => g.mark), x0: group[0].x, x1: group[group.length - 1].x });
    at = to + 1;
  }
  for (; at < placed.length; at++) items.push({ type: 'mark', mark: placed[at].mark, x: placed[at].x });
  return items;
}

// ---- words ------------------------------------------------------------------------------------------------

/** `14:08` in the computer's time. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

type Say = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The screen-reader label of a mark: "14:08, pm-workspace, Claude, turn 7, 12 files". */
export function markLabel(mark: Mark, laneName: string, agentName: string, say: Say): string {
  const { row } = mark;
  const parts = [clock(row.atMs), laneName];
  if (mark.shape === 'undo') parts.push(say('timeline.mark.wentBack'));
  else if (mark.shape === 'stop') parts.push(agentName, say('timeline.mark.stopped'));
  else {
    parts.push(agentName);
    if (row.turn > 0 && !mark.helper) parts.push(say('timeline.mark.turn', { n: row.turn }));
    parts.push(say(row.files === 1 ? 'timeline.mark.file' : 'timeline.mark.files', { n: row.files }));
  }
  if (mark.faded) parts.push(say('timeline.mark.faded'));
  return parts.join(', ');
}
