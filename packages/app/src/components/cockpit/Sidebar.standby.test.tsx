// @vitest-environment jsdom
// Standby helpers in the sidebar, through the real Sidebar and the Add a helper popover: where the rows sit, the "+" door, Enter
// adds one (no role needed), the X removes and Undo brings it back, a closed home agent hands its helpers on, and the switch.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { setHelpersInSidebar } from '../../lib/helpersInSidebar';
import { currentUndo, resetUndoBar, runUndo } from '../../lib/undo-bar';
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
const states = () => rows().map((r) => r.querySelector('[data-testid="standby-state"]')?.textContent);

describe('standby helpers in the sidebar', () => {
  it('a Ready helper sits under its home agent with the word Ready', async () => {
    const { api } = fakeApi([helper()]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('a2', 'idle', 'Other agent')]), api);
    const group = host.querySelector('.ck-helpers')!;
    expect(group.getAttribute('aria-label')).toBe('Helpers of Right panel rebuild');
    expect(names()).toEqual(['Reviewer']);
    expect(states()).toEqual(['Ready']);
    expect(rows()[0].closest('.ck-node')!.querySelector('[data-pane-row="a1"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-pane-row="a2"]').length).toBe(1);
    expect(group.closest('.ck-node')!.querySelector('[data-pane-row="a2"]')).toBeNull();
  });

  it('every state has its word, and a working one for an agent that is not listed yet still shows', async () => {
    const { api } = fakeApi([
      helper({ id: '1', name: 'A', state: 'starting' }),
      helper({ id: '2', name: 'B', state: 'asleep' }),
      helper({ id: '3', name: 'C', state: 'problem', note: 'needs_sign_in' }),
      helper({ id: '4', name: 'D', state: 'busy', used_by: 'agent', pane_id: 'not-listed' }),
      helper({ id: '5', name: 'E', state: 'busy', used_by: 'person', open_pane: 'chat-5' }),
    ]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('chat-5', 'running', 'E')]), api);
    expect(names()).toEqual(['D', 'E', 'A', 'B', 'C']);
    expect(states()).toEqual(['Working', 'With you', 'Starting', 'Resting', "Can't start"]);
    // The chat the person opened is the helper's row, not a second agent row.
    expect(host.querySelector('[data-pane-row="chat-5"]')).toBeNull();
  });

  it('an agent task already shown as a helper chat is not drawn twice', async () => {
    const { api } = fakeApi([helper({ state: 'busy', used_by: 'agent', pane_id: 'task-1' })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('task-1', 'running', 'Reviewer chat', 'a1')]), api);
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[data-pane-row="task-1"]')).not.toBeNull();
  });

  it('closing the home agent moves the row under the newest agent of the project and says so', async () => {
    const { api } = fakeApi([helper({ home: 'a1' })]);
    const c1 = cockpit([pane('a1', 'idle', 'First'), pane('a2', 'idle', 'Second')]);
    await show(c1, api);
    expect(rows()[0].closest('.ck-node')!.querySelector('[data-pane-row="a1"]')).not.toBeNull();
    const c2 = cockpit([pane('a2', 'idle', 'Second')]);
    await show(c2, api);
    expect(rows()[0].closest('.ck-node')!.querySelector('[data-pane-row="a2"]')).not.toBeNull();
    expect(c2.notify).toHaveBeenCalledWith(expect.stringContaining('1 helper on standby moved under'));
  });

  it('no agent left in the project: a small group "Helpers waiting for an agent"', async () => {
    const { api } = fakeApi([helper({ home: 'gone' })]);
    await show(cockpit([]), api);
    expect(host.querySelector('[data-testid="standby-loose"]')!.textContent).toContain('Helpers waiting for an agent');
    expect(names()).toEqual(['Reviewer']);
  });

  it('the + on the agent row opens the popover; Enter adds a helper with no role, named "<Agent> · <model>"', async () => {
    const { api } = fakeApi([]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="row-add-helper"]')!.click());
    const popover = document.querySelector<HTMLFormElement>('[data-testid="add-helper"]')!;
    expect(popover).not.toBeNull();
    expect(popover.textContent).toContain('Right panel rebuild');
    // No role is chosen, and the Add button has the focus: Enter alone makes the helper.
    expect(popover.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(document.activeElement).toBe(popover.querySelector('[data-testid="add-helper-add"]'));
    await act(async () => popover.requestSubmit());
    await flush();
    expect(api.add).toHaveBeenCalledTimes(1);
    expect(api.add.mock.calls[0][0]).toMatchObject({ agent: 'codex', model: null, project: 'C:/work/shop', home: 'a1', after_task: 'wait', name: 'Codex CLI' });
    expect(document.querySelector('[data-testid="add-helper"]')).toBeNull();
    await flush();
    expect(states()).toEqual(['Starting']);
  });

  it('the X removes a Ready helper at once and Undo makes it again', async () => {
    const { api } = fakeApi([helper()]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="standby-row-x"]')!.click());
    await flush();
    expect(api.remove).toHaveBeenCalledWith('sb-1');
    expect(rows()).toHaveLength(0);
    expect(currentUndo()?.text).toBe('Reviewer removed.');
    await act(async () => void runUndo());
    await flush();
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Reviewer', agent: 'codex', model: 'gpt-5', home: 'a1' }));
    expect(rows()).toHaveLength(1);
  });

  it('a click opens the helper: the open chat when it has one, else it asks for one', async () => {
    const { api } = fakeApi([helper({ id: 'x', name: 'Opened', open_pane: 'chat-5' }), helper({ id: 'y', name: 'Fresh' })]);
    const c = cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('chat-5', 'idle', 'Opened')]);
    await show(c, api);
    await act(async () => rows()[0].querySelector<HTMLButtonElement>('.ck-row')!.click());
    expect(c.select).toHaveBeenCalledWith('chat-5');
    await act(async () => rows()[1].querySelector<HTMLButtonElement>('.ck-row')!.click());
    await flush();
    expect(api.open).toHaveBeenCalledWith('y');
    expect(c.select).toHaveBeenCalledWith('chat-9');
  });

  it('the row menu: rename, after a task, remove', async () => {
    const { api } = fakeApi([helper()]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await act(async () => rows()[0].querySelector('.ck-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const menu = document.querySelector('[data-testid="standby-row-menu"]')!;
    const labels = [...menu.querySelectorAll('[role^="menuitem"]')].map((e) => e.textContent?.replace('✓', ''));
    expect(labels).toEqual(expect.arrayContaining(['Open', 'Rename', 'After a task: wait again', 'After a task: close until needed', 'Remove helper']));
    const rest = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((e) => e.textContent?.endsWith('After a task: close until needed'))!;
    await act(async () => rest.click());
    expect(api.update).toHaveBeenCalledWith('sb-1', { after_task: 'close' });
  });

  it('with "Show helpers in the sidebar" off there are no standby rows and the chat is an ordinary row again', async () => {
    setHelpersInSidebar(false);
    const { api } = fakeApi([helper({ state: 'busy', used_by: 'person', open_pane: 'chat-5' })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('chat-5', 'idle', 'Opened')]), api);
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[data-pane-row="chat-5"]')).not.toBeNull();
    setHelpersInSidebar(true);
  });

  it('the pane menu has "Add a helper" on an agent and "Keep on standby" on a finished helper', async () => {
    const { api } = fakeApi([]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('h1', 'idle', 'Checker', 'a1')]), api);
    const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent);
    await act(async () => host.querySelector('[data-pane-row="a1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    expect(menuItems()).toContain('Add a helper');
    expect(menuItems()).not.toContain('Keep on standby');
    await act(async () => void document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(async () => host.querySelector('[data-pane-row="h1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    expect(menuItems()).toContain('Keep on standby');
    expect(menuItems()).not.toContain('Add a helper');
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === 'Keep on standby')!.click());
    await flush();
    expect(api.add).toHaveBeenCalledWith({ name: 'Checker', agent: 'codex', model: null, project: 'C:/work/shop', after_task: 'wait', home: 'a1' });
  });

  it('a click on a new standby never moves its row: the chat it opens is not shown as an agent while the list catches up', async () => {
    // The chat exists (the pane list has it) before the helper list says it is the helper's own: the old sidebar drew it as an agent
    // for that moment and the row jumped up. Every render between the click and the end is checked.
    const { api, set } = fakeApi([helper({ id: 'y', name: 'Fresh', state: 'ready' })]);
    const before = cockpit([pane('a1', 'idle', 'Right panel rebuild')]);
    await show(before, api);
    const place = () => ({ under: rows()[0]?.closest('.ck-node')?.querySelector('[data-pane-row="a1"]') !== null && rows().length === 1, topLevel: [...host.querySelectorAll('[data-pane-row]')].map((e) => e.getAttribute('data-pane-row')) });
    expect(place()).toEqual({ under: true, topLevel: ['a1'] });
    const seen: Array<ReturnType<typeof place>> = [];
    api.open.mockImplementation(async () => {
      // 1. the chat appears in the pane list; the helper list has not heard yet
      await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('chat-9', 'idle', 'Fresh chat')]), api);
      seen.push(place());
      // 2. the backend now says the chat is the helper's own
      set([helper({ id: 'y', name: 'Fresh', state: 'ready', open_pane: 'chat-9' })]);
      return 'chat-9';
    });
    await act(async () => rows()[0].querySelector<HTMLButtonElement>('.ck-row')!.click());
    await flush();
    await flush();
    seen.push(place());
    expect(api.open).toHaveBeenCalledWith('y');
    for (const step of seen) expect(step).toEqual({ under: true, topLevel: ['a1'] });
    expect(seen.length).toBe(2);
    // After the click the chat is still the helper's row, and a later poll changes nothing.
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('chat-9', 'idle', 'Fresh chat')]), api);
    expect(place()).toEqual({ under: true, topLevel: ['a1'] });
  });
});
