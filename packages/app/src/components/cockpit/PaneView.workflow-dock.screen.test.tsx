// @vitest-environment jsdom
// Screen-level: the live view of a workflow INSIDE the chat of its front agent (Labs "Workflows"), through the real PaneView.
// A front that started agents gets a "Workflow" pane at the top of the details column, opened once by itself; with the column
// hidden the same view is a card at the top of the chat. A normal chat, or the Labs switch off, shows nothing of it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ChatItem } from '../../lib/sessionChat';
import { requestChatTab } from '../../lib/chatTab';
import { rememberCrewStart } from '../../lib/crew-members';
import { closeDockPane, resetTaskViews } from '../../lib/task-view';
import { PaneView } from './PaneView';

const flag = vi.hoisted(() => ({ on: true }));
const invoke = vi.fn(async (cmd: string) => {
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'crews_get') return CREW;
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../../lib/settings', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/settings')>();
  return { ...real, loadSettings: async () => ({ ...(await real.loadSettings()), workflows_enabled: flag.on }) };
});
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

const SAMPLE: ChatItem[] = [{ kind: 'user', id: '1', at: '2026-10-30T10:00:00.000Z', text: 'Research then write' }];
const CREW = {
  name: 'Research + Write',
  roles: [
    { name: 'Front', agent_type: 'claude', model: 'haiku', task: 'Route.', front: true },
    { name: 'Researcher', agent_type: 'claude', model: 'sonnet', task: 'Find facts.', parent: 'Front', when_to_use: 'research' },
    { name: 'Writer', agent_type: 'claude', model: 'sonnet', task: 'Write.', parent: 'Front', when_to_use: 'writing' },
  ],
};

