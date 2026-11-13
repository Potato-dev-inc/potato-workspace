// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LS_CHAT_ORDER, readChatOrder, withGroupOrder } from './sidebarOrder';
import { withPinAt } from './pinnedPanes';
import { withProjectOrder } from './sidebarProjects';
import { LS_PANE_TAB_ORDER, readTabOrders } from './paneTabOrder';
import { draggedFilePath, pathForPrompt, promptText } from './dropFiles';

describe('saved orders', () => {
  beforeEach(() => localStorage.clear());
  it('a group order replaces that group only, and keeps the others', () => {
    expect(withGroupOrder(['a', 'b', 'x', 'y'], ['b', 'a'])).toEqual(['x', 'y', 'b', 'a']);
  });
  it('broken storage reads as no order', () => {
    localStorage.setItem(LS_CHAT_ORDER, '{nope');
    expect(readChatOrder()).toEqual([]);
    localStorage.setItem(LS_PANE_TAB_ORDER, '[1,2]');
    expect(readTabOrders()).toEqual({});
  });
  it('tab orders read back per project', () => {
    localStorage.setItem(LS_PANE_TAB_ORDER, JSON.stringify({ 'c:/shop': ['p2', 'p1', 'p2', 7] }));
    expect(readTabOrders()).toEqual({ 'c:/shop': ['p2', 'p1'] });
  });
});

describe('withPinAt', () => {
  it('pins a new chat at a slot among the pins on screen', () => {
    expect(withPinAt(['a', 'b'], 'x', ['a', 'b'], 1)).toEqual(['a', 'x', 'b']);
  });
  it('moves a pin, counting slots before the move', () => {
    expect(withPinAt(['a', 'b', 'c'], 'a', ['a', 'b', 'c'], 3)).toEqual(['b', 'c', 'a']);
  });
  it('pins of closed chats stay, at the end', () => {
    expect(withPinAt(['a', 'gone', 'b'], 'b', ['a', 'b'], 0)).toEqual(['b', 'a', 'gone']);
  });
});

describe('withProjectOrder', () => {
  it('puts the named folders in order; the rest follow', () => {
    const list = [{ path: 'C:\\a' }, { path: 'C:\\b' }, { path: 'C:\\c' }];
    expect(withProjectOrder(list, ['c:/c', 'C:\\a']).map((p) => p.path)).toEqual(['C:\\c', 'C:\\a', 'C:\\b']);
  });
});

describe('typed paths', () => {
  it('quotes a path with a space and leaves a plain one alone', () => {
    expect(pathForPrompt('C:\\My Files\\a.txt')).toBe('"C:\\My Files\\a.txt"');
    expect(pathForPrompt('C:\\work\\a.txt')).toBe('C:\\work\\a.txt');
  });
  it('types a space after each path and never a line break', () => {
    const text = promptText(['C:\\a b\\x.txt', 'C:\\y.txt']);
    expect(text).toBe('"C:\\a b\\x.txt" C:\\y.txt ');
    expect(text).not.toMatch(/[\r\n]/);
  });
});

describe('draggedFilePath', () => {
  it('uses the full path when the drag carries it', async () => {
    const search = vi.fn();
    expect(await draggedFilePath({ kind: 'file', id: 'x', label: 'x', meta: { abs: 'C:/p/x.ts' } }, search)).toBe('C:/p/x.ts');
    expect(search).not.toHaveBeenCalled();
  });
  it('looks a project path up in the pane it came from', async () => {
    const search = vi.fn(async () => [
      { path: 'src/ax.ts', absPath: 'C:/p/src/ax.ts', name: 'ax.ts', size: 1 },
      { path: 'src/x.ts', absPath: 'C:/p/src/x.ts', name: 'x.ts', size: 1 },
    ]);
    expect(await draggedFilePath({ kind: 'file', id: 'src/x.ts', label: 'x.ts', meta: { paneId: 'p1' } }, search)).toBe('C:/p/src/x.ts');
    expect(search).toHaveBeenCalledWith('p1', 'src/x.ts', 8);
  });
  it('gives null when the file cannot be found or the search fails', async () => {
    expect(await draggedFilePath({ kind: 'file', id: 'nope', label: 'n' })).toBeNull();
    expect(await draggedFilePath({ kind: 'file', id: 'a', label: 'a', meta: { paneId: 'p1' } }, async () => Promise.reject(new Error('x')))).toBeNull();
  });
});
