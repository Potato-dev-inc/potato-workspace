// What the helpers bar shows: the helpers of the main agent in front, their state, and which chips fit. Pure.
import { isMinionPane, liveParentId } from '../../lib/pane-helpers';

interface PaneLike {
  info: { id: string; parent_pane_id?: string | null; started_as?: string | null };
  status: string;
}

export type ChipState = 'working' | 'needs' | 'done' | 'stopped';

/** The main agent a pane belongs to: itself, or the top of its chain of live parents. */
export function rootPaneId(list: ReadonlyArray<PaneLike>, id: string): string {
  let at = id;
  for (let guard = 0; guard < 50; guard++) {
    const parent = liveParentId(list, at);
    if (!parent) return at;
    at = parent;
  }
  return at;
}

/** Every helper under `rootId` (the ones it started, and theirs), nearest first, in list order. A minion is not a chip: it lives in Background tasks. */
export function helperIdsOf(list: ReadonlyArray<PaneLike>, rootId: string): string[] {
  const out: string[] = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const at = queue.shift()!;
    for (const p of list) {
      if (seen.has(p.info.id) || isMinionPane(p.info) || liveParentId(list, p.info.id) !== at) continue;
      seen.add(p.info.id);
      out.push(p.info.id);
      queue.push(p.info.id);
    }
  }
  return out;
}

/** Needs you (orange) wins over working (green); a broken pane is stopped (red); anything else has finished. */
export function chipState(status: string, asking: boolean): ChipState {
  if (status === 'error') return 'stopped';
  if (asking || status === 'waiting_input') return 'needs';
  if (status === 'running') return 'working';
  return 'done';
}

export interface ChipLike {
  id: string;
  state: ChipState;
}

/**
 * The chips that fit. Chips that need you and the ones open in a pane are never hidden; the rest fill the room in list
 * order. `max` null: everything fits. The hidden ones go into the "+N" menu, the ones that need you first.
 */
export function splitOverflow<T extends ChipLike>(chips: readonly T[], max: number | null, keep: ReadonlySet<string>): { shown: T[]; more: T[] } {
  if (max === null || chips.length <= max) return { shown: [...chips], more: [] };
  const forced = new Set(chips.filter((c) => c.state === 'needs' || keep.has(c.id)).map((c) => c.id));
  let room = Math.max(0, max - forced.size);
  const shownIds = new Set(forced);
  for (const c of chips) {
    if (shownIds.has(c.id) || room === 0) continue;
    shownIds.add(c.id);
    room--;
  }
  return { shown: chips.filter((c) => shownIds.has(c.id)), more: chips.filter((c) => !shownIds.has(c.id)).sort((a, b) => Number(b.state === 'needs') - Number(a.state === 'needs')) };
}

/** How many chips fit in `width` px beside the crumb and the right end (null while the width is unknown). */
export function chipRoom(width: number | null, standbyCount: number): number | null {
  if (width === null || width <= 0) return null;
  return Math.max(1, Math.floor((width - 260) / 118) - standbyCount);
}
