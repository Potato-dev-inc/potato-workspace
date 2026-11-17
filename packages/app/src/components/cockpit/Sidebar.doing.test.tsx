// @vitest-environment jsdom
// A working chat row says what the agent is doing right now (from the chat's own state), not only "Working".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
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

function cockpit(lane: string) {
  const info = { id: 'p1', agent_type: 'agy', pid: 1, status: 'running', created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title: null, lane } as unknown as PaneInfo;
  const panes = [{ info, status: 'running' }];
  return {
    chatStarting: null,
    registry: { paneList: panes, panes: new Map([['p1', panes[0]]]), initialReady: true },
    names: new Map([['p1', 'Agy']]),
    asked: { questions: [] },
    launchEntries: [{ type: 'agy', label: 'Agy' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map([['p1', 0]]),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;
const state = (doing: string | null) => ({ lane: 'acp', agent: 'agy', status: 'running', phase: 'working', turnInFlight: true, doing }) as unknown as AcpChatState;

async function render(c: CockpitApi, acp: ReturnType<typeof fakeAcpApi>) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} acp={acp} startModeApi={{ get: async () => 'chat', set: async () => undefined }} />));
  await act(async () => {});
}
const line = () => document.querySelector('[data-testid="row-doing"]')?.textContent;

describe('Sidebar row of a working chat', () => {
  it('shows the newest tool it runs now', async () => {
    await render(cockpit('acp'), fakeAcpApi({ state: async () => state('Run command dir') }));
    expect(line()).toBe('Run command dir');
  });

  it('says Thinking while no tool runs', async () => {
    await render(cockpit('acp'), fakeAcpApi({ state: async () => state(null) }));
    expect(line()).toBe('Thinking…');
  });

  it('a terminal agent keeps its usual line', async () => {
    await render(cockpit('terminal'), fakeAcpApi());
    expect(line()).toBeUndefined();
  });
});
