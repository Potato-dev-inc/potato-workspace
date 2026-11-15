// @vitest-environment jsdom
// Screen level (desktop): when the outbox worker stopped for good, the message shows "Sending stopped" with Try again,
// and Try again sends the same text again and puts the old line away.
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

const stopped = (over: Partial<OutboxMessage> = {}): OutboxMessage => ({ id: 'm1', text: 'hello agent', createdAt: 1, state: 'failed', waitingFor: null, error: 'Sending stopped. Try again.', noAnswer: false, ...over });

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  handlers.clear();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'session_chat_open') return { available: true, reason: null, items: [], source: 'file' };
    if (cmd === 'pane_messages_list') return [];
    if (cmd === 'pane_message_send') return stopped({ id: 'm2', text: String(args.text), state: 'queued', error: null });
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

describe('SessionChatPanel: sending stopped', () => {
  it('shows "Sending stopped" with Try again, and Try again sends the same text', async () => {
    act(() => root.render(<SessionChatPanel paneId="p1" reply={{ blockedReason: null }} />));
    await flush();
    emit('pane-outbox', { paneId: 'p1', messages: [stopped()] });
    expect(host.querySelector('[data-testid="chat-pending-error"]')?.textContent).toBe('Sending stopped');
    act(() => (host.querySelector('[data-testid="chat-pending-try-again"]') as HTMLButtonElement).click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('pane_message_send', { paneId: 'p1', text: 'hello agent' });
    expect(host.querySelector('[data-testid="chat-pending-try-again"]')).toBeNull();
  });

  it('an ordinary failure keeps its own sentence and has no Try again', async () => {
    act(() => root.render(<SessionChatPanel paneId="p1" reply={{ blockedReason: null }} />));
    await flush();
    emit('pane-outbox', { paneId: 'p1', messages: [stopped({ error: 'The pane was closed.' })] });
    expect(host.querySelector('[data-testid="chat-pending-error"]')?.textContent).toBe('The pane was closed.');
    expect(host.querySelector('[data-testid="chat-pending-try-again"]')).toBeNull();
  });
});
