// @vitest-environment jsdom
// Screen level, through the real Sidebar: drag one agent onto another and it becomes its helper ("Make helper of ..."),
// with a drop preview, an Undo bar, and the same thing from the row menu. Refusals: itself, its own helper, another project.
// Dragging to reorder keeps working (the top and bottom quarters of a row).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import type { AdoptApi } from '../../lib/helperAdopt';
import { setHelpersInSidebar } from '../../lib/helpersInSidebar';
import { Sidebar } from '../cockpit/Sidebar';
import { UndoBar } from '../cockpit/UndoBar';
import { DragLayer } from './DragLayer';
import { cancelDrag } from './dragStore';
import { resetUndoBar } from '../../lib/undo-bar';
import { LS_SIDEBAR_PROJECTS } from '../../lib/sidebarProjects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement;
let root: Root;
const select = vi.fn();
const notify = vi.fn();
/** Who each agent is a helper of right now (the desktop shell would hold this). */
let parents: Record<string, string | null>;
const calls: [string, string | null][] = [];
let failNext = false;
const adoptApi: AdoptApi = {
  setHelperOf: async (id, parent) => {
    if (failNext) {
      failNext = false;
      throw new Error('That agent is not open any more.');
    }
    calls.push([id, parent]);
    parents[id] = parent;
  },
};

const rect = (l: number, r: number, t: number, b: number) => ({ left: l, right: r, top: t, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {} }) as DOMRect;
/** Every chat row wrapper is 30 px tall, one under the other in document order. Containers are the union of their rows. */
function layout(this: Element): DOMRect {
  const wraps = [...document.querySelectorAll('.ck-rowwrap')];
  const row = (el: Element) => {
    const k = wraps.indexOf(el);
    return rect(0, 200, k * 30, k * 30 + 30);
  };
  if (this.classList.contains('ck-rowwrap')) return row(this);
  const inside = this.matches('.ck-node, .ck-proj, .ck-proj-kids, .ck-pinned, .ck-projlist') ? [...this.querySelectorAll('.ck-rowwrap')].map(row) : [];
  if (inside.length > 0) return rect(0, 200, Math.min(...inside.map((r) => r.top)), Math.max(...inside.map((r) => r.bottom)));
  return rect(0, 0, 0, 0);
}

beforeEach(() => {
  localStorage.clear();
  resetUndoBar();
  setHelpersInSidebar(true);
  localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: 'C:\\proj\\a' }, { path: 'C:\\proj\\b' }]));
  select.mockClear();
  notify.mockClear();
  calls.length = 0;
  failNext = false;
  // Project a: Alpha (with helper Helper) and Beta. Project b: Gamma.
  parents = { a1: null, h1: 'a1', a2: null, b1: null };
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(layout);
});
afterEach(() => {
  setHelpersInSidebar(false);
  act(() => cancelDrag());
  act(() => root.unmount());
  host.remove();
  resetUndoBar();
  vi.restoreAllMocks();
});

const CWD: Record<string, string> = { a1: 'C:\\proj\\a', h1: 'C:\\proj\\a', a2: 'C:\\proj\\a', b1: 'C:\\proj\\b' };
function fakeApi(): CockpitApi {
  const mk = (id: string) => ({
    info: { id, agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: CWD[id], cols: 80, rows: 24, title: null, parent_pane_id: parents[id] } as unknown as PaneInfo,
    status: 'idle',
  });
  const panes = ['a1', 'h1', 'a2', 'b1'].map(mk);
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['a1', 'Alpha'], ['h1', 'Helper'], ['a2', 'Beta'], ['b1', 'Gamma']]),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select,
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify,
    bridgeLine: '',
    interrupt: vi.fn(),
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn(async () => []), gitState: vi.fn(async () => 'repo' as unknown as GitState), gitInitPlan: vi.fn(), gitInit: vi.fn(), forget: vi.fn(), pickFolder: vi.fn() } as unknown as ShipApi;
async function render() {
  await act(async () =>
    root.render(
      <>
        <Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} adoptApi={adoptApi} />
        <DragLayer />
        <UndoBar />
      </>,
    ),
  );
  await act(async () => {});
}
const rowBtn = (id: string) => host.querySelector<HTMLElement>(`[data-pane-row="${id}"]`)!;
const order = () => [...host.querySelectorAll('[data-pane-row]')].map((el) => el.getAttribute('data-pane-row'));
/** The agents drawn inside the helper list of `id`. */
const helpersOf = (id: string) => [...(rowBtn(id).closest('.ck-node')?.querySelectorAll(':scope > .ck-helpers [data-pane-row]') ?? [])].map((el) => el.getAttribute('data-pane-row'));
const fire = (target: EventTarget, type: string, x: number, y: number) =>
  act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));
