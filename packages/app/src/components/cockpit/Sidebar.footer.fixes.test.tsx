// @vitest-environment jsdom
// Sidebar footer, through the real Sidebar: the ... menu has a Theme item with Dark / Light / Light, dimmed / Auto, and the
// "background tasks" chip opens the list (jobs and helpers, with time and Stop) over the whole app, not inside the footer.
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
    setThemeChoice: vi.fn(async () => {}),
    toggleTheme: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
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


const more = () => document.querySelector<HTMLElement>('button[aria-label="More"]')!;
async function openMore() {
  await act(async () => more().click());
  await act(async () => {});
}

describe('Theme item in the footer menu', () => {
  it('lists Dark, Light, Light dimmed and Auto, marks the current one, and picks by name', async () => {
    const c = cockpit(true);
    await mount(c);
    await openMore();
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Dark', 'Light', 'Light, dimmed', 'Auto']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(document.querySelector('[role="menu"]')!.textContent).toContain('Theme');
    expect(document.querySelector('[role="menu"]')!.textContent).not.toContain('Switch to light');
    await act(async () => items[2].click());
    expect(c.setThemeChoice).toHaveBeenCalledWith('dim');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('background tasks chip', () => {
  it('opens the list over the whole app with the helper and the job, each with Stop', async () => {
    vi.spyOn(tauriJobsApi, 'all').mockResolvedValue({ p1: [job] });
    const c = cockpit(true);
    (c.registry as unknown as { paneList: unknown[] }).paneList.push({
      info: { id: 'h1', agent_type: 'codex', pid: 2, status: 'running', created_at: 2, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title: 'Reviewer', parent_pane_id: 'p1' },
      status: 'running',
    });
    await mount(c);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="jobs-chip"]')!.click());
    const sheet = document.querySelector('.ck-sheet--jobs')!;
    expect(sheet).not.toBeNull();
    // Not inside the sidebar footer: it sits in the app layer.
    expect(host.contains(sheet)).toBe(false);
    expect(sheet.querySelector('[data-testid="jobs-helper"]')).not.toBeNull();
    expect(sheet.textContent).toContain('node');
    const stops = [...sheet.querySelectorAll('button')].filter((b) => b.textContent === 'Stop');
    expect(stops.length).toBeGreaterThanOrEqual(2);
    await act(async () => stops[0].click());
    expect(c.interrupt).toHaveBeenCalledWith('h1');
  });
});
