import { describe, expect, it } from 'vitest';
import { chipRoom, chipState, helperIdsOf, rootPaneId, splitOverflow } from './helpers-bar-model';

const p = (id: string, parent?: string, status = 'idle') => ({ info: { id, parent_pane_id: parent }, status });
const list = [p('a'), p('h1', 'a'), p('h2', 'a'), p('g1', 'h1'), p('b'), p('hb', 'b'), p('orphan', 'gone')];

describe('helpers bar model', () => {
  it('a main agent is its own root, a helper belongs to the top of its chain', () => {
    expect(rootPaneId(list, 'a')).toBe('a');
    expect(rootPaneId(list, 'h1')).toBe('a');
    expect(rootPaneId(list, 'g1')).toBe('a');
    expect(rootPaneId(list, 'orphan')).toBe('orphan');
  });
  it('the helpers of an agent are the ones it started and theirs; a main agent is never one', () => {
    expect(helperIdsOf(list, 'a')).toEqual(['h1', 'h2', 'g1']);
    expect(helperIdsOf(list, 'b')).toEqual(['hb']);
    expect(helperIdsOf(list, 'orphan')).toEqual([]);
  });
  it('a loop of parents does not hang', () => {
    const loop = [p('x', 'y'), p('y', 'x')];
    expect(rootPaneId(loop, 'x')).toBeTypeOf('string');
    expect(helperIdsOf(loop, 'x')).toBeInstanceOf(Array);
  });
  it('states: needs you beats working, errors are stopped, the rest is done', () => {
    expect(chipState('running', true)).toBe('needs');
    expect(chipState('waiting_input', false)).toBe('needs');
    expect(chipState('running', false)).toBe('working');
    expect(chipState('error', false)).toBe('stopped');
    expect(chipState('idle', false)).toBe('done');
  });
});

describe('overflow', () => {
  const chip = (id: string, state: 'working' | 'needs' | 'done' | 'stopped' = 'done') => ({ id, state });
  const chips = [chip('a'), chip('b'), chip('c', 'needs'), chip('d'), chip('e', 'needs')];
  it('everything shows when it fits or the width is unknown', () => {
    expect(splitOverflow(chips, null, new Set()).more).toEqual([]);
    expect(splitOverflow(chips, 5, new Set()).more).toEqual([]);
  });
  it('a chip that needs you is never pushed into +N, even when the room is smaller than their number', () => {
    const { shown, more } = splitOverflow(chips, 1, new Set());
    expect(shown.map((c) => c.id)).toEqual(['c', 'e']);
    expect(more.map((c) => c.id)).toEqual(['a', 'b', 'd']);
  });
  it('the chips open in a pane stay too, and the rest fill the room in order', () => {
    const { shown, more } = splitOverflow(chips, 3, new Set(['d']));
    expect(shown.map((c) => c.id)).toEqual(['c', 'd', 'e']);
    expect(more.map((c) => c.id)).toEqual(['a', 'b']);
    expect(splitOverflow(chips, 4, new Set()).shown.map((c) => c.id)).toEqual(['a', 'b', 'c', 'e']);
  });
  it('the hidden ones list the ones that need you first', () => {
    const many = [chip('a'), chip('b', 'needs'), chip('c', 'needs'), chip('d', 'needs'), chip('e')];
    // Needs-you chips are forced, so none of them can be hidden; hidden ones are the calm ones.
    const { more } = splitOverflow(many, 2, new Set());
    expect(more.every((c) => c.state !== 'needs')).toBe(true);
  });
  it('room: unknown width means no limit; at least one chip always fits', () => {
    expect(chipRoom(null, 0)).toBeNull();
    expect(chipRoom(0, 0)).toBeNull();
    expect(chipRoom(300, 2)).toBe(1);
    expect(chipRoom(1200, 0)).toBeGreaterThan(5);
  });
});
