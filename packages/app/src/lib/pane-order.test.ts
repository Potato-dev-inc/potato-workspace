// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { clearPaneUse, nextNeedingPane, paneAtNumber, paneLastUsed, rankPanes, recordPaneUse, stepPane } from './pane-order';

afterEach(clearPaneUse);

const panes = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

describe('rankPanes', () => {
  it('lists the panes that need you first, then the most recently used, then the rest in order', () => {
    recordPaneUse('b');
    recordPaneUse('c');
    expect(rankPanes(panes, new Set(['d']), paneLastUsed()).map((p) => p.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('keeps the list order when nothing was used and nothing needs you', () => {
    expect(rankPanes(panes, new Set(), paneLastUsed()).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('among panes that need you, the one used last comes first', () => {
    recordPaneUse('a');
    recordPaneUse('d');
    expect(rankPanes(panes, new Set(['a', 'd', 'b']), paneLastUsed()).map((p) => p.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('does not change the list it was given', () => {
    const before = panes.map((p) => p.id);
    rankPanes(panes, new Set(['d']), paneLastUsed());
    expect(panes.map((p) => p.id)).toEqual(before);
  });
});

describe('stepPane', () => {
  const ids = ['a', 'b', 'c'];
  it('goes to the next and previous pane, wrapping round', () => {
    expect(stepPane(ids, 'a', 1)).toBe('b');
    expect(stepPane(ids, 'c', 1)).toBe('a');
    expect(stepPane(ids, 'a', -1)).toBe('c');
  });
  it('with nothing selected: the first going down, the last going up', () => {
    expect(stepPane(ids, null, 1)).toBe('a');
    expect(stepPane(ids, null, -1)).toBe('c');
    expect(stepPane(ids, 'gone', 1)).toBe('a');
  });
  it('is null when there are no panes', () => {
    expect(stepPane([], null, 1)).toBeNull();
  });
});

describe('paneAtNumber', () => {
  it('counts from 1 and is null past the end', () => {
    expect(paneAtNumber(['a', 'b'], 1)).toBe('a');
    expect(paneAtNumber(['a', 'b'], 2)).toBe('b');
    expect(paneAtNumber(['a', 'b'], 3)).toBeNull();
    expect(paneAtNumber(['a', 'b'], 0)).toBeNull();
    expect(paneAtNumber(['a', 'b'], 10)).toBeNull();
  });
});

describe('nextNeedingPane', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('is the next pane down the list that needs you', () => {
    expect(nextNeedingPane(ids, new Set(['c', 'd']), 'a')).toBe('c');
    expect(nextNeedingPane(ids, new Set(['c', 'd']), 'c')).toBe('d');
  });
  it('wraps round, and skips the selected pane while another one needs you', () => {
    expect(nextNeedingPane(ids, new Set(['a', 'b']), 'b')).toBe('a');
  });
  it('is the selected pane when it is the only one', () => {
    expect(nextNeedingPane(ids, new Set(['b']), 'b')).toBe('b');
  });
  it('is null when nothing needs you', () => {
    expect(nextNeedingPane(ids, new Set(), 'a')).toBeNull();
  });
  it('starts at the top with nothing selected', () => {
    expect(nextNeedingPane(ids, new Set(['c']), null)).toBe('c');
  });
});
