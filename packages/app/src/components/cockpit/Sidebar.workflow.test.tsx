// @vitest-environment jsdom
// The sidebar row of a workflow, through the real Sidebar (Labs "Workflows"): under the front agent, one quiet row with the
// workflow's name and how many agents work or need you. It stays as "done" until the front closes, opens the front chat with the
// Workflow pane, and is not there for a normal chat or with the switch off.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { rememberCrewStart } from '../../lib/crew-members';
import { resetTaskViews, useTaskView } from '../../lib/task-view';
import { Sidebar } from './Sidebar';

const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), workflows_enabled: flag.on }) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('pm.sidebar.groupBy', 'status');
  flag.on = true;
  resetTaskViews();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const pane = (id: string, status: string, title: string, parent?: string, startedAs?: string) => ({
  info: { id, agent_type: 'claude', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:/work/shop', cols: 80, rows: 24, title, parent_pane_id: parent, started_as: startedAs },
  status,
});
type P = ReturnType<typeof pane>;

function cockpit(list: P[]) {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'Claude'])),
    asked: { questions: [] }, launchEntries: [{ type: 'claude', label: 'Claude' }], readyAgents: new Set<string>(), mode: 'orchestration', theme: 'dark',
    selectedId: null, select: vi.fn(), prompts: {}, statusSince: new Map(), now: 60_000, spawn: null, notify: vi.fn(),
    setMode: vi.fn(async () => {}), toggleTheme: vi.fn(async () => {}), openSettings: vi.fn(async () => {}), bridgeLine: '',
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Shows what the details column of chat "front" holds. */
function Probe() {
  const v = useTaskView('front');
  return <i data-testid="probe">{v ? v.panes.map((p) => p.kind).join(',') : 'none'}</i>;
}
async function show(c: CockpitApi) {
  await act(async () =>
    root.render(
      <>
        <Sidebar c={c} onOpenPalette={() => {}} ship={ship} />
        <Probe />
      </>,
    ),
  );
  await flush();
  await flush();
}
const rowEl = () => host.querySelector<HTMLElement>('[data-testid="workflow-row"]');
const FRONT = pane('front', 'running', 'Router');
const mark = () => rememberCrewStart('wf', [{ role: 'Front', pane_id: 'front' }], 'Front', 'Research + Write');

describe('the workflow row in the sidebar', () => {
  it('sits under the front agent and says the name, how many work and how many need you', async () => {
    mark();
    await show(cockpit([FRONT, pane('a', 'running', 'Researcher', 'front', 'minion'), pane('b', 'running', 'Coder', 'front', 'minion'), pane('c', 'waiting_input', 'Writer', 'front', 'minion')]));
    const row = rowEl()!;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-testid="workflow-row-name"]')!.textContent).toBe('Workflow: Research + Write');
    expect(row.querySelector('[data-testid="workflow-row-counts"]')!.textContent).toBe('1 needs you · 2 working');
    expect(row.getAttribute('data-tone')).toBe('needs-you');
    expect(row.closest('.ck-node')!.querySelector('[data-pane-row="front"]')).not.toBeNull();
    // It has no hover buttons that could cover it, and no edge stripe class.
    expect(row.querySelectorAll('button')).toHaveLength(1);
    expect(row.outerHTML).not.toMatch(/stripe|accent-bar/);
  });

  it('stays as done after the work, and is gone when the front has started nothing', async () => {
    mark();
    await show(cockpit([FRONT, pane('a', 'idle', 'Researcher', 'front', 'minion')]));
    expect(rowEl()!.querySelector('[data-testid="workflow-row-counts"]')!.textContent).toBe('done');
    expect(rowEl()!.getAttribute('data-tone')).toBe('done');
    await act(async () => root.render(<Sidebar c={cockpit([FRONT])} onOpenPalette={() => {}} ship={ship} />));
    await flush();
    expect(rowEl()).toBeNull();
  });

  it('counts a helper waiting on a permission prompt as needs you, like the chip and the pane', async () => {
    mark();
    await show(cockpit([FRONT, pane('a', 'waiting_input', 'Researcher', 'front', 'minion'), pane('b', 'running', 'Writer', 'front', 'minion')]));
    expect(rowEl()!.querySelector('[data-testid="workflow-row-counts"]')!.textContent).toBe('1 needs you · 1 working');
  });

  it('a click opens the front chat with the Workflow pane open', async () => {
    mark();
    const c = cockpit([FRONT, pane('a', 'running', 'Researcher', 'front', 'minion')]);
    await show(c);
    expect(host.querySelector('[data-testid="probe"]')!.textContent).toBe('none');
    await act(async () => rowEl()!.querySelector('button')!.click());
    expect(c.select).toHaveBeenCalledWith('front');
    expect(host.querySelector('[data-testid="probe"]')!.textContent).toBe('workflow');
  });

  it('is not there for a normal chat with the same agents, or with the Labs switch off', async () => {
    await show(cockpit([FRONT, pane('a', 'running', 'Researcher', 'front', 'minion')]));
    expect(rowEl()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    mark();
    flag.on = false;
    await show(cockpit([FRONT, pane('a', 'running', 'Researcher', 'front', 'minion')]));
    expect(rowEl()).toBeNull();
  });
});
