// @vitest-environment jsdom
// Screen level: an OpenCode `question` tool call in the Chat tab is a card with options, and picking one sends the
// answer through the same outbox as the message box.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
  { kind: 'user', id: 'u1', at: null, text: 'pick a colour' },
  { kind: 'toolCall', id: 't:q', at: null, callId: 'q', name: 'question', summary: 'question', input: { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] } },
  { kind: 'toolResult', id: 'r:q', at: null, callId: 'q', ok: false, summary: 'Failed', output: 'no picker' },
];

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'session_chat_open') return { available: true, reason: null, items: ITEMS, source: 'file' };
    if (cmd === 'pane_messages_list') return [];
    if (cmd === 'pane_message_send') return { id: 'm1', text: String(args.text), createdAt: 1, state: 'queued', waitingFor: null, error: null };
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

describe('the Chat tab with a question tool call', () => {
  it('draws the options and sends the pick as a message', async () => {
    act(() => root.render(<SessionChatPanel paneId="p1" reply={{ blockedReason: null }} />));
    await flush();
    const card = host.querySelector('[data-testid="question-card"]');
    expect(card).not.toBeNull();
    expect(host.textContent).toContain('Which colour?');
    const blue = [...host.querySelectorAll<HTMLButtonElement>('.ck-qcard-opt')].find((b) => b.textContent === 'Blue')!;
    await act(async () => blue.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('pane_message_send', { paneId: 'p1', text: 'My answer to "Which colour?": Blue' });
  });
});
