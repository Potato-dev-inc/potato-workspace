// @vitest-environment jsdom
// Screen level: the sidebar shows a "Closed chats" row only when there are closed chats; it opens the list, and
// Reopen selects the chat that came back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { fakeAcpApi } from '../../lib/acpChatFake';
import type { ClosedChat, ClosedChatsApi } from '../../lib/closedChats';
import type { ShipApi } from '../../lib/ship-api';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function cockpit() {
  const info = { id: 'p1', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo;
  const panes = [{ info, status: 'idle' }];
  const select = vi.fn();
  const c = {
    registry: { paneList: panes, panes: new Map([['p1', panes[0]]]), initialReady: true },
    names: new Map([['p1', 'Codex']]),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: 'p1',
    select,
    newAgent: vi.fn(),
    prompts: {},
    statusSince: new Map([['p1', 0]]),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
  return { c, select };
}

const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;
const closedChat: ClosedChat = { id: 'acp-1', agent: 'claude', label: 'Claude', cwd: 'C:\\work\\shop', updated_ms: Date.now() - 3_600_000, title: 'Fix the cart bug' };

function closedApi(initial: ClosedChat[]) {
  let chats = initial;
  const reopen = vi.fn(async (id: string) => {
    chats = chats.filter((x) => x.id !== id);
    return id;
  });
  const api: ClosedChatsApi = { list: async () => chats, reopen, remove: async () => undefined, removeAll: async () => 0, watch: async () => () => undefined };
  return { api, reopen };
}

async function render(c: CockpitApi, closedChatsApi: ClosedChatsApi) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} acp={fakeAcpApi()} closedChatsApi={closedChatsApi} />));
  await act(async () => {});
}
const entry = () => host.querySelector<HTMLButtonElement>('[data-testid="side-closed-chats"]');

describe('Sidebar Closed chats entry', () => {
  it('shows the entry with the count when there are closed chats', async () => {
    await render(cockpit().c, closedApi([closedChat]).api);
    expect(entry()?.textContent).toContain('Closed chats');
    expect(entry()?.textContent).toContain('1');
  });

  it('hides the entry when there are none', async () => {
    await render(cockpit().c, closedApi([]).api);
    expect(entry()).toBeNull();
    expect(host.textContent).not.toContain('Closed chats');
  });

  it('opens the list, and Reopen selects the chat and drops the entry', async () => {
    const { c, select } = cockpit();
    const { api, reopen } = closedApi([closedChat]);
    await render(c, api);
    await act(async () => entry()!.click());
    expect(document.body.textContent).toContain('Fix the cart bug');
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Reopen')!;
    await act(async () => button.click());
    await act(async () => {});
    expect(reopen).toHaveBeenCalledWith('acp-1');
    expect(select).toHaveBeenCalledWith('acp-1');
    expect(entry()).toBeNull();
  });
});
