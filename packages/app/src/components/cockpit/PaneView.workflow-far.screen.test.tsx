// @vitest-environment jsdom
// Screen-level (P3.1): a project on another PC shows the same crew chip and workflow card as a local one. The real PaneView renders the
// same front and helpers twice, once on this PC and once in a HostProvider holding a fake far host; the DOM must match, and the far
// crew and the far Labs switch are read from the far host, never from this PC.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ChatItem } from '../../lib/sessionChat';
import { requestChatTab } from '../../lib/chatTab';
import { rememberCrewStart } from '../../lib/crew-members';
import { closeDockPane, resetTaskViews } from '../../lib/task-view';
import { HostProvider } from '../../lib/host/context';
import { ALL_CAPS, type Host } from '../../lib/host/host';
import { PaneView } from './PaneView';

const flag = vi.hoisted(() => ({ on: true }));
const invoke = vi.fn(async (cmd: string) => {
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'crews_get') return CREW;
  return null;
});
/** The far PC: it answers the workflow reads itself, and says so when it is asked. */
const far = vi.hoisted(() => ({ list: [] as unknown[] | null, calls: [] as string[], handlers: [] as Array<() => void> }));
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


const farHost = (): Host => ({
  place: { kind: 'pc', node: 'n1', name: 'Mac mini' },
  live: true,
  caps: ALL_CAPS,
  invoke: (async (cmd: string) => {
    far.calls.push(cmd);
    if (cmd === 'crews_get') return CREW;
    if (cmd === 'workflows_list') return far.list;
    return null;
  }) as Host['invoke'],
  listen: (async (event: string, cb: () => void) => {
    if (event === 'workflow-state') far.handlers.push(cb);
    return () => undefined;
  }) as Host['listen'],
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
async function show(c: CockpitApi, on?: Host) {
  requestChatTab('p');
  await act(async () => root.render(on ? <HostProvider host={on}><PaneView c={c} paneId="p" /></HostProvider> : <PaneView c={c} paneId="p" />));
  await flush();
  await flush();
}
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const FRONT = mk('p', 'running', 'Router');
const TWO = [mk('h1', 'running', 'Researcher', 'p', 'minion', 'find facts'), mk('h2', 'waiting_input', 'Writer', 'p', 'spin_off', 'write it')];
const markFront = () => rememberCrewStart('wf', [{ role: 'Front', pane_id: 'p' }], 'Front', 'Research + Write');
/** What the screen draws for the workflow: the crew chip, then the pane or the card. */
const drawn = () => ['[data-testid="crew-chip"]', '[data-slot="workflow"]', '[data-testid="wf-card"]'].map((s) => q(s)?.outerHTML ?? '-').join('|');

beforeEach(() => {
  far.list = [{ slug: 'wf' }];
  far.calls = [];
  far.handlers = [];
});

describe('a far project shows the same workflow as a local one', () => {
  it('the crew chip and the workflow pane are the same DOM, with the details column open', async () => {
    markFront();
    await show(cockpit([FRONT, ...TWO]));
    const local = drawn();
    expect(local).toContain('wf-summary');
    await act(async () => root.unmount());
    root = createRoot(host);
    await show(cockpit([FRONT, ...TWO]), farHost());
    expect(drawn()).toBe(local);
  });

  it('the card above the chat is the same DOM, with the details column hidden', async () => {
    window.localStorage.setItem('pm.sessionRail.open', '0');
    markFront();
    await show(cockpit([FRONT, ...TWO]));
    const local = drawn();
    expect(local).toContain('wf-card');
    await act(async () => root.unmount());
    root = createRoot(host);
    await show(cockpit([FRONT, ...TWO]), farHost());
    expect(drawn()).toBe(local);
  });

  it('reads the crew and the Labs switch from the far PC, never from this one', async () => {
    markFront();
    flag.on = false; // this PC has Workflows off; the far PC has it on, and it is the far PC's crews that count
    invoke.mockClear();
    await show(cockpit([FRONT, ...TWO]), farHost());
    expect(q('[data-slot="workflow"]')).not.toBeNull();
    expect(far.calls).toEqual(expect.arrayContaining(['workflows_list', 'crews_get']));
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('crews_get');
  });

  it('shows nothing when the far PC has Workflows off', async () => {
    markFront();
    far.list = null;
    await show(cockpit([FRONT, ...TWO]), farHost());
    expect(q('[data-slot="workflow"]')).toBeNull();
    expect(q('[data-testid="wf-card"]')).toBeNull();
  });

  it('reads the crew again when the far PC says the workflow gained helpers', async () => {
    markFront();
    await show(cockpit([FRONT, ...TWO]), farHost());
    const before = far.calls.filter((c) => c === 'crews_get').length;
    expect(far.handlers.length).toBeGreaterThan(0);
    await act(async () => far.handlers.forEach((h) => h()));
    await flush();
    expect(far.calls.filter((c) => c === 'crews_get').length).toBeGreaterThan(before);
  });
});
