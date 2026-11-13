import { describe, expect, it } from 'vitest';
import { dropSplit } from './drop-split';

describe('dropSplit', () => {
  it('without a split: right half puts the chat on the right, left half puts it on the left', () => {
    expect(dropSplit('a', null, 'b', 'right')).toEqual({ selected: 'a', split: 'b' });
    expect(dropSplit('a', null, 'b', 'left')).toEqual({ selected: 'b', split: 'a' });
  });
  it('nothing selected: it just opens', () => {
    expect(dropSplit(null, null, 'b', 'right')).toEqual({ selected: 'b', split: null });
  });
  it('the chat already shown alone changes nothing', () => {
    expect(dropSplit('a', null, 'a', 'right')).toBeNull();
  });
  it('with a split: a new chat replaces that side; the other side swaps; the same side changes nothing', () => {
    expect(dropSplit('a', 'b', 'c', 'right')).toEqual({ selected: 'a', split: 'c' });
    expect(dropSplit('a', 'b', 'c', 'left')).toEqual({ selected: 'c', split: 'b' });
    expect(dropSplit('a', 'b', 'a', 'right')).toEqual({ selected: 'b', split: 'a' });
    expect(dropSplit('a', 'b', 'b', 'left')).toEqual({ selected: 'b', split: 'a' });
    expect(dropSplit('a', 'b', 'b', 'right')).toBeNull();
    expect(dropSplit('a', 'b', 'a', 'left')).toBeNull();
  });
});
