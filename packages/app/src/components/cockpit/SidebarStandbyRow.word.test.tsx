// @vitest-environment jsdom
// The standby row's state word (1.1.9): it fits the row in a thin sidebar, shows Opening with a spinner at once, and Ready follows fast.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { setHelpersInSidebar } from '../../lib/helpersInSidebar';
import { currentUndo, resetUndoBar, runUndo } from '../../lib/undo-bar';
import type { StandbyHelperEntry, StandbyHelpersApi, StandbyHelpersView } from '../../lib/standbyHelpers';
import { readFileSync } from 'node:fs';
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
  localStorage.setItem('pm.sidebar.groupBy', 'status');
  setHelpersInSidebar(true);
  resetUndoBar();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const pane = (id: string, status: string, title: string, parent?: string) => ({
  info: { id, agent_type: 'codex', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:/work/shop', cols: 80, rows: 24, title, parent_pane_id: parent },
  status,
});
type P = ReturnType<typeof pane>;
/** A chat that is a standby seat's own (the pane list says which seat). */
const seatChat = (id: string, status: string, seat: string, parent?: string): P => {
  const p = pane(id, status, 'OpenCode', parent);
  return { ...p, info: { ...p.info, standby_seat: seat } as P['info'] };
};

const helper = (over: Partial<StandbyHelperEntry> = {}): StandbyHelperEntry => ({
  id: 'sb-1', name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: 'C:/work/shop', after_task: 'wait', state: 'ready', note: null, pane_id: null, home: 'a1',
  used_by: null, taken_over: false, open_pane: null, person_pane: null, ...over,
});

function cockpit(list: P[], selectedId: string | null = null) {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'Codex'])),
    asked: { questions: [] }, launchEntries: [{ type: 'codex', label: 'Codex' }], readyAgents: new Set<string>(), mode: 'orchestration', theme: 'dark',
    selectedId, select: vi.fn(), prompts: {}, statusSince: new Map(), now: 60_000, spawn: null, notify: vi.fn(),
    setMode: vi.fn(async () => {}), toggleTheme: vi.fn(async () => {}), openSettings: vi.fn(async () => {}), bridgeLine: '',
  } as unknown as CockpitApi;
}

function fakeApi(start: StandbyHelperEntry[], max = 4) {
  let current: StandbyHelpersView = { helpers: start, max, idle_minutes: 30 };
  const set = (helpers: StandbyHelperEntry[]) => (current = { ...current, helpers });
  const api = {
    get: vi.fn(async () => current),
    add: vi.fn(async (input) => set([...current.helpers, helper({ id: `sb-${current.helpers.length + 1}`, name: input.name, agent: input.agent, model: input.model, home: input.home ?? null, state: 'starting' })])),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => set(current.helpers.map((h) => (h.id === id ? { ...h, ...patch } : h)))),
    remove: vi.fn(async (id: string) => set(current.helpers.filter((h) => h.id !== id))),
    detach: vi.fn(async (id: string) => set(current.helpers.map((h) => (h.id === id ? { ...h, home: null, warm: true } : h)))),
    start: vi.fn(async () => current),
    setLimits: vi.fn(async () => current),
    open: vi.fn(async () => 'chat-9'),
    takeBack: vi.fn(async () => current),
  } as unknown as { [K in keyof StandbyHelpersApi]: ReturnType<typeof vi.fn> };
  return { api: api as unknown as StandbyHelpersApi & typeof api, set };
}

const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const word = () => host.querySelector('[data-testid="standby-state"]');

async function show(api: StandbyHelpersApi) {
  await act(async () => root.render(<Sidebar c={cockpit([pane('a1', 'idle', 'Right panel rebuild')])} onOpenPalette={() => {}} ship={ship} standbyApi={api} />));
  await flush();
  await flush();
}

describe('standby row state word', () => {
  it('a long start step shows its words and a spinner at once, with the full text as a tooltip', async () => {
    const { api } = fakeApi([helper({ state: 'starting', stage: 'opening session' })]);
    await show(api);
    expect(word()?.textContent).toBe('Opening session');
    expect(word()?.querySelector('.ck-sb-spin')).not.toBeNull();
    expect(word()?.querySelector('.ck-sb-word')?.getAttribute('title')).toBe('Opening session');
  });

  it('the css lets the word shrink with an ellipsis and drops it under the name instead of cutting it off', () => {
    const css = readFileSync('src/styles/standby-rows.css', 'utf8');
    expect(css).toMatch(/\.ck-sb-state \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;/);
    expect(css).toMatch(/\.ck-sb-word \{[^}]*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.ck-sb-row \{[^}]*flex-wrap: wrap;[^}]*height: auto;/);
  });

  it('Ready shows within a second or two of the helper turning ready (no 3 s wait)', async () => {
    {
      const { api, set } = fakeApi([helper({ state: 'starting', stage: 'connecting' })]);
      await show(api);
      expect(word()?.textContent).toBe('Connecting');
      set([helper({ state: 'ready' })]);
      await act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
      expect(word()?.textContent).toBe('Ready');
    }
  });
});
