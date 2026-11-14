// @vitest-environment jsdom
// Screen-level: the pane header is ONE row (name, view tabs, state and actions, a ⋯ More button), and the project's
// open panes are tabs with the agent's icon, a live state dot on the tabs behind and a close button on the idle ones.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { HandoffControl } from '../../hooks/useHandoff';
import { PaneView } from './PaneView';
import { tabDot } from './PaneTabs';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const mk = (id: string, agent: string, status: string, title: string | null = null) => ({
  status,
  info: { id, agent_type: agent, status, pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 100, rows: 30, title },
});

function cockpit(select = vi.fn(), closePane = vi.fn()): CockpitApi {
  const list = [mk('p1', 'claude', 'idle', 'fix login'), mk('p2', 'codex', 'running', 'tests'), mk('p3', 'opencode', 'waiting_input', 'docs'), mk('p4', 'gemini', 'idle', 'review')];
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['p1', 'Claude'], ['p2', 'Codex'], ['p3', 'OpenCode'], ['p4', 'Gemini']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 1000,
    selectedId: 'p1',
    mode: 'orchestration',
    select,
    notify: vi.fn(),
    answer: vi.fn(),
    closePane,
  } as unknown as CockpitApi;
}
const handoff = { mode: 'new_agent', busy: false, allowed: () => true, start: vi.fn() } as unknown as HandoffControl;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});
const show = async (c: CockpitApi) => {
  await act(async () => root.render(<PaneView c={c} paneId="p1" handoff={handoff} />));
  await act(async () => { await new Promise((r) => setImmediate(r)); });
};

// These tests are about the pane, not the side panel: a window under 960 px (240 sidebar + 240 panel + 480 chat) has none.
Object.defineProperty(window, 'innerWidth', { value: 900, configurable: true });

describe('pane header: one row', () => {
  it('holds the view tabs, Hand off, a ⋯ More button and no second tab bar', async () => {
    await show(cockpit());
    const head = host.querySelector('.ck-pane-head')!;
    expect(host.querySelector('.ck-tabs-bar')).toBeNull();
    expect(head.querySelector('[aria-label="Pane view"][role="tablist"]')).not.toBeNull();
    const more = head.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    expect(more.getAttribute('aria-label')).toBe('More');
    expect(more.textContent).toBe('\u22ef');
    expect(head.querySelector('[data-testid="pane-handoff"]')!.textContent).toBe('Hand off');
    // order: name, tabs, then the actions on the right
    const tabs = head.querySelector('[aria-label="Pane view"]')!;
    expect(head.querySelector('.ck-pane-id')!.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('pane header: narrow', () => {
  // jsdom has no layout: make the header report that its content is wider than it is.
  const width = (over: boolean) => {
    const sw = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return over && this.classList.contains('ck-pane-head') && (this as HTMLElement).dataset.fold !== '3' ? 900 : 100;
    });
    const cw = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(100);
    return () => {
      sw.mockRestore();
      cw.mockRestore();
    };
  };

  it('moves Hand off into the ⋯ menu before anything is cut, and keeps it reachable', async () => {
    const restore = width(true);
    try {
      await show(cockpit());
      const head = host.querySelector('.ck-pane-head')!;
      expect(head.querySelector('[data-testid="pane-handoff"]')).toBeNull();
      await act(async () => head.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
      const menu = document.querySelector('[role="menu"]')!;
      expect(head.contains(menu)).toBe(false);
      const items = [...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
      expect(items).toEqual(expect.arrayContaining(['Transcript', 'Receipt', 'Hand off']));
    } finally {
      restore();
    }
  });

  it('keeps every action in the header when there is room', async () => {
    await show(cockpit());
    expect(host.querySelector('.ck-pane-head [data-testid="pane-handoff"]')).not.toBeNull();
  });
});

describe('pane tabs', () => {
  it('shows one tab per open agent of the project, each with its icon; the front tab is selected', async () => {
    await show(cockpit());
    const tabs = [...host.querySelectorAll('[data-testid="pane-tabs"] [role="tab"]')];
    expect(tabs).toHaveLength(4);
    expect(tabs.map((t) => t.textContent)).toEqual(['fix login', 'tests', 'docs', 'review']);
    for (const t of tabs) expect(t.querySelector('svg, .pm-agent-logo, [class*="agent-logo"]')).not.toBeNull();
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    expect(host.querySelector('.ck-ptab.is-active')!.getAttribute('data-pane-tab')).toBe('p1');
  });

  it('background tabs carry a state dot: working green, needs you orange; the front tab and idle ones have none', async () => {
    await show(cockpit());
    const dot = (id: string) => host.querySelector(`[data-pane-tab="${id}"] [data-testid="pane-tab-dot"]`);
    expect(dot('p1')).toBeNull();
    expect(dot('p2')!.className).toContain('ck-ptab-dot--working');
    expect(dot('p2')!.getAttribute('aria-label')).toBe('Working');
    expect(dot('p3')!.className).toContain('ck-ptab-dot--needs');
    expect(dot('p4')).toBeNull();
  });

  it('close on an idle tab closes it at once (the undo bar follows); a click on a tab selects it', async () => {
    const select = vi.fn();
    const closePane = vi.fn();
    await show(cockpit(select, closePane));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-pane-tab="p4"] .ck-ptab-x')!.click());
    expect(closePane).toHaveBeenCalledWith('p4');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-pane-tab="p2"] [role="tab"]')!.click());
    expect(select).toHaveBeenCalledWith('p2');
  });

  it('close on a working or waiting tab asks first, like the sidebar: it opens that pane and asks it to close', async () => {
    const select = vi.fn();
    const closePane = vi.fn();
    const asked: unknown[] = [];
    const listen = (e: Event) => asked.push((e as CustomEvent).detail);
    window.addEventListener('pm:pane-action', listen);
    try {
      await show(cockpit(select, closePane));
      for (const id of ['p2', 'p3']) {
        await act(async () => host.querySelector<HTMLButtonElement>(`[data-pane-tab="${id}"] .ck-ptab-x`)!.click());
      }
    } finally {
      window.removeEventListener('pm:pane-action', listen);
    }
    expect(closePane).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith('p2');
    expect(select).toHaveBeenCalledWith('p3');
    expect(asked).toEqual([
      { paneId: 'p2', action: 'close' },
      { paneId: 'p3', action: 'close' },
    ]);
  });

  it('tabDot: needs you beats working, errors are red, idle has none', () => {
    expect(tabDot('running', true)).toBe('needs');
    expect(tabDot('running', false)).toBe('working');
    expect(tabDot('error', false)).toBe('error');
    expect(tabDot('idle', false)).toBeNull();
  });
});
