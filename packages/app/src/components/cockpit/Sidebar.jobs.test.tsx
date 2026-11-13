// @vitest-environment jsdom
// One list of panes: the footer's "background tasks" chip and the sidebar's "No agents running" read the same
// panes, so a job left behind by a pane that is not listed is never shown as something running.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { fakeAcpApi } from '../../lib/acpChatFake';
import { tauriJobsApi, type PaneJob } from '../../lib/pane-jobs';
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
  vi.restoreAllMocks();
});

const job: PaneJob = { pid: 10, parentPid: 1, name: 'node', command: 'node dev', startedAtMs: 1, ports: [3000] };

function cockpit(withPane: boolean) {
  const info = { id: 'p1', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo;
  const panes = withPane ? [{ info, status: 'idle' }] : [];
  return {
    chatStarting: null,
    beginChatStart: vi.fn(),
    endChatStart: vi.fn(),
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(withPane ? [['p1', 'Codex']] : []),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    newAgent: vi.fn(),
    prompts: {},
    statusSince: new Map(withPane ? [['p1', 0]] : []),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const ship = { recent: async () => [], gitState: async () => 'repo' } as unknown as ShipApi;
async function mount(c: CockpitApi) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} acp={fakeAcpApi({})} />));
  await act(async () => {});
}

describe('footer and sidebar count the same panes', () => {
  it('with no panes listed, a leftover job shows no chip and the sidebar says no agents', async () => {
    vi.spyOn(tauriJobsApi, 'all').mockResolvedValue({ ghost: [job, { ...job, pid: 11 }] });
    await mount(cockpit(false));
    expect(host.textContent).toContain('No agents running');
    expect(host.querySelector('[data-testid="jobs-chip"]')).toBeNull();
  });

  it('with a listed pane, its job shows in the footer and the sidebar does not say no agents', async () => {
    vi.spyOn(tauriJobsApi, 'all').mockResolvedValue({ p1: [job], ghost: [job] });
    await mount(cockpit(true));
    expect(host.textContent).not.toContain('No agents running');
    expect(host.querySelector('[data-testid="jobs-chip"]')?.textContent).toContain('1 background task');
  });
});
