// @vitest-environment jsdom
// Screen level, through the real Sidebar and the real Background tasks section: a row can be put in the sidebar (menu or drag),
// detached, put back, and sent back to Background tasks. Letting a row go on the agent that owns it does nothing; on a different
// agent it asks "Hand over now" or "Hand over when it finishes". The row is the same task: its owner never changes by a move.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import type { AdoptApi } from '../../lib/helperAdopt';
import type { PaneJob } from '../../lib/pane-jobs';
import { setHelpersInSidebar } from '../../lib/helpersInSidebar';
import { closeHandOver, type HandMode, type HandOverApi } from '../../lib/task-handover';
import { setTaskSidebarApiForTest, type TaskPlacement, type TaskSidebarApi } from '../../lib/task-sidebar';
import { BackgroundSection, type HelperRow } from '../cockpit/rail/BackgroundSection';
import { HandOverSheet } from '../cockpit/HandOverSheet';
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
const interrupt = vi.fn();
const opened: (string | null)[] = [];
const hands: [string, string, HandMode, Record<string, string>][] = [];
const cancels: string[] = [];
let stored: TaskPlacement[];

const taskApi: TaskSidebarApi = {
  get: async () => stored,
  show: async (row) => {
    stored = stored.some((r) => r.task_id === row.task_id) ? stored.map((r) => (r.task_id === row.task_id ? row : r)) : [...stored, row];
    return stored;
  },
  place: async (id, under) => {
    stored = stored.map((r) => (r.task_id === id ? { ...r, under } : r));
    return stored;
  },
  remove: async (id) => {
    stored = stored.filter((r) => r.task_id !== id);
    return stored;
  },
  reorder: async () => stored,
};
const handApi: HandOverApi = {
  handOver: async (task, to, mode, names) => {
    hands.push([task, to, mode, names]);
    return '';
  },
  cancel: async (task) => {
    cancels.push(task);
    return true;
  },
};
const adoptApi: AdoptApi = { setHelperOf: async () => {} };

const rect = (l: number, r: number, t: number, b: number) => ({ left: l, right: r, top: t, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {} }) as DOMRect;
/** Every chat or task row wrapper is 30 px tall, one under the other in document order. The sidebar is x 0..200, the rail's section x 300..500. */
function layout(this: Element): DOMRect {
  const wraps = [...document.querySelectorAll('.ck-rowwrap')];
  const row = (el: Element) => {
    const k = wraps.indexOf(el);
    return rect(0, 200, k * 30, k * 30 + 30);
  };
  if (this.classList.contains('ck-rowwrap')) return row(this);
  if (this.classList.contains('ck-side')) return rect(0, 200, 0, 1000);
  if (this.matches('[data-testid="bg-section"]')) return rect(300, 500, 0, 100);
  const inside = this.matches('.ck-node, .ck-proj, .ck-proj-kids, .ck-pinned, .ck-projlist') ? [...this.querySelectorAll('.ck-rowwrap')].map(row) : [];
  if (inside.length > 0) return rect(0, 200, Math.min(...inside.map((r) => r.top)), Math.max(...inside.map((r) => r.bottom)));
  return rect(0, 0, 0, 0);
}

beforeEach(() => {
  localStorage.clear();
  resetUndoBar();
  setHelpersInSidebar(true);
  localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: 'C:\\proj\\a' }]));
  select.mockClear();
  notify.mockClear();
  interrupt.mockClear();
  opened.length = 0;
  hands.length = 0;
  cancels.length = 0;
  stored = [];
  setTaskSidebarApiForTest(taskApi, []);
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(layout);
});
afterEach(() => {
  setHelpersInSidebar(false);
  act(() => cancelDrag());
  act(() => closeHandOver());
  act(() => root.unmount());
  host.remove();
  resetUndoBar();
  setTaskSidebarApiForTest(null, []);
  vi.restoreAllMocks();
});

