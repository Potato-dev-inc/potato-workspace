// @vitest-environment jsdom
// Screen level: pane tabs are dragged sideways to reorder (saved per project), onto the right edge to split.
// A click never drags, Esc cancels, Alt+Arrow moves a tab from the keyboard.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneTabs } from '../cockpit/PaneTabs';
import { DragLayer } from './DragLayer';
import { WorkAreaDropZones } from './WorkAreaDropZones';
import { cancelDrag } from './dragStore';
import { LS_PANE_TAB_ORDER } from '../../lib/paneTabOrder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mk = (id: string, title: string, cwd = 'C:\\work\\shop') => ({
  status: 'idle',
  info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd, cols: 100, rows: 30, title },
});
let host: HTMLDivElement;
let root: Root;
const select = vi.fn();
const onDropChat = vi.fn();

function api(): CockpitApi {
  const list = [mk('p1', 'one'), mk('p2', 'two'), mk('p3', 'three'), mk('q1', 'other project', 'C:\\work\\blog')];
  return { registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])) }, names: new Map(), prompts: {}, select, closePane: vi.fn(), notify: vi.fn() } as unknown as CockpitApi;
}
const rectOf = (l: number, r: number, t: number, b: number) => ({ left: l, right: r, top: t, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {} }) as DOMRect;

beforeEach(() => {
  localStorage.clear();
  select.mockClear();
  onDropChat.mockClear();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  // Three tabs, 100 px wide each, in a bar 0-300 x 0-30; the work area's right edge zone is 700-1000.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const tab = this.getAttribute('data-pane-tab');
    if (tab) {
      const at = [...(this.parentElement?.children ?? [])].indexOf(this);
      return rectOf(at * 100, at * 100 + 100, 0, 30);
    }
    if (this.getAttribute('data-testid') === 'pane-tabs') return rectOf(0, 300, 0, 30);
    if (this.getAttribute('data-testid') === 'dropzone-right') return rectOf(700, 1000, 0, 600);
    return rectOf(0, 0, 0, 0);
  });
});
afterEach(() => {
  act(() => cancelDrag());
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <>
        <PaneTabs c={api()} paneId="p1" />
        <div style={{ position: 'relative' }}>
          <WorkAreaDropZones onDropChat={onDropChat} />
        </div>
        <DragLayer />
      </>,
    ),
  );
  await act(async () => {});
}
const order = () => [...host.querySelectorAll('[data-pane-tab]')].map((el) => el.getAttribute('data-pane-tab'));
const tab = (id: string) => host.querySelector<HTMLElement>(`[data-pane-tab="${id}"]`)!;
const fire = (target: EventTarget, type: string, x: number, y: number) =>
  act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));
const saved = () => JSON.parse(localStorage.getItem(LS_PANE_TAB_ORDER) ?? '{}') as Record<string, string[]>;

