// @vitest-environment jsdom
// Screen level: chats and projects are dragged into a new order in the sidebar, a chat is dragged to the Pinned
// group, helpers move with their parent. Click never drags, Esc cancels, Alt+Arrow works from the keyboard.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { Sidebar } from '../cockpit/Sidebar';
import { DragLayer } from './DragLayer';
import { cancelDrag } from './dragStore';
import { LS_CHAT_ORDER } from '../../lib/sidebarOrder';
import { LS_PINNED_PANES } from '../../lib/pinnedPanes';
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
  // The empty Pinned drop box floats above the first row.
  if (this.classList.contains('ck-pin-drop')) return rect(0, 200, -60, -5);
  return rect(0, 0, 0, 0);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: 'C:\\proj\\a' }, { path: 'C:\\proj\\b' }]));
  select.mockClear();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(layout);
});
afterEach(() => {
  act(() => cancelDrag());
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function fakeApi(): CockpitApi {
  const mk = (id: string, cwd: string, parent: string | null = null) => ({
    info: { id, agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd, cols: 80, rows: 24, title: null, parent_pane_id: parent } as unknown as PaneInfo,
    status: 'idle',
  });
  // Project a: chat a1 (with helper h1) and chat a2. Project b: chat b1.
  const panes = [mk('a1', 'C:\\proj\\a'), mk('h1', 'C:\\proj\\a', 'a1'), mk('a2', 'C:\\proj\\a'), mk('b1', 'C:\\proj\\b')];
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
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}
function makeShip(): ShipApi {
  return { recent: vi.fn(async () => []), gitState: vi.fn(async () => 'repo' as unknown as GitState), gitInitPlan: vi.fn(), gitInit: vi.fn(), forget: vi.fn(), pickFolder: vi.fn() } as unknown as ShipApi;
}
async function render() {
  await act(async () =>
    root.render(
      <>
        <Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={makeShip()} />
        <DragLayer />
      </>,
    ),
  );
  await act(async () => {});
}
const rowBtn = (id: string) => host.querySelector<HTMLElement>(`[data-pane-row="${id}"]`)!;
/** The chat rows in the order they are drawn. */
const order = () => [...host.querySelectorAll('[data-pane-row]')].map((el) => el.getAttribute('data-pane-row'));
const fire = (target: EventTarget, type: string, x: number, y: number) =>
  act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));
const press = (el: Element, key: string) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true })));
async function drag(from: Element, to: { x: number; y: number }) {
  await fire(from, 'pointerdown', 20, 10);
  await fire(window, 'pointermove', 60, 40);
  await fire(window, 'pointermove', to.x, to.y);
  await fire(window, 'pointerup', to.x, to.y);
}

describe('reorder chats inside a project', () => {
  it('starts in the usual order, helper under its parent', async () => {
    await render();
    expect(order()).toEqual(['a1', 'h1', 'a2', 'b1']);
  });

  it('dragging a chat above another moves it there and saves the order', async () => {
    await render();
    await fire(rowBtn('a2'), 'pointerdown', 20, 70);
    await fire(window, 'pointermove', 60, 40);
    await fire(window, 'pointermove', 50, 5);
    expect(host.querySelector('[data-testid="drop-line"]')).not.toBeNull();
    await fire(window, 'pointerup', 50, 5);
    expect(order()).toEqual(['a2', 'a1', 'h1', 'b1']);
    expect(JSON.parse(localStorage.getItem(LS_CHAT_ORDER) ?? '[]')).toEqual(['a2', 'a1']);
  });

  it('a chat with a helper moves together with the helper', async () => {
    await render();
    // Below the second chat (rows are 30 px; the second chat is at 60-90).
    await drag(rowBtn('a1'), { x: 50, y: 85 });
    expect(order()).toEqual(['a2', 'a1', 'h1', 'b1']);
    const node = rowBtn('a1').closest('.ck-node')!;
    expect(node.contains(rowBtn('h1'))).toBe(true);
  });

  it('a chat cannot be dropped into another project', async () => {
    await render();
    await drag(rowBtn('a2'), { x: 50, y: 100 });
    expect(order()).toEqual(['a1', 'h1', 'a2', 'b1']);
    expect(localStorage.getItem(LS_CHAT_ORDER)).toBeNull();
  });

  it('a plain click still opens the chat and does not drag', async () => {
    await render();
    await fire(rowBtn('a2'), 'pointerdown', 20, 70);
    await fire(window, 'pointermove', 22, 72);
    await fire(window, 'pointerup', 22, 72);
    await act(async () => rowBtn('a2').click());
    expect(select).toHaveBeenCalledWith('a2');
    expect(localStorage.getItem(LS_CHAT_ORDER)).toBeNull();
  });

  it('Esc cancels the drag: the order stays', async () => {
    await render();
    await fire(rowBtn('a2'), 'pointerdown', 20, 70);
    await fire(window, 'pointermove', 50, 5);
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await fire(window, 'pointerup', 50, 5);
    expect(order()).toEqual(['a1', 'h1', 'a2', 'b1']);
    expect(localStorage.getItem(LS_CHAT_ORDER)).toBeNull();
  });

  it('Alt+Down moves the focused chat one place and says so', async () => {
    await render();
    await press(rowBtn('a1'), 'ArrowDown');
    expect(order()).toEqual(['a2', 'a1', 'h1', 'b1']);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Moved Alpha to place 2 of 2');
  });
});

