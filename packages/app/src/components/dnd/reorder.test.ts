import { describe, expect, it } from 'vitest';
import { applyOrder, insertIndex, lineForSlot, moveToSlot, type Box } from './reorder';

const col = (n: number): Box[] => Array.from({ length: n }, (_, i) => ({ left: 0, right: 100, top: i * 20, bottom: i * 20 + 20 }));
const row = (n: number): Box[] => Array.from({ length: n }, (_, i) => ({ left: i * 100, right: i * 100 + 100, top: 0, bottom: 30 }));

describe('insertIndex', () => {
  it('picks the slot by the middle of each item', () => {
    const b = col(3);
    expect(insertIndex(b, 'y', -5)).toBe(0);
    expect(insertIndex(b, 'y', 9)).toBe(0);
    expect(insertIndex(b, 'y', 11)).toBe(1);
    expect(insertIndex(b, 'y', 45)).toBe(2);
    expect(insertIndex(b, 'y', 55)).toBe(3);
    expect(insertIndex(row(2), 'x', 120)).toBe(1);
    expect(insertIndex(row(2), 'x', 160)).toBe(2);
  });
  it('an empty list has one slot', () => expect(insertIndex([], 'y', 10)).toBe(0));
});

describe('lineForSlot', () => {
  it('draws a thin line on the start edge of the item, or after the last', () => {
    expect(lineForSlot(col(3), 'y', 1)).toEqual({ left: 0, top: 19, width: 100, height: 2 });
    expect(lineForSlot(col(3), 'y', 3)).toEqual({ left: 0, top: 59, width: 100, height: 2 });
    expect(lineForSlot(row(2), 'x', 1)).toEqual({ left: 99, top: 0, width: 2, height: 30 });
  });
  it('draws nothing for an empty list', () => expect(lineForSlot([], 'y', 0)).toBeNull());
});

describe('moveToSlot', () => {
  it('moves forward and back, counting slots before the move', () => {
    expect(moveToSlot(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c']);
    expect(moveToSlot(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a']);
    expect(moveToSlot(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
  });
  it('dropping where it already is changes nothing', () => {
    expect(moveToSlot(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
    expect(moveToSlot(['a', 'b', 'c'], 'b', 2)).toEqual(['a', 'b', 'c']);
  });
  it('inserts an id that was not in the list', () => expect(moveToSlot(['a', 'b'], 'x', 1)).toEqual(['a', 'x', 'b']));
});

describe('applyOrder', () => {
  it('follows the saved order; unknown items come first', () => {
    expect(applyOrder(['a', 'b', 'c', 'd'], (x) => x, ['c', 'a', 'b'])).toEqual(['d', 'c', 'a', 'b']);
  });
  it('ignores saved ids that are gone, and an empty order keeps the list', () => {
    expect(applyOrder(['a', 'b'], (x) => x, ['z', 'b', 'a'])).toEqual(['b', 'a']);
    expect(applyOrder(['a', 'b'], (x) => x, [])).toEqual(['a', 'b']);
  });
});
