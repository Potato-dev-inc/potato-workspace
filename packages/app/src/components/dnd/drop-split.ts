// Where the two chats end up when a chat is dropped on one side of the work area. Pure, so it is easy to test.
// The left side is the selected chat; the right side is the split's chat (null: no split yet).
export type DropSide = 'left' | 'right';
export interface SplitPick {
  selected: string;
  split: string | null;
}

/** The new left/right chats after dropping `id` on `side`; null when nothing changes. */
export function dropSplit(selected: string | null, split: string | null, id: string, side: DropSide): SplitPick | null {
  if (selected === null) return { selected: id, split: null };
  if (split === null) {
    if (id === selected) return null;
    return side === 'right' ? { selected, split: id } : { selected: id, split: selected };
  }
  if (side === 'right') {
    if (id === split) return null;
    // The chat from the left side moves over: the two swap.
    return id === selected ? { selected: split, split: id } : { selected, split: id };
  }
  if (id === selected) return null;
  return id === split ? { selected: id, split: selected } : { selected: id, split };
}
