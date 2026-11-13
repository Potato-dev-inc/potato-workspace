// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { ClosedChat } from './closedChats';
import { isReopenChatKey, lastClosed, reopenLastClosedChat } from './reopen-closed';

const chat = (id: string, updated_ms: number, title: string | null = null): ClosedChat => ({ id, agent: 'claude', label: 'Claude', cwd: '/p', updated_ms, title });
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('Ctrl+Shift+T', () => {
  it('matches Ctrl+Shift+T on Windows and Cmd+Shift+T on a Mac, nothing else', () => {
    expect(isReopenChatKey(key({ key: 'T', ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isReopenChatKey(key({ key: 't', ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isReopenChatKey(key({ key: 't', ctrlKey: true }), false)).toBe(false);
    expect(isReopenChatKey(key({ key: 't', ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
    expect(isReopenChatKey(key({ key: 't', metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isReopenChatKey(key({ key: 't', ctrlKey: true, shiftKey: true }), true)).toBe(false);
  });

  it('picks the chat that was closed last (newest activity)', () => {
    expect(lastClosed([chat('a', 5), chat('b', 9), chat('c', 7)])?.id).toBe('b');
    expect(lastClosed([])).toBeNull();
  });

  it('reopens it, selects its pane and says so', async () => {
    const api = { list: vi.fn(async () => [chat('a', 1), chat('b', 2, 'Fix the cart')]), reopen: vi.fn(async (id: string) => `pane-${id}`) };
    const select = vi.fn();
    const notify = vi.fn();
    await reopenLastClosedChat(select, notify, api);
    expect(api.reopen).toHaveBeenCalledWith('b');
    expect(select).toHaveBeenCalledWith('pane-b');
    expect(notify).toHaveBeenCalledWith('Reopened Fix the cart');
  });

  it('with nothing closed it says so and opens nothing', async () => {
    const api = { list: vi.fn(async () => []), reopen: vi.fn() };
    const notify = vi.fn();
    await reopenLastClosedChat(vi.fn(), notify, api);
    expect(api.reopen).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('There is no closed chat to reopen.');
  });

  it('a failed reopen says why and selects nothing', async () => {
    const api = { list: vi.fn(async () => [chat('a', 1)]), reopen: vi.fn(async () => Promise.reject(new Error('This chat is not closed any more.'))) };
    const select = vi.fn();
    const notify = vi.fn();
    await reopenLastClosedChat(select, notify, api);
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('This chat is not closed any more.');
  });
});
