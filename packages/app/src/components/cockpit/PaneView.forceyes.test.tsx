// @vitest-environment jsdom
// Force yes in the pane header, on the real PaneView: a chat shows the chip (quiet while off, "Force yes on" while on, and the
// click asks first), and a terminal pane shows it too and reads its state from the app.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import type { ChatItem } from '../../lib/sessionChat';
import { PaneView } from './PaneView';

let terminalOn = true;
const invoke = vi.fn(async (cmd: string) => {
  switch (cmd) {
    case 'checkpoints_list':
      return { state: 'ok', message: '', items: [] };
    case 'pane_force_yes':
      return terminalOn;
    case 'pane_set_force_yes':
      return true;
    default:
      return null;
  }
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, source: 'acp', items: SAMPLE })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
  onSessionChatSource: vi.fn(async () => () => undefined),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

const SAMPLE: ChatItem[] = [{ kind: 'user', id: 'u1', at: null, text: 'Fix it' }];

function cockpit(lane: 'acp' | 'terminal' = 'acp') {
  const info = { id: 'p1', agent_type: 'codex', status: 'idle', pid: 0, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 100, rows: 30, lane };
  const p = { status: 'idle', info };
  const notify = vi.fn();
  const closePane = vi.fn();
  const c = {
    registry: { paneList: [p], panes: new Map([['p1', p]]), initialReady: true },
    names: new Map([['p1', 'Codex']]),
    activities: {},
    previews: {},
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p1',
    mode: 'orchestration',
    select: vi.fn(),
    notify,
    answer: vi.fn(),
    closePane,
  } as unknown as CockpitApi;
  return { c, notify, closePane };
}

const state = (over: Partial<AcpChatState> = {}): AcpChatState => ({
  lane: 'acp',
  agent: 'codex',
  label: 'Codex',
  phase: 'idle',
  status: 'idle',
  turnInFlight: false,
  stopping: false,
  canSteer: false,
  turn: 1,
  title: null,
  usage: null,
  permissions: [],
  closed: false,
  conversation: 'p1',
  inTerminal: null,
  agentAnswering: false,
  configOptions: [],
  commands: [],
  ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  terminalOn = true;
  invoke.mockClear();
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
const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="force-yes-chip"]');
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

describe('Force yes chip in the pane header', () => {
  it('a chat shows it quiet while off and asks before it turns on', async () => {
    const setForceYes = vi.fn(async () => state({ forceYes: true }));
    await act(async () => root.render(<PaneView c={cockpit().c} paneId="p1" acp={fakeAcpApi({ state: async () => state({ forceYes: false }), setForceYes })} />));
    await flush();
    expect(chip()?.textContent).toBe('Force yes');
    await act(async () => chip()!.click());
    expect(host.querySelector('[data-testid="force-yes-warning"]')).not.toBeNull();
    expect(setForceYes).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="force-yes-confirm"]')!.click());
    await flush();
    expect(setForceYes).toHaveBeenCalledWith('p1', true);
  });

  it('a chat with Force yes on shows the chip as on', async () => {
    await act(async () => root.render(<PaneView c={cockpit().c} paneId="p1" acp={fakeAcpApi({ state: async () => state({ forceYes: true }), setForceYes: vi.fn() })} />));
    await flush();
    expect(chip()?.textContent).toBe('Force yes on');
    expect(chip()?.dataset.on).toBe('true');
  });

  it('a terminal pane reads its switch from the app and shows it', async () => {
    const { c } = cockpit('terminal');
    await act(async () => root.render(<PaneView c={c} paneId="p1" acp={fakeAcpApi()} />));
    await flush();
    expect(calls('pane_force_yes')).toHaveLength(1);
    expect((calls('pane_force_yes')[0] as unknown[])[1]).toEqual(expect.objectContaining({ paneId: 'p1', agent: 'codex' }));
    expect(chip()?.textContent).toBe('Force yes on');
  });
});

describe('Force yes and the session card in the chat header', () => {
  const card = () => host.querySelector('[data-testid="session-rail"]');
  const panelButton = () => host.querySelector<HTMLButtonElement>('.ck-pane-head button[aria-label="Hide session details"], .ck-pane-head button[aria-label="Show session details"]');

  beforeEach(() => window.localStorage.removeItem('pm.sessionRail.open'));
  afterEach(() => window.localStorage.removeItem('pm.sessionRail.open'));

  it('clicking Force yes asks first and does not open or move the session card', async () => {
    const setForceYes = vi.fn(async () => state({ forceYes: true }));
    await act(async () => root.render(<PaneView c={cockpit().c} paneId="p1" acp={fakeAcpApi({ state: async () => state({ forceYes: false }), setForceYes })} />));
    await flush();
    const before = card();
    expect(before).not.toBeNull();
    await act(async () => chip()!.click());
    const warning = host.querySelector('[data-testid="force-yes-warning"]');
    expect(warning).not.toBeNull();
    // It is drawn in the top layer, not inside the header (which clips), and it is fixed under its own chip.
    expect(warning!.closest(".ck-pane-head")).toBeNull();
    expect(warning!.parentElement).toBe(host);
    expect((warning as HTMLElement).style.position).toBe("fixed");
    expect(card()).not.toBeNull();
    // The card is the same node as before: nothing reopened it.
    expect(card()).toBe(before);
    expect(setForceYes).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="force-yes-confirm"]')!.click());
    await flush();
    expect(setForceYes).toHaveBeenCalledWith('p1', true);
    expect(card()).toBe(before);
  });

  it('the session card opens and closes only from its own panel button', async () => {
    await act(async () => root.render(<PaneView c={cockpit().c} paneId="p1" acp={fakeAcpApi({ state: async () => state({ forceYes: false }), setForceYes: vi.fn() })} />));
    await flush();
    expect(card()).not.toBeNull();
    // The status word beside Force yes does nothing when pressed.
    await act(async () => host.querySelector<HTMLElement>('.ck-pane-state')!.click());
    expect(host.querySelector('[data-testid="force-yes-warning"]')).toBeNull();
    expect(card()).not.toBeNull();
    await act(async () => panelButton()!.click());
    expect(card()).toBeNull();
    await act(async () => panelButton()!.click());
    expect(card()).not.toBeNull();
  });
});
