// @vitest-environment jsdom
// Screen level: a sidebar row is dragged onto the work-area zones. A click does not drag, Esc cancels.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { Sidebar } from '../cockpit/Sidebar';
import { DragLayer } from './DragLayer';
import { WorkAreaDrop } from './WorkAreaDrop';
import { cancelDrag } from './dragStore';

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
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  // The work area is 1000 x 600: the middle line is 452-548, the bottom zone is below y = 408.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [l, r] = this.getAttribute('data-testid') === 'work-drop' ? [0, 1000] : [0, 0];
    return { left: l, right: r, top: 0, bottom: r === 0 ? 0 : 600, width: r - l, height: r === 0 ? 0 : 600, x: l, y: 0, toJSON() {} } as DOMRect;
  });
});
afterEach(() => {
  act(() => cancelDrag());
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function fakeApi(select = vi.fn()): CockpitApi {
  const mk = (id: string) => ({
    info: { id, agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo,
    status: 'idle',
  });
  const panes = [mk('p1'), mk('p2')];
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['p1', 'Codex'], ['p2', 'Codex two']]),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: 'p1',
    select,
    prompts: {},
    statusSince: new Map([['p1', 0], ['p2', 0]]),
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
async function render(select: () => void, onDropChat: (id: string, zone: string, column: string) => void) {
  await act(async () =>
    root.render(
      <>
        <Sidebar c={fakeApi(select as never)} onOpenPalette={() => {}} ship={makeShip()} />
        <div style={{ position: 'relative' }}>
          <WorkAreaDrop shown={['p1']} remembered={0.58} partnerOf={() => 'p1'} nameOf={(id) => (id === 'p1' ? 'Codex' : 'Codex two')} onDrop={onDropChat} />
        </div>
        <DragLayer />
      </>,
    ),
  );
  await act(async () => {});
}
const row = () =>
  [...host.querySelectorAll<HTMLButtonElement>('button.ck-row')].find((b) => b.querySelector('.ck-row-title')?.textContent === 'Codex two')!;
const fire = (target: EventTarget, type: string, x: number, y: number) =>
  act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));

describe('drag a chat from the sidebar', () => {
  const zoneNow = () => host.querySelector('[data-testid="work-drop"]')?.getAttribute('data-zone');
  const take = () => host.querySelector('[data-testid="drop-take"]')!.textContent;

  it('right of the middle band: the preview shows the right half, and the drop says right', async () => {
    const onDrop = vi.fn();
    await render(vi.fn(), onDrop);
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 200, 40);
    expect(host.querySelector('[data-testid="drag-ghost"]')?.textContent).toBe('Codex two');
    await fire(window, 'pointermove', 800, 100);
    expect(zoneNow()).toBe('right');
    expect(take()).toBe('Codex two');
    expect(host.querySelector('[data-testid="drop-stay"]')?.textContent).toBe('Stays here');
    await fire(window, 'pointerup', 800, 100);
    expect(onDrop).toHaveBeenCalledWith('p2', 'right', 'right');
    expect(host.querySelector('[data-testid="drag-ghost"]')).toBeNull();
    expect(host.querySelector('[data-testid="work-drop"]')).toBeNull();
  });

  it('left of the middle band drops on the left', async () => {
    const onDrop = vi.fn();
    await render(vi.fn(), onDrop);
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 100, 100);
    expect(zoneNow()).toBe('left');
    await fire(window, 'pointerup', 100, 100);
    expect(onDrop).toHaveBeenCalledWith('p2', 'left', 'left');
  });

  it('on the middle line (48 px either side of the centre) the line turns on and the label says half and half', async () => {
    const onDrop = vi.fn();
    await render(vi.fn(), onDrop);
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 540, 100);
    expect(zoneNow()).toBe('mid');
    expect(host.querySelector('[data-testid="drop-midline"]')?.className).toContain('is-on');
    expect(take()).toBe('Codex two · half and half');
    await fire(window, 'pointermove', 453, 100);
    expect(zoneNow()).toBe('mid');
    await fire(window, 'pointermove', 451, 100);
    expect(zoneNow()).toBe('left');
    expect(host.querySelector('[data-testid="drop-midline"]')?.className).not.toContain('is-on');
    await fire(window, 'pointermove', 500, 100);
    await fire(window, 'pointerup', 500, 100);
    expect(onDrop).toHaveBeenCalledWith('p2', 'mid', 'right');
  });

  it('the lowest third wins over the middle band: the preview says below and the other half stays on top', async () => {
    const onDrop = vi.fn();
    await render(vi.fn(), onDrop);
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 500, 450);
    expect(zoneNow()).toBe('down');
    expect(take()).toBe('Codex two · below');
    expect(host.querySelector('[data-testid="drop-stay"]')?.textContent).toBe('Stays on top');
    expect(host.querySelector('[data-testid="drop-midline"]')).toBeNull();
    await fire(window, 'pointerup', 500, 450);
    expect(onDrop).toHaveBeenCalledWith('p2', 'down', 'right');
  });

  it('shows the hint while dragging', async () => {
    await render(vi.fn(), vi.fn());
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 800, 100);
    expect(host.querySelector('[data-testid="drop-hint"]')?.textContent).toBe('Left or right: beside · Bottom: below · Esc cancels');
  });

  it('a plain click still selects and does not drag; a move under 6 px is a click', async () => {
    const select = vi.fn();
    const onDrop = vi.fn();
    await render(select, onDrop);
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 23, 22);
    expect(host.querySelector('[data-testid="drag-ghost"]')).toBeNull();
    await fire(window, 'pointerup', 23, 22);
    await act(async () => row().click());
    expect(select).toHaveBeenCalledWith('p2');
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('the click after a real drag does not select the chat', async () => {
    const select = vi.fn();
    await render(select, vi.fn());
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 800, 100);
    await fire(window, 'pointerup', 800, 100);
    await act(async () => row().click());
    expect(select).not.toHaveBeenCalled();
  });

  it('Esc cancels: no drop, the ghost goes away', async () => {
    const onDrop = vi.fn();
    await render(vi.fn(), onDrop);
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 800, 100);
    expect(host.querySelector('[data-testid="drop-take"]')).not.toBeNull();
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[data-testid="drag-ghost"]')).toBeNull();
    expect(host.querySelector('[data-testid="drop-take"]')).toBeNull();
    await fire(window, 'pointerup', 800, 100);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('releasing outside the work area drops nothing', async () => {
    const onDrop = vi.fn();
    await render(vi.fn(), onDrop);
    await fire(row(), 'pointerdown', 20, 20);
    await fire(window, 'pointermove', 1500, 100);
    await fire(window, 'pointerup', 1500, 100);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
