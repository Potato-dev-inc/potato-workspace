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

  it('a seat working for an agent is still its one row under its home; its task chat is never an agent row', async () => {
    const { api } = fakeApi([helper({ state: 'busy', used_by: 'agent', pane_id: 'task-1' })]);
    const c = cockpit([pane('a1', 'idle', 'Right panel rebuild'), seatChat('task-1', 'running', 'sb-1', 'a1')]);
    await show(c, api);
    expect(names()).toEqual(['Reviewer']);
    expect(states()).toEqual(['Working']);
    expect(rows()[0].closest('.ck-node')!.querySelector('[data-pane-row="a1"]')).not.toBeNull();
    expect(host.querySelector('[data-pane-row="task-1"]')).toBeNull();
    // A click on the row opens the chat the task runs in.
    await act(async () => rows()[0].querySelector<HTMLButtonElement>('.ck-row')!.click());
    expect(c.select).toHaveBeenCalledWith('task-1');
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

  it('the X takes a standby off its agent (it keeps running as a warm agent) and Undo puts it back', async () => {
    const { api } = fakeApi([helper()]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    expect(host.querySelector('[data-testid="standby-tag"]')?.textContent).toBe('standby');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="standby-row-x"]')!.click());
    await flush();
    expect(api.detach).toHaveBeenCalledWith('sb-1');
    expect(api.remove).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[data-testid="standby-warm"]')?.textContent).toContain('1 warm');
    expect(currentUndo()?.text).toBe('Reviewer is a warm agent now. It keeps running.');
    await act(async () => void runUndo());
    await flush();
    expect(api.update).toHaveBeenCalledWith('sb-1', { home: 'a1' });
  });

  it('a warm agent sits on the quiet line at the bottom, folded; its menu offers Make standby for… and Close', async () => {
    const { api } = fakeApi([helper({ home: null, warm: true })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    expect(rows()).toHaveLength(0);
    const line = host.querySelector<HTMLButtonElement>('[data-testid="standby-warm"] .ck-sb-warm-line')!;
    expect(line.textContent).toContain('1 warm');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    await act(async () => line.click());
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute('data-kind')).toBe('warm');
    expect(rows()[0].querySelector('[data-testid="standby-tag"]')).toBeNull();
    await act(async () => rows()[0].querySelector('.ck-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const menu = document.querySelector('[data-testid="standby-row-menu"]')!;
    const labels = [...menu.querySelectorAll('[role^="menuitem"]')].map((e) => e.textContent?.replace('✓', ''));
    expect(menu.textContent).toContain('Make standby for…');
    expect(labels).toEqual(expect.arrayContaining(['Right panel rebuild', 'Close']));
    expect(labels.some((l) => l?.startsWith('Remove from'))).toBe(false);
    await act(async () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((e) => e.textContent === 'Right panel rebuild')!.click());
    expect(api.update).toHaveBeenCalledWith('sb-1', { home: 'a1' });
  });

  it('a starting standby says the real stage, not just Starting', async () => {
    const { api } = fakeApi([helper({ state: 'starting', stage: 'opening session' })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    expect(states()).toEqual(['Opening session']);
  });

  it('a standby that waits for low memory says so', async () => {
    const { api } = fakeApi([helper({ state: 'starting', stage: 'waiting for memory' })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    expect(states()).toEqual(['Waiting for memory']);
  });

  it('a sleeping standby that is waking up says so', async () => {
    const { api } = fakeApi([helper({ state: 'starting', stage: 'waking up' })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    expect(states()).toEqual(['Waking up…']);
  });

  it('Close stops it: the menu item removes the helper', async () => {
    const { api } = fakeApi([helper()]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await act(async () => rows()[0].querySelector('.ck-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const menu = document.querySelector('[data-testid="standby-row-menu"]')!;
    await act(async () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((e) => e.textContent === 'Close')!.click());
    await flush();
    expect(api.remove).toHaveBeenCalledWith('sb-1');
    expect(api.detach).not.toHaveBeenCalled();
    expect(currentUndo()?.text).toBe('Reviewer removed.');
  });

  it('the first click on a Ready standby shows its pane as soon as the id is known, before the list is read again', async () => {
    const { api } = fakeApi([helper({ id: 'y', name: 'Fresh' })]);
    const order: string[] = [];
    (api.get as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('get');
      return { helpers: [helper({ id: 'y', name: 'Fresh' })], max: 4, idle_minutes: 30 };
    });
    const c = cockpit([pane('a1', 'idle', 'Right panel rebuild')]);
    (c.select as ReturnType<typeof vi.fn>).mockImplementation(() => void order.push('select'));
    await show(c, api);
    order.length = 0;
    await act(async () => rows()[0].querySelector<HTMLButtonElement>('.ck-row')!.click());
    await flush();
    expect(order.indexOf('select')).toBe(0);
    expect(order.indexOf('get')).toBeGreaterThan(order.indexOf('select'));
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

  it('a row says why an agent last passed it by (and never counts uses: a standby is used once); Try it opens it for the person', async () => {
    const { api } = fakeApi([helper({ id: 'x', name: 'Reviewer', used_today: 3, skip_reason: 'different_model' }), helper({ id: 'y', name: 'Second', used_today: 1 })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    const row = (id: string) => rows().find((r) => r.dataset.helperId === id)!;
    expect(row('x').querySelector('[data-testid="standby-skip"]')?.textContent).toBe('Skipped: different model');
    expect(row('x').textContent).not.toMatch(/Used (once|\d+ times) today/);
    expect(row('y').textContent).not.toMatch(/Used (once|\d+ times) today/);
    expect(row('y').querySelector('[data-testid="standby-meta"]')).toBeNull();
    await act(async () => row('x').querySelector<HTMLButtonElement>('.ck-row-more')!.click());
    const tryIt = [...document.querySelectorAll<HTMLElement>('[data-testid="standby-row-menu"] [role="menuitem"]')].find((e) => e.textContent === 'Try it')!;
    expect(tryIt).toBeDefined();
    await act(async () => tryIt.click());
    await flush();
    expect(api.open).toHaveBeenCalledWith('x');
  });

  it('the row menu: rename, remove from the agent, close (no "after a task" choice: a standby is used once)', async () => {
    const { api } = fakeApi([helper()]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild')]), api);
    await act(async () => rows()[0].querySelector('.ck-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const menu = document.querySelector('[data-testid="standby-row-menu"]')!;
    const labels = [...menu.querySelectorAll('[role^="menuitem"]')].map((e) => e.textContent?.replace('✓', ''));
    expect(labels).toEqual(expect.arrayContaining(['Open', 'Rename', 'Remove from Right panel rebuild', 'Close']));
    expect(labels.some((l) => /after a task/i.test(l ?? ''))).toBe(false);
  });

  it('with "Show helpers in the sidebar" off there are no standby rows and the chat is an ordinary row again', async () => {
    setHelpersInSidebar(false);
    const { api } = fakeApi([helper({ state: 'busy', used_by: 'person', open_pane: 'chat-5' })]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('chat-5', 'idle', 'Opened')]), api);
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[data-pane-row="chat-5"]')).not.toBeNull();
    setHelpersInSidebar(true);
  });

  it('the pane menu has "Add a helper" on an agent and "Keep as standby" on a finished helper', async () => {
    const { api } = fakeApi([]);
    await show(cockpit([pane('a1', 'idle', 'Right panel rebuild'), pane('h1', 'idle', 'Checker', 'a1')]), api);
    const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent);
    await act(async () => host.querySelector('[data-pane-row="a1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    expect(menuItems()).toContain('Add a helper');
    expect(menuItems()).not.toContain('Keep as standby');
    await act(async () => void document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(async () => host.querySelector('[data-pane-row="h1"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    expect(menuItems()).toContain('Keep as standby');
    expect(menuItems()).not.toContain('Add a helper');
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === 'Keep as standby')!.click());
    await flush();
    expect(api.add).toHaveBeenCalledWith({ name: 'Checker', agent: 'codex', model: null, project: 'C:/work/shop', after_task: 'wait', home: 'a1' });
  });

  // The founder's rule: "when an agent wants to create a subagent, if it matches, the standby gets in ... it does not create
  // anything else". Every render of a whole claim is checked, with the pane list and the helper list arriving in either order.
  describe('a claim never moves the seat and never adds a row', () => {
    const A1 = () => pane('a1', 'running', 'Claude');
    /** What the person sees: the seat rows, where they hang, every agent row, and whether a "taken" banner shows. */
    const picture = () => ({
      seats: names(),
      state: states()[0],
      underOwner: rows().length === 1 && rows()[0].closest('.ck-node')?.querySelector('[data-pane-row="a1"]') !== null && rows()[0].closest('.ck-helpers') !== null,
      agentRows: [...host.querySelectorAll('[data-pane-row]')].map((e) => e.getAttribute('data-pane-row')),
      takeover: document.querySelector('[data-testid="takeover-banner"]') !== null,
    });
    const steady = (state: string) => ({ seats: ['OpenCode · deepseek'], state, underOwner: true, agentRows: ['a1'], takeover: false });
    const seat = (over: Partial<StandbyHelperEntry> = {}) => helper({ id: 'sb-1', name: 'OpenCode · deepseek', agent: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', home: 'a1', ...over });
    type Step = { panes: P[]; helpers?: StandbyHelperEntry[]; expect: string; why: string };

    async function run(steps: Step[], start: StandbyHelperEntry[] = [seat()], first: P[] = [A1()]) {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const { api, set } = fakeApi(start);
        const settle = async () => {
          await flush();
          await flush();
        };
        const render = async (list: P[]) => {
          await act(async () => root.render(<Sidebar c={cockpit(list)} onOpenPalette={() => {}} ship={ship} standbyApi={api} />));
          await settle();
        };
        await render(first);
        expect(picture(), 'before the task').toEqual(steady('Ready'));
        let checked = 0;
        for (const step of steps) {
          // The pane list changes first (an event), exactly as the app sends it; the helper list follows at its next read.
          await render(step.panes);
          expect(picture(), `${step.why} (pane list arrived, helper list not read yet)`).toMatchObject({ seats: ['OpenCode · deepseek'], underOwner: true, agentRows: ['a1'], takeover: false });
          if (step.helpers) set(step.helpers);
          await act(async () => void vi.advanceTimersByTime(3100));
          await settle();
          expect(picture(), step.why).toEqual(steady(step.expect));
          checked += 1;
        }
        expect(checked).toBe(steps.length);
      } finally {
        vi.useRealTimers();
      }
    }

    it('pane list first: Ready -> Working -> Ready, one row under its owner in every render, nothing else appears', async () => {
      await run([
        { why: 'the task chat is listed, not linked to the caller yet', panes: [A1(), seatChat('task-1', 'idle', 'sb-1')], expect: 'Ready' },
        { why: 'the task chat is linked under the caller', panes: [A1(), seatChat('task-1', 'running', 'sb-1', 'a1')], expect: 'Working' },
        { why: 'the helper list says busy', panes: [A1(), seatChat('task-1', 'running', 'sb-1', 'a1')], helpers: [seat({ state: 'busy', used_by: 'agent', pane_id: 'task-1' })], expect: 'Working' },
        { why: 'the task ended; the seat is ready and its finished chat is still open', panes: [A1(), seatChat('task-1', 'idle', 'sb-1', 'a1')], helpers: [seat({ state: 'ready' })], expect: 'Ready' },
        { why: 'the helper list drops the finished chat before the pane list does', panes: [A1(), seatChat('task-1', 'idle', 'sb-1', 'a1')], helpers: [seat({ state: 'ready' })], expect: 'Ready' },
        { why: 'the finished chat was closed', panes: [A1()], helpers: [seat({ state: 'ready' })], expect: 'Ready' },
        { why: 'a second task on the same seat', panes: [A1(), seatChat('task-2', 'running', 'sb-1', 'a1')], helpers: [seat({ state: 'busy', used_by: 'agent', pane_id: 'task-2' })], expect: 'Working' },
        { why: 'and back', panes: [A1()], helpers: [seat({ state: 'ready' })], expect: 'Ready' },
      ]);
    });

    it('helper list first: the row says Working before the chat is listed, and still nothing else appears', async () => {
      await run([
        { why: 'busy, its chat not listed yet', panes: [A1()], helpers: [seat({ state: 'busy', used_by: 'agent', pane_id: 'task-1' })], expect: 'Working' },
        { why: 'the chat is listed', panes: [A1(), seatChat('task-1', 'running', 'sb-1', 'a1')], expect: 'Working' },
        { why: 'the seat is starting its next clean session while the task chat lingers', panes: [A1(), seatChat('task-1', 'idle', 'sb-1', 'a1')], helpers: [seat({ state: 'starting' })], expect: 'Starting' },
        { why: 'ready again', panes: [A1()], helpers: [seat({ state: 'ready' })], expect: 'Ready' },
      ]);
    });

    it('a seat the person has open: the task runs in that same chat, no "taken" banner, no new row', async () => {
      await run(
        [
          { why: 'an agent took the seat: same chat, now linked under the caller', panes: [A1(), seatChat('chat-5', 'running', 'sb-1', 'a1')], helpers: [seat({ state: 'busy', used_by: 'agent', pane_id: 'chat-5' })], expect: 'Working' },
          { why: 'the task ended', panes: [A1(), seatChat('chat-5', 'idle', 'sb-1', 'a1')], helpers: [seat({ state: 'ready' })], expect: 'Ready' },
          { why: 'the chat was closed', panes: [A1()], helpers: [seat({ state: 'ready' })], expect: 'Ready' },
        ],
        [seat({ open_pane: 'chat-5' })],
        [A1(), seatChat('chat-5', 'idle', 'sb-1')],
      );
    });

    it('the number of rows is the same before, during and after a task', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const { api, set } = fakeApi([seat()]);
        const count = () => host.querySelectorAll('[data-pane-row], [data-testid="standby-row"]').length;
        const render = async (list: P[]) => {
          await act(async () => root.render(<Sidebar c={cockpit(list)} onOpenPalette={() => {}} ship={ship} standbyApi={api} />));
          await flush();
          await act(async () => void vi.advanceTimersByTime(3100));
          await flush();
          await flush();
        };
        await render([A1()]);
        const before = count();
        expect(before).toBe(2);
        set([seat({ state: 'busy', used_by: 'agent', pane_id: 'task-1' })]);
        await render([A1(), seatChat('task-1', 'running', 'sb-1', 'a1')]);
        expect(count()).toBe(before);
        set([seat({ state: 'ready' })]);
        await render([A1(), seatChat('task-1', 'idle', 'sb-1', 'a1')]);
        expect(count()).toBe(before);
        set([seat({ state: 'ready' })]);
        await render([A1()]);
        expect(count()).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // (Keep this test last: it renders inside an act() that is already running, and a test after it would render nothing.)
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
