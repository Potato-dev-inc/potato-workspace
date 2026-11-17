// @vitest-environment jsdom
// Spin-offs in the sidebar (Two types): nested one level under their agent with a small "↳", kept at the top level when the
// agent closes. Through the real Sidebar screen.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { setHelpersInSidebar } from '../../lib/helpersInSidebar';
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
  localStorage.clear();
  // The tree is off by default (the helpers bar holds helpers); these tests are about the tree, so they turn it on.
  setHelpersInSidebar(true);
  // These tests are about the Needs you / Working / Idle grouping; the Projects view is the default.
  localStorage.setItem('pm.sidebar.groupBy', 'status');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  setHelpersInSidebar(false);
  act(() => root.unmount());
  host.remove();
});

const pane = (id: string, status: string, title: string, parent?: string, started_as?: string) => ({
  info: { id, agent_type: 'codex', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title, parent_pane_id: parent, started_as },
  status,
});

function api(list: ReturnType<typeof pane>[]) {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'Codex'])),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    notify: vi.fn(),
    setMode: vi.fn(async () => {}),
    toggleTheme: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

async function render(c: CockpitApi) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} />));
  await act(async () => {});
}

const titles = (el: ParentNode = host) => [...el.querySelectorAll(el === host ? '.ck-group .ck-row-title' : '.ck-row-title')].map((t) => t.textContent);


describe('sidebar spin-offs', () => {
  it('nests a spin-off under its agent with a "↳" and says whose it is in the tooltip; a minion is no row', async () => {
    await render(
      api([
        pane('p', 'running', 'Claude 1'),
        pane('s1', 'running', 'Fix flaky tests', 'p', 'spin_off'),
        pane('m1', 'running', 'Review the diff', 'p', 'minion'),
      ]),
    );
    const group = host.querySelector('.ck-helpers') as HTMLElement;
    expect(group).not.toBeNull();
    expect(titles(group)).toEqual(['Fix flaky tests']);
    expect(titles()).not.toContain('Review the diff');
    const mark = group.querySelector('[data-testid="row-spinoff-mark"]');
    expect(mark?.textContent).toBe('↳');
    expect(mark?.parentElement?.getAttribute('title')).toMatch(/Spin-off of Claude 1 · started .+ ago/);
    // The agent's own row has no mark.
    expect(host.querySelectorAll('[data-testid="row-spinoff-mark"]')).toHaveLength(1);
  });

  it('nests a spin-off even when the "show helpers in the sidebar" switch is off; other helpers stay a count', async () => {
    setHelpersInSidebar(false);
    await render(api([pane('p', 'running', 'Claude 1'), pane('s1', 'idle', 'Fix flaky tests', 'p', 'spin_off'), pane('h1', 'running', 'Check tests', 'p')]));
    const group = host.querySelector('.ck-helpers') as HTMLElement;
    expect(titles(group)).toEqual(['Fix flaky tests']);
    expect(titles()).not.toContain('Check tests');
    expect(host.querySelector('[data-testid="row-helper-count"]')?.textContent).toBe('1');
  });

  it('keeps the spin-off, at the top level without a mark, when its agent closes', async () => {
    const spin = pane('s1', 'idle', 'Fix flaky tests', 'p', 'spin_off');
    await render(api([pane('p', 'running', 'Claude 1'), spin]));
    expect(host.querySelectorAll('[data-testid="row-spinoff-mark"]')).toHaveLength(1);
    // The agent's pane is gone from the list; the spin-off still names it as its parent.
    await render(api([spin]));
    expect(host.querySelector('.ck-helpers')).toBeNull();
    expect(host.querySelector('[data-testid="row-spinoff-mark"]')).toBeNull();
    expect(titles()).toEqual(['Fix flaky tests']);
  });
});
