import { describe, expect, it } from 'vitest';
import { dropColumn, dropZone, layoutOfPlan, planDrop, previewBoxes, slotOfPlan, type DropInput } from './work-drop';

const rect = { left: 0, top: 0, width: 1000, height: 600 };

describe('dropZone', () => {
  it('the centre is the middle line', () => {
    expect(dropZone(500, 100, rect)).toBe('mid');
    expect(dropZone(548, 100, rect)).toBe('mid');
    expect(dropZone(452, 100, rect)).toBe('mid');
  });
  it('49 px left of the centre is left, and 49 px right is right', () => {
    expect(dropZone(451, 100, rect)).toBe('left');
    expect(dropZone(549, 100, rect)).toBe('right');
  });
  it('the lowest 32% is down, and it wins over the middle band', () => {
    expect(dropZone(500, 420, rect)).toBe('down');
    expect(dropZone(100, 420, rect)).toBe('down');
    expect(dropZone(500, 400, rect)).toBe('mid');
  });
  it('works for a work area that does not start at 0,0', () => {
    const r = { left: 240, top: 36, width: 800, height: 500 };
    expect(dropZone(640, 100, r)).toBe('mid');
    expect(dropZone(300, 100, r)).toBe('left');
    expect(dropZone(900, 100, r)).toBe('right');
    expect(dropZone(640, 36 + 500 * 0.7, r)).toBe('down');
    expect(dropColumn(300, r)).toBe('left');
    expect(dropColumn(900, r)).toBe('right');
  });
});

const base: DropInput = { shown: ['a'], id: 'b', zone: 'right', column: 'right', remembered: 0.58, partner: 'a' };
const plan = (over: Partial<DropInput>) => planDrop({ ...base, ...over });

describe('planDrop', () => {
  it('right: the dragged chat goes on the right and the divider is where the person left it', () => {
    expect(plan({})).toMatchObject({ panes: ['a', 'b'], ratio: 0.58, stacked: false });
  });
  it('left: the dragged chat goes on the left and the divider is mirrored', () => {
    const p = plan({ zone: 'left', column: 'left' });
    expect(p.panes).toEqual(['b', 'a']);
    expect(p.ratio).toBeCloseTo(0.42);
  });
  it('the middle line is exactly 50/50 even when the remembered divider is 58, with the dragged chat on the right', () => {
    expect(plan({ zone: 'mid' })).toMatchObject({ panes: ['a', 'b'], ratio: 0.5 });
  });
  it('down with one chat open stacks the two', () => {
    expect(plan({ zone: 'down' })).toMatchObject({ panes: ['a', 'b'], stacked: true, wide: false, ratio: null });
  });
  it('down with two open puts the third below, full width; with three it is a 2 x 2', () => {
    expect(plan({ zone: 'down', shown: ['a', 'c'] })).toMatchObject({ panes: ['a', 'c', 'b'], stacked: false, wide: true });
    expect(plan({ zone: 'down', shown: ['a', 'c', 'd'] })).toMatchObject({ panes: ['a', 'c', 'd', 'b'], wide: false });
  });
  it('down with four open replaces the bottom chat under the pointer', () => {
    const shown = ['a', 'c', 'd', 'e'];
    expect(plan({ zone: 'down', shown, column: 'left' })).toMatchObject({ panes: ['a', 'c', 'b', 'e'], replaced: 'd' });
    expect(plan({ zone: 'down', shown, column: 'right' })).toMatchObject({ panes: ['a', 'c', 'd', 'b'], replaced: 'e' });
  });
  it('with two open, a left drop replaces the left chat and a right or middle drop replaces the right one', () => {
    const shown = ['a', 'c'];
    expect(plan({ shown, zone: 'left' })).toMatchObject({ panes: ['b', 'c'], replaced: 'a' });
    expect(plan({ shown, zone: 'right' })).toMatchObject({ panes: ['a', 'b'], replaced: 'c' });
    expect(plan({ shown, zone: 'mid' })).toMatchObject({ panes: ['a', 'b'], replaced: 'c', ratio: 0.5 });
  });
  it('a chat that is already open moves and is never shown twice', () => {
    const p = plan({ shown: ['a', 'b'], id: 'b', zone: 'left' });
    expect(p.panes).toEqual(['b', 'a']);
    expect(new Set(p.panes).size).toBe(p.panes.length);
  });
  it('dragging the only open chat brings the partner to the front on the other side', () => {
    expect(plan({ shown: ['a'], id: 'a', zone: 'right', partner: 'z' }).panes).toEqual(['z', 'a']);
    expect(plan({ shown: ['a'], id: 'a', zone: 'left', partner: 'z' }).panes).toEqual(['a', 'z']);
    expect(plan({ shown: ['a'], id: 'a', zone: 'down', partner: 'z' })).toMatchObject({ panes: ['z', 'a'], stacked: true });
  });
  it('without a partner, the only open chat just opens', () => {
    expect(plan({ shown: ['a'], id: 'a', partner: null }).panes).toEqual(['a']);
    expect(plan({ shown: [], id: 'a', partner: null }).panes).toEqual(['a']);
  });
});

describe('layoutOfPlan and slotOfPlan', () => {
  it('maps a two-chat plan to a plain split', () => {
    const l = layoutOfPlan(plan({}));
    expect(l).toMatchObject({ selected: 'a', split: 'b' });
    expect(l.below.leftDown).toBeNull();
  });
  it('maps stacked, wide and 2 x 2', () => {
    expect(layoutOfPlan(plan({ zone: 'down' })).below.stacked).toBe(true);
    const wide = layoutOfPlan(plan({ zone: 'down', shown: ['a', 'c'] }));
    expect(wide.below).toMatchObject({ leftDown: 'b', rightDown: null, wide: true });
    const grid = layoutOfPlan(plan({ zone: 'down', shown: ['a', 'c', 'd'] }));
    expect(grid.below).toMatchObject({ leftDown: 'd', rightDown: 'b' });
    expect(grid.below.wide).toBeUndefined();
  });
  it('the dropped chat takes the focus in its slot', () => {
    expect(slotOfPlan(plan({}), 'b')).toBe('right');
    expect(slotOfPlan(plan({ zone: 'left' }), 'b')).toBe('left');
    expect(slotOfPlan(plan({ zone: 'down', shown: ['a', 'c'] }), 'b')).toBe('leftDown');
    expect(slotOfPlan(plan({ zone: 'down', shown: ['a', 'c', 'd'] }), 'b')).toBe('rightDown');
  });
});

describe('previewBoxes', () => {
  it('the middle line splits the area in two equal halves', () => {
    const { take, stay } = previewBoxes('mid', 0.58);
    expect(take).toMatchObject({ left: 50, width: 50 });
    expect(stay).toMatchObject({ left: 0, width: 50 });
  });
  it('the right zone follows the remembered divider and the left zone mirrors it', () => {
    expect(previewBoxes('right', 0.58).take.left).toBeCloseTo(58);
    expect(previewBoxes('right', 0.58).take.width).toBeCloseTo(42);
    expect(previewBoxes('left', 0.58).take).toMatchObject({ left: 0 });
    expect(previewBoxes('left', 0.58).take.width).toBeCloseTo(42);
  });
  it('down takes the lower half', () => {
    expect(previewBoxes('down', 0.5)).toMatchObject({ take: { top: 50, height: 50, width: 100 }, stay: { top: 0, height: 50 } });
  });
});
