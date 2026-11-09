// @vitest-environment jsdom
// The model and effort pickers above the message box, across an app restart. The state objects are what the backend sends
// (`acp_chat_state` / the `acp-chat-state` event). The restored chat shows the pickers the backend kept for it (before it
// started and after it answered the restore with no settings), and a new session that replaced a lost one shows ITS options.
// The Rust half (the options survive `begin_epoch`, are saved with the conversation, and a replacement session takes its
// own) is tested in acp/conversation_tests.rs.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpChatApi, AcpChatState } from '../../lib/acpChat';
import type { ChatItem } from '../../lib/sessionChat';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
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
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const SAMPLE: ChatItem[] = [{ kind: 'user', id: 'u1', at: null, text: 'Earlier question' }];

const select = (id: string, name: string, current: string, values: string[], category: string) => ({
  id,
  name,
  category,
  type: 'select',
  currentValue: current,
  options: values.map((v) => ({ value: v, name: v.toUpperCase() })),
});
const MODEL_AND_EFFORT = [select('model', 'Model', 'a', ['a', 'b'], 'model'), select('effort', 'Effort', 'low', ['low', 'high'], 'thought_level')];
const NEW_SESSION_OPTIONS = [select('model', 'Model', 'z', ['y', 'z'], 'model')];

/** The state the backend sends for a chat. */
function backendState(over: Record<string, unknown> = {}): AcpChatState {
  return {
    lane: 'acp',
    agent: 'fakeagent',
    label: 'Fake agent',
    phase: 'idle',
    status: 'idle',
    turnInFlight: false,
    stopping: false,
    quietSecs: 0,
    canSteer: false,
    turn: 1,
    epoch: 1,
    revision: 1,
    title: null,
    usage: { used: 120, size: 1000 },
    commands: [],
    configOptions: MODEL_AND_EFFORT,
    modes: null,
    historyLost: null,
    permissions: [],
    exit: null,
    closed: false,
    conversation: 'p1',
    inTerminal: null,
    agentAnswering: false,
    interruptedTurn: false,
    signIn: { needed: false, hint: '' },
    ...over,
  } as unknown as AcpChatState;
}

function cockpit(): CockpitApi {
  const info = { id: 'p1', agent_type: 'fakeagent', status: 'idle', pid: 0, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 100, rows: 30, lane: 'acp' };
  const p = { status: 'idle', info };
  return {
    registry: { paneList: [p], panes: new Map([['p1', p]]), initialReady: true },
    names: new Map([['p1', 'Fake agent']]),
    activities: {},
    previews: {},
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p1',
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
    answer: vi.fn(),
    closePane: vi.fn(),
  } as unknown as CockpitApi;
}

/** An api over a fake backend: `state` answers the read, `push` sends an `acp-chat-state` event. */
function fakeBackend(first: AcpChatState) {
  const listeners = new Set<(paneId: string, state: AcpChatState) => void>();
  const api = {
    state: vi.fn(async () => first),
    watch: vi.fn(async (cb: (paneId: string, state: AcpChatState) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    setConfig: vi.fn(),
    cancel: vi.fn(async () => true),
    watchConversations: vi.fn(async () => () => undefined),
    conversationOfTerminal: vi.fn(async () => null),
  } as unknown as AcpChatApi;
  return { api, push: (state: AcpChatState) => act(async () => listeners.forEach((l) => l('p1', state))) };
}

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

const flush = () => act(async () => void (await new Promise((r) => setImmediate(r))));
// Each setting is one control (a menu pill, or a segmented switch for the effort-like one) tagged with its id and value.
const pickers = () => [...host.querySelectorAll<HTMLElement>('[data-testid="acp-chips"] [data-chip-id]')];
const labels = () => pickers().map((s) => s.querySelector('[aria-label]')?.getAttribute('aria-label') ?? s.getAttribute('aria-label'));
const isOff = (el: HTMLElement) => el.hasAttribute('data-disabled');
async function mount(api: AcpChatApi) {
  await act(async () => root.render(<PaneView c={cockpit()} paneId="p1" acp={api} />));
  await flush();
  await flush();
}

describe('model and effort pickers after a restart', () => {
  it('a restored chat shows the pickers the backend kept for it, with their current values', async () => {
    // The app was restarted: this state is what the backend reports for the restored conversation, before and after the
    // agent answered the restore without any settings.
    const { api, push } = fakeBackend(backendState({ phase: 'dormant', epoch: 0, revision: 0 }));
    await mount(api);
    expect(labels()).toEqual(['Model', 'Effort']);
    expect(pickers().map((s) => s.dataset.value)).toEqual(['a', 'low']);
    await push(backendState({ phase: 'idle', epoch: 1, revision: 2 }));
    expect(labels()).toEqual(['Model', 'Effort']);
    // New replies move the revision; the pickers stay.
    await push(backendState({ phase: 'working', turnInFlight: true, turn: 2, revision: 3 }));
    expect(pickers().every(isOff)).toBe(true);
    await push(backendState({ phase: 'idle', turn: 2, revision: 4 }));
    expect(labels()).toEqual(['Model', 'Effort']);
    expect(pickers().every((s) => !isOff(s))).toBe(true);
  });

  it('a new session that replaced the lost one shows its own options', async () => {
    const { api, push } = fakeBackend(backendState());
    await mount(api);
    expect(labels()).toEqual(['Model', 'Effort']);
    await push(backendState({ epoch: 2, revision: 5, historyLost: { reason: 'Session not found' } as never, configOptions: NEW_SESSION_OPTIONS }));
    expect(labels()).toEqual(['Model']);
    expect(pickers()[0].dataset.value).toBe('z');
    act(() => pickers()[0].querySelector('button')!.click());
    expect([...host.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['Y', 'Z']);
  });
});
