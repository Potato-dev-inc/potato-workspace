import { describe, expect, it } from 'vitest';
import {
  NO_BELOW,
  belowAfterSelect,
  canSplitDown,
  clampRows,
  closeSlot,
  downPartner,
  hasLayout,
  isWide,
  moveSlot,
  nudgeRows,
  parseBelow,
  rowsFromTopPx,
  sanitizeBelow,
  shownIds,
  splitColumnDown,
  SPLIT_ROW_MIN_PX,
  type SplitBelow,
} from './split-grid';

const four: SplitBelow = { leftDown: 'c', rightDown: 'd', leftRows: 0.4, rightRows: 0.6 };

describe('split down', () => {
  it('picks the next chat in the list that is not shown, wrapping round; none when four are shown', () => {
    expect(downPartner(['a', 'b', 'c', 'd'], ['a', 'b'], 'a')).toBe('c');
    expect(downPartner(['a', 'b', 'c', 'd'], ['a', 'b'], 'b')).toBe('c');
    expect(downPartner(['a', 'b', 'c', 'd'], ['b', 'c', 'd'], 'd')).toBe('a');
    expect(downPartner(['a', 'b'], ['a', 'b'], 'a')).toBeNull();
    expect(downPartner(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd'], 'a')).toBeNull();
  });

  it('puts a chat below a column once, and the limit is four chats', () => {
    const one = splitColumnDown(NO_BELOW, 'left', 'c');
    expect(one).toMatchObject({ leftDown: 'c', rightDown: null });
    expect(splitColumnDown(one, 'left', 'x')).toBe(one);
    expect(canSplitDown(NO_BELOW, 'right', 2)).toBe(true);
    expect(canSplitDown(one, 'left', 3)).toBe(false);
    expect(canSplitDown(one, 'right', 4)).toBe(false);
  });

  it('lists the chats on screen, top row first', () => {
    expect(shownIds('a', 'b', four)).toEqual(['a', 'b', 'c', 'd']);
    expect(shownIds('a', 'b', NO_BELOW)).toEqual(['a', 'b']);
  });
});

describe('close one chat', () => {
  const layout = { left: 'a', right: 'b', below: four };
  it('a chat below simply goes', () => {
    expect(closeSlot(layout, 'leftDown')).toMatchObject({ left: 'a', right: 'b', below: { leftDown: null, rightDown: 'd' } });
  });
  it('a top chat with one below is replaced by it', () => {
    expect(closeSlot(layout, 'left')).toMatchObject({ left: 'c', right: 'b', below: { leftDown: null, rightDown: 'd' } });
    expect(closeSlot(layout, 'right')).toMatchObject({ left: 'a', right: 'd', below: { leftDown: 'c', rightDown: null } });
  });
  it('a top chat alone in its column makes the other column take its place', () => {
    const three = { left: 'a', right: 'b', below: { ...NO_BELOW, rightDown: 'd' } };
    expect(closeSlot(three, 'left')).toMatchObject({ left: 'b', right: 'd', below: NO_BELOW });
  });
  it('an emptied right column takes the left column lower chat', () => {
    const three = { left: 'a', right: 'b', below: { ...NO_BELOW, leftDown: 'c' } };
    expect(closeSlot(three, 'right')).toMatchObject({ left: 'a', right: 'c', below: NO_BELOW });
  });
  it('closing one of two leaves one chat and ends the split', () => {
    expect(closeSlot({ left: 'a', right: 'b', below: NO_BELOW }, 'right')).toMatchObject({ left: 'a', right: null });
    expect(closeSlot({ left: 'a', right: 'b', below: NO_BELOW }, 'left')).toMatchObject({ left: 'b', right: null });
  });
});

describe('the layout stays honest', () => {
  it('drops a chat below that is gone, shown twice or on top; keeps the rows', () => {
    const b = sanitizeBelow(four, 'a', 'b', (id) => id !== 'd');
    expect(b).toMatchObject({ leftDown: 'c', rightDown: null, leftRows: 0.4 });
    expect(sanitizeBelow(four, 'c', 'b', () => true)).toMatchObject({ leftDown: null, rightDown: 'd' });
    expect(sanitizeBelow(four, 'a', 'b', () => true)).toBe(four);
  });
  it('reads a saved layout leniently', () => {
    expect(parseBelow(null)).toBe(NO_BELOW);
    expect(parseBelow({ leftDown: 5, rightDown: '' })).toBe(NO_BELOW);
    expect(parseBelow({ leftDown: 'c', leftRows: 7 })).toMatchObject({ leftDown: 'c', leftRows: 0.5 });
  });
  it('picking a chat that is below moves the old left chat into its place', () => {
    expect(belowAfterSelect(four, 'a', 'c')).toMatchObject({ leftDown: 'a', rightDown: 'd' });
    expect(belowAfterSelect(four, 'a', 'd')).toMatchObject({ leftDown: 'c', rightDown: 'a' });
    expect(belowAfterSelect(four, 'a', 'b')).toBe(four);
    expect(belowAfterSelect(four, 'a', null)).toBe(NO_BELOW);
  });
});

describe('moving the focus', () => {
  it('goes to the neighbour, and stops at the edge', () => {
    expect(moveSlot('left', 'right', four)).toBe('right');
    expect(moveSlot('leftDown', 'right', four)).toBe('rightDown');
    expect(moveSlot('leftDown', 'right', NO_BELOW)).toBe('right');
    expect(moveSlot('right', 'left', four)).toBe('left');
    expect(moveSlot('left', 'left', four)).toBeNull();
    expect(moveSlot('left', 'down', four)).toBe('leftDown');
    expect(moveSlot('left', 'down', NO_BELOW)).toBeNull();
    expect(moveSlot('rightDown', 'up', four)).toBe('right');
    expect(moveSlot('right', 'up', four)).toBeNull();
  });
});

describe('row sizes', () => {
  it('keeps each chat at its minimum height', () => {
    const span = 800;
    expect(clampRows(0.01, span)).toBeCloseTo(SPLIT_ROW_MIN_PX / span);
    expect(clampRows(0.99, span)).toBeCloseTo(1 - SPLIT_ROW_MIN_PX / span);
    expect(clampRows(0.3, span)).toBe(0.3);
    expect(clampRows(0.3, 200)).toBe(0.5);
  });
  it('a drag and the arrow keys move it', () => {
    expect(rowsFromTopPx(400, 800)).toBe(0.5);
    expect(rowsFromTopPx(10, 800)).toBeCloseTo(0.2);
    expect(nudgeRows(0.5, 80, 800)).toBeCloseTo(0.6);
    expect(nudgeRows(0.5, -80, 800)).toBeCloseTo(0.4);
  });
});

describe('stacked and wide layouts', () => {
  const stacked = { ...NO_BELOW, stacked: true };
  const wide = { ...NO_BELOW, leftDown: 'c', wide: true };

  it('stacked counts as a layout, is saved and read back, and wide needs exactly the one chat below on the left', () => {
    expect(hasLayout(stacked)).toBe(true);
    expect(hasLayout(NO_BELOW)).toBe(false);
    expect(parseBelow(JSON.parse(JSON.stringify(stacked)))).toEqual({ ...NO_BELOW, stacked: true });
    expect(parseBelow(JSON.parse(JSON.stringify(wide)))).toMatchObject({ leftDown: 'c', wide: true });
    expect(parseBelow({ leftDown: 'c', rightDown: 'd', wide: true }).wide).toBeUndefined();
    expect(isWide({ ...wide, rightDown: 'd' })).toBe(false);
    expect(isWide(wide)).toBe(true);
  });

  it('sanitize keeps stacked and wide, and drops wide when its chat is gone', () => {
    expect(sanitizeBelow(stacked, 'a', 'b', () => true)).toBe(stacked);
    expect(sanitizeBelow(wide, 'a', 'b', () => true)).toBe(wide);
    expect(sanitizeBelow(wide, 'a', 'b', (id) => id !== 'c').wide).toBeUndefined();
  });

  it('stacked: focus moves between the two with Up and Down only; no split down', () => {
    expect(moveSlot('left', 'down', stacked)).toBe('right');
    expect(moveSlot('right', 'up', stacked)).toBe('left');
    expect(moveSlot('left', 'right', stacked)).toBeNull();
    expect(canSplitDown(stacked, 'left', 2)).toBe(false);
  });

  it('wide: down from either top chat reaches the wide one, which only goes up', () => {
    expect(moveSlot('left', 'down', wide)).toBe('leftDown');
    expect(moveSlot('right', 'down', wide)).toBe('leftDown');
    expect(moveSlot('leftDown', 'up', wide)).toBe('left');
    expect(moveSlot('leftDown', 'right', wide)).toBeNull();
  });

  it('a chat below the right column turns the wide layout into a 2 x 2', () => {
    const grid = splitColumnDown(wide, 'right', 'd');
    expect(grid).toMatchObject({ leftDown: 'c', rightDown: 'd', wide: false });
    expect(isWide(grid)).toBe(false);
  });

  it('closing a chat of a stacked or wide layout ends the stack / the wide row', () => {
    const closed = closeSlot({ left: 'a', right: 'b', below: stacked }, 'right');
    expect(closed.right).toBeNull();
    const w = closeSlot({ left: 'a', right: 'b', below: wide }, 'leftDown');
    expect(w).toMatchObject({ left: 'a', right: 'b' });
    expect(w.below.wide).toBeUndefined();
  });
});
