// @vitest-environment jsdom
// "Show earlier messages" on the desktop chat, through the real panel. The fake backend keeps a journal the way the PC
// does: a session line first, then the messages. `chat_earlier` answers "more" only when a message stands before the
// page (the session line before the first message is not an earlier message).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => undefined,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import type { ChatItem } from '../../lib/sessionChat';
import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const session = (): ChatItem => ({ kind: 'session', id: 'session', at: null, model: null, cliVersion: null });
const user = (n: number): ChatItem => ({ kind: 'user', id: `u${n}`, at: null, text: `message ${n}` });
const answer = (n: number): ChatItem => ({ kind: 'assistant', id: `a${n}`, at: null, text: `answer ${n}`, model: null, finalAnswer: true });
const end = (n: number): ChatItem => ({ kind: 'turnEnd', id: `e${n}`, at: null, outcome: 'completed', durationMs: 5 });

/** The journal of a chat: a session line, then `count` exchanges. */
function journalOf(count: number): ChatItem[] {
  const out: ChatItem[] = [session()];
  for (let n = 0; n < count; n++) out.push(user(n), answer(n), end(n));
  return out;
}

const CONVERSATION = new Set(['user', 'assistant', 'toolCall', 'toolResult', 'turnEnd', 'thinking']);

/** The PC's answer for a page before `before`: the items in front of it, and whether a message is left in front of them. */
function pageBefore(journal: ChatItem[], before: string, limit: number) {
  const at = journal.findIndex((item) => item.id === before);
  if (at < 0) return { items: [], more: false };
  const start = Math.max(0, at - limit);
  return { items: journal.slice(start, at), more: journal.slice(0, start).some((item) => CONVERSATION.has(item.kind)) };
}

/** The chat the view opens with: the last `held` items of the journal. */
function openWith(journal: ChatItem[], held: number) {
  return journal.slice(Math.max(0, journal.length - held));
}

beforeEach(() => {
  localStorage.clear();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function openChat(journal: ChatItem[], shown: ChatItem[]) {
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'pane_messages_list') return [];
    if (cmd === 'session_chat_open') return { available: true, reason: null, items: shown, source: 'acp' };
    if (cmd === 'chat_earlier') return pageBefore(journal, String(args.before), Number(args.limit));
    return undefined;
  });
  act(() => root.render(<SessionChatPanel paneId="p1" reply={{ blockedReason: null }} />));
  await flush();
  await flush();
}

const row = () => host.querySelector('[data-testid="show-earlier"]');

describe('Show earlier messages: the row only when there are earlier messages', () => {
  it('a short chat, whose first message is the first item after the session line, shows no row', async () => {
    const journal = journalOf(2);
    await openChat(journal, journal);
    expect(invoke).toHaveBeenCalledWith('chat_earlier', { paneId: 'p1', before: 'u0', limit: 0 });
    expect(row()).toBeNull();
    expect(host.textContent).toContain('message 0');
  });

  it('a long chat shows the row; a click loads the earlier messages and the row goes once the first message is reached', async () => {
    const journal = journalOf(20);
    await openChat(journal, openWith(journal, 30));
    expect(host.textContent).not.toContain('message 0');
    const button = host.querySelector<HTMLButtonElement>('[data-testid="show-earlier"] button');
    expect(button?.textContent).toBe('Show earlier messages');
    await act(async () => button!.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('chat_earlier', { paneId: 'p1', before: 'u10', limit: 50 });
    // The page reaches the first message: nothing is left before it, so the row is gone.
    expect(host.textContent).toContain('message 0');
    expect(host.textContent).toContain('message 19');
    expect(row()).toBeNull();
  });

  it('a long chat with more than one page: the row stays while messages are left, and goes on the last page', async () => {
    const journal = journalOf(120);
    await openChat(journal, openWith(journal, 10));
    let clicks = 0;
    while (row() && clicks < 20) {
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="show-earlier"] button')!.click());
      await flush();
      clicks++;
      // Each page is 50 items; the first message is reached after the pages cover the whole journal.
      if (clicks < 7) expect(row()).not.toBeNull();
    }
    expect(clicks).toBe(7);
    expect(host.textContent).toContain('message 0');
    expect(row()).toBeNull();
  });
});
