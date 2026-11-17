// @vitest-environment jsdom
// Screen-level: a chat whose agent started other agents shows ONE crew chip at its top. One agent: the chip names it and goes
// straight there. Many: a panel with Spin-offs and Minions; a spin-off opens its chat, a minion opens the read-only view.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ChatItem } from '../../lib/sessionChat';
import { requestChatTab } from '../../lib/chatTab';
import { resetTaskViews } from '../../lib/task-view';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, items: SAMPLE })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const SAMPLE: ChatItem[] = [{ kind: 'user', id: '1', at: '2026-10-30T10:00:00.000Z', text: 'Do the work' }];

const mk = (id: string, status: string, title: string, parent?: string, startedAs?: string) => ({
  status,
  info: { id, agent_type: 'claude', status, pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title, parent_pane_id: parent, started_as: startedAs },
});

function cockpit(list: ReturnType<typeof mk>[]): CockpitApi {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'Claude'])),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 125_000,
    selectedId: 'p',
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
    interrupt: vi.fn(async () => undefined),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true });
  resetTaskViews();
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

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
async function show(c: CockpitApi) {
  requestChatTab('p');
  await act(async () => root.render(<PaneView c={c} paneId="p" />));
  await flush();
}
const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="crew-chip"]');
const panel = () => document.querySelector('[data-testid="crew-panel"]');
const LEAD = mk('p', 'running', 'Lead');

describe('crew chip in the chat', () => {
  it('is not there when the chat started nothing', async () => {
    await show(cockpit([LEAD]));
    expect(chip()).toBeNull();
  });

  it('with one spin-off names it and a click opens its chat; the history row stays', async () => {
    const c = cockpit([LEAD, mk('s', 'running', 'OpenCode 2', 'p', 'spin_off')]);
    await show(c);
    expect(host.querySelectorAll('[data-testid="crew-chip"]')).toHaveLength(1);
    expect(chip()!.textContent).toBe('Spin-off: OpenCode 2 · working');
    expect(host.querySelectorAll('[data-testid="pane-helper-row"]')).toHaveLength(1);
    await act(async () => chip()!.click());
    expect(c.select).toHaveBeenCalledWith('s');
    expect(panel()).toBeNull();
  });

  it('with several opens a panel: a spin-off row opens its chat, a minion row opens the read-only view, a finished one stays as done', async () => {
    const c = cockpit([LEAD, mk('s1', 'running', 'Fix tests', 'p', 'spin_off'), mk('s2', 'idle', 'Old idea', 'p', 'spin_off'), mk('m1', 'running', 'Review the diff', 'p', 'minion')]);
    await show(c);
    expect(chip()!.textContent).toBe('2 spin-offs · 1 minion');
    await act(async () => chip()!.click());
    const groups = [...document.querySelectorAll('[data-testid="crew-group"]')];
    expect(groups.map((g) => g.getAttribute('data-kind'))).toEqual(['spin_off', 'minion']);
    expect(groups[0]!.querySelector('h3')!.textContent).toBe('Spin-offs (2)');
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="crew-row"]')];
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['working', 'done', 'working']);
    expect(rows[1]!.textContent).toContain('done');
    // The two kinds do not share an icon.
    expect(rows[0]!.querySelector('.ck-crew-kind')!.innerHTML).not.toBe(rows[2]!.querySelector('.ck-crew-kind')!.innerHTML);

    await act(async () => rows[0]!.querySelector<HTMLButtonElement>('.ck-crew-open')!.click());
    expect(c.select).toHaveBeenCalledWith('s1');
    expect(panel()).toBeNull();

    await act(async () => chip()!.click());
    const minion = document.querySelectorAll<HTMLElement>('[data-testid="crew-row"]')[2]!;
    await act(async () => minion.querySelector<HTMLButtonElement>('.ck-crew-open')!.click());
    await flush();
    expect(c.select).toHaveBeenCalledTimes(1);
    const column = host.querySelector('[data-testid="task-column"]')!;
    expect(column.querySelector('[data-testid="task-side-view"]')).not.toBeNull();
    expect(column.querySelector('textarea, [role="textbox"]')).toBeNull();
  });

  it('closes on Escape, and a running row can be stopped', async () => {
    const c = cockpit([LEAD, mk('s1', 'running', 'Fix tests', 'p', 'spin_off'), mk('m1', 'running', 'Review', 'p', 'minion')]);
    await show(c);
    await act(async () => chip()!.click());
    expect(panel()).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('.ck-crew-stop button')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('.ck-crew-stop .rp-mini.is-danger')!.click());
    expect(c.interrupt).toHaveBeenCalledWith('s1');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  it('folds many finished rows into one line and shows them on request', async () => {
    const list = [LEAD, ...Array.from({ length: 5 }, (_, i) => mk(`d${i}`, 'idle', `Done ${i}`, 'p', 'minion')), mk('w', 'running', 'Busy', 'p', 'minion')];
    await show(cockpit(list));
    expect(chip()!.textContent).toBe('1 working · 5 done');
    await act(async () => chip()!.click());
    expect(document.querySelectorAll('[data-testid="crew-row"]')).toHaveLength(1);
    const more = document.querySelector<HTMLButtonElement>('[data-testid="crew-show-done"]')!;
    expect(more.textContent).toBe('5 done · show');
    await act(async () => more.click());
    expect(document.querySelectorAll('[data-testid="crew-row"]')).toHaveLength(6);
  });
  it('a row that needs you can be stopped too, and each group folds on its own', async () => {
    const list = [
      LEAD,
      mk('n', 'waiting_input', 'Pick one', 'p', 'spin_off'),
      ...Array.from({ length: 3 }, (_, i) => mk(`sd${i}`, 'idle', `Old ${i}`, 'p', 'spin_off')),
      ...Array.from({ length: 3 }, (_, i) => mk(`md${i}`, 'idle', `Min ${i}`, 'p', 'minion')),
    ];
    await show(cockpit(list));
    await act(async () => chip()!.click());
    const needs = document.querySelector<HTMLElement>('[data-testid="crew-row"][data-state="needs-you"]')!;
    expect(needs.querySelector('.ck-crew-stop button')).not.toBeNull();
    const shows = document.querySelectorAll<HTMLButtonElement>('[data-testid="crew-show-done"]');
    expect(shows).toHaveLength(2);
    await act(async () => shows[0]!.click());
    expect(document.querySelectorAll('[data-testid="crew-show-done"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="crew-row"]')).toHaveLength(4);
  });
});
