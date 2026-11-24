// @vitest-environment jsdom
// "Tools are out of date — Reconnect", through the real chat screen: the banner shows for this chat only when the app
// reports its tool list is older, Reconnect restarts that chat's agent, and the banner clears once the agent
// reports the app's tool list again.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const listen = vi.fn(async () => () => {});
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => (listen as (...x: unknown[]) => unknown)(...a) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { resetDriftShare, type ToolsDrift } from '../../lib/mcp-drift';
import type { ChatItem } from '../../lib/sessionChat';
import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'First' },
  { kind: 'assistant', id: 'a1', at: null, text: 'One.', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 1_000 },
];

const stale = (paneId: string | null, canReconnect = true): ToolsDrift => ({ paneId, agentCatalog: 'old0000000000000', appCatalog: 'new0000000000000', canReconnect });

let host: HTMLDivElement;
let root: Root;
let drift: ToolsDrift[];
let reconnectError: string | null;

const flush = () =>
  act(async () => {
    await new Promise((r) => setImmediate(r));
  });

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  drift = [];
  resetDriftShare();
  reconnectError = null;
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'session_chat_open') return { available: true, reason: null, items: ITEMS, source: 'file' };
    if (cmd === 'pane_messages_list') return [];
    if (cmd === 'branch_lineage') return { from: null, children: [] };
    if (cmd === 'keep_going_lineage') return { from: null, to: null };
    if (cmd === 'mcp_tools_drift') return drift;
    if (cmd === 'mcp_reconnect') {
      if (reconnectError) throw new Error(reconnectError);
      drift = [];
    }
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

async function mount() {
  act(() => {
    root.render(<SessionChatPanel paneId="pane-7" reply={{ blockedReason: null }} />);
  });
  await flush();
  await flush();
}

const banner = () => host.querySelector('[data-tools-stale]');
const reconnectButton = () => [...host.querySelectorAll<HTMLButtonElement>('[data-tools-stale] button')].find((b) => b.textContent === 'Reconnect');

describe('SessionChatPanel and the out-of-date tools banner', () => {
  it('shows nothing while the agent has the app tool list', async () => {
    await mount();
    expect(banner()).toBeNull();
  });

  it('shows nothing when only another chat is out of date', async () => {
    drift = [stale('pane-other')];
    await mount();
    expect(banner()).toBeNull();
  });

  it('shows the banner for this chat and Reconnect clears it', async () => {
    drift = [stale('pane-7')];
    await mount();
    expect(banner()?.textContent).toContain('Tools are out of date.');
    act(() => reconnectButton()?.click());
    await flush();
    await flush();
    expect(invoke).toHaveBeenCalledWith('mcp_reconnect', { paneId: 'pane-7' });
    expect(banner()).toBeNull();
  });

  it('says why a reconnect failed and keeps the banner', async () => {
    drift = [stale('pane-7')];
    reconnectError = 'BUSY: The agent is working. Wait for it to finish, then reconnect.';
    await mount();
    act(() => reconnectButton()?.click());
    await flush();
    await flush();
    expect(banner()).not.toBeNull();
    expect(banner()?.querySelector('[role="alert"]')?.textContent).toBe('The agent is working. Wait for it to finish, then reconnect.');
  });

  it('asks for a close and reopen when the app cannot restart that agent itself', async () => {
    drift = [stale('pane-7', false)];
    await mount();
    expect(reconnectButton()).toBeUndefined();
    expect(banner()?.textContent).toContain('Close this agent and open it again.');
  });
});