describe('pin by dragging', () => {
  it('shows a drop box for the first pin while a chat is dragged, and pins the chat there', async () => {
    await render();
    expect(host.querySelector('.ck-pin-drop')).toBeNull();
    await fire(rowBtn('a2'), 'pointerdown', 20, 70);
    await fire(window, 'pointermove', 60, 40);
    expect(host.querySelector('.ck-pin-drop')?.textContent).toBe('Drop here to pin');
    await fire(window, 'pointermove', 60, -20);
    await fire(window, 'pointerup', 60, -20);
    expect(JSON.parse(localStorage.getItem(LS_PINNED_PANES) ?? '[]')).toEqual(['a2']);
    expect(host.querySelector('.ck-pinned')?.contains(rowBtn('a2'))).toBe(true);
  });

  it('a helper cannot be pinned on its own', async () => {
    await render();
    await fire(rowBtn('h1'), 'pointerdown', 20, 40);
    await fire(window, 'pointermove', 60, 10);
    await fire(window, 'pointermove', 60, -20);
    await fire(window, 'pointerup', 60, -20);
    expect(localStorage.getItem(LS_PINNED_PANES)).toBeNull();
  });

  it('pinned chats are dragged into a new order', async () => {
    localStorage.setItem(LS_PINNED_PANES, JSON.stringify(['a2', 'b1']));
    await render();
    expect(order().slice(0, 2)).toEqual(['a2', 'b1']);
    await drag(rowBtn('b1'), { x: 50, y: 5 });
    expect(JSON.parse(localStorage.getItem(LS_PINNED_PANES) ?? '[]')).toEqual(['b1', 'a2']);
    expect(order().slice(0, 2)).toEqual(['b1', 'a2']);
  });
});

describe('reorder projects', () => {
  const header = (path: string) => [...host.querySelectorAll<HTMLElement>('.ck-proj-drag')].find((el) => el.closest('.ck-proj')?.getAttribute('aria-label') === path)!;
  const projectNames = () => [...host.querySelectorAll('.ck-proj')].map((el) => el.getAttribute('aria-label'));

  it('dragging a project above another reorders them and saves the list', async () => {
    await render();
    expect(projectNames()).toEqual(['a', 'b']);
    await drag(header('b'), { x: 50, y: 5 });
    expect(projectNames()).toEqual(['b', 'a']);
    expect(JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS) ?? '[]').map((p: { path: string }) => p.path)).toEqual(['C:\\proj\\b', 'C:\\proj\\a']);
    // The chats stay in their projects.
    expect(order()).toEqual(['b1', 'a1', 'h1', 'a2']);
  });

  it('Alt+Up on a project header moves the project up', async () => {
    await render();
    await press(header('b').querySelector('button')!, 'ArrowUp');
    expect(projectNames()).toEqual(['b', 'a']);
  });

  it('Esc cancels', async () => {
    await render();
    await fire(header('b'), 'pointerdown', 20, 100);
    await fire(window, 'pointermove', 50, 5);
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await fire(window, 'pointerup', 50, 5);
    expect(projectNames()).toEqual(['a', 'b']);
  });
});
