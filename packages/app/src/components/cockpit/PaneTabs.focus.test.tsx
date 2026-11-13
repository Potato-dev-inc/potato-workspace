// @vitest-environment jsdom
// Double-clicking a tab opens it and fills the window (focus mode).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneTabs } from './PaneTabs';
import { isFocusMode, setFocusMode } from '../../lib/focus-mode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mk = (id: string, title: string) => ({ status: 'idle', info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 100, rows: 30, title } });
let host: HTMLDivElement;
let root: Root;
const select = vi.fn();
function api(): CockpitApi {
  const list = [mk('p1', 'fix login'), mk('p2', 'tests')];
  return { registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])) }, names: new Map(), prompts: {}, select, closePane: vi.fn() } as unknown as CockpitApi;
}
beforeEach(() => {
  select.mockClear();
  setFocusMode(false);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<PaneTabs c={api()} paneId="p1" />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFocusMode(false);
});
const tab = (title: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === title)!;

describe('pane tabs: focus mode', () => {
  it('a single click only opens the tab', () => {
    act(() => tab('tests').click());
    expect(select).toHaveBeenCalledWith('p2');
    expect(isFocusMode()).toBe(false);
  });
  it('a double-click opens the tab and turns focus mode on', () => {
    act(() => void tab('tests').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(select).toHaveBeenCalledWith('p2');
    expect(isFocusMode()).toBe(true);
  });
  it('the tab tells you about it', () => {
    expect(tab('tests').title).toContain('Double-click to fill the window');
  });
});
