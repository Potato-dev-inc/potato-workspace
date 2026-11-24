// @vitest-environment jsdom
// The desktop chat with three more features, through the backend commands: a picture the agent names (the PC checks the path),
// "Show earlier messages" (a page of the chat's journal, the reader keeps their place), and the draft that follows the person.
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

import type { ChatItem } from '../../lib/sessionChat';
import { clearPictureCache } from './ChatPicture';
import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const DOT = 'data:image/png;base64,iVBORw0KGgo=';

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, at: null, text });
const answer = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, at: null, text, model: null, finalAnswer: true });
const end = (id: string): ChatItem => ({ kind: 'turnEnd', id, at: null, outcome: 'completed', durationMs: 5 });

/** What the fake backend answers; each test sets what it needs. */
let backend: Record<string, (args: Record<string, unknown>) => unknown>;

import { earlierTuning, forgetKnownMore } from '../../hooks/useEarlier';
beforeEach(() => {
  earlierTuning.probeMs = 0;
  forgetKnownMore();
  localStorage.clear();
  clearPictureCache();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  handlers.clear();
  backend = {};
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'pane_messages_list') return [];
    return backend[cmd]?.(args);
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function open(items: ChatItem[], reply = true) {
  backend.session_chat_open = () => ({ available: true, reason: null, items, source: 'acp' });
  act(() => root.render(<SessionChatPanel paneId="p1" reply={reply ? { blockedReason: null } : undefined} />));
  await flush();
  await flush();
}

describe('pictures in the desktop chat', () => {
  const named = answer('a1', 'Here is the chart:\n\n![sales chart](<out/my chart.png>)\n\nDone.');

  it('asks the PC for the picture the answer names, draws it, and a click opens it large (Esc closes)', async () => {
    backend.chat_picture = () => ({ name: 'my chart.png', mime: 'image/png', size: 8, dataUrl: DOT });
    await open([user('u1', 'make a chart'), named, end('e1')]);
    expect(invoke).toHaveBeenCalledWith('chat_picture', { paneId: 'p1', path: 'out/my chart.png' });
    const img = host.querySelector<HTMLImageElement>('[data-testid="chat-picture"] img')!;
    expect(img.getAttribute('src')).toBe(DOT);
    expect(img.getAttribute('alt')).toBe('sales chart');
    expect(host.textContent).toContain('Here is the chart:');
    expect(host.textContent).toContain('Done.');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="chat-picture"]')!.click());
    expect(document.querySelector('[data-testid="chat-picture-big"] img')!.getAttribute('src')).toBe(DOT);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-testid="chat-picture-big"]')).toBeNull();
  });

  it('a picture the PC refuses (outside the project, a web address) shows one sentence, never the picture', async () => {
    backend.chat_picture = () => {
      throw new Error('PICTURE_NOT_IN_PROJECT: That picture is not in this project, so it is not shown.');
    };
    await open([user('u1', 'x'), answer('a1', 'See ![x](<C:/Windows/secret.png>) and ![y](https://example.com/a.png)'), end('e1')]);
    expect(host.querySelector('img')).toBeNull();
    const notes = [...host.querySelectorAll('[data-testid="chat-picture-refused"]')].map((n) => n.textContent);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('That picture is not in this project');
    // Both were sent to the PC to decide; the page itself never loads an address.
    expect(invoke).toHaveBeenCalledWith('chat_picture', { paneId: 'p1', path: 'C:/Windows/secret.png' });
  });

  it('text that is not picture syntax stays text', async () => {
    await open([user('u1', 'x'), answer('a1', 'Wow! [not an image](https://example.com) and ![broken'), end('e1')]);
    expect(host.querySelector('[data-testid="chat-picture"]')).toBeNull();
    expect(invoke.mock.calls.some((call) => call[0] === 'chat_picture')).toBe(false);
    expect(host.textContent).toContain('![broken');
  });
});

