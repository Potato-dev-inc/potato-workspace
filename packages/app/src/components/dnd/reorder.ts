// Pure helpers for "drag to reorder": where a dragged thing would land among the items, where to draw the thin
// insertion line, and the new order. No DOM here, so each piece is easy to test.
import type { DropLine } from './dragStore';

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export type Axis = 'x' | 'y';

/** The slot (0..boxes.length) the pointer is closest to: before the first item whose middle is past the pointer. */
export function insertIndex(boxes: readonly Box[], axis: Axis, point: number): number {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const mid = axis === 'x' ? (b.left + b.right) / 2 : (b.top + b.bottom) / 2;
    if (point < mid) return i;
  }
  return boxes.length;
}

/** The thin line for slot `index`: on the start edge of that item, or after the last one. null: no items. */
export function lineForSlot(boxes: readonly Box[], axis: Axis, index: number, thickness = 2): DropLine | null {
  if (boxes.length === 0) return null;
  const last = index >= boxes.length;
  const b = boxes[last ? boxes.length - 1 : index];
  if (axis === 'x') {
    const x = last ? b.right : b.left;
    return { left: x - thickness / 2, top: b.top, width: thickness, height: b.bottom - b.top };
  }
  const y = last ? b.bottom : b.top;
  return { left: b.left, top: y - thickness / 2, width: b.right - b.left, height: thickness };
}

/**
 * `list` with `id` moved to slot `slot`, counted in the list as it was before the move (the same numbers
 * `insertIndex` gives). An id that is not in the list is inserted. Dropping where it already is changes nothing.
 */
export function moveToSlot<T>(list: readonly T[], id: T, slot: number): T[] {
  const from = list.indexOf(id);
  const rest = list.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, from !== -1 && slot > from ? slot - 1 : slot));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** `items` in the saved `order`; items the order does not know yet come first, in their own order. */
export function applyOrder<T>(items: readonly T[], idOf: (item: T) => string, order: readonly string[]): T[] {
  if (order.length === 0) return [...items];
  const rank = new Map(order.map((id, i) => [id, i] as const));
  const fresh = items.filter((x) => !rank.has(idOf(x)));
  const known = items.filter((x) => rank.has(idOf(x))).sort((a, b) => (rank.get(idOf(a)) as number) - (rank.get(idOf(b)) as number));
  return [...fresh, ...known];
}
