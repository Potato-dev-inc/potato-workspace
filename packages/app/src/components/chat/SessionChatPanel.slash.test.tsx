// @vitest-environment jsdom
// Screen level: the "/" menu of a chat session shows the agent's saved commands at once (no session yet), the app's own
// commands always, and "Loading commands…" while the agent has said nothing and nothing is saved.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import type { AcpCommand } from '../../lib/acpChat';
import { SLASH_CACHE_KEY, rememberCommands } from '../../lib/slashCommands';
import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT: AcpCommand[] = [
  { name: 'compact', description: 'Shrink the conversation', hint: null },
  { name: 'review', description: 'Review the changes', hint: null },
];

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
const names = () => [...host.querySelectorAll('.ck-slash-name')].map((e) => e.textContent);
function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function open(props: { live?: AcpCommand[]; waiting?: boolean; onWarm?: () => void }) {
  act(() => root.render(<SessionChatPanel paneId="p1" reply={{ blockedReason: null }} slashAgent="claude" slashCommands={props.live ?? []} slashWaiting={props.waiting ?? true} onWarm={props.onWarm} />));
  await flush();
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  localStorage.removeItem(SLASH_CACHE_KEY);
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'session_chat_open') return { available: true, reason: null, items: [], source: 'file' };
    if (cmd === 'pane_messages_list') return [];
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

describe('the "/" menu before the agent is ready', () => {
  it('shows the saved commands with no session yet, then the app commands', async () => {
    rememberCommands('claude', '2.0.1', AGENT);
    await open({});
    type('/');
    expect(names()).toEqual(['/compact', '/review', '/recap', '/next']);
    expect(host.querySelector('[data-testid="slash-loading"]')).toBeNull();
  });

  it('shows the app commands and a Loading row when nothing is saved, and the agent list replaces it', async () => {
    await open({});
    type('/');
    expect(names()).toEqual(['/recap', '/next']);
    expect(host.querySelector('[data-testid="slash-loading"]')?.textContent).toBe('Loading commands…');
    await open({ live: AGENT, waiting: false });
    expect(names()).toEqual(['/compact', '/review', '/recap', '/next']);
    expect(host.querySelector('[data-testid="slash-loading"]')).toBeNull();
    // What the agent sent is kept for next time.
    expect(localStorage.getItem(SLASH_CACHE_KEY)).toContain('compact');
  });

  it('an app command puts its prompt in the box, and focusing the box warms the chat', async () => {
    const onWarm = vi.fn();
    await open({ onWarm });
    act(() => field().focus());
    expect(onWarm).toHaveBeenCalled();
    type('/rec');
    await act(async () => (host.querySelector('.ck-slash-opt') as HTMLElement).click());
    expect(field().value).toContain('recap of what we did so far');
  });
});
