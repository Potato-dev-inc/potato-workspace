// @vitest-environment jsdom
// Screen level (desktop): a message that went in and got no answer shows "No answer yet" with Try again and Start fresh,
// and Try again sends the same text again. The line goes when the backend says a reply showed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const listen = vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
  handlers.set(event, cb);
  return () => handlers.delete(event);
});
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...(a as Parameters<typeof listen>)) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import type { OutboxMessage } from '../../lib/paneOutbox';
import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const emit = (event: string, payload: unknown) => act(() => handlers.get(event)?.({ payload }));

function sent(over: Partial<OutboxMessage> = {}): OutboxMessage {
  return { id: 'm1', text: 'hello agent', createdAt: 1, state: 'sent', waitingFor: null, error: null, noAnswer: true, ...over };
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  handlers.clear();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'session_chat_open') return { available: true, reason: null, items: [], source: 'file' };
    if (cmd === 'pane_messages_list') return [];
    if (cmd === 'pane_message_send') return { ...sent({ id: 'm2', text: String(args.text), noAnswer: false, state: 'queued' }) };
    return undefined;
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

const line = () => host.querySelector('[data-testid="chat-pending-no-answer"]');

describe('SessionChatPanel: a message with no answer', () => {
  it('shows "No answer yet", Try again sends the same text, Start fresh stops the stuck turn', async () => {
    const onInterrupt = vi.fn();
    act(() => root.render(<SessionChatPanel paneId="p1" reply={{ blockedReason: null, onInterrupt }} />));
    await flush();
    emit('pane-outbox', { paneId: 'p1', messages: [sent()] });
    expect(line()?.textContent).toBe('No answer yet');

    act(() => (host.querySelector('[data-testid="chat-pending-retry"]') as HTMLButtonElement).click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('pane_message_send', { paneId: 'p1', text: 'hello agent' });
    // The old line is put away once the same text is on its way again.
    expect(line()).toBeNull();

    emit('pane-outbox', { paneId: 'p1', messages: [sent({ id: 'm3' })] });
    expect(line()).not.toBeNull();
    act(() => (host.querySelector('[data-testid="chat-pending-fresh"]') as HTMLButtonElement).click());
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(line()).toBeNull();
  });

  it('keeps the line even when the chat already shows the message, and drops it when the backend clears it', async () => {
    act(() => root.render(<SessionChatPanel paneId="p1" reply={{ blockedReason: null }} />));
    await flush();
    emit('session-chat-items', { paneId: 'p1', reset: false, items: [{ kind: 'user', id: 'u1', at: null, text: 'hello agent' }] });
    emit('pane-outbox', { paneId: 'p1', messages: [sent()] });
    expect(line()).not.toBeNull();
    emit('pane-outbox', { paneId: 'p1', messages: [sent({ noAnswer: false })] });
    expect(line()).toBeNull();
  });
});