const pane = (id: string, parent: string | null, startedAs: string | null) => ({
  info: { id, agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\\proj\\a', cols: 80, rows: 24, title: null, parent_pane_id: parent, started_as: startedAs } as unknown as PaneInfo,
  status: id === 'm1' ? 'running' : 'idle',
});
function fakeApi(selectedId: string | null = null): CockpitApi {
  const panes = [pane('a1', null, null), pane('a2', null, null), pane('m1', 'a1', 'minion')];
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['a1', 'Alpha'], ['a2', 'Beta'], ['m1', 'Reviewer']]),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId,
    select,
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify,
    bridgeLine: '',
    interrupt,
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn(async () => []), gitState: vi.fn(async () => 'repo' as unknown as GitState), gitInitPlan: vi.fn(), gitInit: vi.fn(), forget: vi.fn(), pickFolder: vi.fn() } as unknown as ShipApi;
const minionRow: HelperRow = { id: 'm1', title: 'Reviewer', agent: 'Codex', agentType: 'codex', status: 'running', kind: 'minion', startedAtMs: 1 };
const job: PaneJob = { pid: 7, parentPid: 1, name: 'Dev server', command: 'npm run dev', startedAtMs: 5000, ports: [5173] };
let jobs: PaneJob[] = [];

