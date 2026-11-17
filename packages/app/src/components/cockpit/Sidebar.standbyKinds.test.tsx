// @vitest-environment jsdom
// Standby kinds (plan 2.5), through the real Sidebar, the Add a standby popover and the right panel: a spin-off standby has a
// sidebar row, a minion standby has none and shows as "1 ready" in its agent's Background tasks; "Run as" is in the popover and the row menu.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { setTwoTypesWording } from '../../i18n';
import { useEnglish } from '../../i18n/test-utils';
import { setHelpersInSidebar } from '../../lib/helpersInSidebar';
import { resetUndoBar } from '../../lib/undo-bar';
import type { StandbyHelperEntry, StandbyHelpersApi, StandbyHelpersView } from '../../lib/standbyHelpers';
import { AddHelperPopover } from './AddHelperPopover';
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
  useEnglish();
  setTwoTypesWording(true);
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
  setTwoTypesWording(false);
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
    add: vi.fn(async (input) => set([...current.helpers, helper({ id: `sb-${current.helpers.length + 1}`, name: input.name, agent: input.agent, model: input.model, home: input.home ?? null, kind: input.kind, state: 'starting' })])),
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

async function show(c: CockpitApi, api: StandbyHelpersApi) {
  await act(async () =>
    root.render(
      <>
        <Sidebar c={c} onOpenPalette={() => {}} ship={ship} standbyApi={api} />
        <AddHelperPopover api={api} front={{ id: 'a1', cwd: 'C:/work/shop', agent: 'codex' }} homeLabel={() => 'Right panel rebuild'} />
      </>,
    ),
  );
  await flush();
  await flush();
}
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="standby-row"]')];
const names = () => rows().map((r) => r.querySelector('.ck-row-title')?.textContent);

describe('standby kinds in the sidebar', () => {
  it('a spin-off standby has a row under its agent; a minion standby has none', async () => {
    const { api } = fakeApi([helper({ id: 'sb-1', name: 'Reviewer', kind: 'spin_off' }), helper({ id: 'sb-2', name: 'Tester', kind: 'minion' }), helper({ id: 'sb-3', name: 'Old one' })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    // The one with no kind (an older app) is a spin-off.
    expect(names()).toEqual(['Reviewer', 'Old one']);
  });

  it('in One type mode the kind is ignored: every standby has its row', async () => {
    setTwoTypesWording(false);
    const { api } = fakeApi([helper({ id: 'sb-1', name: 'Reviewer', kind: 'spin_off' }), helper({ id: 'sb-2', name: 'Tester', kind: 'minion' })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    expect(names()).toEqual(['Reviewer', 'Tester']);
  });

  it('the standby list says whether the kinds are on, so every window follows it', async () => {
    setTwoTypesWording(false);
    const { api } = fakeApi([helper({ id: 'sb-1', name: 'Reviewer' }), helper({ id: 'sb-2', name: 'Tester', kind: 'minion' })]);
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ helpers: [helper({ id: 'sb-1', name: 'Reviewer' }), helper({ id: 'sb-2', name: 'Tester', kind: 'minion' })], max: 4, idle_minutes: 30, two_types: true });
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await flush();
    expect(names()).toEqual(['Reviewer']);
  });

  it('the popover has "Run as" (Spin-off by default); picking Minion adds a minion standby', async () => {
    const { api } = fakeApi([]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="row-add-helper"]')!.click());
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="add-helper-kind"] [role="radio"]')];
    expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([['Spin-off', 'true'], ['Minion', 'false']]);
    await act(async () => radios[1].click());
    await act(async () => document.querySelector<HTMLFormElement>('[data-testid="add-helper"]')!.requestSubmit());
    await flush();
    expect(api.add.mock.calls[0][0]).toMatchObject({ kind: 'minion' });
    await flush();
    expect(names()).toEqual([]);
  });

  it('the row menu has Run as; choosing Minion saves it and the row leaves the sidebar', async () => {
    const { api } = fakeApi([helper()]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await act(async () => rows()[0].querySelector('.ck-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const menu = document.querySelector('[data-testid="standby-row-menu"]')!;
    const runAs = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].filter((e) => /Spin-off|Minion/.test(e.textContent ?? ''));
    expect(runAs.map((e) => [e.textContent?.replace('✓', ''), e.getAttribute('aria-checked')])).toEqual([['Spin-off', 'true'], ['Minion', 'false']]);
    await act(async () => runAs[1].click());
    await flush();
    expect(api.update).toHaveBeenCalledWith('sb-1', { kind: 'minion' });
    await flush();
    expect(names()).toEqual([]);
  });

  it('the default for a new standby comes from the setting', async () => {
    const { api } = fakeApi([]);
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ helpers: [], max: 4, idle_minutes: 30, default_kind: 'minion' });
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="row-add-helper"]')!.click());
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="add-helper-kind"] [role="radio"]')];
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });
});
