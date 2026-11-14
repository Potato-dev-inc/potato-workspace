// Split view up to four chats, as a 2x2 grid. The top row is the old split (left = the selected pane, right = `split`);
// each column may also hold a chat BELOW its top one. Pure functions, so the layout rules are easy to test.
// A column with nothing below fills the whole column height.

export type SplitSlot = 'left' | 'right' | 'leftDown' | 'rightDown';
export type SplitColumn = 'left' | 'right';

/** The chats below the two top ones, and how much of each column's height the top chat takes (0 to 1). */
export interface SplitBelow {
  leftDown: string | null;
  rightDown: string | null;
  leftRows: number;
  rightRows: number;
}

export const NO_BELOW: SplitBelow = { leftDown: null, rightDown: null, leftRows: 0.5, rightRows: 0.5 };

/** The shortest a chat may get when a column holds two, in px. The CSS uses the same number. */
export const SPLIT_ROW_MIN_PX = 160;
export const SPLIT_ROW_DIVIDER_PX = 9;
export const SPLIT_ROW_KEY_STEP_PX = 24;
export const SPLIT_ROW_DEFAULT = 0.5;
/** Most chats in one split view. */
export const SPLIT_MAX_PANES = 4;

export function hasBelow(b: SplitBelow): boolean {
  return b.leftDown !== null || b.rightDown !== null;
}

export function columnOf(slot: SplitSlot): SplitColumn {
  return slot === 'left' || slot === 'leftDown' ? 'left' : 'right';
}

export function isDownSlot(slot: SplitSlot): boolean {
  return slot === 'leftDown' || slot === 'rightDown';
}

/** The chats in the four slots (null: empty). */
export function slotIds(left: string, right: string, b: SplitBelow): Record<SplitSlot, string | null> {
  return { left, right, leftDown: b.leftDown, rightDown: b.rightDown };
}

/** The chats on screen, top row first. */
export function shownIds(left: string, right: string, b: SplitBelow): string[] {
  return [left, right, b.leftDown, b.rightDown].filter((id): id is string => id !== null);
}

/** Keeps only chats that still exist and are not shown twice; a bad ratio becomes the even one. */
export function sanitizeBelow(b: SplitBelow, left: string, right: string, hasPane: (id: string) => boolean): SplitBelow {
  const taken = new Set([left, right]);
  const keep = (id: string | null): string | null => {
    if (id === null || taken.has(id) || !hasPane(id)) return null;
    taken.add(id);
    return id;
  };
  const leftDown = keep(b.leftDown);
  const rightDown = keep(b.rightDown);
  const ok = (r: number) => (Number.isFinite(r) && r > 0 && r < 1 ? r : SPLIT_ROW_DEFAULT);
  if (leftDown === b.leftDown && rightDown === b.rightDown && ok(b.leftRows) === b.leftRows && ok(b.rightRows) === b.rightRows) return b;
  return { leftDown, rightDown, leftRows: ok(b.leftRows), rightRows: ok(b.rightRows) };
}

/** Reads a saved `below` (anything else is no chats below). */
export function parseBelow(v: unknown): SplitBelow {
  if (!v || typeof v !== 'object') return NO_BELOW;
  const o = v as Partial<Record<keyof SplitBelow, unknown>>;
  const id = (x: unknown) => (typeof x === 'string' && x !== '' ? x : null);
  const rows = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1 ? x : SPLIT_ROW_DEFAULT);
  const parsed: SplitBelow = { leftDown: id(o.leftDown), rightDown: id(o.rightDown), leftRows: rows(o.leftRows), rightRows: rows(o.rightRows) };
  return hasBelow(parsed) ? parsed : NO_BELOW;
}

/**
 * The chat that opens below a column: the first chat in the list (starting after `from`, then wrapping) that is not
 * shown yet. Null when four are shown, the column already has one below, or there is no other chat.
 */
export function downPartner(paneIds: readonly string[], shown: readonly string[], from: string | null): string | null {
  if (shown.length >= SPLIT_MAX_PANES) return null;
  const start = from === null ? -1 : paneIds.indexOf(from);
  const n = paneIds.length;
  for (let step = 1; step <= n; step++) {
    const id = paneIds[(start + step + n) % n];
    if (id !== undefined && !shown.includes(id)) return id;
  }
  return null;
}

