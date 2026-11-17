// @vitest-environment jsdom
// Hover actions in the sidebar, through the real Sidebar: on a standby row, a minion row and a running spin-off row, while the
// "..." button (and the X) show, the "standby" tag, the minion tag and the time/state step aside and cannot be hit.
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { useEnglish } from '../../i18n/test-utils';
import { setHelpersInSidebar } from '../../lib/helpersInSidebar';
import { resetUndoBar } from '../../lib/undo-bar';
import { setTaskSidebarApiForTest, type TaskPlacement, type TaskSidebarApi } from '../../lib/task-sidebar';
import type { StandbyHelperEntry, StandbyHelpersApi, StandbyHelpersView } from '../../lib/standbyHelpers';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;
const stored: TaskPlacement[] = [{ task_id: 'minion:m1', kind: 'minion', owner: 'a1', under: 'a1', name: 'Reviewer', command: null }];
const taskApi: TaskSidebarApi = {
  get: async () => stored,
  show: async () => stored,
  place: async () => stored,
  remove: async () => stored,
  reorder: async () => stored,
};

beforeEach(() => {
  useEnglish();
  localStorage.clear();
  localStorage.setItem('pm.sidebar.groupBy', 'status');
  setHelpersInSidebar(true);
  resetUndoBar();
  setTaskSidebarApiForTest(taskApi, stored);
  // The real stylesheets, so computed style says what the person sees. jsdom has no :hover or :focus-within, so both become [data-hov] on the row.
  style = document.createElement('style');
  style.textContent = ['cockpit-sidebar.css', 'cockpit-taskdrag.css', 'standby-rows.css'].map((f) => readFileSync(`src/styles/${f}`, 'utf8').replace(/:(hover|focus-within)/g, '[data-hov]')).join('\n');
  document.head.appendChild(style);
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  style.remove();
  setTaskSidebarApiForTest(null, []);
  setHelpersInSidebar(false);
});

const pane = (id: string, status: string, title: string, parent: string | null, startedAs: string | null) => ({
  info: { id, agent_type: 'codex', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:/work/shop', cols: 80, rows: 24, title, parent_pane_id: parent, started_as: startedAs } as unknown as PaneInfo,
  status,
});
const helper = (): StandbyHelperEntry =>
  ({ id: 'sb-1', name: 'OpenCode', agent: 'codex', model: 'gpt-5', project: 'C:/work/shop', after_task: 'wait', state: 'ready', note: null, pane_id: null, home: 'a1', used_by: null, taken_over: false, open_pane: null, person_pane: null }) as StandbyHelperEntry;

function cockpit() {
  const list = [pane('a1', 'idle', 'Claude 1', null, null), pane('m1', 'running', 'Reviewer', 'a1', 'minion'), pane('s1', 'running', 'Spin one', 'a1', 'spin_off')];
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, p.info.title])),
    asked: { questions: [] }, launchEntries: [{ type: 'codex', label: 'Codex' }], readyAgents: new Set<string>(), mode: 'orchestration', theme: 'dark',
    selectedId: null, select: vi.fn(), prompts: {}, statusSince: new Map([['s1', 1000]]), now: 60_000, spawn: null, notify: vi.fn(),
    setMode: vi.fn(async () => {}), toggleTheme: vi.fn(async () => {}), openSettings: vi.fn(async () => {}), bridgeLine: '',
  } as unknown as CockpitApi;
}
const standbyApi = {
  get: vi.fn(async () => ({ helpers: [helper()], max: 4, idle_minutes: 30 }) as StandbyHelpersView),
} as unknown as StandbyHelpersApi;
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function show() {
  await act(async () => root.render(<Sidebar c={cockpit()} onOpenPalette={() => {}} ship={ship} standbyApi={standbyApi} />));
  await flush();
  await flush();
}
const hidden = (el: Element) => {
  const s = getComputedStyle(el);
  return s.opacity === '0' || s.visibility === 'hidden';
};
const dead = (el: Element) => getComputedStyle(el).pointerEvents === 'none' || getComputedStyle(el).visibility === 'hidden';
/** Hover or keyboard focus inside the row (the button is real and focusable: it must be in the tab order). */
const focusIn = (wrap: Element, sel: string) =>
  act(async () => {
    const b = wrap.querySelector<HTMLElement>(sel)!;
    expect(b.tabIndex).toBeGreaterThanOrEqual(0);
    b.focus();
    wrap.setAttribute('data-hov', '');
  });

describe('sidebar hover actions are not covered by tags', () => {
  it('standby row: the "standby" tag shows at rest, hides and stops taking clicks on focus, and the X and "..." are reachable', async () => {
    await show();
    const wrap = host.querySelector<HTMLElement>('[data-testid="standby-row"]')!;
    const tag = wrap.querySelector('[data-testid="standby-tag"]')!;
    expect(tag.textContent).toBe('standby');
    expect(hidden(tag)).toBe(false);
    await focusIn(wrap, '[data-testid="standby-row-x"]');
    expect(hidden(tag)).toBe(true);
    expect(dead(tag)).toBe(true);
    expect(hidden(wrap.querySelector('[data-testid="standby-state"]')!)).toBe(true);
    const x = wrap.querySelector<HTMLElement>('[data-testid="standby-row-x"]')!;
    const more = wrap.querySelector<HTMLElement>('.ck-row-more')!;
    expect(getComputedStyle(x).display).toBe('inline-flex');
    expect(getComputedStyle(more).opacity).toBe('1');
    expect(x.getAttribute('aria-label')).toContain('OpenCode');
    expect(more.getAttribute('aria-label')).toContain('OpenCode');
  });

  it('minion row: the minion tag steps aside on focus and the "..." shows', async () => {
    await show();
    const wrap = host.querySelector<HTMLElement>('[data-testid="sidebar-task"]')!;
    const tag = wrap.querySelector('[data-testid="task-tag"]')!;
    expect(hidden(tag)).toBe(false);
    await focusIn(wrap, '.ck-row-more');
    expect(hidden(tag)).toBe(true);
    expect(dead(tag)).toBe(true);
    expect(getComputedStyle(wrap.querySelector('.ck-row-more')!).opacity).toBe('1');
    expect(wrap.querySelector('.ck-row-more')!.getAttribute('aria-label')).toContain('Reviewer');
  });

  it('running spin-off row: the elapsed time steps aside and the "..." shows', async () => {
    await show();
    const wrap = host.querySelector<HTMLElement>('[data-pane-row="s1"]')!.closest<HTMLElement>('.ck-rowwrap')!;
    const time = wrap.querySelector('.ck-row-time')!;
    expect(hidden(time)).toBe(false);
    await focusIn(wrap, '.ck-row-more');
    expect(hidden(time)).toBe(true);
    expect(getComputedStyle(wrap.querySelector('.ck-row-more')!).opacity).toBe('1');
  });

  it('the stylesheet keeps the narrow-width wrap and respects reduced motion', () => {
    const css = readFileSync('src/styles/standby-rows.css', 'utf8');
    expect(css).toMatch(/\.ck-sb-row \{[^}]*flex-wrap: wrap;[^}]*height: auto;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.cockpit \.ck-sb-tag,\s*\.cockpit \.ck-taskrow \.tdr-tag \{\s*transition: none;/);
  });
});