/** Row k (0-based, document order) is 30 px tall at k*30: its middle is k*30 + 15. */
const middle = (k: number) => k * 30 + 15;
async function startDrag(from: string, y: number) {
  await fire(rowBtn(from), 'pointerdown', 20, 10);
  await fire(window, 'pointermove', 60, 40);
  await fire(window, 'pointermove', 60, y);
}
/** The change is async (a call to the shell) and the pane list comes back after it: let it finish, then draw the list again. */
const settle = async () => {
  await act(async () => {});
  await act(async () => {});
  await render();
};
/** Lets go. */
const drop = async (y: number) => {
  await fire(window, 'pointerup', 60, y);
  await settle();
};
const preview = () => host.querySelector('[data-testid="adopt-preview"]');
const undoBar = () => document.querySelector('[data-testid="undo-bar"]');
/** A real click starts with a press; a drag's last click is swallowed until one comes. */
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    el.click();
  });
  await settle();
};
const undoButton = () => undoBar()!.querySelector<HTMLButtonElement>('.ck-undobar-btn')!;

describe('drag an agent onto another to make it a helper', () => {
  it('shows "Make helper of Alpha" while the pointer is over the middle of the row, and nothing before', async () => {
    await render();
    expect(preview()).toBeNull();
    await startDrag('a2', middle(0));
    expect(preview()?.textContent).toBe('Make helper of Alpha');
    expect(preview()?.classList.contains('is-refused')).toBe(false);
    // Over the edge of the row the preview goes (that is where reordering happens).
    await fire(window, 'pointermove', 60, 2);
    expect(preview()).toBeNull();
  });

  it('dropping makes it a helper: indented under the target, with an Undo bar; Undo makes it a main agent again', async () => {
    await render();
    expect(helpersOf('a1')).toEqual(['h1']);
    await startDrag('a2', middle(0));
    await drop(middle(0));
    expect(calls).toEqual([['a2', 'a1']]);
    expect(helpersOf('a1')).toEqual(['h1', 'a2']);
    expect(undoBar()?.textContent).toContain('Beta now helps Alpha');
    expect(preview()).toBeNull();
    await click(undoButton());
    expect(calls[1]).toEqual(['a2', null]);
    expect(helpersOf('a1')).toEqual(['h1']);
    expect(order()).toEqual(['a1', 'h1', 'a2', 'b1']);
  });

  it('the dragged agent keeps its own helpers, and they move along under it', async () => {
    await render();
    // Alpha (with Helper) onto Beta. Beta is row 2 in document order before the move.
    await startDrag('a1', middle(2));
    expect(preview()?.textContent).toBe('Make helper of Beta');
    await drop(middle(2));
    expect(calls).toEqual([['a1', 'a2']]);
    expect(helpersOf('a2')).toEqual(['a1', 'h1']);
    expect(rowBtn('a1').closest('.ck-node')!.contains(rowBtn('h1'))).toBe(true);
    expect(parents).toEqual({ a1: 'a2', h1: 'a1', a2: null, b1: null });
  });

  it('refuses another project: a preview that says so, a notice, and nothing changes', async () => {
    await render();
    await startDrag('a2', middle(3));
    expect(preview()?.textContent).toBe("Can't make helper of Gamma");
    expect(preview()?.classList.contains('is-refused')).toBe(true);
    await drop(middle(3));
    expect(calls).toEqual([]);
    expect(notify).toHaveBeenCalledWith('An agent can only help another agent in the same project.');
    expect(undoBar()).toBeNull();
    expect(order()).toEqual(['a1', 'h1', 'a2', 'b1']);
  });

  it('refuses its own helper (a loop) and an agent that is itself a helper', async () => {
    await render();
    // Alpha onto its own helper (row 1).
    await startDrag('a1', middle(1));
    expect(preview()?.classList.contains('is-refused')).toBe(true);
    await drop(middle(1));
    expect(calls).toEqual([]);
    expect(notify).toHaveBeenLastCalledWith('That would make a loop: the other agent already helps this one.');
    // Beta onto Alpha's helper: only a main agent can be given helpers.
    await startDrag('a2', middle(1));
    await drop(middle(1));
    expect(notify).toHaveBeenLastCalledWith('Only a main agent can be given helpers.');
    // A helper dragged onto another main agent.
    await startDrag('h1', middle(2));
    await drop(middle(2));
    expect(notify).toHaveBeenLastCalledWith('This agent is already a helper. Make it a main agent first.');
    expect(calls).toEqual([]);
  });

  it('dropping an agent on itself does nothing', async () => {
    await render();
    await startDrag('a2', middle(2));
    expect(preview()).toBeNull();
    await drop(middle(2));
    expect(calls).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('dragging to reorder still works at the edge of a row, and makes no helper', async () => {
    await render();
    await startDrag('a2', 5);
    expect(host.querySelector('[data-testid="drop-line"]')).not.toBeNull();
    await drop(5);
    expect(calls).toEqual([]);
    expect(order()[0]).toBe('a2');
  });

  it('a plain click still opens the agent', async () => {
    await render();
    await fire(rowBtn('a2'), 'pointerdown', 20, 70);
    await fire(window, 'pointerup', 20, 70);
    await click(rowBtn('a2'));
    expect(select).toHaveBeenCalledWith('a2');
    expect(calls).toEqual([]);
  });

  it('a failed change says why and shows no Undo', async () => {
    await render();
    await startDrag('a2', middle(0));
    failNext = true;
    await drop(middle(0));
    await act(async () => {});
    expect(notify).toHaveBeenCalledWith('That agent is not open any more.');
    expect(undoBar()).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('the row menu does the same without a mouse', () => {
  const openMenu = async (id: string) => {
    await act(async () => void rowBtn(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })));
  };
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.textContent);
  const pick = (label: string) => click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label)!);

  it('"Make helper of…" lists the main agents of the same project, and picking one makes the helper', async () => {
    await render();
    await openMenu('a2');
    expect(items()).toContain('Make helper of…');
    expect(items()).not.toContain('Make it a main agent again');
    await pick('Make helper of…');
    // Only Alpha: not itself, not Helper (already a helper), not Gamma (another project).
    expect(items()).toEqual(['Alpha']);
    expect(document.activeElement?.textContent).toBe('Alpha');
    await pick('Alpha');
    expect(calls).toEqual([['a2', 'a1']]);
    expect(helpersOf('a1')).toEqual(['h1', 'a2']);
    expect(undoBar()?.textContent).toContain('Beta now helps Alpha');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('a helper gets "Make it a main agent again" (and Undo puts it back)', async () => {
    await render();
    await openMenu('h1');
    expect(items()).not.toContain('Make helper of…');
    await pick('Make it a main agent again');
    expect(calls).toEqual([['h1', null]]);
    expect(helpersOf('a1')).toEqual([]);
    expect(undoBar()?.textContent).toContain('Helper is a main agent again');
    await click(undoButton());
    expect(calls[1]).toEqual(['h1', 'a1']);
    expect(helpersOf('a1')).toEqual(['h1']);
  });
});
