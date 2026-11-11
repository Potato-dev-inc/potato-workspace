// @vitest-environment jsdom
// A chat session over ACP in the pane view: the "Chat" badge, the Chat tab as the pane (there is no terminal
// to show), and a message box that stays on after the agent stopped (the next message starts it again).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ChatItem } from '../../lib/sessionChat';
import type { AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import { PaneView, forgetRememberedTabs } from './PaneView';

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
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

const SAMPLE: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'Write notes.txt' },
  { kind: 'assistant', id: 'a1.1', at: null, text: 'Asking first.', model: null, finalAnswer: false },
];

function cockpit(lane: 'acp' | undefined, status = 'idle', questions: unknown[] = []): CockpitApi {
  const info = { id: 'p1', agent_type: 'codex', status, pid: lane ? 0 : 4120, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 100, rows: 30, ...(lane ? { lane } : {}) };
  const p = { status, info };
  return {
    registry: { paneList: [p], panes: new Map([['p1', p]]), initialReady: true },
    names: new Map([['p1', 'Codex']]),
    activities: {},
    previews: {},
    asked: { questions, answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
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

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;

describe('pane view of a chat session over ACP', () => {
  it('says "Chat" on the pane and opens on its Chat tab', async () => {
    await act(async () => root.render(<PaneView c={cockpit('acp')} paneId="p1" />));
    await flush();
    expect(host.querySelector('[data-testid="pane-lane"]')?.textContent).toBe('Chat');
    expect(tab('Chat').getAttribute('aria-selected')).toBe('true');
    expect(host.textContent).toContain('Write notes.txt');
    expect(host.querySelector('[data-testid="term"]')).toBeNull();
  });

  it('has no Terminal view at all: Chat is the pane, with no "no terminal" placeholder', async () => {
    await act(async () => root.render(<PaneView c={cockpit('acp')} paneId="p1" />));
    await flush();
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain('Terminal');
    expect(tab('Chat').getAttribute('aria-selected')).toBe('true');
    expect(host.textContent).not.toMatch(/no terminal|This is a chat session/i);
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.querySelector('[data-testid="term"]')).toBeNull();
  });

  it('says its status in words: Working, Waiting for you, Done', async () => {
    const words = async (status: string) => {
      await act(async () => root.render(<PaneView c={cockpit('acp', status)} paneId={'p1'} key={status} />));
      await flush();
      return host.querySelector('.ck-pane-doing')?.textContent ?? '';
    };
    expect(await words('running')).toBe('Working');
    expect(await words('waiting_input')).toContain('Waiting for you');
    expect(await words('idle')).toBe('Done');
  });

  it('shows the result of the run (files changed and the summary) under the conversation', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
      if (cmd === 'pane_run_info') return { handle: 'h1', status: 'completed', receipt: { structured_result: { summary: 'Added notes.txt', files_changed: ['notes.txt'], checks_run: ['cargo test'], open_questions: [] } } };
      if (cmd === 'turn_summaries') return [{ paneId: 'p1', agent: 'codex', turn: 1, startedAtMs: 0, endedAtMs: 1, durationMs: 1, files: { count: 2, added: 14, deleted: 3, paths: ['notes.txt', 'a.rs'] }, approvals: [], end: { kind: 'idle' }, sentence: 'x' }];
      return null;
    });
    await act(async () => root.render(<PaneView c={cockpit('acp')} paneId="p1" />));
    await flush();
    const strip = host.querySelector('[data-testid="acp-result"]');
    expect(strip?.textContent).toContain('Added notes.txt');
    expect(strip?.textContent).toContain('2 files +14 −3');
    expect(strip?.textContent).toContain('1 check');
  });

  it('a terminal pane has no badge and keeps its terminal', async () => {
    await act(async () => root.render(<PaneView c={cockpit(undefined)} paneId="p1" />));
    await flush();
    expect(host.querySelector('[data-testid="pane-lane"]')).toBeNull();
    expect(host.querySelector('[data-testid="term"]')).not.toBeNull();
  });

  it("shows the agent's question under the conversation, and no screen fallback card", async () => {
    const question = {
      id: 'q1',
      question: 'Codex asks permission: Write notes.txt',
      choices: [{ id: 'allow_once', label: 'Allow Once' }, { id: 'reject_once', label: 'Reject' }],
      allow_free_text: false,
      urgency: 'high',
      created_at_ms: 1,
      expires_at_ms: 99,
      state: 'pending',
      kind: 'acp_permission',
      pane_id: 'p1',
    };
    await act(async () => root.render(<PaneView c={cockpit('acp', 'waiting_input', [question])} paneId="p1" />));
    await flush();
    expect(host.textContent).toContain('Write notes.txt');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Allow Once')).toBe(true);
    expect(host.textContent).not.toContain('Looks stuck');
  });

  it('keeps the message box on when the agent stopped: the next message starts it again', async () => {
    await act(async () => root.render(<PaneView c={cockpit('acp', 'error')} paneId="p1" />));
    await flush();
    const box = host.querySelector<HTMLTextAreaElement>('textarea');
    expect(box).not.toBeNull();
    expect(box!.disabled).toBe(false);
  });

  describe('while the agent works', () => {
    const running = (over: Partial<AcpChatState> = {}): AcpChatState => ({
      lane: 'acp', agent: 'codex', label: 'Codex', phase: 'working', status: 'running', turnInFlight: true, stopping: false,
      canSteer: false, turn: 1, title: null, usage: null, permissions: [], closed: false, ...over,
    });
    const fake = (initial: AcpChatState, over: { quietSecs?: number } = {}) => {
      let push: ((id: string, next: AcpChatState) => void) | null = null;
      const cancel = vi.fn(async () => true);
      const api = fakeAcpApi({
        state: async () => ({ ...initial, ...over }),
        cancel,
        watch: async (cb) => {
          push = cb;
          return () => undefined;
        },
      });
      return { api, cancel, emit: (next: AcpChatState) => act(async () => push?.('p1', next)) };
    };
    const stopButton = () => host.querySelector<HTMLButtonElement>('[data-testid="chat-composer-stop"]');
    const status = () => host.querySelector('[data-testid="chat-composer-status"]');

    it('the send button is the Stop button, "Working…" sits in the footer, and there is no strip above the box', async () => {
      const { api, cancel } = fake(running());
      await act(async () => root.render(<PaneView c={cockpit('acp', 'running')} paneId="p1" acp={api} />));
      await flush();
      expect(host.querySelector('[data-testid="acp-strip"]')).toBeNull();
      expect(status()?.textContent).toBe('Working…');
      expect(host.querySelector('.ck-chat-composer-foot')!.contains(status())).toBe(true);
      expect(stopButton()?.getAttribute('aria-label')).toBe('Stop');
      await act(async () => stopButton()!.click());
      expect(cancel).toHaveBeenCalledWith('p1');
      // At once, before the backend answers: Stopping…, button off.
      expect(status()?.textContent).toBe('Stopping…');
      expect(stopButton()!.disabled).toBe(true);
    });

    it('Esc in the box stops the turn', async () => {
      const { api, cancel } = fake(running());
      await act(async () => root.render(<PaneView c={cockpit('acp', 'running')} paneId="p1" acp={api} />));
      await flush();
      const field = host.querySelector('textarea')!;
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      expect(cancel).toHaveBeenCalledWith('p1');
    });

    it('a question the agent asks reads "Waiting for your answer" in the footer', async () => {
      const { api } = fake(running({ phase: 'needs_input' }));
      await act(async () => root.render(<PaneView c={cockpit('acp', 'running')} paneId="p1" acp={api} />));
      await flush();
      expect(status()?.textContent).toBe('Waiting for your answer');
    });

    it('a quiet agent keeps its strip with Stop and Keep waiting (a real action), and the footer stays silent', async () => {
      const { api } = fake(running({ quietSecs: 300 }));
      await act(async () => root.render(<PaneView c={cockpit('acp', 'running')} paneId="p1" acp={api} />));
      await flush();
      expect(host.querySelector('[data-testid="acp-quiet"]')?.textContent).toContain('No answer for 5 min');
      expect(status()).toBeNull();
    });

    it('idle: no Stop, no status', async () => {
      const { api } = fake(running({ phase: 'idle', status: 'idle', turnInFlight: false }));
      await act(async () => root.render(<PaneView c={cockpit('acp')} paneId="p1" acp={api} />));
      await flush();
      expect(stopButton()).toBeNull();
      expect(status()).toBeNull();
      expect(host.querySelector('.ck-chat-composer-foot button[type="submit"]')).not.toBeNull();
    });
  });
});
