// @vitest-environment jsdom
// The "Continue where you left off" card is on the New agent page, and Hide on it sticks across a remount.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAddonApi } from '../../../lib/acpAddon';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import type { ClosedChatsApi } from '../../../lib/closedChats';
import type { NewAgentApi } from './api';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [{ id: 'claude', label: 'Claude', kind: 'cli', installed: true, modes: { headless: true, visible: true } }] as unknown as AgentDescriptor[];
const addonApi = { list: async () => ({ labsEnabled: true, addons: [] }), install: vi.fn(), remove: vi.fn(), watch: async () => () => undefined } as unknown as AcpAddonApi;
const pageApi = (): NewAgentApi => ({
  recent: async () => [],
  pickFolder: async () => null,
  pickPaths: async () => [],
  defaultFolder: async () => null,
  gitState: async () => 'repo',
  lanes: async () => ({ labsEnabled: true, agents: [{ id: 'claude', lane: 'terminal', disabled: false }] }),
  accounts: async () => [],
  loadHome: async () => ({ name: '', cards: [{ id: 'c1', kind: 'recent' }] }),
  saveCards: async () => undefined,
  onHomeChanged: async () => () => undefined,
});
const closedApi = {
  list: async () => [
    { id: 'a', agent: 'codex', label: 'Codex', cwd: '/w/alpha', updated_ms: 1, title: 'Fix login' },
    { id: 'b', agent: 'codex', label: 'Codex', cwd: '/w/beta', updated_ms: 1, title: 'hi' },
  ],
  reopen: vi.fn(),
  remove: vi.fn(),
  removeAll: vi.fn(),
  watch: async () => () => undefined,
} as unknown as ClosedChatsApi;
const previous = { savedAt: Date.now(), chats: [{ id: 'a', agent: 'codex', cwd: '/w/alpha', title: null }, { id: 'b', agent: 'codex', cwd: '/w/beta', title: null }], split: null };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount() {
  await act(async () => {
    root.render(<NewAgentPage agents={agents} panes={[]} needs={[]} api={pageApi()} addonApi={addonApi} onStart={vi.fn(async () => undefined)} onSignIn={vi.fn()} onOpenPane={vi.fn()} continueYesterday={{ previous, api: closedApi, openIds: [], onReopened: vi.fn() }} />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const card = () => document.querySelector('[data-testid="continue-card"]');

describe('the New agent page shows Continue where you left off', () => {
  it('lists only the real chat, and Hide stays hidden after the page is mounted again', async () => {
    await mount();
    expect(card()).not.toBeNull();
    expect(document.querySelectorAll('.ck-na-continue-name')).toHaveLength(1);
    const hide = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Hide')!;
    await act(async () => hide.click());
    expect(card()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(card()).toBeNull();
  });
});
