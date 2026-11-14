// @vitest-environment jsdom
// A chat that works on a copy ("Work on a copy"), seen in the pane: the strip with what changed and the two ways out
// (Keep the changes, Throw away the copy), the same two in the More menu, and the question when the chat is closed
// while its copy has changes. A chat that works in the project itself shows none of it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import { requestPaneAction } from '../../lib/pane-actions';
import { currentUndo, finishUndo, resetUndoBar } from '../../lib/undo-bar';
import type { ChatItem } from '../../lib/sessionChat';
import { PaneView } from './PaneView';

let copyFiles = 2;
const invoke = vi.fn(async (cmd: string) => {
  switch (cmd) {
    case 'checkpoints_list':
      return { state: 'ok', message: '', items: [] };
    case 'acp_chat_copy':
      return { kind: 'git', files: copyFiles, additions: 5, deletions: 1 };
    case 'acp_chat_copy_keep':
      return { kept: true, files: 2 };
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

function cockpit() {
  const info = { id: 'p1', agent_type: 'codex', status: 'idle', pid: 0, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 100, rows: 30, lane: 'acp' };
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
  copyFiles = 2;
  resetUndoBar();
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
const bar = () => host.querySelector('[data-testid="chat-copy-bar"]');
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

async function mount(copy: AcpChatState['copy'], c: CockpitApi) {
  await act(async () => root.render(<PaneView c={c} paneId="p1" acp={fakeAcpApi({ state: async () => state({ copy }) })} />));
  await flush();
}

describe('a chat that works on a copy', () => {
  it('shows what the copy changed and the two buttons, only for a copy chat', async () => {
    await mount(null, cockpit().c);
    expect(bar()).toBeNull();
    expect(calls('acp_chat_copy')).toHaveLength(0);

    await act(async () => root.unmount());
    root = createRoot(host);
    await mount({ kind: 'git' }, cockpit().c);
    expect(bar()).not.toBeNull();
    expect(bar()!.textContent).toContain('2 files changed');
    expect(bar()!.textContent).toContain('+5');
    expect(button('Keep the changes')).toBeDefined();
    expect(button('Throw away the copy')).toBeDefined();
  });

  it('a plain trial copy is called a trial copy', async () => {
    await mount({ kind: 'plain' }, cockpit().c);
    expect(bar()!.textContent).toContain('Trial copy');
  });

  it('Keep the changes asks the backend and says what happened', async () => {
    const { c, notify } = cockpit();
    await mount({ kind: 'git' }, c);
    await act(async () => button('Keep the changes')!.click());
    await flush();
    expect(calls('acp_chat_copy_keep')).toEqual([['acp_chat_copy_keep', { paneId: 'p1' }]]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Kept in your project'));
  });

  it('Throw away the copy waits in the undo bar, and is final only when the bar ends', async () => {
    await mount({ kind: 'git' }, cockpit().c);
    await act(async () => button('Throw away the copy')!.click());
    expect(currentUndo()?.text).toBe('Threw away the copy');
    expect(calls('acp_chat_copy_discard')).toHaveLength(0);
    await act(async () => finishUndo(currentUndo()!.id));
    await flush();
    expect(calls('acp_chat_copy_discard')).toEqual([['acp_chat_copy_discard', { paneId: 'p1' }]]);
  });

  it('Keep is off while the copy has no changes', async () => {
    copyFiles = 0;
    await mount({ kind: 'git' }, cockpit().c);
    expect(bar()!.textContent).toContain('No changes yet');
    expect(button('Keep the changes')!.disabled).toBe(true);
  });

  it('the More menu has the same two actions', async () => {
    await mount({ kind: 'git' }, cockpit().c);
    await act(async () => host.querySelector<HTMLButtonElement>('.ck-pane-head button.ck-more-btn')!.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((m) => m.textContent);
    expect(items).toContain('Keep the changes');
    expect(items).toContain('Throw away the copy');
  });

  it('closing a chat whose copy has changes asks what to do with the copy first', async () => {
    const { c, closePane } = cockpit();
    await mount({ kind: 'git' }, c);
    await act(async () => requestPaneAction('p1', 'close'));
    await flush();
    expect(closePane).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('This copy has changes');
    await act(async () => button('Close, decide later')!.click());
    expect(closePane).toHaveBeenCalledWith('p1');
  });

  it('closing a chat whose copy has no changes closes at once', async () => {
    copyFiles = 0;
    const { c, closePane } = cockpit();
    await mount({ kind: 'git' }, c);
    await act(async () => requestPaneAction('p1', 'close'));
    await flush();
    expect(document.body.textContent).not.toContain('This copy has changes');
    expect(closePane).toHaveBeenCalledWith('p1');
  });
});
