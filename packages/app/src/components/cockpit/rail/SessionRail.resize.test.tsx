// @vitest-environment jsdom
// Screen-level: the right panel has a handle on its left edge; its width follows the stored choice and is held back
// so the chat keeps room.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRail } from './SessionRail';
import { RAIL_WIDTH_KEY, resetPanelWidthsForTests } from '../../../lib/panel-widths';

vi.mock('../../../hooks/useSessionChat', () => ({ useSessionChat: () => ({ model: null, cliVersion: null, usage: null, plan: [], outputs: [] }) }));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'main' }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const props = { paneId: 'p1', status: 'idle', cwd: '/work/shop', agentName: 'Claude', readsChat: true, helperOf: null, helpers: [], onOpenPane: () => {} };
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
  it('is 280 px at first and has a handle named for it', () => {
    expect(rail().style.width).toBe('280px');
    expect(handle().getAttribute('aria-label')).toBe('Resize the side panel');
  });
  it('arrow keys on the handle widen it (the left edge moves left) and the width is remembered', () => {
    key('ArrowLeft');
    expect(rail().style.width).toBe('296px');
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe('296');
    key('End');
    expect(rail().style.width).toBe('520px');
    key('Home');
    expect(rail().style.width).toBe('240px');
  });
  it('a double-click on the handle goes back to 280 px', () => {
    key('End');
    act(() => void handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(rail().style.width).toBe('280px');
  });
  it('is held back on a narrower window so the chat keeps 480 px', () => {
    key('End');
    setWindow(1100);
    // 1100 - 240 sidebar - 480 chat = 380
    expect(rail().style.width).toBe('380px');
  });
});
