// @vitest-environment jsdom
// The pane remembers its view for this app run (per pane id), and the less used views sit in a "More" menu.
// Real PaneView, real clicks and keys. Only the desktop shell (`invoke`) and the terminal are mocks.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView, forgetRememberedTabs } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

function cockpit(paneId: string): CockpitApi {
  const p = {
    status: 'idle',
    info: { id: paneId, agent_type: 'claude', status: 'idle', pid: 4120, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 158, rows: 56 },
  };
  return {
    registry: { paneList: [p], panes: new Map([[paneId, p]]), initialReady: true },
    names: new Map([[paneId, 'Claude']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: paneId,
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
    answer: vi.fn(),
    closePane: vi.fn(),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetRememberedTabs();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockImplementation(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null));
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

const flush = () =>
  act(async () => {
    await new Promise((r) => setImmediate(r));
  });
const render = async (paneId: string) => {
  await act(async () => root.render(<PaneView c={cockpit(paneId)} paneId={paneId} />));
  await flush();
};
const remount = async (paneId: string) => {
  act(() => root.unmount());
  root = createRoot(host);
  await render(paneId);
};
const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')];
const selected = () => tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;
const tabNamed = (name: string) => tabs().find((t) => t.textContent === name)!;
const moreButton = () => host.querySelector<HTMLButtonElement>('.ck-tabs-bar button[aria-haspopup="menu"]')!;
const menuItems = () => [...host.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
const menuItemNamed = (name: string) => menuItems().find((m) => m.textContent === name)!;

describe('the pane remembers its view', () => {
  it('a remount of the same pane id opens the view it was on', async () => {
    await render('p1');
    expect(selected()).toBe('Terminal');
    await act(async () => tabNamed('Terminal').click());
    await act(async () => moreButton().click());
    await act(async () => menuItemNamed('Receipt').click());
    expect(moreButton().textContent).toBe('Receipt');
    await remount('p1');
    expect(selected()).toBeUndefined();
    expect(moreButton().textContent).toBe('Receipt');
  });

  it('different pane ids do not share a view', async () => {
    await render('p1');
    await act(async () => moreButton().click());
    await act(async () => menuItemNamed('Receipt').click());
    await render('p2');
    expect(moreButton().textContent).toBe('More');
    expect(selected()).toBe('Terminal');
    await render('p1');
    expect(moreButton().textContent).toBe('Receipt');
  });

  it('a view from the More menu is remembered too', async () => {
    await render('p1');
    await act(async () => moreButton().click());
    await act(async () => menuItemNamed('History').click());
    expect(moreButton().textContent).toBe('History');
    await remount('p1');
    expect(moreButton().textContent).toBe('History');
  });
});

describe('the More menu', () => {
  it('holds Transcript, Receipt and History, and Terminal and Chat stay on the row', async () => {
    await render('p1');
    expect(tabs().map((t) => t.textContent)).toEqual(['Terminal', 'Chat']);
    expect(moreButton().textContent).toBe('More');
    expect(moreButton().getAttribute('aria-expanded')).toBe('false');
    await act(async () => moreButton().click());
    expect(moreButton().getAttribute('aria-expanded')).toBe('true');
    expect(menuItems().map((m) => m.textContent)).toEqual(['Transcript', 'Receipt', 'History']);
  });

  it('picking an item opens that view, and the button shows its name', async () => {
    await render('p1');
    await act(async () => moreButton().click());
    await act(async () => menuItemNamed('Receipt').click());
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(moreButton().textContent).toBe('Receipt');
    expect(moreButton().getAttribute('aria-expanded')).toBe('false');
    expect(selected()).toBeUndefined();
    expect(host.querySelector('.ck-pane-body .ck-scroll')).not.toBeNull();
  });

  it('Escape closes it and returns focus to the More button', async () => {
    await render('p1');
    await act(async () => moreButton().click());
    expect(document.activeElement).toBe(menuItemNamed('Transcript'));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });

  it('Down and Up move between the items, wrapping', async () => {
    await render('p1');
    await act(async () => moreButton().click());
    const [first, second, third] = menuItems();
    expect(document.activeElement).toBe(first);
    const press = (k: string) =>
      act(async () => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    await press('ArrowDown');
    expect(document.activeElement).toBe(second);
    await press('ArrowDown');
    expect(document.activeElement).toBe(third);
    await press('ArrowDown');
    expect(document.activeElement).toBe(first);
    await press('ArrowUp');
    expect(document.activeElement).toBe(third);
  });

  it('a click outside closes it', async () => {
    await render('p1');
    await act(async () => moreButton().click());
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});
