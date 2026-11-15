// @vitest-environment jsdom
// Screen-level: the right panel has a handle on its left edge; its width follows the stored choice and is held back
// so the chat keeps room.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRail } from './SessionRail';
import { RAIL_WIDTH_KEY, resetPanelWidthsForTests } from '../../../lib/panel-widths';

vi.mock('../../../hooks/useSessionChat', () => ({ useSessionChat: () => ({ model: null, cliVersion: null, usage: null, plan: [], outputs: [], turns: [] }) }));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'main' }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const props = { paneId: 'p1', status: 'idle', cwd: '/work/shop', agentType: 'claude', agentName: 'Claude', readsChat: true, helperOf: null, helpers: [], onOpenPane: () => {} };
const setWindow = (w: number) =>
  act(() => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    window.dispatchEvent(new Event('resize'));
  });
const rail = () => host.querySelector<HTMLElement>('[data-testid="session-rail"]')!;
const handle = () => host.querySelector<HTMLElement>('[role="separator"]')!;
const key = (k: string) => act(() => void handle().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

beforeEach(() => {
  window.localStorage.clear();
  resetPanelWidthsForTests();
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<SessionRail {...props} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('SessionRail width', () => {
  it('is 300 px at first and has a handle named for it', () => {
    expect(rail().style.width).toBe('300px');
    expect(handle().getAttribute('aria-label')).toBe('Resize the side panel');
  });
  it('arrow keys on the handle widen it (the left edge moves left) and the width is remembered', () => {
    key('ArrowLeft');
    expect(rail().style.width).toBe('316px');
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe('316');
    key('End');
    expect(rail().style.width).toBe('520px');
    key('Home');
    expect(rail().style.width).toBe('240px');
  });
  it('a double-click on the handle goes back to 300 px', () => {
    key('End');
    act(() => void handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(rail().style.width).toBe('300px');
  });
  it('is held back on a narrower window so the chat keeps 480 px', () => {
    key('End');
    setWindow(1100);
    // 1100 - 240 sidebar - 480 chat = 380
    expect(rail().style.width).toBe('380px');
  });
});

describe('SessionRail snap to close', () => {
  const drag = (from: number, to: number) =>
    act(() => {
      handle().dispatchEvent(new MouseEvent('pointerdown', { clientX: from, button: 0, bubbles: true }));
      handle().dispatchEvent(new MouseEvent('pointermove', { clientX: to, bubbles: true }));
      handle().dispatchEvent(new MouseEvent('pointerup', { clientX: to, bubbles: true }));
    });
  it('dragging the edge under 200 px closes the panel and keeps the last good width', () => {
    const onClose = vi.fn();
    act(() => root.render(<SessionRail {...props} onClose={onClose} />));
    // The panel is 300 px; the edge moves right by 120 px: 180 px wide.
    drag(1000, 1120);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe('300');
  });
  it('dragging to a width between 200 and 240 px stops at 240 and does not close', () => {
    const onClose = vi.fn();
    act(() => root.render(<SessionRail {...props} onClose={onClose} />));
    drag(1000, 1080);
    expect(onClose).not.toHaveBeenCalled();
    expect(rail().style.width).toBe('240px');
  });
});
