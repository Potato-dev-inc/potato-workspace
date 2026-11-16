// @vitest-environment jsdom
// Screen-level: a minion of this chat. Its row is in the chat ("Minion: <task>") and in Background tasks, a click opens a
// read-only view in the details column beside the right panel (no text box), and when the minion is gone the rows go.
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

const T0 = Date.parse('2026-10-30T10:00:00Z');
const SAMPLE: ChatItem[] = [
  { kind: 'user', id: '1', at: '2026-10-30T10:00:00.000Z', text: 'Review the diff' },
  { kind: 'assistant', id: '2', at: '2026-10-30T10:00:10.000Z', text: 'Reading the changes.', model: null, finalAnswer: false },
];

const mk = (id: string, status: string, title: string, parent?: string, startedAs?: string, createdAt = 1) => ({
  status,
  info: { id, agent_type: 'claude', status, pid: 1, created_at: createdAt, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title, parent_pane_id: parent, started_as: startedAs },
});

function cockpit(list: ReturnType<typeof mk>[], selected: string): CockpitApi {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'Claude'])),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: selected,
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
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
const chatRows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="pane-helper-row"]')];
const railRows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="rail-helper"]')];

async function show(c: CockpitApi, paneId: string) {
  requestChatTab(paneId);
  await act(async () => root.render(<PaneView c={c} paneId={paneId} />));
  await flush();
}

const LIST = [mk('p', 'running', 'Lead', undefined, undefined, T0 - 60_000), mk('m', 'running', 'Review the diff', 'p', 'minion', T0 + 20_000)];

describe('pane view: a minion of this chat', () => {
  it('has a row in the chat and in Background tasks; a click opens the read-only view, not the pane', async () => {
    const c = cockpit(LIST, 'p');
    await show(c, 'p');
    expect(chatRows().map((r) => r.textContent)).toEqual(['Minion: Review the diffClaudeworking']);
    expect(railRows()).toHaveLength(1);
    expect(host.querySelector('[data-testid="task-column"]')).toBeNull();

    await act(async () => chatRows()[0].querySelector<HTMLButtonElement>('button')!.click());
    await flush();
    expect(c.select).not.toHaveBeenCalled();
    const column = host.querySelector('[data-testid="task-column"]')!;
    expect(column.querySelector('[data-testid="task-side-view"]')).not.toBeNull();
    // The minion's own chat is read here (its first message is the task), and there is no way to type into it.
    expect(column.textContent).toContain('Review the diff');
    expect(column.querySelector('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')).toBeNull();
    expect(column.querySelector('[aria-label="Back"]')).not.toBeNull();

    // The rail row opens the same view; Fill makes it lie over the chat; the chat itself stays mounted.
    await act(async () => column.querySelector<HTMLButtonElement>('[aria-label="Fill the window"]')!.click());
    expect(host.querySelector('[data-testid="task-column"]')!.getAttribute('data-full')).toBe('true');
    expect(host.querySelector('[data-testid="session-chat"]')).not.toBeNull();
  });

  it('removes the rows when the minion is gone (its agent was closed, so it was stopped)', async () => {
    await show(cockpit(LIST, 'p'), 'p');
    expect(chatRows()).toHaveLength(1);
    expect(railRows()).toHaveLength(1);
    await act(async () => root.render(<PaneView c={cockpit([LIST[0]], 'p')} paneId="p" />));
    await flush();
    expect(chatRows()).toHaveLength(0);
    expect(railRows()).toHaveLength(0);
  });

  it('a helper that is not a minion (One type) still opens its own pane', async () => {
    const c = cockpit([LIST[0], mk('h', 'running', 'Check tests', 'p', undefined, T0 + 20_000)], 'p');
    await show(c, 'p');
    await act(async () => chatRows()[0].querySelector<HTMLButtonElement>('button')!.click());
    expect(c.select).toHaveBeenCalledWith('h');
    expect(host.querySelector('[data-testid="task-column"]')).toBeNull();
  });
});
