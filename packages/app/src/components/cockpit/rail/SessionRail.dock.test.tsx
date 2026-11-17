// @vitest-environment jsdom
// Screen-level: the dock (the details column), rendered through the real SessionRail. A minion opens a pane, a second pane
// stacks under it with a splitter, the splitter keeps its sizes, the column folds to a strip and keeps its panes, and "fill"
// takes the window.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { SessionRail } from './SessionRail';
import { resetRailFoldForTests } from './railFold';
import { openBrowserPane, openMinionView, openTerminalView, resetTaskViews } from '../../../lib/task-view';
import { resetPanelWidthsForTests } from '../../../lib/panel-widths';
import { currentBrowserRect, onBrowserRect, type PageRect } from '../../../lib/dock-browser';

// The app's side of the native page: every call to Rust is recorded; the tab list is whatever the test says.
const tauri = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]>, on: false, tabs: [] as unknown[], slow: false }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    tauri.calls.push([cmd, args]);
    if (cmd === 'dock_browser_snapshot') return tauri.slow ? new Promise(() => undefined) : new ArrayBuffer(8);
    if (cmd === 'dock_browser_tabs') return tauri.tabs;
    return undefined;
  }),
}));
vi.mock('../../../lib/dock-browser', async (orig) => ({ ...(await orig<typeof import('../../../lib/dock-browser')>()), useDockBrowserEnabled: () => tauri.on }));
const chat = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../../hooks/useSessionChat', () => ({ useSessionChat: () => chat.current }));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'feat/rail' }));
const jobs = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../../../lib/pane-jobs', async (orig) => ({
  ...(await orig<typeof import('../../../lib/pane-jobs')>()),
  usePaneJobs: () => ({ p1: jobs.list }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB = { pid: 7, parentPid: 1, name: 'npm test', command: 'npm test -- upload', startedAtMs: 1_000, ports: [5173] };
const minion = { id: 'm1', title: 'Reviewer', agent: 'Claude', agentType: 'claude', status: 'running', kind: 'minion' as const };
const second = { id: 'm2', title: 'Tester', agent: 'Claude', agentType: 'claude', status: 'running', kind: 'minion' as const };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  tauri.calls.length = 0;
  tauri.on = false;
  tauri.tabs = [];
  tauri.slow = false;
  URL.createObjectURL = vi.fn(() => 'blob:still');
  URL.revokeObjectURL = vi.fn();
  window.localStorage.clear();
  resetPanelWidthsForTests();
  resetRailFoldForTests();
  resetTaskViews();
  jobs.list = [JOB];
  chat.current = { state: 'ready', reason: null, waitingFor: null, source: 'acp', model: 'm', cliVersion: null, usage: null, plan: [], outputs: [], turns: [], earlier: undefined };
  // Every pane is 400 px high, so a splitter has room to move.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const big = this.classList.contains('tk-pane');
    const page = this.dataset.testid === 'dock-browser-page';
    // A floating layer is over the page unless the test says it opened far away.
    if (this.classList.contains('fl-layer') || this.getAttribute('role') === 'dialog') {
      const far = this.dataset.far === '1';
      return { x: far ? 10 : 800, y: far ? 10 : 500, left: far ? 10 : 800, top: far ? 10 : 500, width: 200, height: 100, right: far ? 210 : 1000, bottom: far ? 110 : 600, toJSON: () => ({}) } as DOMRect;
    }
    const r = { x: page ? 700 : 0, y: page ? 450 : 0, left: page ? 700 : 0, top: page ? 450 : 0, width: page ? 380 : 0, height: big ? 400 : page ? 300 : 0, right: 0, bottom: 0, toJSON: () => ({}) };
    return r as DOMRect;
  });
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const props = { paneId: 'p1', status: 'idle', cwd: '/work/shop', agentType: 'claude', agentName: 'Claude 1', accountLabel: null, readsChat: true, helperOf: null, helpers: [minion, second], onOpenPane: () => {}, onStopHelper: async () => {} };
const mount = async () => {
  await act(async () => root.render(<SessionRail {...props} />));
  await act(async () => {});
};
const slots = () => [...host.querySelectorAll('[data-testid="task-column"] .tk-pane')].map((e) => (e as HTMLElement).dataset.slot);
const pane = (slot: string) => host.querySelector<HTMLElement>(`.tk-pane[data-slot="${slot}"]`)!;
const splitter = () => host.querySelector<HTMLElement>('[data-testid="dock-splitter"]');
const ptr = (el: HTMLElement, type: string, y: number) => act(() => void el.dispatchEvent(new MouseEvent(type, { clientY: y, button: 0, bubbles: true, cancelable: true })));
const weight = (slot: string) => Number(pane(slot).style.flex.split(' ')[0]);

