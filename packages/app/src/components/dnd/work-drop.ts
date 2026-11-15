// Where a dragged agent lands when it is dropped on the work area, and what the live preview draws. Pure, so every
// rule is easy to test. The zones are decided from the pointer, checked in this order:
//   down  the lowest 32% of the work area      -> split down (stacked, a wide third chat, or a 2 x 2)
//   mid   within 48px of the vertical centre   -> exactly half and half, the dragged agent on the right
//   left / right                               -> beside, the divider where the person last left it (mirrored on the left)
import { NO_BELOW, type SplitBelow, type SplitSlot } from '../cockpit/split-grid';

export type WorkDropZone = 'left' | 'right' | 'mid' | 'down';
export type WorkDropColumn = 'left' | 'right';

/** Half of the middle band's width: a pointer this close to the centre line is a "half and half" drop. */
export const MID_HALF_BAND_PX = 48;
/** The lowest share of the work area's height that means "split down". */
export const DOWN_FRACTION = 0.32;

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The zone under the pointer. The bottom edge wins over the middle band. */
export function dropZone(x: number, y: number, rect: RectLike): WorkDropZone {
  if (y > rect.top + rect.height * (1 - DOWN_FRACTION)) return 'down';
  const centre = rect.left + rect.width / 2;
  if (Math.abs(x - centre) <= MID_HALF_BAND_PX) return 'mid';
  return x < centre ? 'left' : 'right';
}

/** Which half of the work area the pointer is in (a bottom drop on four chats replaces the one under it). */
export function dropColumn(x: number, rect: RectLike): WorkDropColumn {
  return x < rect.left + rect.width / 2 ? 'left' : 'right';
}

export interface DropInput {
  /** The chats on screen now: left, right, then the ones below (split-grid.ts shownIds). Empty: nothing is open. */
  shown: readonly string[];
  /** The chat that was dropped. */
  id: string;
  zone: WorkDropZone;
  column: WorkDropColumn;
  /** The left side's share the person last left (0 to 1). The middle line ignores it. */
  remembered: number;
  /** The chat that comes to the front on the other side when the dropped one is the only chat open (null: none). */
  partner: string | null;
}

export interface DropPlan {
  /** The chats in order: left, right, then below. One entry: just open it. */
  panes: string[];
  stacked: boolean;
  /** Three chats, the third across the full width. */
  wide: boolean;
  /** The left side's share of the room, or null when the divider is not part of this drop. */
  ratio: number | null;
  /** A chat that leaves the split because of the drop (it keeps running and stays in the sidebar). */
  replaced: string | null;
}

export const MOST_PANES = 4;

/** What the layout becomes when `id` is dropped in `zone`. */
export function planDrop(input: DropInput): DropPlan {
  const { id, zone, column, remembered, partner } = input;
  let rest = input.shown.filter((p) => p !== id);
  if (rest.length === 0) {
    // The only open chat (or none) was dragged: another chat comes to the front on the other side.
    if (partner === null || partner === id) return { panes: [id], stacked: false, wide: false, ratio: null, replaced: null };
    rest = [partner];
  }
  if (zone === 'down') {
    if (rest.length === 1) return { panes: [rest[0], id], stacked: true, wide: false, ratio: null, replaced: null };
    if (rest.length < MOST_PANES) {
      const panes = [...rest, id];
      return { panes, stacked: false, wide: panes.length === 3, ratio: null, replaced: null };
    }
    // Four chats are open: the one under the pointer (bottom left or bottom right) is replaced.
    const panes = rest.slice(0, MOST_PANES);
    const at = column === 'left' ? 2 : 3;
    const replaced = panes[at];
    panes[at] = id;
    return { panes, stacked: false, wide: false, ratio: null, replaced };
  }
  const ratio = zone === 'mid' ? 0.5 : zone === 'left' ? 1 - remembered : remembered;
  if (rest.length === 1) {
    return { panes: zone === 'left' ? [id, rest[0]] : [rest[0], id], stacked: false, wide: false, ratio, replaced: null };
  }
  // Two or more chats are open: the drop replaces the chat on that side (left: the left one; right or middle: the right one).
  const top = rest.slice(0, 2);
  const low = rest.slice(2, MOST_PANES);
  const slot = zone === 'left' ? 0 : 1;
  const replaced = top[slot];
  top[slot] = id;
  const panes = [...top, ...low];
  return { panes, stacked: false, wide: panes.length === 3, ratio, replaced };
}

/** The layout fields a plan sets (the left chat is selected, the next one is the split). */
export function layoutOfPlan(plan: DropPlan): { selected: string; split: string | null; below: SplitBelow } {
  const [selected, split = null, leftDown = null, rightDown = null] = plan.panes;
  if (plan.stacked) return { selected, split, below: { ...NO_BELOW, stacked: true } };
  if (leftDown === null && rightDown === null) return { selected, split, below: NO_BELOW };
  return { selected, split, below: { ...NO_BELOW, leftDown, rightDown, ...(plan.wide ? { wide: true } : {}) } };
}

/** The slot the dropped chat takes in the layout the plan builds (it gets the focus). */
export function slotOfPlan(plan: DropPlan, id: string): SplitSlot {
  const at = plan.panes.indexOf(id);
  return (['left', 'right', 'leftDown', 'rightDown'] as const)[at < 0 ? 0 : at];
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The two preview boxes in percent of the work area: the half the dragged chat takes, and the half that stays. */
export function previewBoxes(zone: WorkDropZone, remembered: number): { take: Box; stay: Box } {
  if (zone === 'down') return { take: { left: 0, top: 50, width: 100, height: 50 }, stay: { left: 0, top: 0, width: 100, height: 50 } };
  const share = (zone === 'mid' ? 0.5 : zone === 'left' ? 1 - remembered : remembered) * 100;
  // `share` is the left side's width: the dragged chat is the left side on a left drop, the right side otherwise.
  if (zone === 'left') return { take: { left: 0, top: 0, width: share, height: 100 }, stay: { left: share, top: 0, width: 100 - share, height: 100 } };
  return { take: { left: share, top: 0, width: 100 - share, height: 100 }, stay: { left: 0, top: 0, width: share, height: 100 } };
}