const mk = (id: string, status: string, title: string, parent?: string, startedAs?: string, task?: string) => ({
  status,
  info: { id, agent_type: 'claude', status, pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title, parent_pane_id: parent, started_as: startedAs, origin: task ? { task } : undefined },
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
  flag.on = true;
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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
async function show(c: CockpitApi) {
  requestChatTab('p');
  await act(async () => root.render(<PaneView c={c} paneId="p" />));
  await flush();
  await flush();
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const FRONT = mk('p', 'running', 'Router');
const TWO = [mk('h1', 'running', 'Researcher', 'p', 'minion', 'find facts'), mk('h2', 'waiting_input', 'Writer', 'p', 'spin_off', 'write it')];
const markFront = () => rememberCrewStart('wf', [{ role: 'Front', pane_id: 'p' }], 'Front', 'Research + Write');

describe('the workflow pane in the details column', () => {
  it('opens by itself for a workflow front: the front, its agents with one word each, the summary', async () => {
    markFront();
    await show(cockpit([FRONT, ...TWO]));
    const pane = q('[data-testid="task-column"] [data-slot="workflow"]')!;
    expect(pane).not.toBeNull();
    expect(pane.querySelector('.tk-title')!.textContent).toBe('Workflow: Research + Write');
    expect(q('[data-testid="wf-summary"]')!.textContent).toBe('1 needs you · 1 working');
    expect(q('[data-testid="wf-front"]')!.textContent).toContain('Front');
    const boxes = [...host.querySelectorAll<HTMLElement>('[data-testid="wf-box"]')];
    expect(boxes.map((b) => b.getAttribute('data-state'))).toEqual(['working', 'needs-you']);
    expect(boxes[0]!.textContent).toContain('Researcher');
    expect(boxes[0]!.textContent).toContain('Working');
    expect(boxes[1]!.textContent).toContain('Needs you');
    expect(q('[data-testid="wf-card"]')).toBeNull();
  });

  it('a normal chat with the same agents has no workflow pane, and neither does a front with Labs off', async () => {
    await show(cockpit([FRONT, ...TWO]));
    expect(q('[data-slot="workflow"]')).toBeNull();
    expect(q('[data-testid="wf-live"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    markFront();
    flag.on = false;
    await show(cockpit([FRONT, ...TWO]));
    expect(q('[data-slot="workflow"]')).toBeNull();
    expect(q('[data-testid="wf-card"]')).toBeNull();
  });

  it('is not opened before any agent started, and closing it keeps it closed', async () => {
    markFront();
    await show(cockpit([FRONT]));
    expect(q('[data-slot="workflow"]')).toBeNull();
    await act(async () => root.render(<PaneView c={cockpit([FRONT, ...TWO])} paneId="p" />));
    await flush();
    expect(q('[data-slot="workflow"]')).not.toBeNull();
    await act(async () => closeDockPane('p', 'workflow'));
    await act(async () => root.render(<PaneView c={cockpit([FRONT, ...TWO, mk('h3', 'running', 'More', 'p', 'minion')])} paneId="p" />));
    await flush();
    expect(q('[data-slot="workflow"]')).toBeNull();
  });

  it('a box opens its agent: a spin-off as a chat, a minion as the read-only view under the workflow pane', async () => {
    markFront();
    const c = cockpit([FRONT, ...TWO]);
    await show(c);
    const boxes = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="wf-box"]')];
    await act(async () => boxes[1]!.click());
    expect(c.select).toHaveBeenCalledWith('h2');
    await act(async () => boxes[0]!.click());
    await flush();
    expect(q('[data-testid="task-column"] [data-slot="view"] [data-testid="task-side-view"]')).not.toBeNull();
    expect(q('[data-slot="workflow"]')).not.toBeNull();
  });

  it('shows a finished agent as done, and the log tells who started and who finished', async () => {
    markFront();
    await show(cockpit([FRONT, mk('h1', 'idle', 'Researcher', 'p', 'minion', 'find facts')]));
    expect(q('[data-testid="wf-summary"]')!.textContent).toBe('done');
    expect(q('[data-testid="wf-box"]')!.getAttribute('data-state')).toBe('done');
    expect(q('[data-testid="live-log"]')!.textContent).toContain('Researcher started');
  });
});

describe('marks and counts', () => {
  it('a chat marked AFTER the screen opened gets the pane, and the chip offers the live view', async () => {
    await show(cockpit([FRONT, ...TWO]));
    expect(q('[data-slot="workflow"]')).toBeNull();
    await act(async () => markFront());
    await flush();
    expect(q('[data-slot="workflow"]')).not.toBeNull();
    await act(async () => q('[data-testid="crew-chip"]')!.click());
    expect(document.querySelector('[data-testid="crew-open-live"]')).not.toBeNull();
  });

  it('the chip, the pane and the card say the same count for a helper waiting on a permission prompt', async () => {
    markFront();
    const waiting = [mk('h1', 'waiting_input', 'Researcher', 'p', 'minion', 'find facts'), mk('h2', 'running', 'Writer', 'p', 'minion', 'write it')];
    await show(cockpit([FRONT, ...waiting]));
    expect(q('[data-testid="crew-chip"]')!.textContent).toBe('1 needs you · 1 working');
    expect(q('[data-testid="wf-summary"]')!.textContent).toBe('1 needs you · 1 working');
    await act(async () => root.unmount());
    root = createRoot(host);
    window.localStorage.setItem('pm.sessionRail.open', '0');
    await show(cockpit([FRONT, ...waiting]));
    expect(q('[data-testid="wf-card-line"]')!.textContent).toBe('Workflow: Research + Write · 1 needs you · 1 working');
  });
});

describe('the card when the details column is hidden', () => {
  beforeEach(() => window.localStorage.setItem('pm.sessionRail.open', '0'));

  it('sits under the crew chip as one line; the chevron opens the live view inline', async () => {
    markFront();
    await show(cockpit([FRONT, ...TWO]));
    expect(q('[data-testid="task-column"]')).toBeNull();
    const head = q('[data-testid="wf-card-head"]')!;
    expect(q('[data-testid="wf-card-line"]')!.textContent).toBe('Workflow: Research + Write · 1 needs you · 1 working');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(q('[data-testid="wf-live"]')).toBeNull();
    await act(async () => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('[data-testid="wf-box"]')).toHaveLength(2);
    await act(async () => head.click());
    expect(q('[data-testid="wf-live"]')).toBeNull();
  });

  it('is not there for a normal chat or with Labs off', async () => {
    await show(cockpit([FRONT, ...TWO]));
    expect(q('[data-testid="wf-card"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    markFront();
    flag.on = false;
    await show(cockpit([FRONT, ...TWO]));
    expect(q('[data-testid="wf-card"]')).toBeNull();
  });
});
