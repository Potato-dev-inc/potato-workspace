// @vitest-environment jsdom
// The Closed chats list: it shows each chat (title, agent, folder, time), Reopen calls the command, and Delete asks first.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClosedChat } from '../../lib/closedChats';
import { ClosedChatsSheet } from './ClosedChatsSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const NOW = 10_000_000_000;
const chats: ClosedChat[] = [
  { id: 'a', agent: 'claude', label: 'Claude', cwd: 'C:\\work\\shop', updated_ms: NOW - 2 * 3_600_000, title: 'Fix the cart bug' },
  { id: 'b', agent: 'codex', label: 'Codex', cwd: '/home/me/site', updated_ms: NOW - 3 * 86_400_000, title: null },
];

function setup() {
  const api = { reopen: vi.fn(async (id: string) => `pane-${id}`), remove: vi.fn(async () => undefined), removeAll: vi.fn(async () => 2) };
  const onReopened = vi.fn();
  const onChanged = vi.fn();
  const onClose = vi.fn();
  const notify = vi.fn();
  act(() => root.render(<ClosedChatsSheet chats={chats} api={api} now={NOW} onReopened={onReopened} onChanged={onChanged} onClose={onClose} notify={notify} />));
  return { api, onReopened, onChanged, onClose, notify };
}
const button = (text: string, nth = 0) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === text)[nth]!;

describe('ClosedChatsSheet', () => {
  it('lists each chat with its title, agent, project folder and how long ago', () => {
    setup();
    const rows = document.querySelectorAll('[data-testid="closed-chat-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Fix the cart bug');
    expect(rows[0].textContent).toContain('Claude · shop · 2 h ago');
    expect(rows[1].textContent).toContain('No messages');
    expect(rows[1].textContent).toContain('Codex · site · 3 d ago');
    expect(document.body.textContent).not.toContain('Claude Code');
  });

  it('Reopen calls the command for that chat and hands back the pane', async () => {
    const { api, onReopened, onChanged } = setup();
    await act(async () => button('Reopen', 1).click());
    expect(api.reopen).toHaveBeenCalledWith('b');
    expect(onReopened).toHaveBeenCalledWith('pane-b');
    expect(onChanged).toHaveBeenCalled();
  });

  it('a failed Reopen says why and reopens nothing', async () => {
    const { api, onReopened, notify } = setup();
    api.reopen.mockRejectedValueOnce(new Error('The agent for this chat is not available any more.'));
    await act(async () => button('Reopen').click());
    expect(notify).toHaveBeenCalledWith('The agent for this chat is not available any more.');
    expect(onReopened).not.toHaveBeenCalled();
  });

  it('Delete asks first and deletes only after the person confirms', async () => {
    const { api, onChanged } = setup();
    act(() => button('Delete').click());
    expect(api.remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Delete this chat? This can't be undone.");
    await act(async () => button('Cancel').click());
    expect(api.remove).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-testid="closed-chat-row"]')).toHaveLength(2);

    act(() => button('Delete').click());
    await act(async () => button('Delete').click());
    expect(api.remove).toHaveBeenCalledWith('a');
    expect(onChanged).toHaveBeenCalled();
  });

  it('Delete all closed chats asks with the same words and then deletes them all', async () => {
    const { api } = setup();
    act(() => button('Delete all closed chats').click());
    expect(api.removeAll).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("This can't be undone.");
    await act(async () => button('Delete').click());
    expect(api.removeAll).toHaveBeenCalledTimes(1);
  });
});
