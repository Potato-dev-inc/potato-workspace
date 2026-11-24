// @vitest-environment jsdom
// One active row at a time: while a chat of another PC is open, the last selected chat of this PC is not drawn active too.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
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

const pane = { status: 'idle', info: { id: 'p1', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'D:/code/app', cols: 80, rows: 24 } };
const api = (selectedId: string | null): CockpitApi =>
  ({
    registry: { paneList: [pane], panes: new Map([['p1', pane]]), initialReady: true },
    names: new Map([['p1', 'Codex 1']]),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  }) as unknown as CockpitApi;
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;
const active = () => [...document.querySelectorAll('.ck-row.is-active')].map((e) => e.textContent ?? '');

describe('sidebar: one active row', () => {
  it('draws the selected chat of this PC active, and none of this PC while a far chat is open', async () => {
    const mount = (selectedKey: string | null, selectedId: string | null) => act(async () => root.render(<Sidebar c={api(selectedId)} onOpenPalette={() => {}} ship={ship} devices={{ groups: [], selectedKey, onOpen: () => {} }} />));
    await mount(null, 'p1');
    expect(active().some((t) => t.includes('Codex 1'))).toBe(true);
    await mount('dev:n:p9', 'p1');
    expect(active()).toEqual([]);
    await mount('dev:n:p9', null);
    expect(active()).toEqual([]);
  });
});