/** Puts `id` below a column (replacing nothing: a column with a chat below is left alone). */
export function splitColumnDown(b: SplitBelow, column: SplitColumn, id: string): SplitBelow {
  if (column === 'left') return b.leftDown !== null ? b : { ...b, leftDown: id, leftRows: SPLIT_ROW_DEFAULT };
  return b.rightDown !== null ? b : { ...b, rightDown: id, rightRows: SPLIT_ROW_DEFAULT };
}

export function canSplitDown(b: SplitBelow, column: SplitColumn, shownCount: number): boolean {
  if (shownCount >= SPLIT_MAX_PANES) return false;
  return column === 'left' ? b.leftDown === null : b.rightDown === null;
}

/** The layout: the chats in the top row, below, and the divider ratios. */
export interface SplitLayout {
  left: string;
  /** null: the split is over (one chat is left). */
  right: string | null;
  below: SplitBelow;
}

/**
 * The layout after one chat is taken out of the view (the agent keeps running). Empty slots collapse: a column
 * with no top chat lifts the chat below it, an empty right column takes the left column's lower chat or the
 * right one's, and so on. `right: null` means one chat is left and the split ends.
 */
export function closeSlot(layout: SplitLayout, slot: SplitSlot): SplitLayout {
  let l: string | null = layout.left;
  let r: string | null = layout.right;
  let ld = layout.below.leftDown;
  let rd = layout.below.rightDown;
  if (slot === 'left') l = null;
  else if (slot === 'right') r = null;
  else if (slot === 'leftDown') ld = null;
  else rd = null;
  let lRows = layout.below.leftRows;
  let rRows = layout.below.rightRows;
  const reset = () => {
    lRows = SPLIT_ROW_DEFAULT;
    rRows = SPLIT_ROW_DEFAULT;
  };
  if (l === null) {
    if (ld !== null) {
      l = ld;
      ld = null;
    } else {
      l = r;
      r = rd;
      rd = null;
      reset();
    }
  }
  if (l === null) return { left: layout.left, right: null, below: NO_BELOW };
  if (r === null) {
    if (rd !== null) {
      r = rd;
      rd = null;
    } else if (ld !== null) {
      r = ld;
      ld = null;
    }
    reset();
  }
  if (r === null) return { left: l, right: null, below: NO_BELOW };
  const below: SplitBelow = ld === null && rd === null ? NO_BELOW : { leftDown: ld, rightDown: rd, leftRows: lRows, rightRows: rRows };
  return { left: l, right: r, below };
}

/** The `below` after the person picks `next` (a chat on screen below moves up and the old left chat takes its place). */
export function belowAfterSelect(b: SplitBelow, prev: string | null, next: string | null): SplitBelow {
  if (next === null) return NO_BELOW;
  if (next === b.leftDown) return { ...b, leftDown: prev };
  if (next === b.rightDown) return { ...b, rightDown: prev };
  return b;
}

/** The slot next to `from` in a direction, skipping empty ones; null at the edge. */
export function moveSlot(from: SplitSlot, dir: 'left' | 'right' | 'up' | 'down', b: SplitBelow): SplitSlot | null {
  const col = columnOf(from);
  const down = isDownSlot(from);
  if (dir === 'left') return col === 'right' ? (down && b.leftDown !== null ? 'leftDown' : 'left') : null;
  if (dir === 'right') return col === 'left' ? (down && b.rightDown !== null ? 'rightDown' : 'right') : null;
  if (dir === 'up') return down ? col : null;
  if (down) return null;
  if (col === 'left') return b.leftDown !== null ? 'leftDown' : null;
  return b.rightDown !== null ? 'rightDown' : null;
}

/** Keeps `rows` so both chats in a column are at least SPLIT_ROW_MIN_PX tall (`span`: the column height minus the divider). */
export function clampRows(rows: number, span: number): number {
  if (!Number.isFinite(rows) || !(span >= SPLIT_ROW_MIN_PX * 2)) return SPLIT_ROW_DEFAULT;
  const low = SPLIT_ROW_MIN_PX / span;
  return Math.min(1 - low, Math.max(low, rows));
}

export function nudgeRows(rows: number, deltaPx: number, span: number): number {
  if (!(span > 0)) return clampRows(rows, span);
  return clampRows(rows + deltaPx / span, span);
}

export function rowsFromTopPx(topPx: number, span: number): number {
  if (!(span > 0)) return SPLIT_ROW_DEFAULT;
  return clampRows(topPx / span, span);
}