function Screen() {
  return (
    <>
      <Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} adoptApi={adoptApi} openTaskId={null} onOpenTask={(id) => void opened.push(id)} />
      <div className="rail-host">
        <BackgroundSection
          helpers={[minionRow]}
          jobs={jobs}
          onOpenPane={() => {}}
          onStopJob={async () => {}}
          ownerId="a1"
          ownerName="Alpha"
          handTargets={[{ id: 'a2', name: 'Beta' }]}
          onHand={() => {}}
          onStopHelper={() => {}}
        />
      </div>
      <DragLayer />
      <UndoBar />
      <HandOverSheet api={handApi} notify={notify} />
    </>
  );
}
async function render() {
  await act(async () => root.render(<Screen />));
  await act(async () => {});
}
const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const rowBtn = (id: string) => q(`[data-pane-row="${id}"]`)!;
const railMinion = () => q('[data-testid="rail-helper"]')!;
const railJob = () => q('[data-testid="background-job"]')!;
const taskRow = (id: string) => q(`[data-task-row="${id}"]`);
const nestedUnder = (agent: string) => [...(rowBtn(agent).closest('.ck-node')?.querySelectorAll(':scope > .ck-helpers [data-task-row]') ?? [])].map((el) => el.getAttribute('data-task-row'));
const ownTasks = () => [...host.querySelectorAll('[data-testid="sidebar-tasks-own"] [data-task-row]')].map((el) => el.getAttribute('data-task-row'));
const fire = (target: EventTarget, type: string, x: number, y: number) => act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));
const rowTop = (el: Element) => layout.call(el.closest('.ck-rowwrap')!).top;
async function startDrag(from: Element) {
  await fire(from, 'pointerdown', 20, 10);
  await fire(window, 'pointermove', 60, 40);
}
const drop = async (x: number, y: number) => {
  await fire(window, 'pointermove', x, y);
  await fire(window, 'pointerup', x, y);
  await settle();
};
/** A real click starts with a press; the click that ends a drag is swallowed until one comes. */
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
  });
  await settle();
};
const menuItem = (testid: string) => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)!;
const rightClick = async (el: Element) => {
  await act(async () => void el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
};
const MINION = 'minion:m1';

describe('Show in sidebar, Detach, Back to Background tasks (menus)', () => {
  it('"Show in sidebar" adds a row nested under the agent that owns it, and the rail row says it is in the sidebar', async () => {
    await render();
    expect(taskRow(MINION)).toBeNull();
    expect(q('[data-testid="in-sidebar-mark"]')).toBeNull();
    await rightClick(railMinion());
    await click(menuItem('bg-menu-show'));
    expect(nestedUnder('a1')).toEqual([MINION]);
    expect(taskRow(MINION)?.textContent).toContain('Reviewer');
    expect(taskRow(MINION)?.textContent).toContain('minion');
    expect(q('[data-testid="in-sidebar-mark"]')).not.toBeNull();
    // The same task: it still belongs to Alpha, and it is still a Background tasks row.
    expect(stored).toEqual([{ task_id: MINION, kind: 'minion', owner: 'a1', under: 'a1', name: 'Reviewer', command: null }]);
    expect(railMinion()).not.toBeNull();
  });

  it('"Detach" puts it at the top level with a quiet "Alpha" line; "Put back under" nests it again', async () => {
    stored = [{ task_id: MINION, kind: 'minion', owner: 'a1', under: 'a1', name: 'Reviewer', command: null }];
    setTaskSidebarApiForTest(taskApi, stored);
    await render();
    expect(nestedUnder('a1')).toEqual([MINION]);
    await rightClick(taskRow(MINION)!);
    await click(menuItem('task-menu-detach'));
    expect(nestedUnder('a1')).toEqual([]);
    expect(ownTasks()).toEqual([MINION]);
    expect(q('[data-testid="task-owner-line"]')?.textContent).toBe('↳ Alpha');
    expect(stored[0]).toMatchObject({ owner: 'a1', under: null });
    await rightClick(taskRow(MINION)!);
    await click(menuItem('task-menu-putback'));
    expect(nestedUnder('a1')).toEqual([MINION]);
    expect(ownTasks()).toEqual([]);
  });

  it('"Back to Background tasks" removes the sidebar row and the mark; the task keeps running in the rail', async () => {
    stored = [{ task_id: MINION, kind: 'minion', owner: 'a1', under: 'a1', name: 'Reviewer', command: null }];
    setTaskSidebarApiForTest(taskApi, stored);
    await render();
    await rightClick(taskRow(MINION)!);
    await click(menuItem('task-menu-back'));
    expect(taskRow(MINION)).toBeNull();
    expect(q('[data-testid="in-sidebar-mark"]')).toBeNull();
    expect(railMinion()).not.toBeNull();
    expect(stored).toEqual([]);
  });

  it('Delete on a row of a running task asks once, then stops it; the row stays until it is closed', async () => {
    stored = [{ task_id: MINION, kind: 'minion', owner: 'a1', under: 'a1', name: 'Reviewer', command: null }];
    setTaskSidebarApiForTest(taskApi, stored);
    await render();
    await act(async () => void taskRow(MINION)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
    expect(interrupt).not.toHaveBeenCalled();
    await click(q('[data-testid="task-stop-yes"]')!);
    expect(interrupt).toHaveBeenCalledWith('m1');
  });

  it('a row is a button: Enter (a click) opens it in the main area', async () => {
    stored = [{ task_id: MINION, kind: 'minion', owner: 'a1', under: 'a1', name: 'Reviewer', command: null }];
    setTaskSidebarApiForTest(taskApi, stored);
    await render();
    await click(taskRow(MINION)!);
    expect(opened).toEqual([MINION]);
  });
});

describe('dragging a Background tasks row', () => {
  it('onto the agent that owns it does nothing, and says so', async () => {
    await render();
    await startDrag(railMinion());
    const alpha = rowBtn('a1');
    await fire(window, 'pointermove', 60, rowTop(alpha) + 15);
    expect(q('[data-testid="task-drop-preview"]')?.textContent).toBe('It is already Alpha’s');
    await drop(60, rowTop(alpha) + 15);
    expect(stored).toEqual([]);
    expect(taskRow(MINION)).toBeNull();
    expect(q('[data-testid="hand-now"]')).toBeNull();
    expect(hands).toEqual([]);
  });

  it('onto the bottom edge of its own agent shows it under that agent', async () => {
    await render();
    await startDrag(railMinion());
    const y = rowTop(rowBtn('a1')) + 28;
    await fire(window, 'pointermove', 60, y);
    expect(q('[data-testid="task-drop-preview"]')?.textContent).toBe('Show under Alpha');
    await drop(60, y);
    expect(nestedUnder('a1')).toEqual([MINION]);
    expect(stored[0]).toMatchObject({ owner: 'a1', under: 'a1' });
  });

  it('onto a DIFFERENT agent asks "Hand over now" or "Hand over when it finishes", and changes nothing yet', async () => {
    await render();
    await startDrag(railMinion());
    const beta = rowBtn('a2');
    await fire(window, 'pointermove', 60, rowTop(beta) + 15);
    expect(q('[data-testid="task-drop-preview"]')?.textContent).toBe('Hand to Beta…');
    await drop(60, rowTop(beta) + 15);
    expect(document.body.textContent).toContain('Hand this to Beta?');
    expect(q('[data-testid="hand-now"]')?.textContent).toContain('Hand over now');
    expect(q('[data-testid="hand-later"]')?.textContent).toContain('Hand over when it finishes');
    expect(hands).toEqual([]);
    expect(stored).toEqual([]);
    // Cancel: nothing happens.
    await click(q('[data-testid="hand-cancel"]')!);
    expect(q('[data-testid="hand-now"]')).toBeNull();
    expect(hands).toEqual([]);
  });

  it('"Hand over now" asks the PC to hand it over now, with the names the person sees, and offers Undo', async () => {
    await render();
    await startDrag(railMinion());
    await drop(60, rowTop(rowBtn('a2')) + 15);
    await click(q('[data-testid="hand-now"]')!);
    expect(hands).toEqual([['m1', 'a2', 'now', { m1: 'Reviewer', a1: 'Alpha', a2: 'Beta' }]]);
    expect(document.querySelector('[data-testid="undo-bar"]')?.textContent).toContain('Reviewer was handed to Beta');
    // Undo hands it back, the same way.
    await click(document.querySelector<HTMLElement>('.ck-undobar-btn')!);
    expect(hands[1]).toEqual(['m1', 'a1', 'now', { m1: 'Reviewer', a2: 'Beta', a1: 'Alpha' }]);
  });

  it('"Hand over when it finishes" asks for that; Undo takes it back before it finishes', async () => {
    await render();
    await startDrag(railMinion());
    await drop(60, rowTop(rowBtn('a2')) + 15);
    await click(q('[data-testid="hand-later"]')!);
    expect(hands.map((h) => h.slice(0, 3))).toEqual([['m1', 'a2', 'when_finished']]);
    expect(document.querySelector('[data-testid="undo-bar"]')?.textContent).toContain('will go to Beta when it finishes');
    await click(document.querySelector<HTMLElement>('.ck-undobar-btn')!);
    expect(cancels).toEqual(['m1']);
  });

  it('a command dragged onto a different agent is refused: it belongs to the chat it runs in', async () => {
    jobs = [job];
    await render();
    await startDrag(railJob());
    await fire(window, 'pointermove', 60, rowTop(rowBtn('a2')) + 15);
    expect(q('[data-testid="task-drop-preview"]')?.textContent).toContain('This belongs to Alpha');
    await drop(60, rowTop(rowBtn('a2')) + 15);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('This belongs to Alpha'));
    expect(q('[data-testid="hand-now"]')).toBeNull();
    expect(stored).toEqual([]);
    jobs = [];
  });

  it('onto empty sidebar space shows it on its own; the owner stays Alpha', async () => {
    await render();
    await startDrag(railMinion());
    await drop(60, 600);
    expect(ownTasks()).toEqual([MINION]);
    expect(stored[0]).toMatchObject({ owner: 'a1', under: null });
    expect(q('[data-testid="task-owner-line"]')?.textContent).toBe('↳ Alpha');
  });

  it('a sidebar row dragged back onto the Background tasks section goes back; the task keeps running', async () => {
    stored = [{ task_id: MINION, kind: 'minion', owner: 'a1', under: 'a1', name: 'Reviewer', command: null }];
    setTaskSidebarApiForTest(taskApi, stored);
    await render();
    await startDrag(taskRow(MINION)!);
    await fire(window, 'pointermove', 350, 40);
    expect(q('[data-testid="bg-section"]')?.className).toContain('is-drop-target');
    await drop(350, 40);
    expect(taskRow(MINION)).toBeNull();
    expect(stored).toEqual([]);
    expect(railMinion()).not.toBeNull();
  });
});
