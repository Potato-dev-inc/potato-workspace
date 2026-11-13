// @vitest-environment jsdom
// A sidebar row leads with the agent's own icon; the state stays visible on it.
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

// [id, agent type, status]
const PANES: [string, string, string][] = [
  ['a', 'claude', 'running'],
  ['b', 'codex', 'waiting_input'],
  ['c', 'kilo', 'idle'],
];

function fakeApi(): CockpitApi {
  const panes = PANES.map(([id, type, status]) => ({
    info: { id, agent_type: type, pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo,
    status,
  }));
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]),
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

async function render() {
  await act(async () => root.render(<Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} />));
  await act(async () => {});
}
const rowOf = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button.ck-row')].find((b) => b.querySelector('.ck-row-title')?.textContent === name)!;

describe('agent icons in the sidebar', () => {
  it('sidebar row shows the agent icon instead of the dot', async () => {
    await render();
    expect(rowOf('Alpha').querySelector('.ck-row-glyph svg[data-mark="logo"]')?.getAttribute('data-logo')).toBe('Claude');
    expect(rowOf('Beta').querySelector('.ck-row-glyph svg[data-mark="logo"]')).not.toBeNull();
    // No logo for this agent: a monogram, still an icon, never the bare dot.
    expect(rowOf('Gamma').querySelector('.ck-row-glyph [data-mark="monogram"]')?.getAttribute('data-letter')).toBe('K');
    for (const name of ['Alpha', 'Beta', 'Gamma']) expect(rowOf(name).querySelector('.ck-mark--icon')).not.toBeNull();
  });

  it('working and needs-you are still visible on a row with an icon', async () => {
    await render();
    const working = rowOf('Alpha').querySelector('.ck-mark')!;
    expect(working.getAttribute('aria-label')).toBe('Working');
    expect(working.classList.contains('ck-mark--working')).toBe(true);
    expect(working.querySelector('.ck-mark-shape')).not.toBeNull();
    const needs = rowOf('Beta').querySelector('.ck-mark')!;
    expect(needs.getAttribute('aria-label')).toBe('Needs you');
    expect(needs.querySelector('.ck-mark-shape')).not.toBeNull();
    expect(rowOf('Beta').querySelector('.ck-row-pill')?.textContent).toBe('Needs you');
    expect(rowOf('Beta').getAttribute('aria-label')).toBe('Beta, needs you');
    // Idle: the icon alone, no badge, still spoken.
    const idle = rowOf('Gamma').querySelector('.ck-mark')!;
    expect(idle.getAttribute('aria-label')).toBe('Idle');
    expect(idle.querySelector('.ck-mark-shape')).toBeNull();
  });
});
