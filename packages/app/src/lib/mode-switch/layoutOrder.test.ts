// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_LAYOUT, layoutOrder, parseWindowLayout } from './model';
import { readPaneOrder } from './collect';

describe('layoutOrder', () => {
  it('puts the active pane first, then the open tiles in grid order, then the sidebar-only panes, without repeats', () => {
    expect(layoutOrder('d', ['b', 'a'], ['a', 'b', 'c', 'd', 'e'])).toEqual(['d', 'b', 'a', 'c', 'e']);
    expect(layoutOrder(null, ['b'], ['a', 'b'])).toEqual(['b', 'a']);
    expect(layoutOrder(null, [], [])).toEqual([]);
  });
});

describe('parseWindowLayout', () => {
  it('keeps the two choices and falls back to side by side', () => {
    expect(parseWindowLayout('cascade')).toBe('cascade');
    expect(parseWindowLayout('side_by_side')).toBe('side_by_side');
    expect(parseWindowLayout('grid')).toBe(DEFAULT_WINDOW_LAYOUT);
    expect(parseWindowLayout(undefined)).toBe('side_by_side');
  });
});

describe('readPaneOrder', () => {
  it('reads the tiles and sidebar rows from the page in DOM order, active first', () => {
    const doc = document.implementation.createHTMLDocument('x');
    doc.body.innerHTML = '<div data-pane-row="a"></div><div data-pane-row="b"></div><div data-pane-row="c"></div>';
    expect(readPaneOrder(doc, 'c')).toEqual(['c', 'a', 'b']);
  });
});