describe('drag a pane tab sideways', () => {
  it('shows the tabs of this project in the order they were opened', async () => {
    await render();
    expect(order()).toEqual(['p1', 'p2', 'p3']);
  });

  it('dropping a tab after the last one moves it there, and the order is saved for the project', async () => {
    await render();
    await fire(tab('p1'), 'pointerdown', 50, 15);
    await fire(window, 'pointermove', 150, 15);
    expect(host.querySelector('[data-testid="drop-line"]')).not.toBeNull();
    await fire(window, 'pointermove', 290, 15);
    await fire(window, 'pointerup', 290, 15);
    expect(order()).toEqual(['p2', 'p3', 'p1']);
    expect(Object.values(saved())).toEqual([['p2', 'p3', 'p1']]);
    expect(host.querySelector('[data-testid="drop-line"]')).toBeNull();
  });

  it('dropping between two tabs puts the tab there', async () => {
    await render();
    await fire(tab('p3'), 'pointerdown', 250, 15);
    await fire(window, 'pointermove', 90, 15);
    await fire(window, 'pointerup', 90, 15);
    expect(order()).toEqual(['p1', 'p3', 'p2']);
  });

  it('the saved order comes back on the next mount, and other projects are not affected', async () => {
    localStorage.setItem(LS_PANE_TAB_ORDER, JSON.stringify({ 'c:/work/shop': ['p3', 'p1', 'p2'] }));
    await render();
    expect(order()).toEqual(['p3', 'p1', 'p2']);
  });

  it('a plain click selects the tab and does not drag; a move under 6 px is a click', async () => {
    await render();
    await fire(tab('p2'), 'pointerdown', 150, 15);
    await fire(window, 'pointermove', 153, 16);
    expect(host.querySelector('[data-testid="drag-ghost"]')).toBeNull();
    await fire(window, 'pointerup', 153, 16);
    await act(async () => tab('p2').querySelector<HTMLElement>('[role="tab"]')!.click());
    expect(select).toHaveBeenCalledWith('p2');
    expect(order()).toEqual(['p1', 'p2', 'p3']);
    expect(localStorage.getItem(LS_PANE_TAB_ORDER)).toBeNull();
  });

  it('the click after a real drag does not select the tab', async () => {
    await render();
    await fire(tab('p1'), 'pointerdown', 50, 15);
    await fire(window, 'pointermove', 290, 15);
    await fire(window, 'pointerup', 290, 15);
    await act(async () => tab('p1').querySelector<HTMLElement>('[role="tab"]')!.click());
    expect(select).not.toHaveBeenCalled();
  });

  it('Esc cancels: nothing moves and nothing is saved', async () => {
    await render();
    await fire(tab('p1'), 'pointerdown', 50, 15);
    await fire(window, 'pointermove', 290, 15);
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await fire(window, 'pointerup', 290, 15);
    expect(order()).toEqual(['p1', 'p2', 'p3']);
    expect(localStorage.getItem(LS_PANE_TAB_ORDER)).toBeNull();
  });
});

describe('drag a pane tab to the right edge to split', () => {
  it('shows only the right edge and drops that pane there', async () => {
    await render();
    await fire(tab('p2'), 'pointerdown', 150, 15);
    await fire(window, 'pointermove', 400, 200);
    expect(host.querySelector('[data-testid="dropzone-left"]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('[data-testid="dropzone-left"]')!.hidden).toBe(true);
    await fire(window, 'pointermove', 800, 200);
    expect(host.querySelector('[data-testid="dropzone-right"]')?.className).toContain('is-over');
    await fire(window, 'pointerup', 800, 200);
    expect(onDropChat).toHaveBeenCalledWith('p2', 'right');
    expect(order()).toEqual(['p1', 'p2', 'p3']);
  });

  it('letting go in the middle of the pane does nothing', async () => {
    await render();
    await fire(tab('p2'), 'pointerdown', 150, 15);
    await fire(window, 'pointermove', 400, 200);
    await fire(window, 'pointerup', 400, 200);
    expect(onDropChat).not.toHaveBeenCalled();
  });
});

describe('move a tab with the keyboard', () => {
  const press = (el: Element, key: string) =>
    act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true })));

  it('Alt+Right moves the focused tab one place and says so', async () => {
    await render();
    const main = tab('p1').querySelector('[role="tab"]')!;
    await press(main, 'ArrowRight');
    expect(order()).toEqual(['p2', 'p1', 'p3']);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Moved one to place 2 of 3');
  });

  it('Alt+Left on the first tab does nothing', async () => {
    await render();
    await press(tab('p1').querySelector('[role="tab"]')!, 'ArrowLeft');
    expect(order()).toEqual(['p1', 'p2', 'p3']);
  });

  it('the tab says how to move it', async () => {
    await render();
    expect(tab('p1').querySelector<HTMLElement>('[role="tab"]')!.title).toContain('Alt+Left');
  });
});
