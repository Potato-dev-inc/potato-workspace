// @vitest-environment jsdom
// Screen level: the Chat tab shows the context ring in its message box once the conversation has usage with a
// window size, opens the numbers on click, and draws no ring without them.
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

import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

const items = (contextWindow: number | null) => [
  { kind: 'user', id: '1:0', at: null, text: 'hello' },
  { kind: 'assistant', id: '2:0', at: null, text: 'hi there' },
  { kind: 'usage', id: '3:0', at: null, inputTokens: 40_000, outputTokens: 1000, contextWindow },
];

function backend(contextWindow: number | null) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'session_chat_open') return { available: true, reason: null, items: items(contextWindow), source: 'file' };
    if (cmd === 'pane_messages_list') return [];
    return undefined;
  });
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  listen.mockClear();
  handlers.clear();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function open(reply = true) {
  act(() => root.render(<SessionChatPanel paneId="p1" reply={reply ? { blockedReason: null } : undefined} />));
  await flush();
  await flush();
}

describe('the context ring in the Chat tab message box', () => {
  it('shows the share used and opens the numbers', async () => {
    backend(200_000);
    await open();
    const ring = host.querySelector<HTMLButtonElement>('.ck-chat-composer-foot [aria-label="Context 21% used"]');
    expect(ring).not.toBeNull();
    act(() => ring!.click());
    expect(host.querySelector('[data-testid="context-meter-pop"]')!.textContent).toContain('Used 41k of 200k tokens');
  });

  it('draws no ring when the agent did not say its window size', async () => {
    backend(null);
    await open();
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.querySelector('[data-testid="context-meter"]')).toBeNull();
  });
});