describe('the dock', () => {
  it('a minion opens one pane; a command stacks under it with a splitter; another minion replaces the top one', async () => {
    await mount();
    expect(host.querySelector('[data-testid="task-column"]')).toBeNull();
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[data-testid="rail-helper"] .rp-row-main')[0].click());
    expect(slots()).toEqual(['view']);
    expect(splitter()).toBeNull();
    expect(host.querySelector('[data-testid="task-side-view"]')).not.toBeNull();

    await act(async () => openTerminalView('p1', { owner: 'p1', pid: JOB.pid, startedAtMs: JOB.startedAtMs, name: JOB.name, command: JOB.command }));
    expect(slots()).toEqual(['view', 'terminal']);
    expect(splitter()).not.toBeNull();
    const term = host.querySelector('[data-testid="dock-terminal"]')!;
    expect(term.textContent).toContain('npm test -- upload');
    expect(term.textContent).toContain('Port 5173');
    expect(term.getAttribute('data-live')).toBe('true');

    await act(async () => openMinionView('p1', 'm2'));
    expect(slots()).toEqual(['view', 'terminal']);
    expect(pane('view').textContent).toContain('Tester');
    expect(host.querySelectorAll('[data-testid="dock-splitter"]')).toHaveLength(1);
  });

  it('a command row on the Background tasks page opens its output under the page', async () => {
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('.rp-sec-open')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.tk-sum')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="task-job-open"]')!.click());
    expect(slots()).toEqual(['view', 'terminal']);
    expect(pane('view').querySelector('[data-testid="background-page"]')).not.toBeNull();
    expect(pane('terminal').textContent).toContain('npm test');
    // Closing the output leaves the page; closing the page closes the column.
    await act(async () => pane('terminal').querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    expect(slots()).toEqual(['view']);
    await act(async () => pane('view').querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    expect(host.querySelector('[data-testid="task-column"]')).toBeNull();
  });

  it('dragging the splitter moves the share of the two panes, remembers it, and keeps it after a remount', async () => {
    await mount();
    await act(async () => openMinionView('p1', 'm1'));
    await act(async () => openTerminalView('p1', { owner: 'p1', pid: 7, startedAtMs: 1_000, name: 'npm test', command: 'npm test' }));
    expect(weight('view')).toBe(1);
    expect(weight('terminal')).toBe(1);
    const bar = splitter()!;
    ptr(bar, 'pointerdown', 400);
    ptr(bar, 'pointermove', 500); // 100 px down: the upper pane goes from 400 to 500 of 800
    ptr(bar, 'pointerup', 500);
    expect(weight('view')).toBeCloseTo(1.25, 2);
    expect(weight('terminal')).toBeCloseTo(0.75, 2);
    expect(JSON.parse(window.localStorage.getItem('pm.dock.split')!)).toEqual({ view: 1.25, terminal: 0.75 });
    // A drag cannot make a pane shorter than 160 px.
    ptr(bar, 'pointerdown', 400);
    ptr(bar, 'pointermove', 5000);
    ptr(bar, 'pointerup', 5000);
    expect(weight('terminal')).toBeCloseTo((160 / 800) * 2, 2);
    // Close and open again, and read the stored sizes from scratch.
    await act(async () => resetTaskViews());
    await act(async () => resetPanelWidthsForTests());
    await act(async () => openMinionView('p1', 'm1'));
    await act(async () => openTerminalView('p1', { owner: 'p1', pid: 7, startedAtMs: 1_000, name: 'npm test', command: 'npm test' }));
    expect(weight('terminal')).toBeCloseTo(0.4, 2);
  });

  it('the arrow keys move a focused splitter', async () => {
    await mount();
    await act(async () => openMinionView('p1', 'm1'));
    await act(async () => openTerminalView('p1', { owner: 'p1', pid: 7, startedAtMs: 1_000, name: 'npm test', command: 'npm test' }));
    await act(async () => void splitter()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(weight('view')).toBeGreaterThan(1);
    await act(async () => void splitter()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })));
    expect(weight('view')).toBeCloseTo(0.4, 2);
  });

  it('folding the column to its strip hides it and keeps every pane; the strip opens it again', async () => {
    await mount();
    await act(async () => openMinionView('p1', 'm1'));
    await act(async () => openTerminalView('p1', { owner: 'p1', pid: 7, startedAtMs: 1_000, name: 'npm test', command: 'npm test' }));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Fold the column to a strip"]')!.click());
    expect(host.querySelector('[data-testid="task-column"]')).toBeNull();
    const strip = host.querySelector('[data-testid="dock-strip"]')!;
    expect(strip.querySelectorAll('button')).toHaveLength(2);
    // A new pane opened by a click unfolds the column.
    await act(async () => strip.querySelector<HTMLButtonElement>('[data-slot="terminal"]')!.click());
    expect(host.querySelector('[data-testid="dock-strip"]')).toBeNull();
    expect(slots()).toEqual(['view', 'terminal']);
    expect(pane('view').textContent).toContain('Reviewer');
  });

  it('a pane folds to its header (the others take the height); the last open pane cannot fold', async () => {
    await mount();
    await act(async () => openMinionView('p1', 'm1'));
    await act(async () => openTerminalView('p1', { owner: 'p1', pid: 7, startedAtMs: 1_000, name: 'npm test', command: 'npm test' }));
    await act(async () => void pane('terminal').querySelector('.tk-head')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(pane('terminal').getAttribute('data-folded')).toBe('true');
    expect(pane('terminal').querySelector('[data-testid="dock-terminal"]')).toBeNull();
    expect(splitter()).toBeNull();
    await act(async () => void pane('view').querySelector('.tk-head')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(pane('view').getAttribute('data-folded')).toBeNull();
    await act(async () => pane('terminal').querySelector<HTMLButtonElement>('[aria-label="Open this part"]')!.click());
    expect(pane('terminal').getAttribute('data-folded')).toBeNull();
    expect(splitter()).not.toBeNull();
  });

  it('Fill takes the whole window beside the sidebar with every pane still stacked, and back', async () => {
    await mount();
    await act(async () => openMinionView('p1', 'm1'));
    await act(async () => openTerminalView('p1', { owner: 'p1', pid: 7, startedAtMs: 1_000, name: 'npm test', command: 'npm test' }));
    const fill = pane('view').querySelector<HTMLButtonElement>('[aria-label="Fill the window"]')!;
    await act(async () => fill.click());
    const column = host.querySelector('[data-testid="task-column"]')!;
    expect(column.getAttribute('data-full')).toBe('true');
    expect(slots()).toEqual(['view', 'terminal']);
    expect(host.querySelector('.ck-resize--dock')).toBeNull();
    expect(host.querySelector('[aria-label="Fold the column to a strip"]')).toBeNull();
    // The chat side stays mounted underneath.
    expect(host.querySelector('[data-testid="session-rail"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back to the side"]')!.click());
    expect(host.querySelector('[data-testid="task-column"]')!.getAttribute('data-full')).toBeNull();
    expect(host.querySelector('.ck-resize--dock')).not.toBeNull();
  });

  it('the column edge drags and remembers its width', async () => {
    await mount();
    await act(async () => openMinionView('p1', 'm1'));
    const edge = host.querySelector<HTMLElement>('.ck-resize--dock')!;
    const column = () => host.querySelector<HTMLElement>('[data-testid="task-column"]')!;
    expect(column().style.width).toBe('460px');
    const x = (type: string, px: number) => act(() => void edge.dispatchEvent(new MouseEvent(type, { clientX: px, button: 0, bubbles: true, cancelable: true })));
    x('pointerdown', 800);
    x('pointermove', 700); // the column is on the right, so dragging left makes it wider
    x('pointerup', 700);
    expect(column().style.width).toBe('560px');
    expect(window.localStorage.getItem('pm.dock.width')).toBe('560');
  });

  describe('the browser slot', () => {
    it('is a placeholder under the others; it reports where its page is, and null when it hides', async () => {
      const seen: Array<PageRect | null> = [];
      const stop = onBrowserRect((_id, rect) => seen.push(rect));
      await mount();
      await act(async () => openMinionView('p1', 'm1'));
      await act(async () => openBrowserPane('p1'));
      expect(slots()).toEqual(['view', 'browser']);
      expect(pane('browser').querySelector('[data-testid="dock-browser"]')).not.toBeNull();
      expect(currentBrowserRect('p1')).toEqual({ x: 700, y: 450, width: 380, height: 300 });
      expect(seen[seen.length - 1]).toEqual({ x: 700, y: 450, width: 380, height: 300 });
      // Folding the column hides the page: the rectangle goes away.
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Fold the column to a strip"]')!.click());
      expect(currentBrowserRect('p1')).toBeNull();
      expect(seen[seen.length - 1]).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="browser"]')!.click());
      expect(currentBrowserRect('p1')).not.toBeNull();
      // Opening a minion replaces the top view and keeps the browser.
      await act(async () => openMinionView('p1', 'm2'));
      expect(slots()).toEqual(['view', 'browser']);
      // Folding its pane hides it too.
      await act(async () => void pane('browser').querySelector('.tk-head')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      expect(currentBrowserRect('p1')).toBeNull();
      stop();
    });

    it('an agent opening it keeps a folded column folded', async () => {
      await mount();
      await act(async () => openMinionView('p1', 'm1'));
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Fold the column to a strip"]')!.click());
      await act(async () => openBrowserPane('p1', { expand: false }));
      expect(host.querySelector('[data-testid="dock-strip"]')!.querySelectorAll('button')).toHaveLength(2);
    });

    it('its open button on the page is there only when the switch is on', async () => {
      await mount();
      await act(async () => host.querySelector<HTMLButtonElement>('.rp-sec-open')!.click());
      expect(host.querySelector('[data-testid="dock-open-browser"]')).toBeNull();
      tauri.on = true;
      await act(async () => root.render(<SessionRail {...props} helpers={[minion]} />));
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="dock-open-browser"]')!.click());
      expect(slots()).toEqual(['view', 'browser']);
    });
  });

  describe('the browser pane with a page behind it', () => {
    const tab = { id: 'preview-1', title: 'Shop', url: 'http://localhost:5173/upload', error: '', active: true, popped: false };
    const names = () => tauri.calls.map(([name]) => name);
    const freezes = () => tauri.calls.filter(([name]) => name === 'dock_browser_freeze').map(([, args]) => (args as { frozen: boolean }).frozen);
    const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 120))));
    const showBrowser = async () => {
      tauri.tabs = [tab];
      await mount();
      await act(async () => openBrowserPane('p1'));
      await settle();
    };
    const overlay = (role: string, cls: string, far = false) => {
      const el = document.createElement('div');
      el.className = cls;
      el.setAttribute('role', role);
      if (far) el.dataset.far = '1';
      host.appendChild(el);
      return el;
    };

    it('shows the tab, its address, and the bar buttons call Rust', async () => {
      await showBrowser();
      const input = host.querySelector<HTMLInputElement>('.bp-address')!;
      expect(input.value).toBe('http://localhost:5173/upload');
      expect(host.querySelector('[data-testid="dock-tab"]')!.textContent).toContain('Shop');
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reload"]')!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back"].tk-icon:not(.tk-back)')!.click());
      expect(tauri.calls).toContainEqual(['dock_browser_nav', { kind: 'reload', url: undefined }]);
      expect(tauri.calls).toContainEqual(['dock_browser_nav', { kind: 'back', url: undefined }]);
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="dock-new-tab"]')!.click());
      expect(names()).toContain('dock_browser_new_tab');
    });

    it('opening a menu over the page freezes it to a picture, and closing the menu thaws it', async () => {
      await showBrowser();
      tauri.calls.length = 0;
      const menu = overlay('menu', 'fl-layer ck-menu');
      await settle();
      expect(names()).toEqual(['dock_browser_snapshot', 'dock_browser_freeze']);
      expect(freezes()).toEqual([true]);
      expect(host.querySelector('[data-testid="dock-still"]')).not.toBeNull();
      await act(async () => menu.remove());
      await settle();
      expect(freezes()).toEqual([true, false]);
      expect(host.querySelector('[data-testid="dock-still"]')).toBeNull();
    });

    it('a picture that is slow is not waited for: the page gives way to a plain panel at once', async () => {
      await showBrowser();
      tauri.slow = true;
      tauri.calls.length = 0;
      overlay('menu', 'fl-layer');
      await act(async () => void (await new Promise((r) => setTimeout(r, 900))));
      expect(freezes()).toEqual([true]);
      const still = host.querySelector('[data-testid="dock-still"]');
      expect(still).not.toBeNull();
      expect(still!.tagName).not.toBe('IMG');
    });

    it('a sheet freezes it too, and a menu far from the page does not', async () => {
      await showBrowser();
      tauri.calls.length = 0;
      const far = overlay('menu', 'fl-layer', true);
      await settle();
      expect(freezes()).toEqual([]);
      far.remove();
      const sheet = overlay('dialog', 'ck-sheet');
      await settle();
      expect(freezes()).toEqual([true]);
      await act(async () => sheet.remove());
      await settle();
      expect(freezes()).toEqual([true, false]);
    });

    it('dragging a splitter across the page freezes it until the mouse is up', async () => {
      await showBrowser();
      await act(async () => openMinionView('p1', 'm1'));
      await settle();
      tauri.calls.length = 0;
      const bar = splitter()!;
      ptr(bar, 'pointerdown', 200);
      await settle();
      expect(freezes()).toEqual([true]);
      ptr(bar, 'pointerup', 200);
      await settle();
      expect(freezes()).toEqual([true, false]);
    });

    it('a page in its own window says so, and Bring it back docks it again', async () => {
      tauri.tabs = [{ ...tab, popped: true }];
      await mount();
      await act(async () => openBrowserPane('p1'));
      await settle();
      expect(host.querySelector('[data-testid="dock-popped"]')!.textContent).toContain('own window');
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="dock-bring-back"]')!.click());
      expect(tauri.calls).toContainEqual(['dock_browser_dockback', { id: 'preview-1' }]);
    });

    it('Open in my own browser sends only a web address to the system opener', async () => {
      tauri.tabs = [{ ...tab, url: 'https://example.com/a' }];
      await mount();
      await act(async () => openBrowserPane('p1'));
      await settle();
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="dock-open-outside"]')!.click());
      expect(tauri.calls).toContainEqual(['open_external_url', { url: 'https://example.com/a' }]);
    });

    it('Open in my own browser is off for a page that is not http or https', async () => {
      tauri.tabs = [{ ...tab, url: 'about:blank' }];
      await mount();
      await act(async () => openBrowserPane('p1'));
      await settle();
      expect(host.querySelector<HTMLButtonElement>('[data-testid="dock-open-outside"]')!.disabled).toBe(true);
    });
  });
});
