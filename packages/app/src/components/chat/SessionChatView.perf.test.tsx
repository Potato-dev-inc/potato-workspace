// @vitest-environment jsdom
// A long chat stays cheap: 300 turns are on screen, one streamed chunk lands in the last one, and only that turn
// is drawn again (not all 300). Goes through the real chat hook, so the turn objects come from `groupTurns`.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useSessionChat } from '../../hooks/useSessionChat';
import type { ChatItem } from '../../lib/sessionChatModel';
import { SessionChatView, turnRenders } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function Chat() {
  const chat = useSessionChat('p-perf', true);
  return <SessionChatView state={chat.state} reason={chat.reason} source="acp" turns={chat.turns} model={chat.model} cliVersion={chat.cliVersion} paneId="p-perf" />;
}

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

function longChat(turns: number): ChatItem[] {
  const items: ChatItem[] = [];
  for (let i = 0; i < turns; i++) {
    items.push({ kind: 'user', id: `u${i}`, at: null, text: `question ${i}` });
    items.push({ kind: 'assistant', id: `a${i}`, at: null, text: `**answer** ${i} with \`code\``, model: null, finalAnswer: true });
    if (i < turns - 1) items.push({ kind: 'turnEnd', id: `e${i}`, at: null, outcome: 'completed', durationMs: 1000 });
  }
  return items;
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  handlers.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('a long chat', () => {
  it('redraws only the live turn for one streamed chunk (300 turns)', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'session_chat_open' ? { available: true, reason: null, items: longChat(300), source: 'acp' } : undefined));
    act(() => root.render(<Chat />));
    await flush();
    expect(host.querySelectorAll('[data-turn-id]')).toHaveLength(300);

    turnRenders.count = 0;
    const chunk: ChatItem = { kind: 'assistant', id: 'a299', at: null, text: '**answer** 299 with `code` and more words', model: null, finalAnswer: true };
    await act(async () => handlers.get('session-chat-items')!({ payload: { paneId: 'p-perf', items: [chunk], reset: false } }));
    const after = turnRenders.count;
    console.log(`TurnView renders for one streamed chunk in a 300-turn chat: ${after}`);
    expect(host.textContent).toContain('and more words');
    expect(after).toBeLessThanOrEqual(2);
    expect(host.querySelectorAll('.ck-chat-turn.is-done')).toHaveLength(299);
  });
});

describe('a long chat with turns that are not on screen', () => {
  it('Find in chat still counts a match in the oldest turn, and it keeps counting after a streamed chunk', async () => {
    const items = longChat(300);
    items[0] = { kind: 'user', id: 'u0', at: null, text: 'where is the zucchini code' };
    invoke.mockImplementation(async (cmd: string) => (cmd === 'session_chat_open' ? { available: true, reason: null, items, source: 'acp' } : undefined));
    act(() => root.render(<Chat />));
    await flush();
    const view = host.querySelector<HTMLElement>('[data-testid="session-chat"]')!;
    act(() => void view.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'f', ctrlKey: true })));
    const input = host.querySelector<HTMLInputElement>('.ck-find-input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'zucchini');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
    expect(host.querySelector('[data-testid="chat-find-count"]')!.textContent).toMatch(/1\s*(\/|of)\s*1|1 of 1|1\/1/);
    const chunk: ChatItem = { kind: 'assistant', id: 'a299', at: null, text: 'more words', model: null, finalAnswer: true };
    await act(async () => handlers.get('session-chat-items')!({ payload: { paneId: 'p-perf', items: [chunk], reset: false } }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
    expect(host.querySelector('[data-testid="chat-find-count"]')!.textContent).toMatch(/1\s*(\/|of)\s*1|1 of 1|1\/1/);
  });
});
