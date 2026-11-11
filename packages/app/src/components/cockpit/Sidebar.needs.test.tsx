// @vitest-environment jsdom
// A row that needs the person says so to a screen reader: "<Agent>, needs you".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  // These tests are about the Needs you / Working / Idle grouping; the Projects view is the default.
  localStorage.setItem('pm.sidebar.groupBy', 'status');
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function fakeApi(names: Record<string, string> = { a: 'Alpha', b: 'Beta', c: 'Gamma' }): CockpitApi {
  const mk = (id: string, status: string) => ({
    info: { id, agent_type: 'codex', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo,
    status,
  });
  const panes = [mk('a', 'idle'), mk('b', 'waiting_input'), mk('c', 'error')];
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(Object.entries(names)),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    interrupt: vi.fn(async () => {}),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const ship = {
  recent: vi.fn(async () => []),
  gitState: vi.fn(async () => 'repo' as unknown as GitState),
  gitInitPlan: vi.fn(),
  gitInit: vi.fn(),
  forget: vi.fn(),
  pickFolder: vi.fn(),
} as unknown as ShipApi;

async function render(c: CockpitApi) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} />));
  await act(async () => {});
}
const rowOf = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button.ck-row')].find((b) => b.querySelector('.ck-row-title')?.textContent === name)!;

describe('rows that need the person', () => {
  it('announce "<Agent>, needs you" only for a row that is waiting for an answer', async () => {
    await render(fakeApi());
    expect(rowOf('Beta').getAttribute('aria-label')).toBe('Beta, needs you');
    expect(rowOf('Alpha').getAttribute('aria-label')).toBeNull();
    expect(rowOf('Gamma').getAttribute('aria-label')).toBeNull();
  });
});