describe('Show earlier messages on the desktop', () => {
  const held = [user('u50', 'message 50'), answer('a50', 'answer 50'), end('e50')];

  it('shows the row when the journal has more, loads a page in front, and keeps the reader at the same message', async () => {
    let height = 1000;
    let pageLoaded = false;
    backend.chat_earlier = (args) => {
      if (args.limit === 0) return { items: [], more: !pageLoaded };
      pageLoaded = true;
      // The older messages are in front: the scroll area is taller by what they add.
      height = 1600;
      return { items: [user('u40', 'message 40'), answer('a40', 'answer 40'), end('e40')], more: false };
    };
    await open(held);
    expect(invoke).toHaveBeenCalledWith('chat_earlier', { paneId: 'p1', before: 'u50', limit: 0 });
    const body = host.querySelector<HTMLElement>('.ck-chat-body')!;
    Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => height });
    body.scrollTop = 300;
    const row = host.querySelector<HTMLButtonElement>('[data-testid="show-earlier"] button')!;
    expect(row.textContent).toBe('Show earlier messages');
    await act(async () => row.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('chat_earlier', { paneId: 'p1', before: 'u50', limit: 50 });
    const text = host.textContent ?? '';
    expect(text.indexOf('message 40')).toBeGreaterThan(-1);
    expect(text.indexOf('message 40')).toBeLessThan(text.indexOf('message 50'));
    // 300 + (1600 - 1000): the same message is under the same place.
    expect(body.scrollTop).toBe(900);
    expect(host.querySelector('[data-testid="show-earlier"]')).toBeNull();
  });

  it('a chat with nothing earlier, or one that is not a chat session, shows no row', async () => {
    backend.chat_earlier = () => ({ items: [], more: false });
    await open(held);
    expect(host.querySelector('[data-testid="show-earlier"]')).toBeNull();
  });

  it('live messages that arrive after the page are still added at the end', async () => {
    backend.chat_earlier = (args) => (args.limit === 0 ? { items: [], more: true } : { items: [user('u40', 'message 40')], more: false });
    await open(held);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="show-earlier"] button')!.click());
    await flush();
    act(() => handlers.get('session-chat-items')?.({ payload: { paneId: 'p1', reset: false, items: [user('u60', 'message 60')] } }));
    const text = host.textContent ?? '';
    expect(text.indexOf('message 40')).toBeLessThan(text.indexOf('message 50'));
    expect(text.indexOf('message 50')).toBeLessThan(text.indexOf('message 60'));
  });
});

describe('your draft follows you on the desktop', () => {
  const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
  const type = (value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      set.call(field(), value);
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('an empty box takes the draft the PC holds (from the phone)', async () => {
    backend.chat_draft_get = () => ({ text: 'started on my phone', at: 5 });
    await open([user('u1', 'hi')]);
    expect(invoke).toHaveBeenCalledWith('chat_draft_get', { paneId: 'p1' });
    expect(field().value).toBe('started on my phone');
  });

  it('a box with text is never replaced, even when the answer comes late', async () => {
    let release: (value: unknown) => void = () => undefined;
    backend.chat_draft_get = () => new Promise((resolve) => { release = resolve; });
    await open([user('u1', 'hi')]);
    type('I am typing here');
    await act(async () => release({ text: 'started on my phone', at: 5 }));
    await flush();
    expect(field().value).toBe('I am typing here');
  });

  it('a box restored with its own text is not asked to take another', async () => {
    localStorage.setItem('pm.composerDrafts', JSON.stringify({ p1: { text: 'kept on this PC', at: Date.now() } }));
    backend.chat_draft_get = () => ({ text: 'started on my phone', at: 5 });
    await open([user('u1', 'hi')]);
    expect(field().value).toBe('kept on this PC');
  });

  it('typing goes to the PC after a moment, and sending clears it at once; no attachment ever travels', async () => {
    backend.chat_draft_get = () => ({ text: '', at: 0 });
    backend.pane_message_send = (args) => ({ id: 'm1', text: String(args.text), createdAt: 1, state: 'queued', waitingFor: null, error: null });
    await open([user('u1', 'hi')]);
    type('half a message');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    const writes = invoke.mock.calls.filter((call) => call[0] === 'chat_draft_set');
    expect(writes.at(-1)).toEqual(['chat_draft_set', { paneId: 'p1', text: 'half a message' }]);
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    const after = invoke.mock.calls.filter((call) => call[0] === 'chat_draft_set');
    expect(after.at(-1)).toEqual(['chat_draft_set', { paneId: 'p1', text: '' }]);
    for (const call of after) expect(Object.keys(call[1] as object).sort()).toEqual(['paneId', 'text']);
  });
});
